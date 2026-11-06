import type { DescribeContext, KubeClients, KubeObject } from '../types.js'

/** 资源的作用域：集群级资源忽略 namespace 参数。 */
export type ResourceScope = 'Namespaced' | 'Cluster'

/**
 * 一个可被 `k8s_list_resources` / `k8s_get_resource` 查看的资源类型。
 * 各领域模块只负责声明自己的条目，`index.ts` 负责汇总。
 */
export interface ResourceDef {
  readonly scope: ResourceScope
  /** 列表；namespace 为 undefined 时表示所有命名空间（集群级资源忽略）。 */
  list(clients: KubeClients, namespace: string | undefined): Promise<unknown[]>
  /** 读取单个对象；命名空间资源使用 namespace，集群级资源传空串。 */
  get(clients: KubeClients, namespace: string, name: string): Promise<unknown>
  /** 列表里的一行摘要；缺省只显示元信息。 */
  summary?(item: KubeObject): string
  /** 单资源详情；缺省使用通用 spec/status JSON 兜底。ctx 用于补充 namespace 默认配额。 */
  describe?(item: KubeObject, ctx?: DescribeContext): string[] | Promise<string[]>
}

/** kind（kubectl 风格复数）→ 资源定义。 */
export type ResourceRegistry = Record<string, ResourceDef>

/** 各 API 的 list 返回统一取 items。 */
export async function itemsOf(promise: Promise<{ items?: unknown[] }>): Promise<unknown[]> {
  return (await promise).items ?? []
}
