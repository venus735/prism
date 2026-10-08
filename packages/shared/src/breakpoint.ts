import type { HeaderPair } from './flow'

export type BreakpointPhase = 'request' | 'response'

export interface BreakpointRule {
  id: string
  enabled: boolean
  /** 空或 `example.com` 精确匹配；`*.example.com` 匹配子域；`*` 任意 */
  host: string
  /** 路径子串匹配，空 = 任意 */
  path: string
  /** 空 = 任意 method */
  method: string
  phase: BreakpointPhase | 'both'
}

export interface BreakpointRequestSnapshot {
  method: string
  url: string
  headers: HeaderPair[]
  bodyBase64: string
}

export interface BreakpointResponseSnapshot {
  status: number
  statusText: string
  headers: HeaderPair[]
  bodyBase64: string
}

export interface BreakpointHit {
  flowId: string
  seq: number
  phase: BreakpointPhase
  host?: string
  method?: string
  url?: string
  status?: number
  request?: BreakpointRequestSnapshot
  response?: BreakpointResponseSnapshot
  hitAt: number
}

export interface BreakpointEdit {
  action: 'continue' | 'abort'
  /** request 阶段可选修改 */
  request?: {
    method: string
    url: string
    headers: HeaderPair[]
    bodyBase64: string
  }
  /** response 阶段可选修改 */
  response?: {
    status: number
    statusText: string
    headers: HeaderPair[]
    bodyBase64: string
  }
}

export interface ComposerSpec {
  method: string
  url: string
  headers: HeaderPair[]
  bodyBase64: string
}
