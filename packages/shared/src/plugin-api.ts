import type { HeaderPair } from './flow'

export interface PluginRequestCtx {
  flowId: string
  method: string
  url: string
  headers: HeaderPair[]
  bodyBase64: string
  /** 写入插件日志面板 */
  log?: (message: string) => void
}

export interface PluginResponseCtx extends PluginRequestCtx {
  status: number
  statusText: string
  respHeaders: HeaderPair[]
  respBodyBase64: string
}

export interface PluginEdit {
  request?: {
    method?: string
    url?: string
    headers?: HeaderPair[]
    bodyBase64?: string
  }
  response?: {
    status?: number
    statusText?: string
    headers?: HeaderPair[]
    bodyBase64?: string
  }
  /** 短路：直接返回该响应，不转发上游（仅 onRequest 有效） */
  respond?: {
    status: number
    statusText?: string
    headers: HeaderPair[]
    bodyBase64: string
  }
}

export type PluginType = 'js' | 'python'

export interface PluginStatus {
  name: string
  type: PluginType
  enabled: boolean
  /** ok | error | disabled-by-strikes | missing-python */
  status: 'ok' | 'error' | 'disabled-by-strikes' | 'missing-python'
  errors: number
  lastError?: string
}

export interface PluginLogLine {
  plugin: string
  message: string
  at: number
}
