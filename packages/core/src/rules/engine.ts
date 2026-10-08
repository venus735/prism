import type { HeaderPair, HeaderRuleOp, Rule } from '@proxy/shared'

export interface MatchInput {
  host: string
  path: string
  method: string
  url: string
}

let regexCache = new Map<string, RegExp | null>()

export function ruleMatches(rule: Rule, input: MatchInput): boolean {
  if (!rule.enabled) return false
  const m = rule.match
  if (!hostMatchesPattern(m.host, input.host)) return false
  if (m.path && !input.path.includes(m.path)) return false
  if (m.method && m.method.toUpperCase() !== input.method.toUpperCase()) return false
  if (m.urlRegex) {
    const re = compileRegex(m.urlRegex)
    if (!re || !re.test(input.url)) return false
  }
  return true
}

export function firstMatchingRule(rules: Rule[], input: MatchInput, types: string[]): Rule | null {
  for (const rule of rules) {
    if (!types.includes(rule.action.type)) continue
    if (ruleMatches(rule, input)) return rule
  }
  return null
}

function compileRegex(source: string): RegExp | null {
  if (!regexCache.has(source)) {
    try {
      regexCache.set(source, new RegExp(source))
    } catch {
      regexCache.set(source, null)
    }
  }
  return regexCache.get(source) ?? null
}

function hostMatchesPattern(pattern: string, host: string): boolean {
  const p = pattern.trim().toLowerCase()
  const h = host.toLowerCase()
  if (!p || p === '*') return true
  if (p.startsWith('*.')) {
    return h === p.slice(2) || h.endsWith(p.slice(1))
  }
  return h === p
}

export function applyHeaderOps(headers: HeaderPair[], ops: HeaderRuleOp[]): HeaderPair[] {
  const out = [...headers]
  for (const op of ops) {
    const name = op.name
    if (op.op === 'remove') {
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].name.toLowerCase() === name.toLowerCase()) out.splice(i, 1)
      }
    } else {
      const pair = { name, value: op.value ?? '' }
      const idx = out.findIndex((h) => h.name.toLowerCase() === name.toLowerCase())
      if (idx >= 0) out[idx] = pair
      else out.push(pair)
    }
  }
  return out
}

export function resetRuleEngineCaches(): void {
  regexCache = new Map()
}
