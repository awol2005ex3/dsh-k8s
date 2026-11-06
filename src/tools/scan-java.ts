import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { kubeconfigFor, clientsFor } from '../config.js'
import type { Config as ConfigType } from '../types.js'
import { resolvePods, containerNames, text, mapLimit } from '../pod-targets.js'
import type { Op } from '../pod-targets.js'
import { execInPod } from '../pod-exec.js'
import {
  parseK8sMemoryKi, formatKi, probeFromSpec, parseJavaProbeOutput, mergeProbes,
  memoryViolations, renderFlags, JAVA_PROBE_SCRIPT,
} from '../jvm.js'
import { resolveSearchSettings, POD_TARGET_PARAMS, CONCURRENCY_PARAM } from '../search-params.js'

interface PodJvmRow {
  namespace: string
  pod: string
  container: string
  isJava: boolean
  source: string
  jar: string
  flagsText: string
  limitKi: number | null
  threads: number
  violations: string[]
  probeFailed: boolean
}

/**
 * 「哪些 Pod 是 Java 应用 + JVM 参数是否合理」一步到位：
 * 先从 Pod spec 判断（command/args/JAVA_OPTS），再对疑似 Java 的容器 exec 取证
 * （/proc/1/cmdline + ps + env + /proc/<pid>/task 线程数），最后按 JVM 诊断知识卡的红线判读。
 */
