import { Context } from '@deepseek-ai/cordis'
import { registerClusterTools } from './tools/clusters.js'
import { registerWorkloadTools } from './tools/workloads.js'
import { registerResourceTools } from './tools/resources.js'
import { registerCrdTools } from './tools/crds.js'
import { registerNetworkingTools } from './tools/networking.js'
import { registerWebhookTools } from './tools/webhooks.js'
import { registerGatewayTools } from './tools/gateway.js'
import { registerExecTools } from './tools/exec.js'
import { registerMetricsTools } from './tools/metrics.js'
import { registerMultiLogTools } from './tools/multi-logs.js'
import { registerIngressTools } from './tools/ingress.js'
import { registerHelmTools } from './tools/helm.js'
import { registerStorageTraceTools } from './tools/storage-trace.js'
import { registerDomainTools } from './tools/domains.js'
import { registerEventTools } from './tools/events.js'
import { registerNetworkPolicyTools } from './tools/network-policy.js'
import { registerDiagnoseTools } from './tools/diagnose.js'
import { registerIstioTools } from './tools/istio.js'
import { registerComponentStatusTools } from './tools/component-status.js'

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
 *   workloads.ts — Pod 列表 / 日志
 *   resources.ts — 基础资源列表与单资源详情（按领域拆分在 resources/）
 *   crds.ts      — CRD 定义与实例
 *   networking.ts— Ingress / IngressClass
 *   webhooks.ts  — 准入 Webhook（Validating / Mutating）
 *   gateway.ts   — Gateway API（GatewayClass/Gateway/Route/…）
 *   exec.ts      — Pod 内命令执行（排查用）
 *   metrics.ts   — metrics-server 指标
 *   multi-logs.ts— 多 Pod 日志（按工作负载 / labelSelector）
 *   ingress.ts   — Ingress 体检与 URL 链路追踪
 *   helm.ts      — Helm 3 release 只读查看（解析 Secret，不依赖 helm 命令）
 *   storage-trace.ts — PV / PVC → Pod 存储链路
 *   domains.ts   — DNS 域名查询（coredns Corefile + Service FQDN）
 *   events.ts    — 事件过滤诊断
 *   network-policy.ts — NetworkPolicy 覆盖分析
 *   diagnose.ts  — 单 Pod 一步排障
 *   istio.ts     — Istio VirtualService 链路追踪
 *   component-status.ts — 集群组件状态
 */
export function apply(ctx: Context, config: import('./types.js').Config): void {
  registerClusterTools(ctx, config)
  registerWorkloadTools(ctx, config)
  registerResourceTools(ctx, config)
  registerCrdTools(ctx, config)
  registerNetworkingTools(ctx, config)
  registerWebhookTools(ctx, config)
  registerGatewayTools(ctx, config)
  registerExecTools(ctx, config)
  registerMetricsTools(ctx, config)
  registerMultiLogTools(ctx, config)
  registerIngressTools(ctx, config)
  registerHelmTools(ctx, config)
  registerStorageTraceTools(ctx, config)
  registerDomainTools(ctx, config)
  registerEventTools(ctx, config)
  registerNetworkPolicyTools(ctx, config)
  registerDiagnoseTools(ctx, config)
  registerIstioTools(ctx, config)
  registerComponentStatusTools(ctx, config)
}