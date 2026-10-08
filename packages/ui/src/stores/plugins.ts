import { create } from 'zustand'
import type { PluginLogLine, PluginStatus } from '@proxy/shared'
import { call, subscribe } from '../api/client'

const MAX_LOGS = 500

interface PluginsState {
  plugins: PluginStatus[]
  logs: PluginLogLine[]
  load: () => Promise<void>
  setEnabled: (name: string, enabled: boolean) => Promise<void>
  reload: () => Promise<void>
  create: (name: string, type: 'js' | 'python') => Promise<void>
  openDir: () => Promise<void>
  appendLog: (line: PluginLogLine) => void
}

export const usePluginsStore = create<PluginsState>((set) => ({
  plugins: [],
  logs: [],
  load: async () => {
    const r = await call('plugins.list')
    const l = await call('plugins.logs')
    set({ plugins: r.plugins, logs: l.logs.slice(-MAX_LOGS) })
  },
  setEnabled: async (name, enabled) => {
    const r = await call('plugins.setEnabled', { name, enabled })
    set({ plugins: r.plugins })
  },
  reload: async () => {
    const r = await call('plugins.reload')
    set({ plugins: r.plugins })
  },
  create: async (name, type) => {
    const r = await call('plugins.create', { name, type })
    set({ plugins: r.plugins })
  },
  openDir: async () => {
    await call('plugins.openDir')
  },
  appendLog: (line) => {
    set((s) => ({ logs: [...s.logs.slice(-(MAX_LOGS - 1)), line] }))
  }
}))

let started = false

export function startPluginLogStream(): void {
  if (started) return
  started = true
  void usePluginsStore.getState().load()
  subscribe<PluginLogLine>('plugin-log', (line) => {
    usePluginsStore.getState().appendLog(line)
  })
}
