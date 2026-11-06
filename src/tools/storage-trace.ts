import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { kubeconfigFor, clientsFor, namespaceOf } from '../config.js'
import type { Config as ConfigType } from '../types.js'

type Op = Record<string, any>
type Clients = ReturnType<typeof clientsFor>

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

function uniq(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))]
}

/** 取 PV 的 claimRef，返回 PVC 位置（可能跨命名空间）。 */
function claimRefOf(pv: Op): { namespace: string; name: string } | null {
  const ref = pv.spec?.claimRef
  if (!ref?.name) return null
  return { namespace: text(ref.namespace), name: text(ref.name) }
}

/** 返回引用某个 PVC 的所有 Pod 及挂载路径。 */
async function podsUsingPvc(clients: Clients, namespace: string, pvcName: string): Promise<string[]> {
  const res = await clients.core.listNamespacedPod({ namespace }) as unknown as Op
  const pods: string[] = []
  for (const pod of res.items ?? []) {
    const mounts = (pod.spec?.volumes ?? []).filter((v: Op) => text(v.persistentVolumeClaim?.claimName) === pvcName)
    if (mounts.length === 0) continue
    const name = text(pod.metadata?.name)
    const paths = mounts
      .map((v: Op) => {
        const mount = (pod.spec?.containers ?? [])
          .flatMap((c: Op) => c.volumeMounts ?? [])
          .find((m: Op) => m.name === v.name)
        return mount ? `:${mount.mountPath}` : ''
      })
      .join(',')
    pods.push(name + (paths ? ` (${paths})` : ''))
  }
  return uniq(pods)
}

function storageClassOf(pvc: Op): string {
  return text(pvc.spec?.storageClassName)
    ?? text(pvc.metadata?.annotations?.['volume.beta.kubernetes.io/storage-class'])
}

const PV_TYPES = ['hostPath', 'nfs', 'csi', 'awsElasticBlockStore', 'gcePersistentDisk',
  'azureDisk', 'cephfs', 'iscsi', 'fc', 'rbd', 'glusterfs', 'local'] as const

function pvTypeOf(pv: Op | null): string {
  if (!pv) return ''
  return Object.keys(pv.spec ?? {}).find(k => (PV_TYPES as readonly string[]).includes(k)) ?? ''
}

