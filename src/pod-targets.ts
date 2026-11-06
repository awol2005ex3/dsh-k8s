import type { KubeClients } from './types.js'

/** K8s 资源对象的松散形状（只取用到的字段，避免与 model 类型耦合）。 */
export type Op = Record<string, any>

/** 任意值转字符串，undefined / null 归一为空串。 */
export function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

/** 把 LabelSelector（matchLabels + matchExpressions）转成 API 的 selector 字符串。 */
export function selectorString(selector: Op | undefined): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(selector?.matchLabels ?? {})) {
    parts.push(`${key}=${value}`)
  }
  for (const expr of selector?.matchExpressions ?? []) {
    const values = (expr.values ?? []).join(',')
    switch (expr.operator) {
      case 'In': parts.push(`${expr.key} in (${values})`); break
      case 'NotIn': parts.push(`${expr.key} notin (${values})`); break
      case 'Exists': parts.push(text(expr.key)); break
      case 'DoesNotExist': parts.push(`!${text(expr.key)}`); break
    }
  }
  return parts.join(',')
}

/** 根据工作负载类型取 spec.selector；与 kubectl logs -l 的语义一致。 */
export async function selectorOfWorkload(
  clients: KubeClients,
  kind: string,
  name: string,
  namespace: string,
): Promise<string> {
  const k = kind.toLowerCase()
  switch (k) {
    case 'deployment':
    case 'deploy': {
      const obj = await clients.apps.readNamespacedDeployment({ name, namespace }) as unknown as Op
      return selectorString(obj.spec?.selector)
    }
    case 'statefulset':
    case 'sts': {
      const obj = await clients.apps.readNamespacedStatefulSet({ name, namespace }) as unknown as Op
      return selectorString(obj.spec?.selector)
    }
    case 'daemonset':
    case 'ds': {
      const obj = await clients.apps.readNamespacedDaemonSet({ name, namespace }) as unknown as Op
      return selectorString(obj.spec?.selector)
    }
    case 'replicaset':
    case 'rs': {
      const obj = await clients.apps.readNamespacedReplicaSet({ name, namespace }) as unknown as Op
      return selectorString(obj.spec?.selector)
    }
    case 'job': {
      const obj = await clients.batch.readNamespacedJob({ name, namespace }) as unknown as Op
      return selectorString(obj.spec?.selector)
    }
    default:
      throw new Error(`不支持的工作负载类型 "${kind}"，可用：deployment, statefulset, daemonset, replicaset, job`)
  }
}

/** 按顺序分批并发，避免大集群一次打满 API Server。 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  const size = Math.max(1, limit)
  for (let i = 0; i < items.length; i += size) {
    results.push(...await Promise.all(items.slice(i, i + size).map(fn)))
  }
  return results
}

export interface ResolvePodsOptions {
  /** 命名空间；allNamespaces 未设置时缺省 default。 */
  namespace?: string
  /** 读取所有命名空间的 Pod（与 kubectl -A 一致）。 */
  allNamespaces?: boolean
  /** 标签选择器，例如 app=api,tier=backend。 */
  labelSelector?: string
  /** 工作负载类型，与 name 一起使用。 */
  kind?: string
  /** 工作负载名称。 */
  name?: string
  /** 用正则再过滤 Pod 名（在 selector 之后生效）。 */
  podNameRegex?: string
  /** 是否包含已 Succeeded 的 Pod（默认排除，避免读到历史 Job）。 */
  includeCompleted?: boolean
  /** 最多返回多少个 Pod。 */
  maxPods: number
}

export interface ResolvedPods {
  pods: Op[]
  /** 过滤后（截断前）的 Pod 总数。 */
  total: number
  truncated: boolean
}

/**
 * 统一解析「要搜索哪些 Pod」：命名空间 / 全命名空间、labelSelector、工作负载、
 * Pod 名正则四种方式，前缀过滤语义与 kubectl 一致。
 */
export async function resolvePods(clients: KubeClients, opts: ResolvePodsOptions): Promise<ResolvedPods> {
  let selector = (opts.labelSelector ?? '').trim()
  if (!selector && opts.kind) {
    if (!opts.name) throw new Error('提供 kind 时必须同时提供 name（或改用 labelSelector）。')
    selector = await selectorOfWorkload(clients, opts.kind, opts.name, opts.namespace ?? 'default')
    if (!selector) throw new Error(`${opts.kind}/${opts.name} 的 spec.selector 为空，无法定位 Pod。`)
  }

  let pods: Op[]
  if (opts.allNamespaces) {
    const res = await clients.core.listPodForAllNamespaces({
      labelSelector: selector || undefined,
    }) as unknown as Op
    pods = res.items ?? []
  } else {
    const res = await clients.core.listNamespacedPod({
      namespace: opts.namespace ?? 'default',
      labelSelector: selector || undefined,
    }) as unknown as Op
    pods = res.items ?? []
  }

  let regex: RegExp | undefined
  if (opts.podNameRegex) {
    try {
      regex = new RegExp(opts.podNameRegex)
    } catch (error) {
      throw new Error(`podNameRegex 不是合法正则：${(error as Error).message}`)
    }
  }

  const filtered = pods
    .filter((pod) => opts.includeCompleted || pod.status?.phase !== 'Succeeded')
    .filter((pod) => !regex || regex.test(text(pod.metadata?.name)))
    .sort((a, b) => {
      const na = text(a.metadata?.namespace)
      const nb = text(b.metadata?.namespace)
      return na.localeCompare(nb) || text(a.metadata?.name).localeCompare(text(b.metadata?.name))
    })

  const total = filtered.length
  const truncated = total > opts.maxPods
  return { pods: truncated ? filtered.slice(0, opts.maxPods) : filtered, total, truncated }
}

/** 取 Pod 里声明过的容器名（不含 initContainers）。 */
export function containerNames(pod: Op): string[] {
  return (pod.spec?.containers ?? [])
    .map((c: Op) => text(c.name))
    .filter((name: string) => name.length > 0)
}