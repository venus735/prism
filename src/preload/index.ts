import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { IpcChannel, IpcContract } from '@proxy/shared'

type Listener = (payload: unknown) => void

const invoke = (channel: IpcChannel, payload?: unknown): Promise<unknown> =>
  ipcRenderer.invoke(channel, payload)

const on = (channel: string, listener: Listener): (() => void) => {
  const wrapped = (_e: IpcRendererEvent, payload: unknown): void => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api = {
  invoke,
  on
}

export type Api = typeof api

try {
  contextBridge.exposeInMainWorld('api', api)
} catch {
  // non-context-isolation fallback for tests
}

export {}
