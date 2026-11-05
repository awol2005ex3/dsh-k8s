/**
 * dsh-k8s · 浏览器端 bundle 模块体（与 dsh-cdh 完全同构）。
 *
 * 构建契约：本文件经 tsc 编译后，由 scripts/wrap-client.mjs 包上
 *   window.__ModuleLoader__.load({ id, factory: (require) => { … } })
 * 成为惰性 CJS bundle。副作用全部在工厂闭包内，待浏览器 shell 物化时运行。
 *
 * 功能：
 * 1. Kubernetes 集群配置（名称 / 上下文 / kubeconfig 列表），读写走官方
 *    configForms（volatile 字段落盘 + 宿主热更新，无需重启）；
 * 2. 挂载策略逐级降级：settings.plugins.tab → settings.plugin.item →
 *    settings.section → 设置对话框 DOM 锚点兜底（dsh-cdh 同款）。
 *
 * ⚠ 本文件不能出现任何 import/export 语句；CJS 语义由 wrap-client.mjs 外壳提供。
 */

const PLUGIN_ID = 'dsh-k8s'
/** 配置命名空间 = profile 条目 id（cordis.patch.yml 里 `id: dsh-k8s`）。 */
const SETTINGS_NS = 'dsh-k8s'
const SECTION_LABEL = 'Kubernetes 集群'

/** 构建外壳（scripts/wrap-client.mjs 的 intro）注入的 CJS 语义，仅类型层面使用。 */
declare const module: { exports: unknown }
declare function require(id: string): any

const win = window as unknown as { __dshK8sMounted?: boolean }
const doc = document

/* ── 工具函数 ─────────────────────────────────────────────────────────── */

type ElProps = { style?: string; [key: string]: unknown }

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElProps,
  children?: (Node | string)[],
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag)
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (key === 'style') node.setAttribute('style', value as string)
      else (node as unknown as Record<string, unknown>)[key] = value
    }
  }
  if (children) {
    for (const c of children) node.append(typeof c === 'string' ? doc.createTextNode(c) : c)
  }
  return node
}

function service(ctx: any, name: string): any {
  try {
    if (typeof ctx?.get === 'function') return ctx.get(name)
    return ctx?.[name]
  } catch {
    return undefined
  }
}

/* ── 配置读写通道（官方 configForms，volatile 字段） ─────────────────── */

/** 面板中一行集群（与宿主 Config schema 的 clusterEntry 同构；context 恒为字符串）。 */
interface ClusterRow {
  name: string
  kubeconfig: string
  context: string
}

interface SettingsChannel {
  read(): Promise<ClusterRow[]>
  write(rows: ClusterRow[]): Promise<void>
}

function normalizeRow(value: unknown): ClusterRow {
  const v = (value ?? {}) as Record<string, unknown>
  return {
    name: typeof v.name === 'string' ? v.name : '',
    kubeconfig: typeof v.kubeconfig === 'string' ? v.kubeconfig : '',
    context: typeof v.context === 'string' ? v.context : '',
  }
}

/** 写入负载：context 为空时省略（宿主按「不覆盖 current-context」处理）。 */
function toWire(rows: ClusterRow[]): Array<Record<string, string>> {
  return rows.map((row) => {
    const wire: Record<string, string> = { name: row.name, kubeconfig: row.kubeconfig }
    if (row.context) wire.context = row.context
    return wire
  })
}

function configFormsChannel(ctx: any): SettingsChannel | undefined {
  const forms = service(ctx, 'configForms')
  if (!forms || typeof forms.get !== 'function') return undefined

  /**
   * 探测命名空间是否可用。不缓存结果：镜像异步拉取，插件启动时多半还没就绪，
   * 首次探测失败即永久降级会让面板永远失去读写能力。镜像尚未到达时先返回
   * true，交由 waitReady() 等待。
   */
  function ensure(): boolean {
    try {
      const mirror = typeof forms.describe === 'function' ? forms.describe() : undefined
      const snap = mirror?.getSnapshot?.()
      if (!snap || !snap.view) return true // 镜像还在路上，等
      return snap.view.namespaces?.some((row: any) => row?.ns === SETTINGS_NS) === true
    } catch {
      return false
    }
  }

  if (!ensure()) return undefined

  const form = (): any => forms.get(SETTINGS_NS)

  async function waitReady(): Promise<any> {
    const snap = form().getSnapshot()
    if (snap?.status === 'ready') return snap
    return new Promise((resolve, reject) => {
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        off?.()
        reject(new Error('读取配置超时（宿主配置镜像未就绪）'))
      }, 15000)
      const off = typeof form().subscribe === 'function' ? form().subscribe(check) : undefined
      function check(): void {
        if (done) return
        const s = form().getSnapshot()
        if (s?.status === 'ready') {
          done = true
          clearTimeout(timer)
          off?.()
          resolve(s)
        } else if (s?.status === 'unavailable') {
          done = true
          clearTimeout(timer)
          off?.()
          reject(new Error('宿主未暴露 dsh-k8s 配置命名空间，请确认宿主插件已加载'))
        }
      }
      check()
    })
  }

  return {
    read: async () => {
      const snap = await waitReady()
      const value = (snap.value ?? {}) as Record<string, unknown>
      const list = Array.isArray(value.clusters) ? value.clusters : []
      return list.map(normalizeRow)
    },
    write: async (rows) => {
      const snap = await waitReady()
      if (snap.writable !== true) throw new Error('当前配置为只读，无法保存')
      const ok = await form().mutate(
        [{ op: 'set', path: ['clusters'], value: toWire(rows) as any }],
        snap.revision,
      )
      if (ok !== true) throw new Error('保存被宿主拒绝（配置可能已被其他窗口修改，请点「重新读取」后重试）')
    },
  }
}

