package com.prism.debug

import android.content.Context
import android.os.Build
import android.util.Log
import java.io.File
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import android.util.Base64

/**
 * Root 专用系统 CA 注入。
 *
 * Android 14+：/apex/com.android.conscrypt/cacerts 只读。每个 app 进程有独立 mount namespace，
 * 直接在 su shell 里 mount 只有 shell 自己的 ns 可见——必须
 *   1) 清理历史残留 bind（按唯一 ns 去重）
 *   2) 把系统证书 + 我们的 CA 复制到 /data/local/tmp
 *   3) 数量校验通过后才 bind 到 apex 目录（全局 ns + nsenter 每个唯一 ns 一次）
 *   4) 挂载后终检，失败立即回滚 umount
 * 挂载不持久，重启后由 BootReceiver 重放。
 *
 * Android <14：/system/etc/security/cacerts 直接 remount rw 写入，持久生效。
 */
object RootCertInstaller {

  private const val TAG = "RootCertInstaller"
  private const val SRC_DIR = "/data/local/tmp/proxy-cacerts"
  private const val APEX_DIR = "/apex/com.android.conscrypt/cacerts"
  private const val CERT_CTX = "u:object_r:system_security_cacerts_file:s0"

  /** 缓存的证书文件（DER，供 BootReceiver 重放挂载） */
  private fun certFile(ctx: Context): File = File(ctx.filesDir, "system-ca.der")

  fun hasRoot(): Boolean = RootShell.checkRoot() is RootShell.RootState.Available

  fun isInstalled(ctx: Context): Boolean = certFile(ctx).exists()

  /** 是否已安装过 CA 且设备是 Android 14+ bind 方案 */
  fun needsMount(ctx: Context): Boolean =
    Build.VERSION.SDK_INT >= 34 && certFile(ctx).exists()

  /** CA 挂载文件名（subject hash .0），未安装或损坏返回 null */
  fun mountName(ctx: Context): String? {
    val f = certFile(ctx)
    if (!f.exists()) return null
    return try {
      val cert = CertificateFactory.getInstance("X.509")
        .generateCertificate(f.inputStream()) as X509Certificate
      "${subjectHashOld(cert)}.0"
    } catch (t: Throwable) {
      Log.w(TAG, "hash cert failed", t)
      null
    }
  }

  /**
   * App 进程视角的挂载状态（免 root：apex 证书目录全局可读，bind 挂载注入过
   * 本进程 mount ns 后即可见）。挂载完成前是系统原始 149 张证书。
   * @return -2=未安装 CA；-1=已安装未生效；>=0=已生效的证书总数
   */
  fun mountStatus(ctx: Context): Int {
    if (!needsMount(ctx)) return -2
    val name = mountName(ctx) ?: return -2
    val files = File(APEX_DIR).list() ?: return -1
    if (!files.contains(name)) return -1
    return files.size
  }

  private val remountInFlight = java.util.concurrent.atomic.AtomicBoolean(false)

  /**
   * @return 成功时为 null，失败时为错误信息
   */
  fun install(ctx: Context, caDer: ByteArray): String? {
    return try {
      val cert = CertificateFactory.getInstance("X.509")
        .generateCertificate(caDer.inputStream()) as X509Certificate
      certFile(ctx).writeBytes(caDer)
      val name = "${subjectHashOld(cert)}.0"

      val r = if (Build.VERSION.SDK_INT >= 34) {
        runMountScript(ctx, name, fastPath = false)
      } else {
        RootShell.exec(
          legacyCopyScript(Base64.encodeToString(caDer, Base64.NO_WRAP), name),
          timeoutSec = 300
        )
      }
      if (r.ok) null
      else "exit=${r.exit} ${r.err} ${r.out}".trim().ifBlank { "unknown" }
    } catch (t: Throwable) {
      t.message ?: t.javaClass.simpleName
    }
  }

  /**
   * 执行挂载脚本。魔数提权设备走「脚本落文件 + 微型 payload」：大 payload 经管道
   * 会被内核钩子截断分流（脚本头被吞、中段落到未提权的父 shell 执行），而与探测
   * 同构的短 payload（魔数+一行命令+exit）稳定提权——root sh 域为 untrusted_app
   * +本应用 categories，可读本应用 filesDir，CA 直接 cp，无需 base64 内嵌。
   * su 设备保持内嵌全量脚本（su -c 传参不走管道，无此问题）。
   */
  private fun runMountScript(ctx: Context, name: String, fastPath: Boolean): RootShell.Result {
    val state = RootShell.checkRoot()
    return if (state is RootShell.RootState.Available && state.mode == RootShell.Mode.MAGIC) {
      val scriptFile = File(ctx.filesDir, "mount.sh")
      scriptFile.writeText(
        mountScript("cp '${certFile(ctx).absolutePath}' ${'$'}SRC/${'$'}NAME", name, fastPath)
      )
      RootShell.exec("sh ${scriptFile.absolutePath}", timeoutSec = 300)
    } else {
      val b64 = Base64.encodeToString(certFile(ctx).readBytes(), Base64.NO_WRAP)
      RootShell.exec(
        mountScript("echo '$b64' | base64 -d > ${'$'}SRC/${'$'}NAME", name, fastPath),
        timeoutSec = 300
      )
    }
  }

