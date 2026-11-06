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
  return Number.isNaN(date.getTime()) ? text(value) : date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** 容器状态压成一行（running / waiting / terminated）。 */
function containerState(state: Op | undefined): string {
  if (!state) return '?'
  if (state.running) return `running since=${state.running.startedAt ?? '-'}`
  if (state.waiting) {
    return `waiting reason=${state.waiting.reason ?? '-'}${state.waiting.message ? ` msg="${text(state.waiting.message)}"` : ''}`
  }
  if (state.terminated) {
    const t = state.terminated
    return `terminated reason=${text(t.reason) || '-'} exit=${text(t.exitCode) || '-'}${t.finishedAt ? ` finished=${t.finishedAt}` : ''}`
  }
  return '?'
}

/** 取一个容器的状态（含 ready / restarts / image）。 */
function containerLine(name: string, status: Op | undefined, container: Op): string {
  const parts = [
    `  • ${name}`,
    `state=${containerState(status?.state)}`,
    status?.ready === true ? 'ready=yes' : 'ready=no',
    `restarts=${status?.restartCount ?? 0}`,
    `image=${text(container.image) || '-'}`,
  ]
  if (status?.state?.waiting?.reason) {
    parts.push(`lastReason=${text(status.lastState?.terminated?.reason) || '-'}`)
    parts.push(`lastExit=${text(status.lastState?.terminated?.exitCode) || '-'}`)
  }
  return parts.join('  ')
}

/** Pod 类型的问题判断：从容器状态推断异常原因。 */
function diagnosePhase(pod: Op): string[] {
  const issues: string[] = []
  const phase = text(pod.status?.phase)
  const conditions = pod.status?.conditions ?? []
  const scheduled = conditions.find((c: Op) => c.type === 'PodScheduled')
  const ready = conditions.find((c: Op) => c.type === 'Ready')

  if (scheduled && scheduled.status !== 'True') {
    issues.push(`调度失败：${text(scheduled.reason)} ${text(scheduled.message)}`)
  }
  if (ready && ready.status !== 'True') {
    const reason = text(ready.reason)
    if (reason) issues.push(`未就绪：${reason} ${text(ready.message)}`)
  }
  if (phase === 'Pending' && scheduled?.status === 'True') {
    issues.push('Pod 已调度但仍 Pending（可能在拉镜像或等待资源）。')
  }

  for (const st of pod.status?.containerStatuses ?? []) {
    const waiting = st.state?.waiting?.reason
    if (waiting === 'ImagePullBackOff') issues.push(`容器 ${text(st.name)} 镜像拉取失败（ImagePullBackOff）。`)
    if (waiting === 'ErrImagePull') issues.push(`容器 ${text(st.name)} 镜像拉取错误。`)
    if (waiting === 'CrashLoopBackOff') issues.push(`容器 ${text(st.name)} 崩溃循环（CrashLoopBackOff）。`)
    if (st.state?.terminated?.exitCode && st.state.terminated.exitCode !== 0) {
      issues.push(`容器 ${text(st.name)} 已退出，exit=${text(st.state.terminated.exitCode)}（reason=${text(st.state.terminated.reason) || '-'}）。`)
    }
  }
  return issues
}