/** 运行时择优建通道：每次读写都重新探测 configForms（镜像可能稍后才就绪）。 */
function createChannel(ctx: any): SettingsChannel {
  const required = (): SettingsChannel => {
    const channel = configFormsChannel(ctx)
    if (!channel) throw new Error('当前 dsh 未提供设置表单服务（configForms），无法在此编辑配置')
    return channel
  }
  return {
    read: () => required().read(),
    write: (rows) => required().write(rows),
  }
}

/* ── 面板 ─────────────────────────────────────────────────────────────── */

const PANEL_CSS =
  'color:inherit;font:13px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;' +
  'display:flex;flex-direction:column;gap:10px;max-width:640px;'
const ROW_CSS = 'display:grid;grid-template-columns:96px 1fr;gap:8px;align-items:start;'
const LABEL_CSS = 'font-weight:600;font-size:12.5px;padding-top:6px;'
const INPUT_CSS =
  'width:100%;box-sizing:border-box;padding:6px 8px;font-size:13px;font-family:inherit;' +
  'border:1px solid rgba(127,127,127,.4);border-radius:6px;background:transparent;color:inherit;'
const AREA_CSS =
  INPUT_CSS +
  'min-height:132px;resize:vertical;line-height:1.45;' +
  'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;'
const HINT_CSS = 'color:rgba(127,127,127,.95);font-size:12px;margin:0;'
const CARD_CSS =
  'border:1px solid rgba(127,127,127,.35);border-radius:8px;padding:10px 12px;' +
  'display:flex;flex-direction:column;gap:8px;'
const CARD_HEAD_CSS = 'display:flex;justify-content:space-between;align-items:center;font-weight:600;font-size:13px;'
const BTN_CSS =
  'padding:6px 14px;font-size:13px;cursor:pointer;border:1px solid rgba(127,127,127,.4);' +
  'background:transparent;color:inherit;border-radius:6px;'
const BTN_PRIMARY_CSS =
  'padding:6px 14px;font-size:13px;cursor:pointer;border:none;background:#1f6feb;color:#fff;border-radius:6px;'
const BTN_SM_CSS =
  'padding:2px 10px;font-size:12px;cursor:pointer;border:1px solid rgba(127,127,127,.4);' +
  'background:transparent;color:inherit;border-radius:6px;'
const STATUS_OK = 'color:#1a7f37;font-size:12.5px;white-space:pre-wrap;'
const STATUS_ERR = 'color:#cf222e;font-size:12.5px;white-space:pre-wrap;'

interface PanelHandle {
  root: HTMLElement
  refresh(): Promise<void>
}

function makeButton(label: string, onClick: () => void, style?: string): HTMLButtonElement {
  const btn = el('button', { type: 'button', textContent: label, style: style ?? BTN_CSS })
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    onClick()
  })
  return btn
}

function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  const cells: HTMLElement[] = [el('div', { style: LABEL_CSS, textContent: label })]
  if (hint) {
    cells.push(el('div', {}, [input, el('p', { style: HINT_CSS, textContent: hint })]))
  } else {
    cells.push(input)
  }
  return el('div', { style: ROW_CSS }, cells)
}