export function registerJvmTools(ctx: Context, config: ConfigType): void {
  ctx.tools.register(defineTool({
    name: 'k8s_scan_java_pods',
    description: '扫描多个 Pod，识别哪些是 Java 应用并解析 JVM 参数（-Xmx / -Xms / -Xmn / Metaspace / 总线程数），'
      + '与容器 resources.limits.memory 比对给出红线告警（-Xmx 超 limit、-Xms 超 limit、-Xms > -Xmx）。'
      + 'spec 证据来自 command/args/JAVA_OPTS，运行时证据来自容器内只读取证（/proc/1/cmdline、ps、env、/proc/*/task）。'
      + '支持 labelSelector / 工作负载 / 全命名空间 / Pod 名正则缩小范围。只读，不修改任何状态。',
    parameters: {
      ...POD_TARGET_PARAMS,
      ...CONCURRENCY_PARAM,
      pattern: { type: 'string', description: '（可选）只在命令行/env 命中该串的容器上细查，如 "order-service"。' },
      execProbe: { type: 'boolean', description: '是否进容器取证（默认 true；关掉则只用 Pod spec 判断，速度更快但不取线程数）。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          podsScanned: { type: 'integer' },
          javaContainers: { type: 'integer' },
          truncated: { type: 'boolean' },
          report: { type: 'string' },
          violations: { type: 'array', items: { type: 'string' } },
          errors: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report ?? '（无报告）' }],
    },
    execute: async (args, exec) => {
      if (exec.signal?.aborted) throw new Error('操作已取消')
      const settings = resolveSearchSettings({ ...args, pattern: 'x' }) // 仅借用 maxPods/concurrency 默认值
      const clients = clientsFor(kubeconfigFor(config, args.cluster))
      const useExec = args.execProbe !== false

      const resolved = await resolvePods(clients, {
        namespace: args.namespace,
        allNamespaces: args.allNamespaces === true,
        labelSelector: args.labelSelector,
        kind: args.kind,
        name: args.name,
        podNameRegex: args.podNameRegex,
        includeCompleted: args.includeCompleted === true,
        maxPods: settings.maxPods,
      })

      const errors: string[] = []
      if (resolved.truncated) {
        errors.push(`匹配到 ${resolved.total} 个 Pod，只扫描前 ${settings.maxPods} 个（可调 maxPods）。`)
      }
      const patternFilter = typeof args.pattern === 'string' && args.pattern.trim()
        ? args.pattern.trim().toLowerCase()
        : ''

      // 第一轮：spec 判断（无 exec，速度快，覆盖所有容器）
      interface SpecHit { pod: Op; namespace: string; podName: string; container: Op; containerName: string }
      const specHits: SpecHit[] = []
      const rows: PodJvmRow[] = []
      for (const pod of resolved.pods) {
        const namespace = text(pod.metadata?.namespace) || (args.namespace ?? 'default')
        const podName = text(pod.metadata?.name)
        for (const container of pod.spec?.containers ?? []) {
          const containerName = text(container.name)
          if (!containerName) continue
          const spec = probeFromSpec(container)
          const probe = patternFilter
            ? (JSON.stringify({ command: spec.command, env: container.env ?? [] }).toLowerCase().includes(patternFilter) || spec.isJava)
            : true
          if (patternFilter && !probe) continue
          if (spec.isJava) {
            specHits.push({ pod, namespace, podName, container, containerName })
          } else if (!useExec && probe) {
            rows.push({
              namespace, pod: podName, container: containerName,
              isJava: false, source: 'spec', jar: '', flagsText: '',
              limitKi: parseK8sMemoryKi(text(container.resources?.limits?.memory)),
              threads: 0, violations: [], probeFailed: false,
            })
          }
        }
      }

      // 第二轮：对 spec 可见的 Java 容器 +（可选）spec 无证据的容器 exec 取证
      const targets = specHits.map(h => ({ namespace: h.namespace, pod: h.podName, container: h.containerName }))
      if (useExec) {
        const javaPodSet = new Set(specHits.map(h => `${h.namespace}/${h.podName}`))
        for (const pod of resolved.pods) {
          const namespace = text(pod.metadata?.namespace) || (args.namespace ?? 'default')
          const podName = text(pod.metadata?.name)
          if (!javaPodSet.has(`${namespace}/${podName}`)) {
            // spec 无 Java 证据的 Pod：只对第一个容器做轻量取证（PID1 cmdline 足以判断 java 启动）
            const names = containerNames(pod).slice(0, 1)
            for (const container of names) targets.push({ namespace, pod: podName, container })
          }
        }
      }

      const kc = kubeconfigFor(config, args.cluster)
      const probes = new Map<string, ReturnType<typeof parseJavaProbeOutput> | null>()
      await mapLimit(targets, settings.concurrency, async (t) => {
        const key = `${t.namespace}/${t.pod}/${t.container}`
        try {
          const r = await execInPod(kc, {
            namespace: t.namespace, pod: t.pod, container: t.container,
            command: ['sh', '-c', JAVA_PROBE_SCRIPT],
          })
          probes.set(key, r.exitCode === 0 || r.output ? parseJavaProbeOutput(r.output) : null)
          if (!r.output && r.exitCode !== 0) {
            if (errors.length < 20) errors.push(`${key}: 取证脚本执行失败 (exit ${r.exitCode})`)
          }
        } catch (error) {
          probes.set(key, null)
          if (errors.length < 20) errors.push(`${key}: ${(error as Error).message}`)
        }
      })

      // 组装行
      const seen = new Set<string>()
      for (const pod of resolved.pods) {
        const namespace = text(pod.metadata?.namespace) || (args.namespace ?? 'default')
        const podName = text(pod.metadata?.name)
        for (const container of pod.spec?.containers ?? []) {
          const containerName = text(container.name)
          if (!containerName) continue
          const key = `${namespace}/${podName}/${containerName}`
          if (seen.has(key)) continue
          const spec = probeFromSpec(container)
          const runtime = probes.get(key) ?? null
          const merged = mergeProbes(spec, runtime)
          if (!merged.isJava) {
            if (!useExec) continue // 未取证且 spec 无证据 → 跳过非 Java
            continue
          }
          seen.add(key)
          const limitKi = parseK8sMemoryKi(text(container.resources?.limits?.memory))
          const violations = memoryViolations(limitKi, merged.flags).map(v => v.message)
          rows.push({
            namespace, pod: podName, container: containerName,
            isJava: true,
            source: merged.source,
            jar: merged.jar,
            flagsText: renderFlags(merged.flags),
            limitKi,
            threads: merged.threads,
            violations,
            probeFailed: useExec && !runtime,
          })
        }
      }

      const javaRows = rows.filter(r => r.isJava)
      const violations = javaRows.flatMap(r => r.violations.map(v => `${r.namespace}/${r.pod}/${r.container}: ${v}`))

      // 渲染
      const parts: string[] = []
      parts.push(`扫描 ${resolved.pods.length} 个 Pod；Java 容器 ${javaRows.length} 个；红线告警 ${violations.length} 条。`)
      if (resolved.truncated) parts.push('⚠ Pod 数已达上限，可调 maxPods。')
      for (const r of javaRows) {
        const limit = r.limitKi !== null ? formatKi(r.limitKi) : '未设置'
        const lines = [
          `### ${r.namespace}/${r.pod}/${r.container}${r.probeFailed ? '（容器内取证失败，仅 spec 证据）' : ''}`,
          `- 类型: Java (${r.source})${r.jar ? `  jar: ${r.jar}` : ''}`,
          `- JVM 参数: ${r.flagsText || '（未发现 -X 参数）'}`,
          `- limit.memory: ${limit}`,
        ]
        if (r.threads > 0) lines.push(`- java 线程数: ${r.threads}`)
        for (const v of r.violations) lines.push(`- ⚠ ${v}`)
        parts.push(lines.join('\n'))
      }
      if (javaRows.length === 0) parts.push('（未发现 Java 应用容器）')
      if (errors.length > 0) parts.push(`[取证失败 / 读取失败]\n${errors.map(e => `- ${e}`).join('\n')}`)

      return {
        podsScanned: resolved.pods.length,
        javaContainers: javaRows.length,
        truncated: resolved.truncated,
        report: parts.join('\n\n'),
        violations,
        errors,
      }
    },
  }))
}