export function registerDiagnoseTools(ctx: Context, config: ConfigType): void {
  ctx.tools.register(defineTool({
    name: 'k8s_diagnose_pod',
    description: '一次排障单个 Pod（只读）：聚合 Pod 阶段与条件、各容器状态（含 Waiting/Terminated 原因与退出码）、'
      + '最近 Warning 事件、最后一次容器实例的日志尾部。定位 CrashLoopBackOff / Pending / ImagePullBackOff / 未就绪。',
    parameters: {
      cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
      namespace: { type: 'string', description: '命名空间，缺省为 default。' },
      pod: { type: 'string', required: true, description: 'Pod 名称。' },
      tailLines: { type: 'integer', description: '每个异常容器读取的日志尾部行数，缺省 50。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string' }, namespace: { type: 'string' },
          phase: { type: 'string' }, node: { type: 'string' },
          ip: { type: 'string' }, started: { type: 'string' },
          conditions: { type: 'array', items: { type: 'string' } },
          issues: { type: 'array', items: { type: 'string' } },
          containers: { type: 'array', items: { type: 'string' } },
          events: { type: 'array', items: { type: 'string' } },
          logs: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const lines = [
          `• ${value.namespace}/${value.name}`,
          `phase=${value.phase || '-'} node=${value.node || '-'} ip=${value.ip || '-'} started=${value.started || '-'}`,
          value.conditions?.length ? `conditions: ${value.conditions.join(', ')}` : '',
        ]
        if (value.issues?.length) {
          lines.push('\n[诊断问题]')
          lines.push(...value.issues.map(i => `  ⚠ ${i}`))
        }
        if (value.containers?.length) {
          lines.push('\n[容器]')
          lines.push(...value.containers)
        }
        if (value.events?.length) {
          lines.push('\n[最近事件]')
          lines.push(...value.events.map(e => `  ${e}`))
        }
        if (value.logs?.length) {
          lines.push('\n[异常容器日志尾部]')
          lines.push(...value.logs.map(l => `  ${l}`))
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args) => {
      const clients = clientsFor(kubeconfigFor(config, args.cluster))
      const namespace = namespaceOf(args.namespace)
      const tailLines = args.tailLines ?? 50

      const pod = await clients.core.readNamespacedPod({ name: args.pod, namespace }) as unknown as Op
      const name = text(pod.metadata?.name)

      // 问题判断
      const issues = diagnosePhase(pod)

      // 容器状态
      const containers: string[] = []
      const containerStatuses: Op[] = pod.status?.containerStatuses ?? []
      const specContainers: Op[] = pod.spec?.containers ?? []
      for (const sc of specContainers) {
        const st = containerStatuses.find((c: Op) => c.name === sc.name)
        containers.push(containerLine(text(sc.name), st, sc))
      }

      // 异常容器（waiting 或非 0 退出）→ 读上次日志
      const abnormal = containerStatuses.filter((st: Op) => {
        const waiting = st.state?.waiting?.reason
        if (waiting) return true
        return st.state?.terminated?.exitCode && st.state.terminated.exitCode !== 0
      })

      const logs: string[] = []
      for (const st of abnormal.slice(0, 3)) {
        try {
          const previous = Boolean(st.state?.terminated)
          const log = text(await clients.core.readNamespacedPodLog({
            name,
            namespace,
            container: text(st.name),
            previous,
            tailLines,
          }))
          if (log.trim()) logs.push(`[${text(st.name)}${previous ? ' (previous)' : ''}]\n${log}`)
        } catch {
          logs.push(`[${text(st.name)}] (日志读取失败，可能容器已删除或尚未产生日志)`)
        }
      }

      // 最近 Warning 事件（过滤到该 Pod）
      let events: string[] = []
      try {
        const evRes = await clients.core.listNamespacedEvent({ namespace }) as unknown as Op
        events = (evRes.items ?? [])
          .filter((e: Op) => text(e.involvedObject?.name) === name)
          .filter((e: Op) => text(e.type) === 'Warning')
          .sort((a: Op, b: Op) => {
            const at = Date.parse(iso(a.lastTimestamp ?? a.eventTime))
            const bt = Date.parse(iso(b.lastTimestamp ?? b.eventTime))
            return (Number.isNaN(bt) ? 0 : bt) - (Number.isNaN(at) ? 0 : at)
          })
          .slice(0, 10)
          .map((e: Op) => `${text(e.reason) || '-'} count=${text(e.count) || 1} msg="${text(e.message)}"`)
      } catch {
        // 无事件读取权限时忽略
      }

      return {
        name,
        namespace,
        phase: text(pod.status?.phase) || '',
        node: text(pod.spec?.nodeName) || '',
        ip: text(pod.status?.podIP) || '',
        started: iso(pod.metadata?.creationTimestamp),
        conditions: (pod.status?.conditions ?? []).map((c: Op) => `${c.type}=${c.status}${text(c.reason) ? `(${c.reason})` : ''}`),
        issues,
        containers,
        events,
        logs,
      }
    },
  }))
}