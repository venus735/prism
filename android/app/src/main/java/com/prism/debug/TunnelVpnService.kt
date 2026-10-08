package com.prism.debug

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.VpnService
import android.os.ParcelFileDescriptor
import android.os.Process
import android.system.OsConstants
import java.io.File
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

class TunnelVpnService : VpnService() {

  companion object {
    init {
      System.loadLibrary("hev-socks5-tunnel")
    }

    const val ACTION_START = "com.prism.debug.action.START"
    const val ACTION_STOP = "com.prism.debug.action.STOP"
    const val TUN_IPV4 = "198.18.0.1"
    const val DNS_IPV4 = "198.18.0.2"
    private const val CHANNEL_ID = "tunnel"
    private const val NOTIF_ID = 1

    @JvmStatic external fun TProxyStartService(configPath: String, fd: Int): Boolean
    @JvmStatic external fun TProxyStopService(): Boolean
    @JvmStatic external fun TProxyIsRunning(): Boolean
    @JvmStatic external fun TProxyGetStats(): LongArray

    @Volatile var lastError: String? = null

    @Volatile private var appContext: Context? = null
    private val uidLabels = ConcurrentHashMap<Int, String>()

    /** tun2socks 经 JNI 调用：按连接四元组查发起应用名，失败返回 null（代理端回退为按 IP 显示） */
    @JvmStatic
    fun lookupAppOwner(srcIp: String, srcPort: Int, dstIp: String, dstPort: Int): String? {
      return runCatching {
        val ctx = appContext ?: return null
        val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return null
        val local = InetSocketAddress(InetAddress.getByName(srcIp), srcPort)
        val remote = InetSocketAddress(InetAddress.getByName(dstIp), dstPort)
        var uid = cm.getConnectionOwnerUid(OsConstants.IPPROTO_TCP, local, remote)
        if (uid == Process.INVALID_UID) {
          uid = cm.getConnectionOwnerUid(OsConstants.IPPROTO_TCP, remote, local)
        }
        if (uid == Process.INVALID_UID) return null
        labelForUid(uid)
      }.getOrNull()
    }

    private fun labelForUid(uid: Int): String? {
      uidLabels[uid]?.let { return it }
      val ctx = appContext ?: return null
      val pm = ctx.packageManager
      val packages = pm.getPackagesForUid(uid) ?: return null
      for (pkg in packages) {
        val label = runCatching {
          pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
        }.getOrNull()
        if (!label.isNullOrBlank()) {
          uidLabels[uid] = label
          return label
        }
      }
      return null
    }

    /** 预载全部应用的 uid→名称映射，避免每个连接首次查询时同步加载 */
    private fun preloadAppLabels(context: Context) {
      val pm = context.packageManager
      runCatching {
        for (info in pm.getInstalledApplications(0)) {
          if (!uidLabels.containsKey(info.uid)) {
            val label = runCatching { info.loadLabel(pm).toString() }.getOrNull()
            if (!label.isNullOrBlank()) uidLabels[info.uid] = label
          }
        }
      }
    }
  }

  private var tunFd: ParcelFileDescriptor? = null
  @Volatile private var starting = false
  @Volatile private var healthStop = false
  private var healthThread: Thread? = null

