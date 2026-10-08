package com.prism.debug

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.prism.debug.databinding.ActivityMainBinding
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import kotlin.concurrent.thread

class MainActivity : AppCompatActivity() {

  private lateinit var binding: ActivityMainBinding
  private val handler = Handler(Looper.getMainLooper())
  private var suppressSwitch = false
  private var currentScheme = ConnScheme.WIFI
  private var suppressScheme = false

  private val prepareLauncher =
    registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
      if (r.resultCode == RESULT_OK) startTunnelService() else resetSwitch()
    }

  private val scanLauncher =
    registerForActivityResult(ScanContract()) { result ->
      val text = result.contents ?: return@registerForActivityResult
      val uri = runCatching { android.net.Uri.parse(text) }.getOrNull()
      if (uri?.scheme == "prism" && uri.host == "pair") {
        uri.getQueryParameter("host")?.let {
          switchScheme(ConnScheme.WIFI) // 扫码配对是 Wi-Fi 方案
          binding.hostEdit.setText(it)
        }
        uri.getQueryParameter("port")?.toIntOrNull()?.let { binding.portEdit.setText(it.toString()) }
        Toast.makeText(this, "已填入 Mac 地址", Toast.LENGTH_SHORT).show()
      } else {
        Toast.makeText(this, "二维码内容无法识别", Toast.LENGTH_SHORT).show()
      }
    }

  private val notifPermLauncher =
    registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

  private val statusPoller = object : Runnable {
    override fun run() {
      val running = runCatching { TunnelVpnService.TProxyIsRunning() }.getOrDefault(false)
      updateStatus(running)
      updateCaStatus()
      handler.postDelayed(this, 1000)
    }
  }

  /** CA 挂载状态行：免 root 检查本进程视角的 apex 证书目录（bind 注入后即见） */
  private fun updateCaStatus() {
    val st = runCatching { RootCertInstaller.mountStatus(this) }.getOrDefault(-2)
    when {
      st == -2 -> {
        binding.caStatusText.text = "CA 未安装——HTTPS 解密需先装系统证书"
        binding.caStatusText.setTextColor(0xFF9E9E9E.toInt())
      }
      st < 0 -> {
        binding.caStatusText.text = "CA 挂载中/未生效（冷启动自动重放，稍候…）"
        binding.caStatusText.setTextColor(0xFFF9A825.toInt())
      }
      else -> {
        binding.caStatusText.text = "CA 已生效 ✓（系统信任 $st 张证书，HTTPS 解密可用）"
        binding.caStatusText.setTextColor(0xFF2E7D32.toInt())
      }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    binding = ActivityMainBinding.inflate(layoutInflater)
    setContentView(binding.root)

    // 连接方案（Wi-Fi / USB）：初始状态 + 切换时双地址槽位互存
    currentScheme = Prefs.getScheme(this)
    binding.hostEdit.setText(
      if (currentScheme == ConnScheme.WIFI) Prefs.getHostWifi(this) else Prefs.getHostUsb(this)
    )
    binding.portEdit.setText(Prefs.getPort(this).toString())
    binding.autoStartSwitch.isChecked = Prefs.getAutoStart(this)
    binding.autoStartSwitch.setOnCheckedChangeListener { _, checked ->
      Prefs.setAutoStart(this, checked)
    }

    suppressSwitch = true
    binding.vpnSwitch.isChecked = runCatching { TunnelVpnService.TProxyIsRunning() }.getOrDefault(false)
    suppressSwitch = false

    // 连接方案（Wi-Fi / USB）：切换时双地址槽位互存
    suppressScheme = true
    binding.schemeWifi.isChecked = currentScheme == ConnScheme.WIFI
    binding.schemeUsb.isChecked = currentScheme == ConnScheme.USB
    suppressScheme = false
    updateHostHint()
    binding.schemeToggle.addOnButtonCheckedListener { _, checkedId, isChecked ->
      if (!isChecked || suppressScheme) return@addOnButtonCheckedListener
      switchScheme(if (checkedId == R.id.schemeUsb) ConnScheme.USB else ConnScheme.WIFI)
    }
    binding.vpnSwitch.setOnCheckedChangeListener { _, checked ->
      if (suppressSwitch) return@setOnCheckedChangeListener
      if (checked) connect() else disconnect()
    }

    binding.testButton.setOnClickListener { testConnection() }
    binding.scanButton.setOnClickListener {
      scanLauncher.launch(
        ScanOptions().apply {
          setDesiredBarcodeFormats(ScanOptions.QR_CODE)
          setPrompt("扫描 Mac 端「设置 → 手机接入指引」中的二维码")
          setBeepEnabled(false)
          setOrientationLocked(true)
        }
      )
    }
    binding.appsButton.setOnClickListener { startActivity(Intent(this, AppListActivity::class.java)) }
    binding.caButton.setOnClickListener { showCaGuide() }
    binding.rootStatusText.setOnClickListener { checkRootStatus() }

    // 注入用户配置的提权魔数（保存于 Prefs，适配不同改版内核）
    RootShell.magicCommand = Prefs.getRootMagic(this)
    checkRootStatus()
    binding.rootStatusText.setOnLongClickListener { showMagicEditor(); true }

    // 开机广播在 stopped 状态收不到（Android 15+），冷启动补一次 CA 挂载重放（幂等）
    RootCertInstaller.remountAfterBoot(this)

    if (Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      notifPermLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
    }
  }

  override fun onResume() {
    super.onResume()
    handler.post(statusPoller)
  }

  override fun onPause() {
    super.onPause()
    handler.removeCallbacks(statusPoller)
  }

  /** 切换连接方案：旧方案记住当前输入地址，新方案回填其记忆地址 */
  private fun switchScheme(next: ConnScheme) {
    if (next == currentScheme) return
    val cur = binding.hostEdit.text.toString().trim()
    if (currentScheme == ConnScheme.WIFI) Prefs.setHostWifi(this, cur) else Prefs.setHostUsb(this, cur)
    currentScheme = next
    Prefs.setScheme(this, next)
    suppressScheme = true
    binding.schemeWifi.isChecked = next == ConnScheme.WIFI
    binding.schemeUsb.isChecked = next == ConnScheme.USB
    suppressScheme = false
    binding.hostEdit.setText(
      if (next == ConnScheme.WIFI) Prefs.getHostWifi(this) else Prefs.getHostUsb(this)
    )
    updateHostHint()
  }

  private fun updateHostHint() {
    binding.hostLayout.hint =
      if (currentScheme == ConnScheme.WIFI) "Mac 局域网 IP" else "Mac 地址（USB 方案固定 127.0.0.1）"
  }

  private fun saveAndValidate(): Boolean {
    val host = binding.hostEdit.text.toString().trim()
    val port = binding.portEdit.text.toString().trim().toIntOrNull()
    if (host.isBlank() || runCatching { InetAddress.getByName(host) }.isFailure ||
      host.contains("/") || !host.matches(Regex("^[0-9a-fA-F.:]+$"))
    ) {
      Toast.makeText(
        this,
        if (currentScheme == ConnScheme.USB) "请填写 Mac 地址（USB 方案为 127.0.0.1，仅支持 IP）"
        else "请填写 Mac 的局域网 IP（仅支持 IP，不支持域名）",
        Toast.LENGTH_LONG
      ).show()
      return false
    }
    if (port == null || port !in 1..65535) {
      Toast.makeText(this, "端口无效", Toast.LENGTH_SHORT).show()
      return false
    }
    Prefs.setHost(this, host)
    if (currentScheme == ConnScheme.WIFI) Prefs.setHostWifi(this, host) else Prefs.setHostUsb(this, host)
    Prefs.setPort(this, port)
    return true
  }

  private fun connect() {
    if (!saveAndValidate()) { resetSwitch(); return }
    TunnelVpnService.lastError = null
    val prepare = VpnService.prepare(this)
    if (prepare != null) prepareLauncher.launch(prepare) else startTunnelService()
  }

  private fun startTunnelService() {
    ContextCompat.startForegroundService(
      this,
      Intent(this, TunnelVpnService::class.java).setAction(TunnelVpnService.ACTION_START)
    )
  }

  private fun disconnect() {
    startService(
      Intent(this, TunnelVpnService::class.java).setAction(TunnelVpnService.ACTION_STOP)
    )
  }

  private fun resetSwitch() {
    suppressSwitch = true
    binding.vpnSwitch.isChecked = false
    suppressSwitch = false
  }

  private fun updateStatus(running: Boolean) {
    suppressSwitch = true
    binding.vpnSwitch.isChecked = running
    suppressSwitch = false
    if (running) {
      binding.statusText.text = "已连接 → ${Prefs.getHost(this)}:${Prefs.getPort(this)}"
      binding.statusText.setTextColor(0xFF2E7D32.toInt())
    } else {
      val err = TunnelVpnService.lastError
      binding.statusText.text = err?.let { "连接失败：$it" } ?: "未连接"
      binding.statusText.setTextColor(err?.let { 0xFFC62828.toInt() } ?: 0xFF9E9E9E.toInt())
    }
  }

  private fun testConnection() {
    if (!saveAndValidate()) return
    val host = Prefs.getHost(this)
    val port = Prefs.getPort(this)
    Toast.makeText(this, "测试中…", Toast.LENGTH_SHORT).show()
    thread {
      val msg = try {
        Socket().use { s ->
          s.connect(InetSocketAddress(host, port), 3000)
          s.soTimeout = 3000
          s.getOutputStream().write(byteArrayOf(0x05, 0x01, 0x00))
          s.getOutputStream().flush()
          val resp = ByteArray(2)
          var read = 0
          while (read < 2) {
            val n = s.getInputStream().read(resp, read, 2 - read)
            if (n < 0) break
            read += n
          }
          if (read == 2 && resp[0] == 0x05.toByte() && resp[1] == 0x00.toByte()) {
            "连接成功：Mac 代理可达（SOCKS5 无认证）"
          } else {
            "握手响应异常: ${resp.joinToString(" ") { String.format("%02x", it) }}"
          }
        }
      } catch (t: Throwable) {
        "连接失败：${t.message}"
      }
      handler.post { Toast.makeText(this, msg, Toast.LENGTH_LONG).show() }
    }
  }

  /** 后台探测 Root（su 或内核后门魔数），结果缓存于 RootShell；点击状态行重测，长按配置魔数 */
  private fun checkRootStatus() {
    binding.rootStatusText.text = "Root 检测中…"
    binding.rootStatusText.setTextColor(0xFF9E9E9E.toInt())
    thread {
      val state = RootShell.checkRoot()
      handler.post {
        when (state) {
          is RootShell.RootState.Available -> {
            binding.rootStatusText.text =
              if (state.mode == RootShell.Mode.MAGIC) "Root 可用 ✓（内核后门：${RootShell.magicCommand}）点击重测"
              else "Root 可用 ✓（su）点击重测"
            binding.rootStatusText.setTextColor(0xFF2E7D32.toInt())
          }
          is RootShell.RootState.NoSu -> {
            binding.rootStatusText.text = "未获取 Root——点击重测，长按配置提权命令"
            binding.rootStatusText.setTextColor(0xFFC62828.toInt())
          }
          is RootShell.RootState.MagicFailed -> {
            binding.rootStatusText.text = "Root 授权失败——点击重测，长按配置提权命令"
            binding.rootStatusText.setTextColor(0xFFC62828.toInt())
          }
        }
      }
    }
  }

  /** 配置内核后门提权魔数命令（不同改版内核命令不同，由用户填写） */
  private fun showMagicEditor() {
    val input = android.widget.EditText(this).apply {
      setText(Prefs.getRootMagic(this@MainActivity))
      hint = "如 getprop xxxxx（填你内核对应的命令）"
      setSingleLine()
    }
    MaterialAlertDialogBuilder(this)
      .setTitle("Root 提权命令")
      .setMessage("部分改版内核通过特定命令提权当前 shell（无 su 二进制）。\n填写你内核的提权命令，保存后自动重测。")
      .setView(input)
      .setPositiveButton("保存") { _, _ ->
        val cmd = input.text.toString().trim()
        if (cmd.isNotEmpty()) {
          Prefs.setRootMagic(this, cmd)
          RootShell.magicCommand = cmd
          RootShell.reset()
          checkRootStatus()
        }
      }
      .setNegativeButton("取消", null)
      .show()
  }

  private fun showCaGuide() {
    val installed = RootCertInstaller.isInstalled(this)
    val builder = MaterialAlertDialogBuilder(this)
      .setTitle("安装 CA 证书（HTTPS 解密）")
      .setMessage(
        (if (installed) "系统证书已安装（重启后自动重新挂载）\n\n" else "") +
          "一键装入系统证书目录，全部 App 生效（需 Root，安装需 Mac 端代理可达）。\n\n" +
          "Android 14+：证书以挂载方式注入运行中的进程，重启后自动重放；\n" +
          "Android 14 以下：直接写入 /system，永久生效。"
      )
    when (RootShell.checkRoot()) {
      is RootShell.RootState.Available -> {
        if (!installed) {
          builder.setPositiveButton("一键安装") { _, _ -> installSystemCert() }
        } else {
          builder.setPositiveButton("重新安装") { _, _ -> installSystemCert() }
        }
      }
      else -> {
        builder.setMessage("未获得 Root 权限，无法安装系统证书。\n\n本应用仅支持已 Root 设备，请先解锁并授权 Root 后重试。")
          .setPositiveButton("重新检测 Root") { _, _ -> checkRootStatus() }
      }
    }
    builder.setNegativeButton("关闭", null).show()
  }

  private fun installSystemCert() {
    val host = Prefs.getHost(this)
    val port = Prefs.getPort(this)
    if (host.isBlank()) {
      Toast.makeText(this, "请先配置并连接 Mac 代理", Toast.LENGTH_SHORT).show()
      return
    }
    Toast.makeText(this, "下载证书中…", Toast.LENGTH_SHORT).show()
    thread {
      val err = try {
        if (RootShell.checkRoot() !is RootShell.RootState.Available) {
          "Root 授权失败（su 不可用或被拒绝）"
        } else {
          val der = CaFetcher.fetch(host, port)
          RootCertInstaller.install(this, der)
        }
      } catch (t: Throwable) {
        "下载失败：${t.message}（请确认 Mac 端代理已启动且地址正确）"
      }
      handler.post {
        if (err == null) {
          Toast.makeText(this, "系统证书安装成功，全部 App 即刻信任", Toast.LENGTH_LONG).show()
        } else {
          Toast.makeText(this, "安装失败：$err", Toast.LENGTH_LONG).show()
        }
      }
    }
  }
}
