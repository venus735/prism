package com.prism.debug

import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.Drawable
import android.os.Bundle
import android.view.LayoutInflater
import android.view.ViewGroup
import android.widget.CompoundButton
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.LinearLayoutManager
import com.prism.debug.databinding.ActivityAppListBinding
import com.prism.debug.databinding.ItemAppBinding
import kotlin.concurrent.thread

class AppListActivity : AppCompatActivity() {

  private lateinit var binding: ActivityAppListBinding
  private val selected = mutableSetOf<String>()
  private var adapter: AppAdapter? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    binding = ActivityAppListBinding.inflate(layoutInflater)
    setContentView(binding.root)

    selected.addAll(Prefs.getSelectedApps(this))

    when (Prefs.getMode(this)) {
      AppMode.ALL -> binding.modeAll.isChecked = true
      AppMode.INCLUDE -> binding.modeInclude.isChecked = true
      AppMode.EXCLUDE -> binding.modeExclude.isChecked = true
    }
    listOf(
      binding.modeAll to AppMode.ALL,
      binding.modeInclude to AppMode.INCLUDE,
      binding.modeExclude to AppMode.EXCLUDE
    ).forEach { (btn, mode) ->
      btn.setOnCheckedChangeListener { _, checked ->
        if (checked) {
          Prefs.setMode(this, mode)
          updateHint()
        }
      }
    }
    updateHint()

    thread { loadApps() }
  }

  private fun updateHint() {
    binding.hintText.text = when (Prefs.getMode(this)) {
      AppMode.ALL -> "整机流量都经 Mac 代理转发"
      AppMode.INCLUDE -> "仅勾选的应用走代理（本应用自身始终直连）"
      AppMode.EXCLUDE -> "勾选的应用直连，其余走代理"
    }
  }

  private fun loadApps() {
    val pm = packageManager
    val entries = pm.getInstalledApplications(0)
      .filter { pm.getLaunchIntentForPackage(it.packageName) != null }
      .filter { it.packageName != packageName }
      .map { AppEntry(it.packageName, it.loadLabel(pm).toString(), it.loadIcon(pm)) }
      .sortedWith(compareByDescending<AppEntry> { it.pkg in selected }.thenBy { it.label.lowercase() })

    runOnUiThread {
      adapter = AppAdapter(entries, selected) { pkg, checked ->
        if (checked) selected.add(pkg) else selected.remove(pkg)
        Prefs.setSelectedApps(this, selected.toSet())
      }
      binding.appList.layoutManager = LinearLayoutManager(this)
      binding.appList.adapter = adapter
    }
  }

  private data class AppEntry(val pkg: String, val label: String, val icon: Drawable)

  private class AppAdapter(
    private val entries: List<AppEntry>,
    private val selected: Set<String>,
    private val onToggle: (String, Boolean) -> Unit
  ) : androidx.recyclerview.widget.RecyclerView.Adapter<AppAdapter.VH>() {

    class VH(val b: ItemAppBinding) : androidx.recyclerview.widget.RecyclerView.ViewHolder(b.root)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH =
      VH(ItemAppBinding.inflate(LayoutInflater.from(parent.context), parent, false))

    override fun getItemCount(): Int = entries.size

    override fun onBindViewHolder(holder: VH, position: Int) {
      val e = entries[position]
      holder.b.icon.setImageDrawable(e.icon)
      holder.b.label.text = e.label
      holder.b.pkg.text = e.pkg
      val listener = CompoundButton.OnCheckedChangeListener { _, checked -> onToggle(e.pkg, checked) }
      holder.b.check.setOnCheckedChangeListener(null)
      holder.b.check.isChecked = e.pkg in selected
      holder.b.check.setOnCheckedChangeListener(listener)
      holder.b.root.setOnClickListener { holder.b.check.toggle() }
    }
  }
}
