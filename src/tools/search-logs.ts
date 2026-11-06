import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { kubeconfigFor, clientsFor } from '../config.js'
import type { Config as ConfigType } from '../types.js'
import { resolvePods, containerNames, text, mapLimit } from '../pod-targets.js'
import { resolveSearchSettings, POD_TARGET_PARAMS, GREP_PARAMS, LOG_SCAN_PARAMS, CONCURRENCY_PARAM } from '../search-params.js'
import { searchStreams, renderSearch } from '../search-common.js'
import type { StreamHit } from '../search-common.js'

const MAX_ERRORS = 20

/**
 * 替代 `for pod in $(kubectl get pods ...); do kubectl logs $pod | grep xxx -A 11 -B 20; done`
 * 这类「大规模 Pod 日志搜索」：一次调用扫描几十个 Pod 的日志，按 grep -A/-B 语义
 * 返回命中行与上下文，并自带全局命中数/字符数上限，避免把模型上下文打满。
 */
export function registerSearchLogsTools(ctx: Context, config: ConfigType): void {
  ctx.tools.register(defineTool({
    name: 'k8s_search_pod_logs',
    description: '批量搜索多个 Pod 的日志并按 grep -A/-B 语义返回命中行与上下文（只读，不依赖 kubectl / grep）。'
      + '一次扫描几十个 Pod，适合「哪些 Pod 的日志里出现 xxx」「哪些是 Java 应用」「排查 GC / OOM 关键字」等大规模排查。'
      + '支持 labelSelector / 工作负载 / 全命名空间 / Pod 名正则缩小范围；'
      + 'before=grep -B、after=grep -A、regex/ignoreCase 分别等价 grep -E / -i；'
      + '结果带 [namespace/pod/container] 标签与行号，命中行用 : 标记、上下文行用 - 标记，多段命中用 -- 分隔。'
      + '自带 maxPods 与全局命中/字符上限，适合集群级批量搜索。',
    parameters: {
      ...POD_TARGET_PARAMS,
      ...GREP_PARAMS,
      ...LOG_SCAN_PARAMS,
      ...CONCURRENCY_PARAM,
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

      const tailLines = typeof args.tailLines === 'number' ? args.tailLines : 500
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

      const streams: StreamHit[] = await mapLimit(targets, s.concurrency, async (t) => {
        try {
          const logs = await clients.core.readNamespacedPodLog({
            name: t.pod,
            namespace: t.namespace,
            container: t.container,
            tailLines,
            sinceSeconds: args.sinceSeconds,
            timestamps: args.timestamps,
            previous: args.previous,
          })
          return { namespace: t.namespace, pod: t.pod, container: t.container, text: text(logs) }
        } catch (error) {
          return { namespace: t.namespace, pod: t.pod, container: t.container, text: '', error: (error as Error).message }
        }
      })

      const header = (h: StreamHit) => `[${h.namespace}/${h.pod}/${h.container}]`
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
