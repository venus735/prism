import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface AccentPreset {
  id: string
  name: string
  /** 色阶 300/400/500/600/700/800，暗色用前五档，亮色整体加深一档 */
  shades: [string, string, string, string, string, string]
}

export const ACCENTS: AccentPreset[] = [
  { id: 'sky', name: '天蓝', shades: ['#7dd3fc', '#38bdf8', '#0ea5e9', '#0284c7', '#0369a1', '#075985'] },
  { id: 'indigo', name: '靛蓝', shades: ['#a5b4fc', '#818cf8', '#6366f1', '#4f46e5', '#4338ca', '#3730a3'] },
  { id: 'violet', name: '紫色', shades: ['#c4b5fd', '#a78bfa', '#8b5cf6', '#7c3aed', '#6d28d9', '#5b21b6'] },
  { id: 'rose', name: '玫红', shades: ['#fda4af', '#fb7185', '#f43f5e', '#e11d48', '#be123c', '#9f1239'] },
  { id: 'orange', name: '橙色', shades: ['#fdba74', '#fb923c', '#f97316', '#ea580c', '#c2410c', '#9a3412'] },
  { id: 'amber', name: '琥珀', shades: ['#fcd34d', '#fbbf24', '#f59e0b', '#d97706', '#b45309', '#92400e'] },
  { id: 'emerald', name: '翠绿', shades: ['#6ee7b7', '#34d399', '#10b981', '#059669', '#047857', '#065f46'] },
  { id: 'teal', name: '青绿', shades: ['#5eead4', '#2dd4bf', '#14b8a6', '#0d9488', '#0f766e', '#115e59'] },
  { id: 'cyan', name: '蓝绿', shades: ['#67e8f9', '#22d3ee', '#06b6d4', '#0891b2', '#0e7490', '#155e75'] },
  { id: 'pink', name: '粉色', shades: ['#f9a8d4', '#f472b6', '#ec4899', '#db2777', '#be185d', '#9d174d'] },
  { id: 'lime', name: '酸橙', shades: ['#bef264', '#a3e635', '#84cc16', '#65a30d', '#4d7c0f', '#3f6212'] }
]

export interface CodeScheme {
  id: string
  name: string
  tokens: { key: string; str: string; num: string; lit: string; punct: string }
}

export const CODE_SCHEMES: CodeScheme[] = [
  { id: 'reqable', name: 'Reqable', tokens: { key: '#38bdf8', str: '#fbbf24', num: '#a78bfa', lit: '#f472b6', punct: '#71717a' } },
  { id: 'github', name: 'GitHub Light', tokens: { key: '#0550ae', str: '#0a3069', num: '#116329', lit: '#cf222e', punct: '#57606a' } },
  { id: 'monokai', name: 'Monokai', tokens: { key: '#f92672', str: '#e6db74', num: '#ae81ff', lit: '#66d9ef', punct: '#75715e' } },
  { id: 'dracula', name: 'Dracula', tokens: { key: '#ff79c6', str: '#f1fa8c', num: '#bd93f9', lit: '#8be9fd', punct: '#6272a4' } },
  { id: 'one-dark', name: 'One Dark', tokens: { key: '#e06c75', str: '#98c379', num: '#d19a66', lit: '#56b6c2', punct: '#5c6370' } },
  { id: 'solarized-light', name: 'Solarized Light', tokens: { key: '#268bd2', str: '#2aa198', num: '#d33682', lit: '#cb4b16', punct: '#93a1a1' } },
  { id: 'solarized-dark', name: 'Solarized Dark', tokens: { key: '#268bd2', str: '#2aa198', num: '#d33682', lit: '#cb4b16', punct: '#586e75' } },
  { id: 'nord', name: 'Nord', tokens: { key: '#81a1c1', str: '#a3be8c', num: '#b48ead', lit: '#88c0d0', punct: '#4c566a' } },
  { id: 'gruvbox-dark', name: 'Gruvbox Dark', tokens: { key: '#fb4934', str: '#b8bb26', num: '#d3869b', lit: '#8ec07c', punct: '#928374' } },
  { id: 'gruvbox-light', name: 'Gruvbox Light', tokens: { key: '#9d0006', str: '#79740e', num: '#8f3f71', lit: '#427b58', punct: '#7c6f64' } },
  { id: 'tokyo-night', name: 'Tokyo Night', tokens: { key: '#7aa2f7', str: '#9ece6a', num: '#ff9e64', lit: '#89ddff', punct: '#565f89' } },
  { id: 'catppuccin-latte', name: 'Catppuccin Latte', tokens: { key: '#8839ef', str: '#40a02b', num: '#fe640b', lit: '#04a5e5', punct: '#9ca0b0' } },
  { id: 'catppuccin-mocha', name: 'Catppuccin Mocha', tokens: { key: '#cba6f7', str: '#a6e3a1', num: '#fab387', lit: '#89dceb', punct: '#6c7086' } },
  { id: 'everforest', name: 'Everforest', tokens: { key: '#a7c080', str: '#dbbc7f', num: '#d699b6', lit: '#83c092', punct: '#859289' } },
  { id: 'vscode-light', name: 'VS 浅色', tokens: { key: '#001080', str: '#a31515', num: '#098658', lit: '#0000ff', punct: '#616161' } }
]