  override fun onCreate() {
    super.onCreate()
    appContext = applicationContext
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        thread { stopTunnel() }
        return START_NOT_STICKY
      }
      else -> {
        createChannel()
        startForeground(NOTIF_ID, buildNotification("连接中…"))
        if (TProxyIsRunning()) {
          updateNotification()
        } else if (!starting) {
          starting = true
          thread { startTunnel() }
        }
      }
    }
    return START_STICKY
  }

  private fun startTunnel() {
    try {
      val host = Prefs.getHost(this)
      val port = Prefs.getPort(this)
      if (host.isBlank()) throw IllegalStateException("未配置 Mac 地址")
      lastError = null

      val configFile = File(filesDir, "tun2socks.yml")
      configFile.writeText(buildYaml(host, port))

      val builder = Builder()
        .setSession("Prism")
        .setMtu(8500)
        .addAddress(TUN_IPV4, 24)
        .addAddress("fc00::1", 128)
        .addRoute("0.0.0.0", 0)
        .addRoute("::", 0)
        .addDnsServer(DNS_IPV4)
      applyPerApp(builder)

      val pfd = builder.establish() ?: throw IllegalStateException("VPN 未授权")
      tunFd = pfd
      preloadAppLabels(this)
      if (!TProxyStartService(configFile.absolutePath, pfd.fd)) {
        throw IllegalStateException("tun2socks 启动失败")
      }
      // TProxyStartService 在配置非法时也返回 true（线程先起、main 后退出），轮询确认真正在跑
      var ok = false
      for (i in 0 until 30) {
        Thread.sleep(100)
        if (TProxyIsRunning()) { ok = true; break }
      }
      if (!ok) throw IllegalStateException("tun2socks 未运行：${readLogTail()}")

      Prefs.setLastConnected(this, true)
      updateNotification()
      startHealthMonitor()
    } catch (t: Throwable) {
      lastError = t.message ?: t.javaClass.simpleName
      Prefs.setLastConnected(this, false)
      stopTunnel()
    } finally {
      starting = false
    }
  }

  /**
   * 上游健康监视：Mac 代理持续不可达时自动断开隧道恢复直连（fail-open）。
   * 防止 Mac 侧重启/关机时全机流量进黑洞、各 App 重试风暴导致发热。
   */
  private fun startHealthMonitor() {
    healthStop = false
    healthThread = thread(name = "upstream-health") {
      var failures = 0
      while (!healthStop) {
        Thread.sleep(10_000)
        if (healthStop || !TProxyIsRunning()) break
        if (probeUpstream()) failures = 0
        else failures++
        if (failures >= 6) {
          lastError = "Mac 代理持续不可达（约 1 分钟），已自动断开 VPN 恢复直连"
          stopTunnel()
          break
        }
      }
    }
  }

  /** SOCKS5 无认证握手探测：发出 05 01 00 后应答 05 00（App 自身不走 VPN，直连探测） */
  private fun probeUpstream(): Boolean = runCatching {
    java.net.Socket().use { s ->
      s.tcpNoDelay = true
      s.connect(InetSocketAddress(Prefs.getHost(this), Prefs.getPort(this)), 3000)
      s.soTimeout = 3000
      s.getOutputStream().write(byteArrayOf(0x05, 0x01, 0x00))
      s.getOutputStream().flush()
      val resp = ByteArray(2)
      var n = 0
      while (n < 2) {
        val k = s.getInputStream().read(resp, n, 2 - n)
        if (k < 0) break
        n += k
      }
      n == 2 && resp[0] == 0x05.toByte()
    }
  }.getOrDefault(false)

  private fun applyPerApp(builder: Builder) {
    val apps = Prefs.getSelectedApps(this).filter { it != packageName }
    when (Prefs.getMode(this)) {
      AppMode.ALL -> builder.addDisallowedApplication(packageName)
      AppMode.INCLUDE ->
        // 白名单为空时退化为全代理（至少排除自身，避免回环）
        if (apps.isEmpty()) builder.addDisallowedApplication(packageName)
        else apps.forEach { builder.addAllowedApplication(it) }
      AppMode.EXCLUDE -> {
        builder.addDisallowedApplication(packageName)
        apps.forEach { builder.addDisallowedApplication(it) }
      }
    }
  }

  private fun buildYaml(host: String, port: Int): String = """
    tunnel:
      name: tun0
      mtu: 8500
      ipv4: $TUN_IPV4
      ipv6: 'fc00::1'
    socks5:
      port: $port
      address: '$host'
      udp: 'udp'
    mapdns:
      address: $DNS_IPV4
      port: 53
      network: 100.64.0.0
      netmask: 255.192.0.0
      cache-size: 10000
    misc:
      log-file: '${File(filesDir, "tun.log").absolutePath}'
      log-level: info
  """.trimIndent()

  private fun readLogTail(): String {
    val log = File(filesDir, "tun.log")
    if (!log.exists()) return "无日志"
    return log.readLines().takeLast(3).joinToString(" | ")
  }

  private fun stopTunnel() {
    healthStop = true
    runCatching { TProxyStopService() }
    tunFd?.let { fd -> runCatching { fd.close() } }
    tunFd = null
    Prefs.setLastConnected(this, false)
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun onDestroy() {
    if (TProxyIsRunning()) {
      runCatching { TProxyStopService() }
      tunFd?.let { fd -> runCatching { fd.close() } }
      tunFd = null
    }
    super.onDestroy()
  }

  private fun createChannel() {
    val nm = getSystemService(NotificationManager::class.java)
    if (nm.getNotificationChannel(CHANNEL_ID) == null) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "VPN 隧道", NotificationManager.IMPORTANCE_LOW)
      )
    }
  }

  private fun buildNotification(text: String): Notification {
    val content = PendingIntent.getActivity(
      this, 0, Intent(this, MainActivity::class.java),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val stop = PendingIntent.getService(
      this, 1,
      Intent(this, TunnelVpnService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    return Notification.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_prism)
      .setContentTitle("Prism 棱镜")
      .setContentText(text)
      .setContentIntent(content)
      .setOngoing(true)
      .addAction(Notification.Action.Builder(null, "断开", stop).build())
      .build()
  }

  private fun updateNotification() {
    val nm = getSystemService(NotificationManager::class.java)
    nm.notify(NOTIF_ID, buildNotification("已连接 ${Prefs.getHost(this)}:${Prefs.getPort(this)}"))
  }
}
