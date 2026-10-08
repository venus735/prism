import type { CollectionItem } from './collection'

export type WbScope = 'favorite' | 'bookmark'

/** 工作台侧栏树节点：folder 为文件夹；bookmark 为保存的过滤条件（点击应用到流量列表） */
export interface WbNode {
  id: string
  scope: WbScope
  kind: 'folder' | 'bookmark'
  parentId: string | null
  name: string
  /** bookmark 专用：流量列表过滤表达式 */
  filter?: string
  createdAt: number
}

export type WorkbenchCollections = CollectionItem[]
