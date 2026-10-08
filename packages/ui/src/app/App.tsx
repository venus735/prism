import TrafficPage from '../pages/traffic/TrafficPage'
import StatsPage from '../pages/stats/StatsPage'
import SettingsPage from '../pages/settings/SettingsPage'
import BreakpointsPage from '../pages/breakpoints/BreakpointsPage'
import ComposerPage from '../pages/composer/ComposerPage'
import RulesPage from '../pages/rules/RulesPage'
import PluginsPage from '../pages/plugins/PluginsPage'
import CollectionsPage from '../pages/collections/CollectionsPage'
import ToolboxPage from '../pages/toolbox/ToolboxPage'
import { useUiStore } from '../stores/ui'
import { useBreakpointsStore } from '../stores/breakpoints'
import { TopStatusBar, BottomStatusBar } from './StatusBar'

const NAV = [
  { id: 'traffic', icon: '≡', label: '流量' },
  { id: 'stats', icon: '◔', label: '统计' },
  { id: 'breakpoints', icon: '⏸', label: '断点' },
  { id: 'composer', icon: '✎', label: 'Composer' },
  { id: 'collections', icon: '★', label: '收藏夹' },
  { id: 'rules', icon: '⚡', label: '规则' },
  { id: 'plugins', icon: '⬢', label: '插件' },
  { id: 'toolbox', icon: '⚒', label: '工具箱' },
  { id: 'settings', icon: '⚙', label: '设置' }
] as const

export default function App() {
  const page = useUiStore((s) => s.page)
  const setPage = useUiStore((s) => s.setPage)
  const hitCount = useBreakpointsStore((s) => s.hits.length)

  return (
    <div className="flex h-full flex-col">
      <TopStatusBar />
      <div className="flex flex-1 overflow-hidden">
        <nav className="w-14 flex flex-col items-center gap-1 bg-zinc-900 border-r border-zinc-800 py-3">
          {NAV.map((item) => (
            <button
              key={item.id}
              title={item.label}
              onClick={() => setPage(item.id)}
              className={`relative w-10 h-10 rounded-lg text-lg flex items-center justify-center transition-colors ${
                page === item.id
                  ? 'bg-sky-600/20 text-sky-400'
                  : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'
              }`}
            >
              {item.icon}
              {item.id === 'breakpoints' && hitCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-0.5 rounded-full bg-amber-500 text-black text-[10px] font-bold flex items-center justify-center">
                  {hitCount}
                </span>
              )}
            </button>
          ))}
        </nav>
        <main className="flex-1 overflow-hidden">
          {page === 'traffic' && <TrafficPage />}
          {page === 'stats' && <StatsPage />}
          {page === 'breakpoints' && <BreakpointsPage />}
          {page === 'composer' && <ComposerPage />}
          {page === 'collections' && <CollectionsPage />}
          {page === 'rules' && <RulesPage />}
          {page === 'settings' && <SettingsPage />}
          {page === 'plugins' && <PluginsPage />}
          {page === 'toolbox' && <ToolboxPage />}
        </main>
      </div>
      <BottomStatusBar />
    </div>
  )
}
