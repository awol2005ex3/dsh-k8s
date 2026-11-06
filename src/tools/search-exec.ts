import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { kubeconfigFor, clientsFor } from '../config.js'
import type { Config as ConfigType } from '../types.js'
import { resolvePods, containerNames, text, mapLimit } from '../pod-targets.js'
import { execInPod } from '../pod-exec.js'
import { resolveSearchSettings, POD_TARGET_PARAMS, GREP_PARAMS, CONCURRENCY_PARAM } from '../search-params.js'
import { searchStreams, renderSearch } from '../search-common.js'
import type { StreamHit } from '../search-common.js'

const MAX_ERRORS = 20

/** 只读闸门：批量 exec 放大效应大，拒绝明显的破坏性命令。 */
const DESTRUCTIVE = /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)|\bmkfs\b|\bdd\b\s+if=|\bshutdown\b|\breboot\b|\bmkswap\b|\b:>?\s*\/(etc|usr|bin|sbin|var|lib)\b|\bkill\s+-9\b|\bpkill\b|\becho\s*[^|]*>\s*\/(etc|proc|sys)\b/i

/**
 * 替代 `for pod in ...; do kubectl exec $pod -- sh -c '...' | grep zzz -A 111 -B 20; done`
 * 这类「大规模 Pod 内命令输出搜索」：一次调用在几十个 Pod 的容器里执行同一条只读命令，
 * 把输出按 grep -A/-B 语义过滤后返回。
 */
export function registerSearchExecTools(ctx: Context, config: ConfigType): void {
  ctx.tools.register(defineTool({
    name: 'k8s_search_pod_exec',
    description: '在多个 Pod 的容器内批量执行同一条只读命令，并对输出按 grep -A/-B 语义搜索（不依赖 kubectl / grep）。'
      + '替代「逐个 kubectl exec ... | grep xxx -A 111 -B 20」的大规模排查：适合统计线程数（ps -eLf）、找进程命令行（ps -ef）、'
      + '读 env / /proc/1/cmdline / 挂载与内核参数等。支持 labelSelector / 工作负载 / 全命名空间 / Pod 名正则缩小范围；'
      + 'before=grep -B、after=grep -A、regex/ignoreCase 等价 grep -E / -i；'
      + '输出带 [namespace/pod/container] 标签、行号与非零退出码。**仅限只读命令**，破坏性命令会被拒绝。',
    parameters: {
      ...POD_TARGET_PARAMS,
      ...GREP_PARAMS,
      ...CONCURRENCY_PARAM,
      command: {
        type: 'array', items: { type: 'string' }, required: true,
        description: '要执行的命令数组（每个 Pod 相同），如 ["sh","-c","ps -eLf | wc -l"] 或 ["ps","-ef"]。仅限只读命令。',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          matches: { type: 'string', required: true },
          podsScanned: { type: 'integer', required: true },
          containersScanned: { type: 'integer', required: true },
          totalMatches: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          matchedPods: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                namespace: { type: 'string', required: true },
                pod: { type: 'string', required: true },
                container: { type: 'string', required: true },
                matches: { type: 'integer', required: true },
                exitCode: { type: 'integer', required: true },
              },
            },
          },
          errors: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSearch(value) }],
    },
    execute: async (args, exec) => {
      if (exec.signal?.aborted) throw new Error('操作已取消')
      const s = resolveSearchSettings(args)
      if (!s.pattern) throw new Error('pattern 不能为空。')
      const command: string[] = Array.isArray(args.command) ? args.command.map(String) : []
      if (command.length === 0) throw new Error('command 不能为空。')
      const joined = command.join(' ')
      if (DESTRUCTIVE.test(joined)) {
        throw new Error(`检测到疑似破坏性命令，已拒绝执行（本工具仅限只读排查）：${joined.slice(0, 200)}`)
      }

      const clients = clientsFor(kubeconfigFor(config, args.cluster))
      const resolved = await resolvePods(clients, {
        namespace: args.namespace,
        allNamespaces: args.allNamespaces === true,
        labelSelector: args.labelSelector,
        kind: args.kind,
        name: args.name,
        podNameRegex: args.podNameRegex,
        includeCompleted: args.includeCompleted === true,
        maxPods: s.maxPods,
      })

      const targets: Array<{ namespace: string; pod: string; container: string }> = []
      const scopeErrors: string[] = []
      if (resolved.truncated) {
        scopeErrors.push(`匹配到 ${resolved.total} 个 Pod，只扫描前 ${s.maxPods} 个（可调 maxPods）。`)
      }
      for (const pod of resolved.pods) {
        const namespace = text(pod.metadata?.namespace) || (args.namespace ?? 'default')
        const podName = text(pod.metadata?.name)
        const names = containerNames(pod)
        const wanted = args.container ? names.filter(n => n === args.container) : names
        if (args.container && wanted.length === 0) {
          if (scopeErrors.length < MAX_ERRORS) {
            scopeErrors.push(`${namespace}/${podName}: 没有名为 ${args.container} 的容器（现有：${names.join(',') || '无'}）`)
          }
          continue
        }
        for (const container of wanted) targets.push({ namespace, pod: podName, container })
      }

      const kc = kubeconfigFor(config, args.cluster)
      const streams: StreamHit[] = await mapLimit(targets, s.concurrency, async (t) => {
        try {
          const r = await execInPod(kc, { namespace: t.namespace, pod: t.pod, container: t.container, command })
          return { namespace: t.namespace, pod: t.pod, container: t.container, text: r.output, exitCode: r.exitCode }
        } catch (error) {
          return { namespace: t.namespace, pod: t.pod, container: t.container, text: '', error: (error as Error).message }
        }
      })

      const header = (h: StreamHit) => `[${h.namespace}/${h.pod}/${h.container}]${
        h.exitCode && h.exitCode !== 0 ? ` (exit ${h.exitCode})` : ''}`
      const summary = searchStreams(streams, {
        pattern: s.pattern,
        regex: s.regex,
        ignoreCase: s.ignoreCase,
        before: s.before,
        after: s.after,
        perStreamMax: s.maxMatches,
        globalMax: s.maxTotalMatches,
        maxChars: s.maxChars,
      }, header)
      summary.errors.unshift(...scopeErrors)

      return {
        matches: summary.matches,
        podsScanned: summary.podsScanned,
        containersScanned: summary.containersScanned,
        totalMatches: summary.totalMatches,
        truncated: summary.truncated,
        matchedPods: summary.matchedPods,
        errors: summary.errors,
      }
    },
  }))
}
