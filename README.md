# dsh-k8s

DeepSeek Harness (dsh) plugin for operating multiple Kubernetes clusters across different k8s versions.

- **多个集群运维**：在插件的设置表单里配置任意多个集群，每个集群粘贴一份完整 kubeconfig 字符串。
- **基于官方 Node.js 客户端 `@kubernetes/client-node`**（v1 稳定 promise API），兼容不同 k8s 版本。
- **完全不依赖 `kubectl`**：所有读取、CRD 查询、Pod 内命令执行、指标读取都直接走 K8s API。
- **只读排障**：不含任何 create / patch / delete / replace 写操作，专用于定位问题。

## 安装

```bash
npx @deepseek-ai/dsh plugin --profile web add .
```

安装后重启宿主，然后在 **设置 → 插件 → dsh-k8s** 里粘贴各集群的 kubeconfig。

## 配置

插件唯一配置是一个 `clusters` 数组，每项包含：

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | 唯一集群标识（如 `prod-cluster`），工具调用时用该名称选择集群 |
| `kubeconfig` | 是 | 该集群的完整 kubeconfig 字符串（粘贴 YAML） |
| `context` | 否 | 覆盖 kubeconfig 的 `current-context`，指定要使用的 context 名 |

对应 cordis.yml 示例：

```yaml
plugin:
  dsh-k8s:
    clusters:
      - name: prod-cluster
        kubeconfig: |
          apiVersion: v1
          kind: Config
          current-context: prod-admin
          clusters:
            - name: prod
              cluster:
                server: https://k8s.example.com:6443
                certificate-authority-data: ...
          contexts: [...]
          users: [...]
```

> 注意：修改配置会重挂插件（重新注册工具），属正常行为。

## 工具

### 集群与节点

| 工具 | 说明 |
|------|------|
| `k8s_list_clusters` | 列出已配置集群及 server 与当前 context |
| `k8s_test_connection` | 测试与指定集群的连接，返回 server 与节点数 |
| `k8s_list_nodes` | 列出指定集群的节点、就绪状态、版本与内网 IP |

### 工作负载与配置

| 工具 | 说明 |
|------|------|
| `k8s_list_pods` | 列出指定命名空间的 Pod、运行阶段与重启次数 |
| `k8s_read_pod_logs` | 读取指定 Pod 的日志（默认最近 200 行）；支持 `container`、`previous`（上一次容器实例，排查 CrashLoopBackOff）与 `sinceSeconds` |
| `k8s_list_resources` | 按 `kind` 列出任意已支持的基础资源。`namespace` 留空或填 `*` 表示所有命名空间（集群级资源忽略该参数） |
| `k8s_get_resource` | 查看单个资源详情：Pod / Node / Service / 工作负载有专门摘要，其余类型回退为 spec/status JSON |

`k8s_list_resources` / `k8s_get_resource` 支持的 `kind`：

- **核心**：`pods` · `namespaces` · `nodes` · `services` · `configmaps` · `secrets` · `events` · `serviceaccounts` · `resourcequotas` · `limitranges`
- **工作负载**：`deployments` · `statefulsets` · `daemonsets` · `replicasets` · `jobs` · `cronjobs`
- **网络**：`endpoints` · `endpointslices` · `networkpolicies` · `ingresses`
- **存储**：`pvs` · `pvcs` · `storageclasses` · `csidrivers` · `csinodes` · `volumeattachments`
- **扩缩容 / 策略**：`horizontalpodautoscalers` · `poddisruptionbudgets`
- **RBAC / 调度 / 其他**：`roles` · `rolebindings` · `clusterroles` · `clusterrolebindings` · `priorityclasses` · `runtimeclasses` · `leases` · `certificatesigningrequests` · `apiservices`

> Secret 只返回类型与 key 数量等元信息，不返回内容。

### 网络入口

| 工具 | 说明 |
|------|------|
| `k8s_list_ingresses` | 列出 Ingress，含 `class`、主机名、TLS 与负载均衡地址；不填 `namespace` 时读取所有命名空间 |
| `k8s_list_ingress_classes` | 列出 IngressClass，含 controller、是否为默认类与 parameters |

