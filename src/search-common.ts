import type { GrepOptions } from './grep.js'
import { grepLines, renderGrepBlocks } from './grep.js'

const MAX_ERRORS = 20

/** 一次「容器流」的搜索输入：一段日志或一次 exec 的原始输出。 */
export interface StreamHit {
  readonly namespace: string
  readonly pod: string
  readonly container: string
  readonly text: string
  readonly exitCode?: number
  readonly error?: string
}

export interface SearchOptions extends GrepOptions {
  /** 每个容器流最多保留多少处命中。 */
  readonly perStreamMax: number
  /** 全局最多保留多少处命中。 */
  readonly globalMax: number
  /** 渲染文本总字符上限，防止大规模搜索把上下文撑爆。 */
  readonly maxChars: number
}

export interface MatchedPod {
  namespace: string
  pod: string
  container: string
  matches: number
  exitCode: number
}

export interface SearchSummary {
  matchedPods: MatchedPod[]
  matches: string
  podsScanned: number
  containersScanned: number
  totalMatches: number
  truncated: boolean
  errors: string[]
}

/** 流头部标签（如 `[prod/api-7d9f/app]`），由调用方决定格式。 */
export type StreamHeader = (s: StreamHit) => string

/**
 * 把多个容器流的 grep 结果装配成一份带上下文的报告。
 * 全局命中上限与字符上限都是硬闸，避免几十个 Pod × -A 111 时把模型上下文打满。
 */
export function searchStreams(
  streams: readonly StreamHit[],
  opts: SearchOptions,
  header: StreamHeader,
): SearchSummary {
  const errors: string[] = []
  const matchedPods: MatchedPod[] = []
  const parts: string[] = []
  const pods = new Set<string>()
  let totalMatches = 0
  let truncated = false
  let chars = 0

  const computed = streams.map((s) => ({
    stream: s,
    result: s.error ? null : grepLines(s.text, { ...opts, maxMatches: opts.perStreamMax }),
  }))

  for (const { stream, result } of computed) {
    pods.add(`${stream.namespace}/${stream.pod}`)
    if (!result) {
      if (errors.length < MAX_ERRORS) errors.push(`${header(stream)}: ${stream.error ?? '未知错误'}`)
      continue
    }
    if (result.truncated) truncated = true

    const remaining = opts.globalMax - totalMatches
    const take = Math.max(0, Math.min(result.totalMatches, remaining))
    if (take < result.totalMatches) truncated = true
    if (take === 0) continue

    // 全局上限收紧时重跑一次，保证渲染的上下文窗口也按 take 截断。
    const capped = take < result.totalMatches
      ? grepLines(stream.text, { ...opts, maxMatches: take })
      : result
    totalMatches += capped.totalMatches

    matchedPods.push({
      namespace: stream.namespace,
      pod: stream.pod,
      container: stream.container,
      matches: capped.totalMatches,
      exitCode: stream.exitCode ?? 0,
    })

    const block = `${header(stream)}\n${renderGrepBlocks(capped)}`
    if (chars + block.length + 2 > opts.maxChars) {
      truncated = true
      break
    }
    parts.push(block)
    chars += block.length + 2
  }

  return {
    matchedPods,
    matches: parts.join('\n\n'),
    podsScanned: pods.size,
    containersScanned: streams.length,
    totalMatches,
    truncated,
    errors,
  }
}

/** 统一的模型侧渲染：先给结论摘要，再给命中容器清单，最后给带上下文的原文。 */
export function renderSearch(v: SearchSummary): string {
  const parts: string[] = []
  parts.push(
    `扫描 ${v.podsScanned} 个 Pod / ${v.containersScanned} 个容器流；`
    + `命中 ${v.totalMatches} 处，涉及 ${v.matchedPods.length} 个容器。`,
  )
  if (v.truncated) {
    parts.push('⚠ 结果已截断（命中数或字符数达到上限）。可调 maxMatches / maxTotalMatches / maxChars，或缩小 Pod 范围。')
  }
  if (v.matchedPods.length > 0) {
    parts.push('命中容器：\n' + v.matchedPods
      .map(m => `- ${m.namespace}/${m.pod}/${m.container}  ${m.matches} 处`)
      .join('\n'))
  }
  if (v.matches) parts.push(v.matches)
  else if (v.matchedPods.length === 0) parts.push('（无匹配）')
  if (v.errors.length > 0) {
    parts.push(`[读取 / 执行失败]\n${v.errors.map(e => `- ${e}`).join('\n')}`)
  }
  return parts.join('\n\n')
}
