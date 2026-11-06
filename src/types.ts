import type { Volatile } from '@deepseek-ai/cordis'
import type {
  CoreV1Api,
  AppsV1Api,
  BatchV1Api,
  ApiextensionsV1Api,
  AdmissionregistrationV1Api,
  CustomObjectsApi,
  NetworkingV1Api,
} from '@kubernetes/client-node'

/** 单个集群配置：显示名 + 完整 kubeconfig（YAML）+ 可选 context 覆盖。 */
export interface ClusterConfig {
  readonly name: string
  readonly kubeconfig: string
  readonly context?: string
}

/** 模型侧配置（渲染为设置表单）。 */
export interface Config {
  clusters: Volatile<ClusterConfig[]>
}

/**
 * `makeApiClient` 返回的对象参数风格客户端集合。v1 中每个方法接受一个
 * request 对象并直接 resolve 资源对象，故此处的泛型别名用于统一取用。
 */
export interface KubeClients {
  core: CoreV1Api
  apps: AppsV1Api
  batch: BatchV1Api
  apiextensions: ApiextensionsV1Api
  admissionregistration: AdmissionregistrationV1Api
  customObjects: CustomObjectsApi
  networking: NetworkingV1Api
}