### Gateway API

| 工具 | 说明 |
|------|------|
| `k8s_list_gateway_api` | 查看 Gateway API 资源，自动发现集群实际安装的 CRD 与版本；`kind` 缺省 `all` |

`kind` 可选值：

`gatewayclasses` · `gateways` · `httproutes` · `grpcroutes` · `tcproutes` · `tlsroutes` · `udproutes` · `referencegrants` · `backendtlspolicies`

> 未安装 Gateway API CRD 的集群会返回 `installed: false`，不会报错。Gateway 摘要含 class / listeners / 地址 / Accepted / Programmed，路由摘要含 hosts / parents / backends / Accepted。

### 准入 Webhook

| 工具 | 说明 |
|------|------|
| `k8s_list_webhooks` | 列出 Validating / Mutating Webhook，含调用目标（Service 或 URL）、`failurePolicy`、`sideEffects`、匹配规则，以及 caBundle 的证书解析（Subject / 有效期 / 是否过期） |

示例：`{ cluster: "prod", type: "validating" }`。用于排查准入拒绝、Webhook 超时与证书（caBundle）过期问题。

### CRD

| 工具 | 说明 |
|------|------|
| `k8s_list_crds` | 列出集群内所有 CRD 定义（group / kind / plural / scope / versions） |
| `k8s_list_crd_instances` | 按 `group` + `version` + `plural` 列出该 CRD 的实例；给 `namespace` 走命名空间范围，否则按集群范围读取 |

### Pod 内排查

| 工具 | 说明 |
|------|------|
| `k8s_pod_exec` | 在容器内执行命令（WebSocket exec 子资源），返回 `output` 与真实 `exitCode` |
| `k8s_search_pod_exec` | 多 Pod 批量执行同一条只读命令并按 grep 语义过滤输出（见「大规模 Pod 搜索」） |

示例：`{ pod: "coredns-xxx", namespace: "kube-system", command: ["sh", "-c", "ps aux"] }`。
多容器 Pod 用 `container` 指定容器名。**该工具定位是只读排查**（ps / netstat / cat / env / curl / nslookup 等），不做任何写操作封装。

### 指标

| 工具 | 说明 |
|------|------|
| `k8s_read_metrics` | 读取 metrics-server 指标；`type: pods`（按命名空间）或 `type: nodes` |

集群未安装 metrics-server 时会直接报错，属预期行为。

### Ingress 体检与链路追踪

| 工具 | 说明 |
|------|------|
| `k8s_audit_ingresses` | 体检 Ingress：TLS Secret 是否存在、证书是否过期/即将过期（`expireDays`，缺省 30）、证书是否覆盖 host、backend Service 与端口是否存在、是否缺 `ingressClassName` |
| `k8s_trace_ingress` | 按 URL / host 追踪 Ingress 链路：Ingress → Service → Endpoints/EndpointSlice → Pods，附带 TLS 证书摘要；用于定位 404 / 502 / 503 是规则、Service 还是 Pod 的问题 |

`k8s_trace_ingress` 示例：`{ cluster: "prod", url: "https://www.example.com/api" }`。
路径按 `Exact` / `Prefix` 语义匹配，host 支持单层通配符；`ImplementationSpecific` 按 Prefix 处理并标注。

### 多 Pod 日志

| 工具 | 说明 |
|------|------|
| `k8s_read_pod_logs_multi` | 按工作负载（`kind` + `name`）或 `labelSelector` 批量读取多个 Pod 的日志，等价于 stern / `kubectl logs -l`，但不需要外部命令。单次默认最多 20 个 Pod、每容器 100 行，可调 `maxPods` / `tailLines` |
| `k8s_search_pod_logs` | 多 Pod 日志批量 grep（`-A/-B` 上下文、正则 / 忽略大小写），见「大规模 Pod 搜索」 |
| `k8s_scan_java_pods` | 识别 Java 应用容器并解析 JVM 参数与红线告警，见「大规模 Pod 搜索」 |

