package com.prism.debug

import android.content.Context
import android.content.SharedPreferences

enum class AppMode { ALL, INCLUDE, EXCLUDE }

/** 手机 → Mac 连接方案：Wi-Fi 局域网直连 / USB（adb reverse，App 连 127.0.0.1） */
enum class ConnScheme { WIFI, USB }

object Prefs {
  private fun sp(ctx: Context): SharedPreferences =
    ctx.getSharedPreferences("tunnel", Context.MODE_PRIVATE)

  fun getHost(ctx: Context): String = sp(ctx).getString("host", "") ?: ""
  fun setHost(ctx: Context, v: String) = sp(ctx).edit().putString("host", v.trim()).apply()

  /** 当前连接方案（默认 Wi-Fi） */
  fun getScheme(ctx: Context): ConnScheme =
    runCatching { ConnScheme.valueOf(sp(ctx).getString("scheme", ConnScheme.WIFI.name)!!) }
      .getOrDefault(ConnScheme.WIFI)
  fun setScheme(ctx: Context, v: ConnScheme) =
    sp(ctx).edit().putString("scheme", v.name).apply()

  /** 各方案记忆的地址：Wi-Fi 槽缺省回落到旧版单地址，USB 槽缺省 127.0.0.1 */
  fun getHostWifi(ctx: Context): String =
    sp(ctx).getString("hostWifi", null) ?: getHost(ctx)
  fun setHostWifi(ctx: Context, v: String) =
    sp(ctx).edit().putString("hostWifi", v.trim()).apply()

  fun getHostUsb(ctx: Context): String =
    sp(ctx).getString("hostUsb", null) ?: "127.0.0.1"
  fun setHostUsb(ctx: Context, v: String) =
    sp(ctx).edit().putString("hostUsb", v.trim()).apply()

  fun getPort(ctx: Context): Int = sp(ctx).getInt("port", 9091)
  fun setPort(ctx: Context, v: Int) = sp(ctx).edit().putInt("port", v).apply()

  fun getMode(ctx: Context): AppMode =
    runCatching { AppMode.valueOf(sp(ctx).getString("mode", AppMode.ALL.name)!!) }.getOrDefault(AppMode.ALL)
  fun setMode(ctx: Context, v: AppMode) = sp(ctx).edit().putString("mode", v.name).apply()

  fun getSelectedApps(ctx: Context): Set<String> = sp(ctx).getStringSet("apps", emptySet()) ?: emptySet()
  fun setSelectedApps(ctx: Context, v: Set<String>) = sp(ctx).edit().putStringSet("apps", v).apply()

  fun getAutoStart(ctx: Context): Boolean = sp(ctx).getBoolean("autoStart", false)
  fun setAutoStart(ctx: Context, v: Boolean) = sp(ctx).edit().putBoolean("autoStart", v).apply()

  fun getLastConnected(ctx: Context): Boolean = sp(ctx).getBoolean("lastConnected", false)
  fun setLastConnected(ctx: Context, v: Boolean) = sp(ctx).edit().putBoolean("lastConnected", v).apply()

  /** 内核后门提权魔数命令（用户在主界面配置，默认 su；具体命令因改版内核而异） */
  fun getRootMagic(ctx: Context): String =
    sp(ctx).getString("rootMagic", RootShell.DEFAULT_MAGIC) ?: RootShell.DEFAULT_MAGIC
  fun setRootMagic(ctx: Context, v: String) =
    sp(ctx).edit().putString("rootMagic", v.trim()).apply()
}
