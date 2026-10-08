import { create } from 'zustand'
import type { Rule } from '@proxy/shared'
import { call } from '../api/client'

interface RulesState {
  rules: Rule[]
  /** 每条规则自保存起的累计命中数 */
  matchCounts: Record<string, number>
  load: () => Promise<void>
  setRules: (rules: Rule[]) => Promise<void>
  /** 编辑中的规则在最近流量里的命中预览（防抖由调用方负责） */
  matchPreview: (rule: Rule) => Promise<number>
}

export const useRulesStore = create<RulesState>((set) => ({
  rules: [],
  matchCounts: {},
  load: async () => {
    const r = await call('rules.list')
    set({ rules: r.rules, matchCounts: r.matchCounts ?? {} })
  },
  setRules: async (rules) => {
    const r = await call('rules.set', { rules })
    set({ rules: r.rules })
  },
  matchPreview: async (rule) => {
    try {
      const r = await call('rules.matchPreview', { rule })
      return r.count
    } catch {
      return -1
    }
  }
}))