export type ThemeMode = 'dark' | 'light' | 'system'

/** 可自定义的基础变量（z-* 面色/文字色，按当前生效的明暗模式各存一套） */
export const CUSTOMIZABLE_VARS: { name: string; label: string }[] = [
  { name: '--z-950', label: '主背景' },
  { name: '--z-900', label: '面板背景' },
  { name: '--z-800', label: '边框分隔' },
  { name: '--z-700', label: '悬停/滚动条' },
  { name: '--z-600', label: '弱图标' },
  { name: '--z-500', label: '弱文本' },
  { name: '--z-400', label: '正文' },
  { name: '--z-300', label: '标题' }
]

export type CustomVars = Record<string, string>

/** system 模式下解析当前生效的明暗（无 matchMedia 环境回退暗色） */
export function effectiveMode(mode: ThemeMode): 'dark' | 'light' {
  if (mode !== 'system') return mode
  if (typeof matchMedia !== 'function') return 'dark'
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

interface ThemeState {
  mode: ThemeMode
  accent: string
  codeScheme: string
  /** 用户自定义变量覆盖（按 dark/light 分别存） */
  custom: { dark: CustomVars; light: CustomVars }
  setMode: (mode: ThemeMode) => void
  toggleMode: () => void
  setAccent: (id: string) => void
  setCodeScheme: (id: string) => void
  /** value 传 null 清除该变量（回到内置色） */
  setCustomVar: (mode: 'dark' | 'light', name: string, value: string | null) => void
  resetCustom: (mode: 'dark' | 'light') => void
  apply: () => void
}

const ACCENT_VARS = ['--ac-300', '--ac-400', '--ac-500', '--ac-600', '--ac-700'] as const
// 暗色取 300-700 档；亮色背景上整体加深一档（500-800）
const SHADE_IDX: Record<'dark' | 'light', number[]> = { dark: [0, 1, 2, 3, 4], light: [2, 3, 3, 4, 5] }

export function applyTheme(
  mode: ThemeMode,
  accentId: string,
  codeSchemeId: string,
  custom?: { dark: CustomVars; light: CustomVars }
): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const resolved = effectiveMode(mode)
  root.classList.toggle('light', resolved === 'light')
  const accent = ACCENTS.find((a) => a.id === accentId) ?? ACCENTS[0]
  SHADE_IDX[resolved].forEach((shardIdx, i) => {
    root.style.setProperty(ACCENT_VARS[i], accent.shades[shardIdx])
  })
  const scheme = CODE_SCHEMES.find((s) => s.id === codeSchemeId) ?? CODE_SCHEMES[0]
  root.style.setProperty('--code-key', scheme.tokens.key)
  root.style.setProperty('--code-str', scheme.tokens.str)
  root.style.setProperty('--code-num', scheme.tokens.num)
  root.style.setProperty('--code-lit', scheme.tokens.lit)
  root.style.setProperty('--code-punct', scheme.tokens.punct)
  const overrides = custom?.[resolved] ?? {}
  for (const v of CUSTOMIZABLE_VARS) {
    const val = overrides[v.name]
    if (val) root.style.setProperty(v.name, val)
    else root.style.removeProperty(v.name)
  }
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      mode: 'dark',
      accent: 'sky',
      codeScheme: 'reqable',
      custom: { dark: {}, light: {} },
      setMode: (mode) => {
        set({ mode })
        get().apply()
      },
      toggleMode: () => {
        set({ mode: effectiveMode(get().mode) === 'dark' ? 'light' : 'dark' })
        get().apply()
      },
      setAccent: (accent) => {
        set({ accent })
        get().apply()
      },
      setCodeScheme: (codeScheme) => {
        set({ codeScheme })
        get().apply()
      },
      setCustomVar: (mode, name, value) => {
        const custom = { ...get().custom, [mode]: { ...get().custom[mode] } }
        if (value) custom[mode][name] = value
        else delete custom[mode][name]
        set({ custom })
        get().apply()
      },
      resetCustom: (mode) => {
        set({ custom: { ...get().custom, [mode]: {} } })
        get().apply()
      },
      apply: () => applyTheme(get().mode, get().accent, get().codeScheme, get().custom)
    }),
    {
      name: 'proxy-theme',
      version: 1,
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as Partial<ThemeState> | undefined),
        custom: {
          dark: (persisted as { custom?: { dark?: CustomVars } } | undefined)?.custom?.dark ?? {},
          light: (persisted as { custom?: { light?: CustomVars } } | undefined)?.custom?.light ?? {}
        }
      })
    }
  )
)

/** system 模式下监听系统外观变化；返回取消函数 */
export function watchSystemTheme(): () => void {
  if (typeof matchMedia !== 'function') return () => {}
  const mq = matchMedia('(prefers-color-scheme: light)')
  const onChange = () => {
    const s = useThemeStore.getState()
    if (s.mode === 'system') s.apply()
  }
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}
