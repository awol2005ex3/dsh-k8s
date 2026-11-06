import type { ResourceRegistry } from './types.js'
import { coreResources } from './core.js'
import { workloadResources } from './workloads.js'
import { networkingResources } from './networking.js'
import { storageResources } from './storage.js'
import { autoscalingResources } from './autoscaling.js'
import { policyResources } from './policy.js'
import { rbacResources } from './rbac.js'
import { schedulingResources } from './scheduling.js'
import { coordinationResources } from './coordination.js'
import { certificatesResources } from './certificates.js'
import { apiregistrationResources } from './apiregistration.js'

/**
 * 所有可查看资源类型的汇总表。
 * 新增资源类型时只需在对应领域模块补充条目，这里做一次聚合。
 * 注意：顺序决定文档/参数描述里的展示顺序。
 */
export const RESOURCES: ResourceRegistry = {
  ...coreResources,
  ...workloadResources,
  ...networkingResources,
  ...storageResources,
  ...autoscalingResources,
  ...policyResources,
  ...rbacResources,
  ...schedulingResources,
  ...coordinationResources,
  ...certificatesResources,
  ...apiregistrationResources,
}

/** `k8s_list_resources` / `k8s_get_resource` 的 kind 取值。 */
export const RESOURCE_KINDS = Object.keys(RESOURCES)