并发控制在 5 以内，自动排除已 Succeeded 的 Pod；多 Pod 时每行带 `[pod/container]` 前缀。

### 大规模 Pod 搜索（grep 语义，替代 `kubectl logs/exec | grep -A -B`）

排查「几十个 Pod 里哪些日志出现 xxx」「逐个 exec 再 grep 太慢」时使用。三个工具共享同一套参数与输出结构：

| 工具 | 说明 |
|------|------|
| `k8s_search_pod_logs` | 批量读取多个 Pod 的日志并按 `grep -A/-B` 语义返回命中行与上下文。替代 `for pod in ...; do kubectl logs $pod \| grep xxx -A 11 -B 20; done` |
| `k8s_search_pod_exec` | 在多个 Pod 容器内批量执行同一条**只读**命令，对输出按 `grep -A/-B` 语义搜索。替代 `kubectl exec ... \| grep zzz -A 111 -B 20` |
| `k8s_scan_java_pods` | 扫描多个 Pod，识别哪些是 Java 应用并解析 JVM 参数（`-Xmx` / `-Xms` / `-Xmn` / Metaspace / 线程数），与 `limits.memory` 比对给出红线告警 |

共享参数（三个工具一致）：

- **范围**：`labelSelector` 或 `kind` + `name`（deployment/statefulset/daemonset/replicaset/job）、`namespace` / `allNamespaces`、`podNameRegex` 正则再过滤、`container` 指定容器、`includeCompleted`、`maxPods`（缺省 50，上限 500）、`concurrency`（缺省 5）。
- **grep 语义**：`pattern` 必填；`regex`（等价 `-E`）、`ignoreCase`（等价 `-i`）、`before`（等价 `-B`）、`after`（等价 `-A`）。命中行 `:` 标记、上下文行 `-` 标记、多段命中 `--` 分隔，与 `grep -n` 输出一致。
- **防刷屏闸门**：`maxMatches`（单容器流命中上限）、`maxTotalMatches`（全局命中上限）、`maxChars`（渲染文本字符上限），任一触达即 `truncated: true`。
- **输出**：摘要（扫描数 / 命中数）+ 命中容器清单 + 带标签 `[namespace/pod/container]` 的上下文原文 + 读取失败列表。

`k8s_search_pod_logs` 额外支持 `tailLines`（缺省 500）、`sinceSeconds`、`timestamps`、`previous`（上次容器实例）。

`k8s_search_pod_exec` 的 `command` 仅限只读命令（`ps` / `env` / `cat` / `ls` 等），破坏性命令（rm / dd / mkfs / kill 等）会被直接拒绝；输出头部附非零退出码。

`k8s_scan_java_pods` 两阶段取证：先从 Pod spec（command / args / `JAVA_OPTS` 类 env）识别，再对容器内执行只读取证脚本（`/proc/1/cmdline`、`ps`、`env`、`/proc/*/task` 线程计数）合并证据。红线判读与 `dsh-k8s-jvm-diagnosis` 知识卡一致：

- `-Xmx` 超过容器 `limits.memory`（运行时堆被压限甚至 OOMKilled）
- `-Xms` 超过容器 `limits.memory`（启动即可能崩溃）
- `-Xms` > `-Xmx`（调优错误）

示例：`{ cluster: "prod", allNamespaces: true, pattern: "OutOfMemoryError", ignoreCase: true, after: 11, before: 20 }`
示例：`{ cluster: "prod", kind: "deployment", name: "order-api", command: ["sh", "-c", "ps -eLf | wc -l"], pattern: "\\d+" }`
示例：`{ cluster: "prod", allNamespaces: true, maxPods: 200 }` → 列出全部 Java 容器与其 JVM 参数红线

### Helm release（不依赖 helm 命令）

