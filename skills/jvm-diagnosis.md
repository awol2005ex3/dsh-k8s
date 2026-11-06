# dsh-k8s · JVM 诊断知识卡

当 Pod 里的 Java 服务出现内存溢出、GC 频繁、线程堆积等疑似 JVM 问题时加载本卡。插件只负责取证与初判，无法改 JVM 配置，根因常在「Pod 资源声明不合理」而非代码本身。

## 能力边界

- 本插件只读排查：不执行任何创建 / patch / delete / replace 操作，**严禁**通过 exec 写 Pod 容器内的任何配置。
- 不具备理解完整 Java 源码的能力，只能定位「JVM 参数字段（-Xmx / -Xms / -Xmn / 总线程数等）」是否违反 Pod request/limit，以及从 metrics 抓到的真实内存 / CPU 使用率趋势。
- 需要人工补执行的命令清单见末尾「附录」。

## 固定取证序列

逐条调用以下工具（工具名与参数名均为官方契约，禁止臆造）：

1. `k8s_get_resource`，`kind=pods`，参数：`cluster` / `namespace` / `name=<被疑 Pod 名称>`。
   - 拿到该 Pod 的 spec。进入 `spec.containers[]`，逐个容器读 `resources.requests.cpu` 与 `resources.limits.memory`（注意 request 与 limit 都是字符串如 `500m` / `512Mi`）。
2. `k8s_pod_exec`，参数：`cluster` / `namespace` / `pod` / `container=<相关容器名>` / `command=["sh","-c","env | grep -Ei 'JVM|JAVA|_JAVA_OPT|_JAVA_OPTIONS|GRNDATA']"` 或直接 `ps -eLf` 看线程。
   - 重点看哪些 JVM 启动参数里包含 `-Xmx` / `-Xms` / `-Xmn`。
3. `k8s_read_metrics`，`type=pods`（缺省）。
   - 取该 Pod 每个容器的 `cpu`（转换为核数）与 `memory`（转 Ki）。
4. 若上面已有 exited 容器，再用 `k8s_read_pod_logs` 读其日志尾部看 GC 日志（`[GC]` / `[gc]`），判断是频繁 Full GC 还是分配失败。

## 判读要点

**红线一：`-Xmx` 高于 pod limit。** `-Xmx` 是堆最大值，若 `< k8s Pod limits.memory>` 则运行时 buddy allocator 会限缩堆，实际堆被压到虚线上方后 OOM。常见写法：`-Xmx1g` 在 limit 为 `512Mi` 的 Pod 上崩溃。
- 取数口径：exec 取 `-Xmx` 值，limit 取 `resources.limits.memory` 值，二者比较。格式不同（如 `512M` vs `512Mi`）要先统一换算成 Ki 再比。

**红线二：`-Xms` 高于 pod limit。** 堆初始分配就超 limit，容器一启动即崩，表现为 `Application exception in thread` 无 GC 日志。

**红线三：`-Xms` 远大于 `-Xmx`。** 通常调优问题：留过多给内核分配页，占用 limit 不利（虽不直接崩，但浪费）。

**红线四：JVM 总线程数（`-XX:MaxThreads` 或默认 Thread.MAX_PRIORITY×预估）超过内核线程上限（Linux 上 `nproc` × … 常在 4096–65536 区间，低版本内核更低）。** Pod 内线程总 `Threads(java) + GC threads + signal handler threads` 可能触达 `ulimit -u`（默认 4096）或 cgroup 的 `threads` 限制，触发 `Failed at /lib/x86_64-linux-gnu/.../pthread_create` 崩溃。
- 取数口径：exec 里 `ps -eLf | wc -l` 或 `jstack -m -l <pid>` 汇总 java 与非 java 线程数，除以 cpu 核数估算单核并发上限，与 limit 比对。

**趋势判断：** metrics 把 `memory` 当作 Ki 累计值读取；若某容器持续 memory 占满 limit 的 90%+ 且 CPU=`0m`（GC 但无业务负载），倾向堆上限没撑满；若 CPU 很高且 memory 也高，倾向 GC 竞争或非堆大对象。

**常见误判：**
- 把 container 的 `requests.cpu` 当成限制（应比较 `limits.memory`，不是 `limits.cpu`）。
- 只看 `ps -ef` 没看线程行，低估线程占用。
- 把 `OOMKilled` 事件理解成镜像拉取失败而忽略内存超额。

## 相邻 Skill 分流

- 若根因确认是资源参数（-Xmx 超 limit / requests 超了 limit），结论应为 **「调整 Pod resources 或 JVM 启动参数字段」**，这是配置问题，需人工编辑 YAML 或启动参数，卡片到此结束。
- 若 exec 看到有非零退出且 exitCode=137（SIGKILL by OOM），叠加 metrics 内存长期超额，进入 `k8s_diagnose_pod` 查 exited 容器的退出原因再交叉验证。
- 若问题是「线程数导致容器内进程奔溃」，优先用本卡的第 4 条线索，扩展到 node 视角：`k8s_list_nodes` 看是否批量 OOMKill，必要时人工打 `dmesg` 查看 `out of memory`。

## 附录：可人工补执行的命令清单

```bash
# Pod 内看 JVM 启动参数（只看一个容器，多容器用 --container）
docker inspect --format='{{json .Config.Cmd}}' <pod> | jq -r '.[] | select(.contains("-X"))'
# 或 exec 后：
sh -c "pgrep -f '\.jar' | head -1 | xargs -I{} jcmd {} Thread.print"
# Node / 线程数快照
sh -c "ps -eLf | wc -l; ps -eL | wc -L"
```
