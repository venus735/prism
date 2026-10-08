import type { HeaderPair } from './flow'

/** 收藏夹条目：请求/响应快照，独立于 flow 生命周期（retention 删除后仍可用） */
export interface CollectionItem {
  id: string
  name: string
  group: string
  /** 所在工作台收藏文件夹（null/undefined = 我的收藏根级） */
  folderId?: string | null
  createdAt: number
  request: {
    method: string
    url: string
    headers: HeaderPair[]
    bodyBase64: string
  }
  response?: {
    status: number
    statusText: string
    headers: HeaderPair[]
    bodyBase64: string
  }
}
