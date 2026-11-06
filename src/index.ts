import { Context } from '@deepseek-ai/cordis'
import { registerClusterTools } from './tools/clusters.js'
import { registerWorkloadTools } from './tools/workloads.js'
import { registerCrdTools } from './tools/crds.js'
import { registerNetworkingTools } from './tools/networking.js'
import { registerWebhookTools } from './tools/webhooks.js'
import { registerGatewayTools } from './tools/gateway.js'
import { registerExecTools } from './tools/exec.js'
import { registerMetricsTools } from './tools/metrics.js'

// dsh 约定：入口模块导出 Config schema 常量（volatile 字段渲染为设置表单）。
export { Config } from './config.js'
export type { ClusterConfig, Config as ConfigType } from './types.js'

export const name = 'dsh-k8s'

export const inject = ['tools'] as const

/**
 * 只读排查工具集：全部通过 @kubernetes/client-node 调用，不依赖 kubectl。
 * 不含任何 create / patch / delete / replace 等写操作。
 *
 *   clusters.ts  — 集群列表 / 连接测试 / 节点
 *   workloads.ts — Pod / 日志 / 非 Pod 组件（Deployment/Service/ConfigMap/…）
 *   crds.ts      — CRD 定义与实例
 *   networking.ts— Ingress / IngressClass
 *   webhooks.ts  — 准入 Webhook（Validating / Mutating）
 *   gateway.ts   — Gateway API（GatewayClass/Gateway/Route/…）
 *   exec.ts      — Pod 内命令执行（排查用）
 *   metrics.ts   — metrics-server 指标
 */
export function apply(ctx: Context, config: import('./types.js').Config): void {
  registerClusterTools(ctx, config)
  registerWorkloadTools(ctx, config)
  registerCrdTools(ctx, config)
  registerNetworkingTools(ctx, config)
  registerWebhookTools(ctx, config)
  registerGatewayTools(ctx, config)
  registerExecTools(ctx, config)
  registerMetricsTools(ctx, config)
}
