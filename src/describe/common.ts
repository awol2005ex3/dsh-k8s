import type { KubeObject } from '../types.js'

/** 值转字符串，空值统一成空串，便于 row() 过滤。 */
export function text(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  return String(value)
}

/** 用双空格拼接一行摘要；空值自动跳过。 */
export function row(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((p): p is string => Boolean(p)).join('  ')
}

/** 取某个 condition 的状态；非 True 时附带 reason，便于定位。 */
export function conditionOf(obj: KubeObject, type: string): string {
  const cond = (obj.status?.conditions ?? []).find((c: KubeObject) => c.type === type)
  if (!cond) return ''
  return cond.status === 'True' ? 'True' : `${cond.status}${cond.reason ? `(${cond.reason})` : ''}`
}

/** 把全部 condition 压成一行。 */
export function conditionsOf(obj: KubeObject): string {
  return (obj.status?.conditions ?? [])
    .map((c: KubeObject) => `${c.type}=${c.status}${c.reason ? `(${c.reason})` : ''}`)
    .join(', ')
}

/** labels 压成 k=v,k=v；没有时返回空串。 */
export function labelsOf(obj: KubeObject): string {
  const labels = obj.metadata?.labels ?? {}
  return Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',')
}

/** 资源容量/可分配量只保留 cpu / memory / pods 三项，避免输出过长。 */
export function resourcesOf(values: KubeObject | undefined): string {
  if (!values) return ''
  return ['cpu', 'memory', 'pods', 'ephemeral-storage']
    .filter(k => values[k] !== undefined)
    .map(k => `${k}=${values[k]}`)
    .join(',')
}

/** Pod 模板容器镜像（去重）。 */
export function imagesOf(podSpec: KubeObject | undefined): string {
  const images = (podSpec?.containers ?? []).map((c: KubeObject) => c.image).filter(Boolean)
  return [...new Set(images)].join(',')
}

/** 列表摘要里的镜像字段；无镜像时返回空串并被 row() 过滤。 */
export function imageField(podSpec: KubeObject | undefined): string {
  const images = imagesOf(podSpec)
  return images ? `image=${images}` : ''
}

/** 把对象 JSON 化并截断，用于通用 describe 兜底。 */
export function jsonBlock(value: unknown, limit = 4000): string {
  const json = JSON.stringify(value, null, 2)
  return json.length > limit ? `${json.slice(0, limit)}\n... (truncated)` : json
}

/**
 * 通用兜底描述：元信息 + spec/status JSON。
 * 用于没有专门 describe 实现的资源类型，保证 `k8s_get_resource` 始终可用。
 */
export function genericDescribe(obj: KubeObject): string[] {
  const labels = labelsOf(obj)
  const annotations = Object.keys(obj.metadata?.annotations ?? {}).join(',')
  const lines = [
    `labels=${labels || '-'}`,
    `annotations=${annotations || '-'}`,
  ]
  if (obj.spec !== undefined) lines.push(`spec:\n${jsonBlock(obj.spec)}`)
  if (obj.status !== undefined) lines.push(`status:\n${jsonBlock(obj.status)}`)
  return lines
}

/** 状态字段（waiting / running / terminated）转一行。 */
export function containerState(state: KubeObject | undefined): string {
  if (!state) return '-'
  if (state.running) return `running since=${state.running.startedAt ?? '-'}`
  if (state.waiting) return `waiting reason=${state.waiting.reason ?? '-'}`
  if (state.terminated) {
    return `terminated reason=${state.terminated.reason ?? '-'} exit=${state.terminated.exitCode ?? '-'}`
  }
  return '-'
}