  /** 开机重放挂载（仅 Android 14+ bind 方案需要；legacy 写 /system 持久无需重放） */
  fun remountAfterBoot(ctx: Context) {
    if (!needsMount(ctx)) return
    // 本进程已可见即已完成（免 root 检查，零 shell）——Activity 重建高频触发时是纯 no-op
    if (mountStatus(ctx) >= 0) return
    // BootReceiver 路径先于 MainActivity 运行，进程内 magicCommand 还是默认值——
    // 提权命令必须先从 Prefs 注入（用户自定义魔数），否则无 su 设备上开机重放会失败
    RootShell.magicCommand = Prefs.getRootMagic(ctx)
    // 并发互斥：BootReceiver 与 MainActivity（含 Activity 重建）可能同时触发，
    // 两份全量脚本并发会互相 umount/rm -rf 打穿对方的挂载源（曾致 apex 被空目录 bind 覆盖、全机证书归零）
    if (!remountInFlight.compareAndSet(false, true)) return
    val name = mountName(ctx)
    if (name == null) { remountInFlight.set(false); return }
    Thread {
      try {
        // 开机早期 zygote 可能尚未 fork 完，稍等几秒再注入
        Thread.sleep(5000)
        if (mountStatus(ctx) < 0) {
          val r = runMountScript(ctx, name, fastPath = true)
          // 首跑失败（开机初期系统慢/探测竞争）间隔 30s 重试一次
          if (!r.ok && mountStatus(ctx) < 0) {
            Log.w(TAG, "remount failed (${r.out.trim().take(80)}), retry in 30s")
            Thread.sleep(30_000)
            if (mountStatus(ctx) < 0) {
              runMountScript(ctx, name, fastPath = true)
            }
          }
        }
      } finally {
        remountInFlight.set(false)
      }
    }.start()
  }