| 工具 | 说明 |
|------|------|
| `k8s_list_helm_releases` | 列出 Helm 3 release（解析 `sh.helm.release.v1.*` Secret），含 name / ns / revision / status / chart / version；默认只列最新 revision，可按 `status` 过滤 |
| `k8s_get_helm_release` | 查看单个 release 详情：chart 元数据、chart 默认 values、用户 values、渲染后 manifest、templates 与 NOTES |

`k8s_get_helm_release` 通过 `include` 选择要返回的内容（`meta` / `values` / `config` / `manifest` / `chart` / `templates` / `notes` / `all`），缺省只返回元数据。**注意**：values 与 manifest 可能含明文密钥，需显式 `include` 才返回。

### 存储链路

| 工具 | 说明 |
|------|------|
| `k8s_trace_storage` | 追踪 PVC → PV（及 StorageClass）→ 使用该 PVC 的 Pod（含挂载路径）；也支持从 PV 反查。用于定位 Pending 的 PVC、异常 PV 与挂载失败 |

### DNS 域名

| 工具 | 说明 |
|------|------|
| `k8s_get_dns_names` | 读 coredns Corefile 得出 cluster domain，返回 Service 的完整 FQDN 与简写；也支持 StatefulSet headless 下的 Pod 域名 |

### 事件与诊断

| 工具 | 说明 |
|------|------|
| `k8s_get_events` | 查询事件（默认只返回 Warning），可按 namespace / `involvedKind` / `involvedName` / `reason` / `sinceSeconds` 过滤，按最近时间排序。用于定位 CrashLoopBackOff、Pending、ImagePullBackOff、调度失败等根因 |
| `k8s_explain_networkpolicy` | 解释 NetworkPolicy 对指定 Pod 的覆盖：列出选中该 Pod 的策略、每条 Ingress/Egress 规则（podSelector / namespaceSelector / ipBlock / 端口）是否命中，以及集群是否启用默认拒绝。用于排查 Pod 间网络不通 |
| `k8s_diagnose_pod` | 一步排障单个 Pod：聚合 Pod 阶段/条件、各容器状态（Waiting/Terminated 原因与退出码）、最近 Warning 事件、异常容器上次日志尾部。定位 CrashLoopBackOff / Pending / ImagePullBackOff / 未就绪 |
| `k8s_trace_istio` | 追踪 Istio VirtualService 链路：按 host 匹配 VS → 路由到的 Service（含 DestinationRule 子集/权重）与引用的 Gateway；自动探测 CRD 版本。排查 Istio 网格 404 / 503 |
| `k8s_get_component_status` | 读取集群组件状态（`/api/v1/componentstatuses`）。**该 API 在 1.19+ 已弃用**，部分集群返回空或报错，属预期行为 |

## 内置 Runtime Skills

插件附带两个可按需加载的运维知识卡（Runtime Skill），模型在排查对应故障现象时可加载，不写任何集群状态，只做取证与初判：

| skill 名 | 加载时机 |
|--------|---------|
| `dsh-k8s-jvm-diagnosis` | 排查 Pod 内 JVM 参数（`-Xmx` / `-Xms` / `-Xmn` / 总线程数）是否违反 Pod request/limit 的不合理问题时加载。涵盖内存超限、GC 频繁、线程堆积、堆上限被压低等场景。 |
| `dsh-k8s-low-kernel-thread` | 排查低版本内核下进程/线程数超限（如 nginx `worker_processes auto` 无限增长、Node cluster 多进程失控）导致节点崩溃时加载。涵盖内核版本偏低、`pid_max` 不足、cgroup `pids.max` 缺失、级联 OOM 等场景。 |

两张卡正文位于 `skills/` 目录，可单独查阅或覆盖。

## 源码结构