function buildPanel(ctx: any): PanelHandle {
  const channel = createChannel(ctx)
  let rows: ClusterRow[] = []

  const listHost = el('div', { style: 'display:flex;flex-direction:column;gap:10px;' })
  const status = el('div', { style: HINT_CSS, textContent: '正在读取配置…' })

  function setStatus(text: string, ok: boolean): void {
    status.textContent = text
    status.setAttribute('style', ok ? STATUS_OK : STATUS_ERR)
  }

  function textInput(value: string, placeholder: string, onInput: (v: string) => void): HTMLInputElement {
    const input = el('input', { placeholder, style: INPUT_CSS }) as HTMLInputElement
    input.value = value
    input.addEventListener('input', () => onInput(input.value))
    return input
  }

  function renderRows(): void {
    listHost.replaceChildren()
    if (rows.length === 0) {
      listHost.append(el('p', { style: HINT_CSS, textContent: '暂无集群。点「＋ 添加集群」新增第一个。' }))
      return
    }
    rows.forEach((row, i) => {
      const nameInput = textInput(row.name, '如 prod / staging', (v) => { row.name = v })
      const contextInput = textInput(row.context, '留空使用 kubeconfig 的 current-context', (v) => { row.context = v })
      const kubeInput = el('textarea', { placeholder: '粘贴该集群的 kubeconfig YAML（apiVersion: v1 …）', style: AREA_CSS, rows: '6' }) as HTMLTextAreaElement
      kubeInput.value = row.kubeconfig
      kubeInput.addEventListener('input', () => { row.kubeconfig = kubeInput.value })
      listHost.append(el('div', { style: CARD_CSS }, [
        el('div', { style: CARD_HEAD_CSS }, [
          el('span', { textContent: `集群 ${i + 1}` }),
          makeButton('删除', () => { rows.splice(i, 1); renderRows() }, BTN_SM_CSS),
        ]),
        field('集群名称', nameInput),
        field('上下文', contextInput, '可选：覆盖 kubeconfig 的 current-context'),
        field('kubeconfig', kubeInput, '完整 YAML，仅保存在本机 profile'),
      ]))
    })
  }

  const saveBtn = makeButton('保存配置', async () => {
    const cleaned: ClusterRow[] = []
    for (let i = 0; i < rows.length; i++) {
      const name = rows[i].name.trim()
      const kubeconfig = rows[i].kubeconfig.trim()
      const context = rows[i].context.trim()
      if (!name && !kubeconfig && !context) continue // 整行为空：视为未使用
      if (!name) { setStatus(`集群 ${i + 1}：请填写集群名称`, false); return }
      if (!kubeconfig) { setStatus(`集群 ${i + 1}：请粘贴 kubeconfig 内容`, false); return }
      cleaned.push({ name, kubeconfig, context })
    }
    const seen = new Set<string>()
    for (const row of cleaned) {
      if (seen.has(row.name)) { setStatus(`集群名称重复：${row.name}`, false); return }
      seen.add(row.name)
    }
    saveBtn.disabled = true
    setStatus('正在保存…', true)
    try {
      await channel.write(cleaned)
      rows = cleaned
      renderRows()
      setStatus('已保存，宿主已热更新（无需重启）。', true)
    } catch (err) {
      setStatus(err instanceof Error ? `保存失败：${err.message}` : '保存失败', false)
    } finally {
      saveBtn.disabled = false
    }
  }, BTN_PRIMARY_CSS)

  const addBtn = makeButton('＋ 添加集群', () => {
    rows.push({ name: '', kubeconfig: '', context: '' })
    renderRows()
  })
  const reloadBtn = makeButton('重新读取', () => { void refresh() })

  async function refresh(): Promise<void> {
    setStatus('正在读取配置…', true)
    try {
      rows = await channel.read()
      renderRows()
      setStatus(rows.length > 0 ? `已加载 ${rows.length} 个集群。` : '已加载：当前没有配置集群。', true)
    } catch (err) {
      setStatus(err instanceof Error ? `读取配置失败：${err.message}` : '读取配置失败', false)
    }
  }

  const root = el('div', { style: PANEL_CSS, id: 'dsh-k8s-panel' }, [
    el('div', { style: 'font-weight:700;font-size:15px;', textContent: '☸ Kubernetes · 集群配置' }),
    el('p', {
      style: HINT_CSS,
      textContent:
        '这里维护 dsh-k8s 工具可访问的 Kubernetes 集群。保存后宿主立即热更新；' +
        '连通性验证可在会话中让助手调用 k8s_test_connection。',
    }),
    listHost,
    el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;' }, [saveBtn, addBtn, reloadBtn]),
    status,
  ])

  renderRows()
  void refresh()
  return { root, refresh }
}

/* ── 挂载（slots 优先，DOM 兜底；与 dsh-cdh 一致） ───────────────────── */

const SETTINGS_SLOT_CANDIDATES: Array<[string, Record<string, unknown>]> = [
  ['settings.plugins.tab', { id: SETTINGS_NS, order: 20, label: SECTION_LABEL }],
  ['settings.plugin.item', { key: SETTINGS_NS, label: SECTION_LABEL }],
  ['settings.section', { id: PLUGIN_ID, label: SECTION_LABEL, title: SECTION_LABEL }],
]