  /**
   * Android 14+：清残留 bind → 重建证书目录（系统证书 + 本应用 CA）→ 校验 →
   * bind 覆盖 apex 并注入所有进程 mount ns → 终检失败则回滚。
   * fastPath=true 时前置检查：全局 bind 在位且所有进程都看得到 CA 则直接跳过
   * （全量 umount+nsenter 遍历耗时长，冷启动幂等重放多数情况无需重做）。
   * 所有 nsenter 一律按唯一 mount namespace 去重（每 ns 一个代表 pid）：
   * 绝大多数进程共享同一路径的 ns，逐进程 nsenter 会往同一路径层层叠 bind
   * （曾堆 16K 层致全机卡死）。
   * @param caInstall 把本应用 CA 放入 $SRC/$NAME 的命令（MAGIC 设备 cp 本应用文件；SU 设备 base64 内嵌）
   */
  private fun mountScript(caInstall: String, name: String, fastPath: Boolean = false): String {
    // 唯一 mount ns 代表 pid 集合（108 个左右；sort -k2,2n 保证选号最小的稳定 pid，如 1）
    val reps = """
      REPS=$(for N in /proc/[0-9]*/ns/mnt; do R=$(readlink "${'$'}N" 2>/dev/null); P=${'$'}{N%/ns/mnt}; echo "${'$'}R ${'$'}{P#/proc/}"; done | sort -k2,2n | awk '!seen[${'$'}1]++ {print ${'$'}2}')
    """.trimIndent()
    // 快路径①：全局已挂且源目录完好——全进程可见直接完成；
    // 个别进程遗漏（全局挂载后才启动的）只补 nsenter，不重建目录。
    // （/proc/PID/root 在目标进程自身 mount ns 内解析，可检测每个进程的真实视角）
    val quickCheck = if (!fastPath) "" else
      """
      if [ -s "${'$'}APEX/${'$'}NAME" ] && [ -s "${'$'}SRC/${'$'}NAME" ]; then
        MISSING=0
        for R in /proc/[0-9]*/root; do
          if [ ! -e "${'$'}R${'$'}APEX/${'$'}NAME" ]; then MISSING=1; break; fi
        done
        if [ "${'$'}MISSING" = "0" ]; then echo "already mounted"; exit 0; fi
        for P in ${'$'}REPS; do
          nsenter -t ${'$'}P -m -- mount --bind ${'$'}SRC ${'$'}APEX 2>/dev/null || true
        done
        echo "repaired"
        exit 0
      fi
      """.trimIndent()
    // 脚本级互斥（跨触发源/孤儿进程兜底）：mkdir 原子抢锁，>360s 视为前次已死可重入
    val lockGuard = """
      LOCK=/data/local/tmp/.proxy-mount-lock
      NOW=$(date +%s)
      AGE=$(( NOW - ${'$'}(stat -c %Y "${'$'}LOCK" 2>/dev/null || echo 0) ))
      if [ "${'$'}AGE" -gt 360 ]; then rmdir "${'$'}LOCK" 2>/dev/null || true; fi
      mkdir "${'$'}LOCK" 2>/dev/null || { echo "another remount in flight"; exit 0; }
      trap 'rmdir "${'$'}LOCK" 2>/dev/null' EXIT
    """.trimIndent()
    val head = """
      set -e
      SRC=$SRC_DIR
      APEX=$APEX_DIR
      NAME=$name

$reps

$lockGuard
    """.trimIndent()
    val body = """
      # 0) 清理历史残留 bind（按唯一 ns 去重），避免 rm -rf 打穿活动挂载下的证书
      for i in 1 2 3 4 5 6 7 8; do umount ${'$'}APEX 2>/dev/null || break; done
      for P in ${'$'}REPS; do
        nsenter -t ${'$'}P -m -- sh -c 'for i in 1 2 3 4 5 6 7 8; do umount /apex/com.android.conscrypt/cacerts 2>/dev/null || break; done' 2>/dev/null || true
      done

      # 1) 重建：原系统证书 + 本应用 CA（caInstall 由调用方注入）
      rm -rf ${'$'}SRC
      mkdir -p ${'$'}SRC
      cp ${'$'}APEX/* ${'$'}SRC/
      $caInstall
      chown root:root ${'$'}SRC ${'$'}SRC/*
      chmod 755 ${'$'}SRC
      chmod 644 ${'$'}SRC/*
      chcon $CERT_CTX ${'$'}SRC 2>/dev/null || true
      chcon $CERT_CTX ${'$'}SRC/* 2>/dev/null || true

      # 2) 挂载前校验：拷贝不完整立即中止（此时未做任何挂载，系统无损）
      N=$(ls ${'$'}SRC | wc -l)
      if [ "${'$'}N" -lt 140 ]; then echo "cert copy incomplete: ${'$'}N"; exit 1; fi
      if [ ! -s ${'$'}SRC/${'$'}NAME ]; then echo "ca cert missing"; exit 1; fi

      # 3) bind 覆盖 apex（全局 ns + 每个唯一 ns 一次；zygote 覆盖后续 fork 的 app）
      mount --bind ${'$'}SRC ${'$'}APEX
      for P in ${'$'}REPS; do
        nsenter -t ${'$'}P -m -- mount --bind ${'$'}SRC ${'$'}APEX 2>/dev/null || true
      done

      # 4) 挂载后终检：失败则回滚全部挂载
      if [ ! -s ${'$'}APEX/${'$'}NAME ] || [ "$(ls ${'$'}APEX | wc -l)" -lt 141 ]; then
        for i in 1 2 3 4 5 6 7 8; do umount ${'$'}APEX 2>/dev/null || break; done
        for P in ${'$'}REPS; do
          nsenter -t ${'$'}P -m -- sh -c 'for i in 1 2 3 4 5 6 7 8; do umount /apex/com.android.conscrypt/cacerts 2>/dev/null || break; done' 2>/dev/null || true
        done
        echo "post-mount verify failed, rolled back"
        exit 1
      fi
      echo OK
      """.trimIndent()
    return head + "\n\n" + quickCheck + "\n\n" + body
  }

  /** Android <14：直接写 /system（持久，重启不丢）；CA 同样 base64 内嵌 */
  private fun legacyCopyScript(caB64: String, name: String): String = """
    set -e
    DST=/system/etc/security/cacerts
    [ -d ${'$'}DST ] || { echo "cacerts dir not found"; exit 1; }
    mount -o rw,remount /system 2>/dev/null || mount -o rw,remount / 2>/dev/null || true
    echo '$caB64' | base64 -d > ${'$'}DST/$name
    chown root:root ${'$'}DST/$name 2>/dev/null || true
    chmod 644 ${'$'}DST/$name
    chcon $CERT_CTX ${'$'}DST/$name 2>/dev/null || true
    mount -o ro,remount /system 2>/dev/null || true
    ls ${'$'}DST/$name >/dev/null
    echo OK
  """.trimIndent()

  /** OpenSSL 旧式 subject hash（X509_NAME_hash）：subject DER 的 MD5 前 4 字节小端 */
  private fun subjectHashOld(cert: X509Certificate): String {
    val md5 = MessageDigest.getInstance("MD5").digest(cert.subjectX500Principal.encoded)
    var v = (md5[0].toInt() and 0xFF) or
      ((md5[1].toInt() and 0xFF) shl 8) or
      ((md5[2].toInt() and 0xFF) shl 16) or
      ((md5[3].toInt() and 0xFF) shl 24)
    if (v < 0) v = v.toInt()
    return Integer.toUnsignedString(v, 16)
  }
}
