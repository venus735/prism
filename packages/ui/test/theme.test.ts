import { beforeAll, describe, expect, it } from 'vitest'

let mod: typeof import('../src/stores/theme')
let json: typeof import('../src/components/JsonView')

beforeAll(async () => {
  mod = await import('../src/stores/theme')
  json = await import('../src/components/JsonView')
})

interface FakeSpan {
  props: { className: string; children: string }
}

function spansOf(nodes: unknown[]): FakeSpan[] {
  return nodes.filter(
    (n): n is FakeSpan => typeof n === 'object' && n !== null && 'props' in (n as object)
  ) as FakeSpan[]
}

describe('主题 store', () => {
  it('提供 11 种强调色与 15 种代码配色，id 唯一且颜色合法', () => {
    expect(mod.ACCENTS).toHaveLength(11)
    expect(new Set(mod.ACCENTS.map((a) => a.id)).size).toBe(11)
    for (const a of mod.ACCENTS) {
      expect(a.shades).toHaveLength(6)
      for (const c of a.shades) expect(c).toMatch(/^#[0-9a-f]{6}$/i)
    }
    expect(mod.CODE_SCHEMES).toHaveLength(15)
    expect(new Set(mod.CODE_SCHEMES.map((s) => s.id)).size).toBe(15)
    for (const s of mod.CODE_SCHEMES) {
      for (const v of Object.values(s.tokens)) expect(v).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('切换主题/强调色/代码配色更新状态并可回退默认', () => {
    const st = mod.useThemeStore
    st.getState().setMode('light')
    expect(st.getState().mode).toBe('light')
    st.getState().toggleMode()
    expect(st.getState().mode).toBe('dark')
    st.getState().setAccent('violet')
    expect(st.getState().accent).toBe('violet')
    st.getState().setCodeScheme('monokai')
    expect(st.getState().codeScheme).toBe('monokai')
    st.getState().setAccent('sky')
    st.getState().setCodeScheme('reqable')
    expect(st.getState().accent).toBe('sky')
    expect(st.getState().codeScheme).toBe('reqable')
  })

  it('system 模式解析生效明暗，显式模式原样返回', () => {
    expect(mod.effectiveMode('dark')).toBe('dark')
    expect(mod.effectiveMode('light')).toBe('light')
    expect(['dark', 'light']).toContain(mod.effectiveMode('system'))
  })

  it('system 模式下 toggleMode 切到显式模式', () => {
    const st = mod.useThemeStore
    st.getState().setMode('system')
    st.getState().toggleMode()
    expect(st.getState().mode).toBe(mod.effectiveMode('dark') === 'dark' ? 'light' : 'dark')
    st.getState().setMode('dark')
    expect(st.getState().mode).toBe('dark')
  })

  it('applyTheme 在无 DOM 环境是安全空操作', () => {
    expect(() => mod.applyTheme('light', 'violet', 'nord')).not.toThrow()
    expect(() => mod.useThemeStore.getState().apply()).not.toThrow()
  })
})

describe('jsonNodes 词法着色', () => {
  it('键/字符串/数字/字面量/标点分类正确', () => {
    const nodes = json.jsonNodes('{"a": "b", "n": 1.5, "ok": true, "x": null}')
    const byClass: Record<string, string> = {}
    for (const s of spansOf(nodes)) {
      byClass[s.props.className] = (byClass[s.props.className] ?? '') + s.props.children
    }
    expect(byClass['tj-key']).toContain('"a"')
    expect(byClass['tj-str']).toContain('"b"')
    expect(byClass['tj-num']).toBe('1.5')
    expect(byClass['tj-lit']).toContain('true')
    expect(byClass['tj-lit']).toContain('null')
    expect(byClass['tj-punct']).toContain('{')
  })

  it('值中带冒号的字符串不会被误判为键', () => {
    const nodes = json.jsonNodes('{"a": "b:"}')
    const str = spansOf(nodes)
      .filter((s) => s.props.className === 'tj-str')
      .map((s) => s.props.children)
      .join('')
    expect(str).toBe('"b:"')
    const keys = spansOf(nodes)
      .filter((s) => s.props.className === 'tj-key')
      .map((s) => s.props.children)
      .join('')
    expect(keys).toContain('"a"')
  })
})
