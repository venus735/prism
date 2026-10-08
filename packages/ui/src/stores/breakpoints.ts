import { create } from 'zustand'
import type { BreakpointEdit, BreakpointHit, BreakpointRule } from '@proxy/shared'
import { call, subscribe } from '../api/client'

interface BreakpointsState {
  hits: BreakpointHit[]
  rules: BreakpointRule[]
  load: () => Promise<void>
  setRules: (rules: BreakpointRule[]) => Promise<void>
  resolve: (flowId: string, phase: 'request' | 'response', edit: BreakpointEdit) => Promise<void>
}

export const useBreakpointsStore = create<BreakpointsState>((set) => ({
  hits: [],
  rules: [],
  load: async () => {
    const r = await call('breakpoints.list')
    set({ hits: r.hits, rules: r.rules })
  },
  setRules: async (rules) => {
    const r = await call('breakpoints.setRules', { rules })
    set({ rules: r.rules })
  },
  resolve: async (flowId, phase, edit) => {
    await call('breakpoints.resolve', { flowId, phase, edit })
    const r = await call('breakpoints.list')
    set({ hits: r.hits })
  }
}))

let started = false

export function startBreakpointStream(): void {
  if (started) return
  started = true
  void useBreakpointsStore.getState().load()
  subscribe<BreakpointHit[]>('breakpoint', (hits) => {
    useBreakpointsStore.setState({ hits })
  })
}
