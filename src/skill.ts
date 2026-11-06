import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'

/** 单个内置 skill 的注册元数据。 */
export interface BuiltinSkillDef {
  /** skill 名（kebab-case，出现在 <available_skills> catalog 里）。 */
  readonly name: string
  /** catalog 里唯一的路由文本，控制在 tool-skill 的 500 字符截断上限内。 */
  readonly description: string
  /** 相对编译产物 lib/skill.js 解析的正文路径。 */
  readonly file: string
}

/**
 * 注册清单 = 事实来源：名称、catalog 描述、正文文件一一对应。
 * 顺序只影响注册次序，不影响 catalog 展示。
 *
 * 主题按「故障现象」切分而非按工具分类：模型看到 JVM 参数超限 / 低版本内核线程耗尽时能精准命中一张卡，
 * 每张卡自带边界说明与相邻 skill 的交叉引用，避免重复加载整本手册。
 */
export const BUILTIN_SKILLS: readonly BuiltinSkillDef[] = [
  {
    name: 'dsh-k8s-jvm-diagnosis',
    description:
      '排查 Pod 内 JVM 参数（-Xmx / -Xms / -Xmn / 总线程数）是否违反 Pod request/limit 等不合理问题时加载。' +
      '涵盖内存超限、GC 频繁、线程堆积、堆上限被压低、线程数触达内核 ulimit 等场景。',
    file: 'jvm-diagnosis.md',
  },
  {
    name: 'dsh-k8s-low-kernel-thread',
    description:
      '排查低版本内核下进程/线程数超限（如 nginx worker_processes auto 无限增长、Node cluster 多进程失控）' +
      '导致节点崩溃时加载。涵盖内核版本偏低、pid_max 不足、cgroup pids.max 缺失、级联 OOM 等场景。',
    file: 'low-kernel-thread.md',
  },
]

/** `ctx.skills.register()` 的最小鸭子类型（不引入 @deepseek-ai/dsh-skill 运行时依赖）。 */
interface SkillsServiceLike {
  register(skill: {
    readonly name: string
    readonly description: string
    readonly source: string
    readonly content: string
    readonly invocation?: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  }): () => void | Promise<void>
}

/**
 * 装配全部内置 runtime skill。
 *
 * `ctx.inject(['skills'], cb)` 是官方「服务就绪才装配」范式：子 fiber 的卸载由宿主管理，
 * HMR/卸载时里面的每个 ctx.effect 自动反注册；服务缺席时不阻塞插件加载。
 * 单个正文读失败只跳过那一个 skill，其余 skill 与核心工具照常可用。
 */
export function registerBuiltinSkills(ctx: Context): void {
  const inject = (ctx as unknown as {
    inject?: (deps: string[], callback: (c: Context) => void) => unknown
  }).inject
  if (typeof inject !== 'function') return // 测试替身/老宿主没有延迟装配能力，静默降级

  inject.call(ctx, ['skills'], (skillsCtx: Context) => {
    // 子 ctx 已声明 inject(['skills'])，属性访问合法（与 sandbox-local 的官方范式一致）。
    const skills = (skillsCtx as unknown as { skills?: SkillsServiceLike }).skills
    if (!skills || typeof skills.register !== 'function') {
      ctx.logger('dsh-k8s').warn('dsh-k8s: skills registry unavailable; built-in skills not registered')
      return
    }

    for (const def of BUILTIN_SKILLS) {
      // 正文每次装配现读（文件随 npm 包发布、HMR 时若被替换能生效）。
      let content: string
      try {
        content = readFileSync(new URL(`../skills/${def.file}`, import.meta.url), 'utf8')
      } catch (err) {
        ctx.logger('dsh-k8s').warn(
          'dsh-k8s: cannot read skills/%s, skill %s not registered: %s',
          def.file,
          def.name,
          err instanceof Error ? err.message : String(err),
        )
        continue
      }
      if (!content.trim()) {
        ctx.logger('dsh-k8s').warn('dsh-k8s: skills/%s is empty, skill %s not registered', def.file, def.name)
        continue
      }

      skillsCtx.effect(() => {
        const dispose = skills.register({
          name: def.name,
          description: def.description,
          source: 'runtime',
          content,
          invocation: { modelInvocable: true, userInvocable: true },
        })
        return dispose
      }, `dsh-k8s: skill ${def.name}`)
    }
  })
}