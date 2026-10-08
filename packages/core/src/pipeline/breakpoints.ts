import type {
  BreakpointEdit,
  BreakpointHit,
  BreakpointPhase,
  BreakpointRule
} from '@proxy/shared'

interface PendingGate {
  hit: BreakpointHit
  resolve: (edit: BreakpointEdit) => void
}

export class BreakpointManager {
  private rules: BreakpointRule[] = []
  private pending = new Map<string, PendingGate>()
  private listeners = new Set<(hits: BreakpointHit[]) => void>()

  setRules(rules: BreakpointRule[]): void {
    this.rules = rules
  }

  getRules(): BreakpointRule[] {
    return this.rules
  }

  onHit(listener: (hits: BreakpointHit[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  shouldBreak(
    input: { host?: string; path?: string; method?: string },
    phase: BreakpointPhase
  ): boolean {
    for (const rule of this.rules) {
      if (!rule.enabled) continue
      if (rule.phase !== 'both' && rule.phase !== phase) continue
      if (!hostMatches(rule.host, input.host ?? '')) continue
      if (rule.path && !(input.path ?? '').includes(rule.path)) continue
      if (rule.method && rule.method.toUpperCase() !== (input.method ?? '').toUpperCase()) continue
      return true
    }
    return false
  }

  gate(hit: BreakpointHit): Promise<BreakpointEdit> {
    return new Promise((resolve) => {
      this.pending.set(hit.flowId, { hit, resolve })
      this.notify()
    })
  }

  resolve(flowId: string, edit: BreakpointEdit): boolean {
    const gate = this.pending.get(flowId)
    if (!gate) return false
    this.pending.delete(flowId)
    this.notify()
    gate.resolve(edit)
    return true
  }

  listHits(): BreakpointHit[] {
    return [...this.pending.values()].map((g) => g.hit)
  }

  abortAll(): void {
    for (const [, gate] of this.pending) {
      gate.resolve({ action: 'abort' })
    }
    this.pending.clear()
    this.notify()
  }

  private notify(): void {
    const hits = this.listHits()
    for (const l of this.listeners) l(hits)
  }
}

export function hostMatches(pattern: string, host: string): boolean {
  const p = pattern.trim().toLowerCase()
  const h = host.toLowerCase()
  if (!p || p === '*') return true
  if (p.startsWith('*.')) {
    const suffix = p.slice(1) // ".example.com"
    return h === p.slice(2) || h.endsWith(suffix)
  }
  return h === p
}
