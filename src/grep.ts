/**
 * 纯文本 grep 引擎：复刻 `grep -A N -B M` 的「命中行 + 上下文 + -- 分隔」语义，
 * 供批量 Pod 日志 / exec 输出搜索复用。不依赖任何外部命令。
 */

export interface GrepOptions {
  /** 搜索串；regex=false 时按字面子串匹配。 */
  readonly pattern: string
  /** 是否把 pattern 当正则（缺省 false）。 */
  readonly regex?: boolean
  /** 忽略大小写（缺省 false）。 */
  readonly ignoreCase?: boolean
  /** 命中行之前保留的上下文行数，等价 grep -B。 */
  readonly before?: number
  /** 命中行之后保留的上下文行数，等价 grep -A。 */
  readonly after?: number
  /** 单个文本块最多保留多少处命中，超出即截断（缺省 200）。 */
  readonly maxMatches?: number
}

export interface GrepLine {
  /** 1-based 行号（相对本次读取到的文本）。 */
  readonly lineNumber: number
  readonly text: string
  /** true = 命中行，false = 上下文行。 */
  readonly match: boolean
}

export interface GrepBlock {
  readonly lines: readonly GrepLine[]
}

export interface GrepResult {
  readonly blocks: readonly GrepBlock[]
  /** 命中的行数（受 maxMatches 限制，truncated 时不是真实总数）。 */
  readonly totalMatches: number
  /** 是否因达到 maxMatches 而提前停止。 */
  readonly truncated: boolean
}

const MAX_CONTEXT = 1000
const MAX_MATCHES_CAP = 2000
const DEFAULT_MAX_MATCHES = 200

function clampInt(value: number | undefined, fallback: number, cap: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(cap, Math.max(0, Math.floor(value)))
}

type Matcher = (line: string) => boolean

function compileMatcher(opts: GrepOptions): Matcher {
  const pattern = opts.pattern ?? ''
  if (!pattern) throw new Error('pattern 不能为空。')
  if (opts.regex) {
    let re: RegExp
    try {
      re = new RegExp(pattern, opts.ignoreCase ? 'i' : '')
    } catch (error) {
      throw new Error(`pattern 不是合法正则：${(error as Error).message}`)
    }
    return (line) => re.test(line)
  }
  const needle = opts.ignoreCase ? pattern.toLowerCase() : pattern
  return opts.ignoreCase
    ? (line) => line.toLowerCase().includes(needle)
    : (line) => line.includes(needle)
}

/** 按行切分，统一 CRLF，并去掉「末尾换行产生的空行」。 */
function splitLines(input: string): string[] {
  if (!input) return []
  const lines = input.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * 在一段文本里搜索并生成带上下文的命中块。
 * 相邻/重叠的上下文窗口会合并（与 grep 一致），窗口之间有间隔时用 `--` 分隔。
 */
export function grepLines(input: string, opts: GrepOptions): GrepResult {
  const match = compileMatcher(opts)
  const before = clampInt(opts.before, 0, MAX_CONTEXT)
  const after = clampInt(opts.after, 0, MAX_CONTEXT)
  const maxMatches = clampInt(opts.maxMatches, DEFAULT_MAX_MATCHES, MAX_MATCHES_CAP) || DEFAULT_MAX_MATCHES
  const lines = splitLines(input)

  const matchIdx: number[] = []
  let truncated = false
  for (let i = 0; i < lines.length; i++) {
    if (!match(lines[i])) continue
    if (matchIdx.length >= maxMatches) { truncated = true; break }
    matchIdx.push(i)
  }

  // 合并相邻/重叠窗口：[start, end] 闭区间
  const windows: Array<[number, number]> = []
  for (const idx of matchIdx) {
    const start = Math.max(0, idx - before)
    const end = Math.min(lines.length - 1, idx + after)
    const last = windows[windows.length - 1]
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
    else windows.push([start, end])
  }

  const matchSet = new Set(matchIdx)
  const blocks: GrepBlock[] = windows.map(([start, end]) => ({
    lines: Array.from({ length: end - start + 1 }, (_, k) => {
      const idx = start + k
      return { lineNumber: idx + 1, text: lines[idx], match: matchSet.has(idx) }
    }),
  }))

  return { blocks, totalMatches: matchIdx.length, truncated }
}

/** 把命中块渲染成 grep -n 风格文本（命中行 `:`，上下文行 `-`，块间 `--`）。 */
export function renderGrepBlocks(result: GrepResult): string {
  if (result.blocks.length === 0) return ''
  let maxLine = 0
  for (const block of result.blocks) {
    const last = block.lines[block.lines.length - 1]
    if (last && last.lineNumber > maxLine) maxLine = last.lineNumber
  }
  const width = Math.max(4, String(maxLine).length)
  const out: string[] = []
  for (let b = 0; b < result.blocks.length; b++) {
    if (b > 0) out.push('--')
    for (const line of result.blocks[b].lines) {
      const n = String(line.lineNumber).padStart(width, ' ')
      out.push(`${n}${line.match ? ':' : '-'} ${line.text}`)
    }
  }
  return out.join('\n')
}

/** 便捷封装：一次拿到结构化结果与渲染文本。 */
export function grepAndRender(input: string, opts: GrepOptions): { result: GrepResult; rendered: string } {
  const result = grepLines(input, opts)
  return { result, rendered: renderGrepBlocks(result) }
}
