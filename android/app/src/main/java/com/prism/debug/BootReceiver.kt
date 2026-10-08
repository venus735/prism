package com.prism.debug

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
    // 系统证书是 tmpfs 挂载，不随重启持久，开机先重放
    if (RootCertInstaller.isInstalled(context)) {
      RootCertInstaller.remountAfterBoot(context)
    }
    if (!Prefs.getAutoStart(context) || !Prefs.getLastConnected(context)) return
    ContextCompat.startForegroundService(
      context,
      Intent(context, TunnelVpnService::class.java).setAction(TunnelVpnService.ACTION_START)
    )
  }
}
