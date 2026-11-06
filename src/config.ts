import * as k8s from '@kubernetes/client-node'
import type { ClusterConfig, Config as ConfigType, KubeClients } from './types.js'
import z from '@deepseek-ai/schemastery'

const clusterEntry = z.object({
  name: z.string().required().description('唯一集群标识，例如 prod-cluster。'),
  kubeconfig: z.string().required().role('textarea').description('该集群的 kubeconfig 字符串，粘贴完整 YAML。'),
  context: z.string().description('可选：覆盖 kubeconfig 的 current-context。'),
})

/** Schemastery 配置载体；volatile 字段渲染为设置表单并支持热更新。 */
export const Config = z.object({
  clusters: z.array(clusterEntry).default([]).volatile(),
}) as z<ConfigType>

/** 解包 volatile 引用；兼容旧 dsh 普通数组与测试替身。 */
export function unwrap(config: ConfigType): readonly ClusterConfig[] {
  const v = config.clusters
  const ref = v as unknown as { get?: () => readonly ClusterConfig[] } | undefined
  if (typeof ref?.get === 'function') {
    try { return ref.get() } catch { return [] }
  }
  return v as unknown as readonly ClusterConfig[]
}

function listNames(clusters: readonly ClusterConfig[]): string {
  return clusters.length === 0 ? '（无）' : clusters.map((c) => c.name).join('、')
}

/** 解析集群名 → 已加载 kubeconfig 的 KubeConfig（含 context 校验）。 */
export function kubeconfigFor(config: ConfigType, name: string): k8s.KubeConfig {
  const clusters = unwrap(config)
  const entry = clusters.find((c) => c.name === name)
  if (!entry) throw new Error(`未配置集群 "${name}"，请在 设置→插件 中添加。已知集群：${listNames(clusters)}`)
  const kc = new k8s.KubeConfig()
  try {
    kc.loadFromString(entry.kubeconfig)
  } catch (error) {
    throw new Error(`集群 "${name}" 的 kubeconfig 无法解析：${(error as Error).message}`)
  }
  if (entry.context) {
    if (!kc.getContexts().some((c) => c.name === entry.context)) {
      throw new Error(`集群 "${name}" 指定的 context "${entry.context}" 不存在`)
    }
    kc.setCurrentContext(entry.context)
  }
  return kc
}

/**
 * 由 KubeConfig 构造一组对象参数风格 API 客户端。
 * 全部为只读用途，不暴露任何写操作。
 */
export function clientsFor(kc: k8s.KubeConfig): KubeClients {
  return {
    core: kc.makeApiClient(k8s.CoreV1Api),
    apps: kc.makeApiClient(k8s.AppsV1Api),
    batch: kc.makeApiClient(k8s.BatchV1Api),
    apiextensions: kc.makeApiClient(k8s.ApiextensionsV1Api),
    admissionregistration: kc.makeApiClient(k8s.AdmissionregistrationV1Api),
    customObjects: kc.makeApiClient(k8s.CustomObjectsApi),
    networking: kc.makeApiClient(k8s.NetworkingV1Api),
  }
}

/** 工具参数取 namespace 的统一收口（默认 default）。 */
export function namespaceOf(namespace: string | undefined): string {
  return namespace ?? 'default'
}
