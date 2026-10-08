package com.prism.debug

import android.util.Log
import java.io.File
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Root 执行封装，按优先级尝试两种提权方式：
 *  1. su 二进制（Magisk/KernelSU/APatch 标准方式，默认）
 *  2. 内核后门：交互式 shell 里执行用户配置的魔数命令（改版内核钩子把当前
 *     shell 进程提权为 root，具体命令由用户在主界面长按 Root 状态行填写并持久化）
 *
 * 仅用于调试自己拥有或明确获授权的设备；不得用于未授权的提权或流量拦截。
 */
object RootShell {

  private const val TAG = "RootShell"

  /** 可配置的魔数命令（不同改版内核可能不同）；调用方从 Prefs 注入，未设置用默认值 */
  @Volatile var magicCommand: String = DEFAULT_MAGIC
  private val cachedMode = AtomicReference<Mode?>(null)

  const val DEFAULT_MAGIC = "su"

  enum class Mode { MAGIC, SU }

  sealed class RootState {
    data class Available(val mode: Mode) : RootState()
    data object NoSu : RootState()
    data class MagicFailed(val detail: String) : RootState()
  }

  /** 清除探测缓存（改魔数后重测用） */
  fun reset() {
    cachedMode.set(null)
  }

  private val checkLock = Any()

  /** 探测提权方式；结果缓存在内存，每进程只测一次。synchronized 防并发双探测
   *  （魔数后门一次只容一只 shell：两只并发探测会互相打乱管道状态双双失败） */
  fun checkRoot(): RootState {
    synchronized(checkLock) {
      cachedMode.get()?.let { return RootState.Available(it) }

      // 1) su 二进制
      val suPath = findSu()
      if (suPath != null) {
        val r = execSu(suPath, "id")
        if (r.exit == 0 && r.out.contains("uid=0")) {
          cachedMode.set(Mode.SU)
          return RootState.Available(Mode.SU)
        }
      }

      // 2) 内核后门魔数（交互式 shell：先写魔数，再 id 验证）
      if (tryMagic(magicCommand)) {
        cachedMode.set(Mode.MAGIC)
        return RootState.Available(Mode.MAGIC)
      }

      return if (suPath != null) MagicFailedOrDenied(suPath) else RootState.NoSu
    }
  }

  private fun MagicFailedOrDenied(suPath: String): RootState =
    RootState.MagicFailed("su($suPath) 提权失败且魔数后门无效")

  class Result(val exit: Int, val out: String, val err: String) {
    val ok: Boolean get() = exit == 0
  }

  /** 执行多行脚本；自动选择可用提权方式 */
  fun exec(script: String, timeoutSec: Long = 60): Result {
    val mode = cachedMode.get() ?: (runCatching { checkRoot() }.getOrNull() as? RootState.Available)?.mode
    return when (mode) {
      Mode.SU -> execSu(findSu() ?: return Result(-1, "", "su not found"), script)
      Mode.MAGIC -> execMagic(magicCommand, script, timeoutSec)
      null -> Result(-1, "", "root unavailable")
    }
  }

  // ------------------------------------------------------------------
  // 内核后门：交互式 sh —— 写魔数提权当前 shell，再逐行写命令收集输出
  // 注意：魔数必须与后续命令在同一次 write() 里发送。内核钩子在魔数触发
  // 提权后会吞掉该管道后续的写入（实测：分开写 id/exit 永远到不了 shell，
  // 且 waitFor 无超时会永久卡死）
  // ------------------------------------------------------------------

  private fun tryMagic(magic: String): Boolean {
    val payload = (magic + "\nid\nexit\n").toByteArray()
    return runShell(payload, 10).out.contains("uid=0")
  }

  private fun execMagic(magic: String, script: String, timeoutSec: Long = 60): Result {
    val payload = (magic + "\n" + script + "\nexit\n").toByteArray()
    return runShell(payload, timeoutSec)
  }

  /** 起 sh，单次 write 写入 payload 后关闭 stdin，带超时强杀回收 */
  private fun runShell(payload: ByteArray, timeoutSec: Long): Result = try {
    val p = Runtime.getRuntime().exec("sh")
    val outBuf = StringBuilder()
    val errBuf = StringBuilder()
    // 超时 destroyForcibly 会 close 管道，阻塞中的 read 抛 InterruptedIOException——
    // 不捕获会把整个进程炸掉（曾致崩溃循环），读线程吞掉即可，已读输出保留
    val t1 = Thread { runCatching { p.inputStream.bufferedReader().forEachLine { outBuf.appendLine(it) } } }
    val t2 = Thread { runCatching { p.errorStream.bufferedReader().forEachLine { errBuf.appendLine(it) } } }
    t1.start(); t2.start()

    val os = p.outputStream
    os.write(payload) // 单次 write —— 关键
    runCatching { os.close() }

    if (!p.waitFor(timeoutSec, TimeUnit.SECONDS)) {
      Log.w(TAG, "shell not exited in ${timeoutSec}s, killing")
      p.destroyForcibly()
      p.waitFor(3, TimeUnit.SECONDS)
    }
    t1.join(2000); t2.join(2000)
    val code = runCatching { p.exitValue() }.getOrDefault(-1)
    Result(code, outBuf.toString(), errBuf.toString())
  } catch (t: Throwable) {
    Log.w(TAG, "shell exec failed", t)
    Result(-1, "", t.message ?: t.javaClass.simpleName)
  }

  // ------------------------------------------------------------------
  // 标准 su 路径
  // ------------------------------------------------------------------

  private fun execSu(suPath: String, script: String): Result = try {
    val p = Runtime.getRuntime().exec(arrayOf(suPath, "-c", script))
    val outBuf = StringBuilder()
    val errBuf = StringBuilder()
    val t1 = Thread { runCatching { p.inputStream.bufferedReader().forEachLine { outBuf.appendLine(it) } } }
    val t2 = Thread { runCatching { p.errorStream.bufferedReader().forEachLine { errBuf.appendLine(it) } } }
    t1.start(); t2.start()
    if (!p.waitFor(30, TimeUnit.SECONDS)) {
      Log.w(TAG, "su not exited in 30s, killing")
      p.destroyForcibly()
      p.waitFor(3, TimeUnit.SECONDS)
    }
    t1.join(2000); t2.join(2000)
    val code = runCatching { p.exitValue() }.getOrDefault(-1)
    Result(code, outBuf.toString(), errBuf.toString())
  } catch (t: Throwable) {
    Log.w(TAG, "su exec failed", t)
    Result(-1, "", t.message ?: t.javaClass.simpleName)
  }

  private fun findSu(): String? {
    val candidates = mutableListOf("su")
    for (dir in listOf("/system/bin", "/system/xbin", "/sbin", "/system/sbin", "/vendor/bin", "/debug_ramdisk")) {
      candidates += "$dir/su"
    }
    for (c in candidates) {
      val path = if (c == "su") whichSu() else c
      if (path != null && File(path).canExecute()) return path
    }
    return null
  }

  private fun whichSu(): String? = System.getenv("PATH")
    ?.split(':')
    ?.map { "$it/su" }
    ?.firstOrNull { File(it).canExecute() }
}