```
src/
  index.ts            # 仅做工具注册汇总（薄入口）
  config.ts           # schemastery 配置 + kubeconfig/client 构造
  types.ts            # 配置与客户端类型
  helpers.ts          # 渲染与元信息提取的公共小工具
  pod-targets.ts      # Pod 定位共享模块（selector / 工作负载 / 正则过滤）
  pod-exec.ts         # exec 核心共享模块（流收集 / 退出码解析）
  grep.ts             # grep 引擎（-A/-B 上下文、窗口合并、-- 分隔）
  search-common.ts    # 多流搜索装配（全局命中/字符上限、渲染）
  search-params.ts    # 三个搜索工具的共享参数与默认值收口
  jvm.ts              # JVM 参数解析 / 内存单位换算 / 红线判读
  client.ts           # 浏览器半：设置面板（由 scripts/wrap-client.mjs 包装）
  tools/
    clusters.ts       # 集群 / 连接测试 / 节点
    workloads.ts      # Pod 列表 / 日志
    resources.ts      # 基础资源列表与单资源详情
    crds.ts           # CRD 定义与实例
    networking.ts     # Ingress / IngressClass
    webhooks.ts       # 准入 Webhook（Validating / Mutating）
    gateway.ts        # Gateway API
    exec.ts           # Pod 内命令执行
    metrics.ts        # metrics-server 指标
    multi-logs.ts     # 多 Pod 日志（按工作负载 / labelSelector）
    search-logs.ts    # 多 Pod 日志批量 grep（-A/-B 上下文）
    search-exec.ts    # 多 Pod exec 输出批量 grep
    scan-java.ts      # Java 应用识别 + JVM 参数解析
    ingress.ts        # Ingress 体检（TLS/后端）与 URL 链路追踪
    helm.ts           # Helm 3 release 只读查看（解析 Secret）
    storage-trace.ts  # PVC → PV → Pod 存储链路
    domains.ts        # DNS 域名查询（coredns Corefile + Service FQDN）
    events.ts         # 事件过滤诊断
    network-policy.ts # NetworkPolicy 覆盖分析
    diagnose.ts       # 单 Pod 一步排障
    istio.ts          # Istio VirtualService 链路追踪
    component-status.ts # 集群组件状态（raw HTTP）
  certs.ts            # 证书解析（X509 摘要 / SAN / 剩余天数）
  resources/          # 资源注册表，按 API 领域拆分
    index.ts          # 汇总所有领域模块
    types.ts          # ResourceDef 契约
    core.ts           # Pod / Namespace / Node / Service / ConfigMap / Secret / Event / Quota / LimitRange
    workloads.ts      # Deployment / StatefulSet / DaemonSet / ReplicaSet / Job / CronJob
    networking.ts     # Endpoints / EndpointSlice / NetworkPolicy / Ingress
    storage.ts        # PV / PVC / StorageClass / CSI 资源
    autoscaling.ts    # HPA
    policy.ts         # PDB
    rbac.ts           # Role / RoleBinding / ClusterRole / ClusterRoleBinding
    scheduling.ts     # PriorityClass / RuntimeClass
    coordination.ts   # Lease
    certificates.ts   # CSR
    apiregistration.ts# APIService
  describe/           # 单资源详情渲染，按资源族拆分
    common.ts         # 通用格式化与 spec/status JSON 兜底
    pod.ts
    workload.ts
    service.ts
    node.ts
```

## 安全提示

- **本插件只读**：只注册 list / read / exec（排查命令）/ metrics 类工具，没有任何删除、修改、扩缩容能力。
- `k8s_pod_exec` 具备在容器内执行命令的能力，等价于对该集群的 exec 权限；请确保使用者的 kubeconfig 本身权限最小化。`k8s_search_pod_exec` 将该能力放大到多 Pod，内置破坏性命令拦截（rm / dd / mkfs / kill 等），且仅接受只读用途。
- kubeconfig 可能包含 `exec` 认证插件，`@kubernetes/client-node` 默认允许执行这些插件。**只粘贴你信任的 kubeconfig**。如需限制，可调用 `KubeConfig.setExecCredentialPluginPolicy` 收紧。

## 要求

- Node.js >= 22.14.0
- DeepSeek Harness >= 0.1.7
- `@kubernetes/client-node` ^1.1.3

## 许可

Apache-2.0