function createSettingsComponent(React: any, handle: PanelHandle): any {
  return function K8sSettings() {
    const ref = React.useRef(null)
    React.useEffect(function () {
      const node = ref.current as HTMLElement | null
      if (!node) return
      node.appendChild(handle.root)
      void handle.refresh()
    }, [])
    return React.createElement('div', { ref, 'data-dsh-k8s-settings': 'true' })
  }
}

/** 回退：设置对话框里的可挂载锚点。 */
function findSettingsHost(): HTMLElement | null {
  const selectors = [
    '[data-slot="settings.plugin.item"]',
    '[data-slot="settings.plugins.tab"]',
    '[data-slot="settings.section"]',
    '[data-slot="settings.content"]',
    '[data-slot="settings.body"]',
  ]
  for (const selector of selectors) {
    const node = doc.querySelector(selector)
    if (node instanceof HTMLElement) return node
  }
  return null
}

function mountPanelInSettings(panel: HTMLElement, refresh: () => void): void {
  const host = findSettingsHost()
  if (!host) {
    if (panel.parentElement) panel.remove()
    return
  }
  if (panel.parentElement !== host) {
    host.append(panel)
    refresh()
  }
}

/** 注册设置页插槽；成功返回 true（调用方据此决定是否启用 DOM 兜底）。 */
function tryRegisterSettingsSlot(ctx: any, handle: PanelHandle, onSlotted: () => void): boolean {
  let wired = false
  let mounted = false

  const register = (slots: any): void => {
    if (wired || !slots || typeof slots.inject !== 'function') return
    let React: any
    try {
      React = require('react')
    } catch {
      return
    }
    if (!React || typeof React.createElement !== 'function') return
    wired = true

    const Comp = createSettingsComponent(React, handle)
    const priority = new Map(SETTINGS_SLOT_CANDIDATES.map(([name], index) => [name, index]))
    const mountedAt = new Set<string>()
    const declared = (name: string): boolean => {
      if (typeof slots.specDynamic !== 'function') return false
      try {
        return Boolean(slots.specDynamic(name))
      } catch {
        return false
      }
    }

    for (const [name, opts] of SETTINGS_SLOT_CANDIDATES) {
      try {
        slots.inject(name, () => {
          // 高优先级插槽已声明时不再重复挂载
          for (const [other] of SETTINGS_SLOT_CANDIDATES) {
            if (priority.get(other)! < priority.get(name)! && declared(other)) return
          }
          if (mountedAt.size > 0 && !mountedAt.has(name)) return
          const dispose = slots.register({ name, ...opts }, Comp)
          mountedAt.add(name)
          mounted = true
          onSlotted()
          return () => {
            mountedAt.delete(name)
            if (typeof dispose === 'function') dispose()
          }
        })
      } catch {
        // 单个插槽注入失败不影响其余候选
      }
    }
  }

  try {
    if (typeof ctx?.inject === 'function') ctx.inject(['slots'], (scope: any) => register(scope?.slots))
    register(service(ctx, 'slots'))
  } catch {
    // 回退到 DOM 挂载
  }
  return mounted
}

/* ── 客户端插件契约（浏览器半 fiber；inject 声明 connection） ───────────── */

function apply(ctx: any): void {
  if (win.__dshK8sMounted === true) return
  win.__dshK8sMounted = true

  const handle = buildPanel(ctx)
  // 插槽注册在 inject 回调里异步生效；注册成功前先用 DOM 兜底。
  // ⚠ 两者必须互斥：`[data-slot="settings.section"]` 是所有设置分区**共享**的
  // 单一容器（宿主按 only:active 渲染当前分区），面板一旦被兜底搬进去，
  // 每个配置 tab 都会出现 K8s 配置项。onSlotted 里必须断开 observer。
  let slotted = false
  let observer: MutationObserver | undefined

  function stopFallback(): void {
    slotted = true
    observer?.disconnect()
    observer = undefined
    const anchor = doc.querySelector('[data-dsh-k8s-settings]')
    if (anchor) {
      if (handle.root.parentElement !== anchor) anchor.appendChild(handle.root)
    } else if (handle.root.parentElement) {
      // 插槽组件还没挂载（对话框未开 / 未切到本 tab）：先摘除，
      // 组件挂载时它的 effect 会把面板 append 回来。
      handle.root.remove()
    }
  }

  slotted = tryRegisterSettingsSlot(ctx, handle, stopFallback)
  if (!slotted) {
    observer = new MutationObserver(() => {
      if (!slotted) mountPanelInSettings(handle.root, handle.refresh)
    })
    observer.observe(doc.documentElement, { childList: true, subtree: true })
  }
}

// 工厂返回值即插件模块表：loader 从中读取 name / inject / apply 组装 fiber。
module.exports = { name: PLUGIN_ID, inject: ['connection'], apply }
