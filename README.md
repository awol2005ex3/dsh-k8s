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
| `k8s_read_pod_logs` | 读取指定 Pod 的日志（默认最近 200 行） |
| `k8s_list_resources` | 列出非 Pod 组件（只读）。`kind` 取值见下表 |

`k8s_list_resources` 支持的 `kind`：

`deployments` · `statefulsets` · `daemonsets` · `replicasets` · `jobs` · `cronjobs` ·
`services` · `configmaps` · `secrets` · `events` · `endpoints` · `serviceaccounts` · `pvcs`

> Secret 只返回名称/命名空间/创建时间等元信息，不返回内容。

### CRD

| 工具 | 说明 |
|------|------|
| `k8s_list_crds` | 列出集群内所有 CRD 定义（group / kind / plural / scope / versions） |
| `k8s_list_crd_instances` | 按 `group` + `version` + `plural` 列出该 CRD 的实例；给 `namespace` 走命名空间范围，否则按集群范围读取 |

### Pod 内排查

| 工具 | 说明 |
|------|------|
| `k8s_pod_exec` | 在容器内执行命令（WebSocket exec 子资源），返回 `output` 与真实 `exitCode` |

示例：`{ pod: "coredns-xxx", namespace: "kube-system", command: ["sh", "-c", "ps aux"] }`。
多容器 Pod 用 `container` 指定容器名。**该工具定位是只读排查**（ps / netstat / cat / env / curl / nslookup 等），不做任何写操作封装。

### 指标

| 工具 | 说明 |
|------|------|
| `k8s_read_metrics` | 读取 metrics-server 指标；`type: pods`（按命名空间）或 `type: nodes` |

集群未安装 metrics-server 时会直接报错，属预期行为。

## 源码结构

```
src/
  index.ts            # 仅做工具注册汇总（薄入口）
  config.ts           # schemastery 配置 + kubeconfig/client 构造
  types.ts            # 配置与客户端类型
  helpers.ts          # 渲染与元信息提取的公共小工具
  client.ts           # 浏览器半：设置面板（由 scripts/wrap-client.mjs 包装）
  tools/
    clusters.ts       # 集群 / 连接测试 / 节点
    workloads.ts      # Pod / 日志 / 非 Pod 组件
    crds.ts           # CRD 定义与实例
    exec.ts           # Pod 内命令执行
    metrics.ts        # metrics-server 指标
```

## 安全提示

- **本插件只读**：只注册 list / read / exec（排查命令）/ metrics 类工具，没有任何删除、修改、扩缩容能力。
- `k8s_pod_exec` 具备在容器内执行命令的能力，等价于对该集群的 exec 权限；请确保使用者的 kubeconfig 本身权限最小化。
- kubeconfig 可能包含 `exec` 认证插件，`@kubernetes/client-node` 默认允许执行这些插件。**只粘贴你信任的 kubeconfig**。如需限制，可调用 `KubeConfig.setExecCredentialPluginPolicy` 收紧。

## 要求

- Node.js >= 22.14.0
- DeepSeek Harness >= 0.1.7
- `@kubernetes/client-node` ^1.1.3

## 许可

Apache-2.0