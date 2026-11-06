import type { V1ObjectMeta } from '@kubernetes/client-node'

/** 资源对象的公共形状（够用即可，避免依赖完整 model 类型）。 */
export interface KubeResource {
  metadata?: V1ObjectMeta
  [key: string]: unknown
}

/** 从资源里取名称 / 命名空间 / 创建时间，统一兜底。 */
export function meta(row: KubeResource): { name: string; namespace: string; created: string } {
  const raw = row.metadata?.creationTimestamp
  // creationTimestamp 在客户端模型里是 Date；统一成 ISO，避免渲染出本地化长串。
  const created = raw instanceof Date ? raw.toISOString().replace(/\.\d{3}Z$/, 'Z') : ''
  return {
    name: row.metadata?.name ?? '',
    namespace: row.metadata?.namespace ?? '',
    created,
  }
}

/** 判断数组型工具输出渲染，避免各工具重复写模板字符串。 */
export function renderList(rows: string[], empty: string): { type: 'text'; text: string } {
  return { type: 'text', text: rows.length === 0 ? empty : rows.join('\n') }
}