export function registerStorageTraceTools(ctx: Context, config: ConfigType): void {
  ctx.tools.register(defineTool({
    name: 'k8s_trace_storage',
    description: '追踪存储链路（只读）：PVC → PV（及 StorageClass）→ 使用该 PVC 的 Pod；'
      + '也支持从 PV 反查 PVC 和引用 Pod。用于定位 Pending 的 PVC、状态异常的 PV 与挂载失败问题。',
    parameters: {
      cluster: { type: 'string', required: true, description: '已配置集群的名称。' },
      namespace: { type: 'string', description: 'PVC 所在命名空间；不填则查所有命名空间。' },
      pvc: { type: 'string', description: 'PVC 名称。' },
      pv: { type: 'string', description: 'PV 名称；与 pvc 二选一（pv 优先）。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          chains: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                pvc: { type: 'string' }, namespace: { type: 'string' },
                status: { type: 'string' }, capacity: { type: 'string' },
                storageClass: { type: 'string' }, volumeMode: { type: 'string' },
                pv: { type: 'string' }, pvStatus: { type: 'string' },
                pvType: { type: 'string' }, reclaimPolicy: { type: 'string' },
                pods: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.chains.length === 0) {
          return [{ type: 'text', text: '未找到匹配的 PVC/PV。' }]
        }
        const rows = value.chains.map(chain => [
          `• PVC ${chain.namespace}/${chain.pvc}`,
          `status=${chain.status || '-'} capacity=${chain.capacity || '-'}`,
          `class=${chain.storageClass || '-'} mode=${chain.volumeMode || '-'}`,
          chain.pv ? `→ PV ${chain.pv}${chain.pvStatus ? ` (${chain.pvStatus})` : ''}${chain.pvType ? ` ${chain.pvType}` : ''}${chain.reclaimPolicy ? ` reclaim=${chain.reclaimPolicy}` : ''}` : '→ PV (未绑定)',
          chain.pods ? `使用 Pod:\n${chain.pods}` : '（当前无 Pod 引用）',
        ].filter(Boolean).join('  '))
        return [{ type: 'text', text: rows.join('\n') }]
      },
    },
    execute: async (args) => {
      const clients = clientsFor(kubeconfigFor(config, args.cluster))
      const chains: Op[] = []

      if (args.pv) {
        // 从 PV 出发
        let pv: Op
        try {
          pv = await clients.core.readPersistentVolume({ name: args.pv }) as unknown as Op
        } catch {
          throw new Error(`PV "${args.pv}" 不存在。`)
        }
        const claim = claimRefOf(pv)
        let pvc: Op | null = null
        if (claim) {
          try {
            pvc = await clients.core.readNamespacedPersistentVolumeClaim({
              name: claim.name, namespace: claim.namespace,
            }) as unknown as Op
          } catch {
            // PVC 已删除，但仍保留 claimRef
          }
        }
        chains.push({
          pvc: text(pvc?.metadata?.name ?? claim?.name ?? '(未绑定)'),
          namespace: text(pvc?.metadata?.namespace ?? claim?.namespace ?? ''),
          status: text(pvc?.status?.phase ?? '(未绑定)'),
          capacity: text(pvc?.status?.capacity?.storage) || text(pv.spec?.capacity?.storage) || '',
          storageClass: pvc ? storageClassOf(pvc) : '',
          volumeMode: text(pvc?.spec?.volumeMode) || '',
          pv: text(pv.metadata?.name),
          pvStatus: text(pv.status?.phase) || '',
          pvType: pvTypeOf(pv),
          reclaimPolicy: text(pv.spec?.persistentVolumeReclaimPolicy) || '',
          pods: claim ? (await podsUsingPvc(clients, claim.namespace, claim.name)).join('\n   ') : '',
        })
      } else {
        // 从 PVC 出发
        if (!args.pvc) throw new Error('请提供 pvc 或 pv 参数。')
        const targetNamespace = args.namespace ? namespaceOf(args.namespace) : undefined
        let items: Op[]
        if (targetNamespace) {
          const res = await clients.core.listNamespacedPersistentVolumeClaim({ namespace: targetNamespace }) as unknown as Op
          items = res.items ?? []
        } else {
          const res = await clients.core.listPersistentVolumeClaimForAllNamespaces({}) as unknown as Op
          items = res.items ?? []
        }
        const matched = items.filter((p: Op) => text(p.metadata?.name) === args.pvc)
        if (matched.length === 0) {
          throw new Error(`未找到 PVC "${args.pvc}"${targetNamespace ? ` 命名空间 ${targetNamespace}` : '（所有命名空间）'}。`)
        }
        for (const pvc of matched) {
          const ns = text(pvc.metadata?.namespace)
          let pv: Op | null = null
          const pvName = text(pvc.spec?.volumeName)
          if (pvName) {
            try {
              pv = await clients.core.readPersistentVolume({ name: pvName }) as unknown as Op
            } catch {
              // PV 已删除
            }
          }
          chains.push({
            pvc: text(pvc.metadata?.name),
            namespace: ns,
            status: text(pvc.status?.phase) || '',
            capacity: text(pvc.status?.capacity?.storage) || text(pvc.spec?.resources?.requests?.storage) || '',
            storageClass: storageClassOf(pvc),
            volumeMode: text(pvc.spec?.volumeMode) || '',
            pv: pv ? text(pv.metadata?.name) : pvName || '',
            pvStatus: pv ? text(pv.status?.phase) || '' : pvName ? '(PV 已删除)' : '',
            pvType: pvTypeOf(pv),
            reclaimPolicy: pv ? text(pv.spec?.persistentVolumeReclaimPolicy) || '' : '',
            pods: (await podsUsingPvc(clients, ns, text(pvc.metadata?.name))).join('\n   '),
          })
        }
      }

      return { chains }
    },
  }))
}