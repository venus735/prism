import type { HeaderPair } from './flow'

export type RulePhase = 'request' | 'response'

export interface RuleMatch {
  /** 空 = 任意；`example.com` 精确；`*.example.com` 子域；`*` 任意 */
  host: string
  /** 路径子串，空 = 任意 */
  path: string
  /** 空 = 任意 method */
  method: string
  /** 正则（对完整 URL），可选 */
  urlRegex?: string
}

export interface HeaderRuleOp {
  /** set：设置/替换；remove：删除 */
  op: 'set' | 'remove'
  name: string
  value?: string
}

/** body 文本搜索替换（先解压再替换，替换后以 identity 返回） */
export interface BodyReplace {
  search: string
  replace: string
  /** true 时 search 按正则（全局）解析 */
  regex?: boolean
}

export type RuleAction =
  | { type: 'mock'; status: number; headers: HeaderPair[]; bodyBase64: string }
  | { type: 'block' }
  | { type: 'hold' }
  /** 本地文件映射：命中后返回 path 指向的文件内容（Content-Type 按扩展名推断） */
  | { type: 'map-local'; path: string }
  | {
      type: 'rewrite-request'
      urlReplace?: string
      headerOps: HeaderRuleOp[]
      bodyBase64?: string
      replaces?: BodyReplace[]
    }
  | {
      type: 'rewrite-response'
      status?: number
      headerOps: HeaderRuleOp[]
      bodyBase64?: string
      replaces?: BodyReplace[]
    }
  /**
   * 弱网/限速：kbps 限制响应带宽；latencyMs 转发前附加延迟；
   * lossPercent 概率随机丢包（模拟断流）。
   */
  | { type: 'throttle'; kbps: number; latencyMs?: number; lossPercent?: number }
  | { type: 'bypass-tls' }

export interface Rule {
  id: string
  name: string
  enabled: boolean
  match: RuleMatch
  action: RuleAction
}
