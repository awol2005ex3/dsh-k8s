import type { KubeObject } from '../types.js'
import type { DescribeContext } from '../types.js'

/** 从 namespace LimitRange 汇总出的容器默认 request / limit。 */
export interface ContainerDefaults {
  readonly request: Record<string, string>
  readonly limit: Record<string, string>
}

const EMPTY_DEFAULTS: ContainerDefaults = { request: {}, limit: {} }

/** 只关心这几类资源；容器里额外声明的 key 仍会原样输出。 */
const RES_KEYS = ['cpu', 'memory', 'ephemeral-storage']

/**
 * 把 namespace 的若干 LimitRange 汇总成 Container 类型的默认 request / limit。
 * K8s 校验要求 default/defaultRequest 在同 namespace 内唯一，这里按首次出现为准。
 */
export function limitRangeDefaults(ranges: readonly KubeObject[]): ContainerDefaults {
  const request: Record<string, string> = {}
  const limit: Record<string, string> = {}
  for (const range of ranges) {
    for (const l of range.spec?.limits ?? []) {
      if (l.type !== 'Container') continue
      for (const [k, v] of Object.entries(l.defaultRequest ?? {})) {
        if (request[k] === undefined) request[k] = String(v)
      }
      for (const [k, v] of Object.entries(l.default ?? {})) {
        if (limit[k] === undefined) limit[k] = String(v)
      }
    }
  }
  return { request, limit }
}

/**
 * 读取 pod/workload 所在命名空间的 LimitRange 并汇总默认配额。
 * 读取失败（无权限、无 LimitRange 等）时返回空表，绝不影响 describe 主流程。
 */
export async function fetchContainerDefaults(
  ctx?: DescribeContext,
): Promise<ContainerDefaults> {
  if (!ctx?.namespace) return EMPTY_DEFAULTS
  try {
    const list = await ctx.clients.core.listNamespacedLimitRange({ namespace: ctx.namespace })
    return limitRangeDefaults((list.items ?? []) as KubeObject[])
  } catch {
    return EMPTY_DEFAULTS
  }
}

/**
 * 把某一类（requests 或 limits）压成一行；容器未显式声明时用 LimitRange 默认补齐，
 * 补齐的值带 `*` 标记。返回空串表示该类完全没有可显示的值。
 */
function resLine(
  resources: KubeObject | undefined,
  defaults: Record<string, string>,
  label: 'requests' | 'limits',
): { text: string; usedDefault: boolean } {
  const explicit = (resources?.[label] ?? {}) as Record<string, string>
  const keys = [...new Set([...RES_KEYS, ...Object.keys(explicit)])]
  const parts: string[] = []
  let usedDefault = false
  for (const k of keys) {
    const value = explicit[k]
    if (value !== undefined) {
      parts.push(`${k}=${value}`)
      continue
    }
    const dflt = defaults[k]
    if (dflt !== undefined) {
      parts.push(`${k}=${dflt}*`)
      usedDefault = true
    }
  }
  return { text: parts.length > 0 ? `${label}: ${parts.join(', ')}` : '', usedDefault }
}

/**
 * 输出一组容器的资源配额块（requests/limits），未设置处用 LimitRange 默认值补齐并标记。
 * 返回的行已带缩进，可直接嵌进 describe 结果。
 */
export function containerResourceLines(
  containers: readonly KubeObject[],
  defaults: ContainerDefaults,
): string[] {
  if (containers.length === 0) return []
  const lines: string[] = []
  let usedDefault = false
  for (const c of containers) {
    if (!c?.name) continue
    lines.push(`  - ${c.name}`)
    const req = resLine(c.resources, defaults.request, 'requests')
    const lim = resLine(c.resources, defaults.limit, 'limits')
    usedDefault = usedDefault || req.usedDefault || lim.usedDefault
    if (req.text) lines.push(`    ${req.text}`)
    if (lim.text) lines.push(`    ${lim.text}`)
  }
  if (lines.length === 0) return []
  if (usedDefault) lines.push('    (* 来自 namespace LimitRange 默认值)')
  return lines
}
