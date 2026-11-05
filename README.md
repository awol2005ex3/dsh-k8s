# dsh-k8s

DeepSeek Harness (dsh) plugin for operating multiple Kubernetes clusters across different k8s versions.

- **多个集群运维**：在插件的设置表单里配置任意多个集群，每个集群粘贴一份完整 kubeconfig 字符串。
- **基于官方 Node.js 客户端 `@kubernetes/client-node`**（v1 稳定 promise API），兼容不同 k8s 版本。
- **只读 + 排障工具**：列出集群、测试连接、查看节点 / Pod / 日志。

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

| 工具 | 说明 |
|------|------|
| `k8s_list_clusters` | 列出已配置集群及 server 与当前 context |
| `k8s_test_connection` | 测试与指定集群的连接，返回 server 与节点数 |
| `k8s_list_nodes` | 列出指定集群的节点、就绪状态、版本与内网 IP |
| `k8s_list_pods` | 列出指定命名空间的 Pod、运行阶段与重启次数 |
| `k8s_read_pod_logs` | 读取指定 Pod 的日志（默认最近 200 行） |

## 安全提示

- kubeconfig 可能包含 `exec` 认证插件，`@kubernetes/client-node` 默认允许执行这些插件。**只粘贴你信任的 kubeconfig**。如需限制，可调用 `KubeConfig.setExecCredentialPluginPolicy` 收紧。

## 要求

- Node.js >= 22.14.0
- DeepSeek Harness >= 0.1.7
- `@kubernetes/client-node` ^1.1.3

## 许可

Apache-2.0