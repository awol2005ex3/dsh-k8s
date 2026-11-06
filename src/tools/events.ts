import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { kubeconfigFor, clientsFor, namespaceOf } from '../config.js'
import type { Config as ConfigType } from '../types.js'

type Op = Record<string, any>
type Clients = ReturnType<typeof clientsFor>

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

function iso(value: unknown): string {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

interface EventRow {
  type: string
  reason: string
  object: string
  namespace: string
  count: number
  lastTimestamp: string
  message: string
  _ts: number
  _involvedKind: string
  _involvedName: string
}

export function registerEventTools(ctx: Context, config: ConfigType): void {
  ctx.tools.register(defineTool({
    name: 'k8s_get_events',
    description: '查询集群事件（只读），可按命名空间 / 对象类型 / 对象名称过滤，按最近时间排序。'
      + '用于定位 CrashLoopBackOff、Pending、ImagePullBackOff、调度失败、资源不足等问题的根因事件。',
    parameters: {
      cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
      namespace: { type: 'string', description: '命名空间；不填则查询所有命名空间。' },
      involvedKind: { type: 'string', description: '按事件关联对象类型过滤，例如 Pod / Deployment / Node / PersistentVolumeClaim。' },
      involvedName: { type: 'string', description: '按事件关联对象名称过滤（模糊包含）。' },
      reason: { type: 'string', description: '按事件 reason 过滤（模糊包含），例如 Failed / BackOff。' },
      type: { type: 'string', description: '事件类型：Warning | Normal | all（缺省只返回 Warning）。' },
      limit: { type: 'integer', description: '最多返回多少条，缺省 50。' },
      sinceSeconds: { type: 'integer', description: '只返回最近 N 秒的事件。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          events: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                type: { type: 'string' }, reason: { type: 'string' },
                object: { type: 'string' }, namespace: { type: 'string' },
                count: { type: 'integer' }, lastTimestamp: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.events.length === 0) {
          return [{ type: 'text', text: '（无匹配事件）' }]
        }
        return [{ type: 'text', text: value.events.map(e =>
          `• [${e.type}] ${e.reason || '-'}  ${e.object}${e.namespace ? ` ns=${e.namespace}` : ''}  count=${e.count}  @${e.lastTimestamp}\n  ${e.message}`,
        ).join('\n') }]
      },
    },
    execute: async (args) => {
      const clients = clientsFor(kubeconfigFor(config, args.cluster))
      const namespace = args.namespace ? namespaceOf(args.namespace) : undefined
      const limit = args.limit ?? 50

      const typeFilter = text(args.type ?? 'Warning').toLowerCase()
      const reasonFilter = text(args.reason).toLowerCase()
      const kindFilter = text(args.involvedKind).toLowerCase()
      const nameFilter = text(args.involvedName).toLowerCase()
      const sinceMs = args.sinceSeconds !== undefined ? args.sinceSeconds * 1000 : null
      const now = Date.now()

      let items: Op[] = []
      if (namespace) {
        const res = await clients.core.listNamespacedEvent({ namespace }) as unknown as Op
        items = res.items ?? []
      } else {
        const res = await clients.core.listEventForAllNamespaces({}) as unknown as Op
        items = res.items ?? []
      }

      const rows: EventRow[] = []
      for (const e of items) {
        const eventType = text(e.type) || 'Normal'
        if (typeFilter !== 'all' && eventType.toLowerCase() !== typeFilter) continue

        const involvedKind = text(e.involvedObject?.kind)
        const involvedName = text(e.involvedObject?.name)
        if (kindFilter && involvedKind.toLowerCase() !== kindFilter) continue
        if (nameFilter && !involvedName.toLowerCase().includes(nameFilter)) continue

        const reason = text(e.reason)
        if (reasonFilter && !reason.toLowerCase().includes(reasonFilter)) continue

        const last = iso(e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp)
        const ts = Date.parse(last)
        if (sinceMs !== null && !Number.isNaN(ts) && ts < now - sinceMs) continue

        rows.push({
          type: eventType,
          reason,
          object: `${involvedKind || '?'}/${involvedName || '?'}`,
          namespace: text(e.metadata?.namespace),
          count: Number(e.count) || 1,
          lastTimestamp: last,
          message: truncate(text(e.message), 400),
          _ts: Number.isNaN(ts) ? 0 : ts,
          _involvedKind: involvedKind,
          _involvedName: involvedName,
        })
      }

      rows.sort((a, b) => b._ts - a._ts)
      const events = rows.slice(0, limit).map(({ _ts, _involvedKind, _involvedName, ...rest }) => rest)
      return { events }
    },
  }))
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value
}