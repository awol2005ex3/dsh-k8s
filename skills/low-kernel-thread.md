# dsh-k8s · 低版本内核线程耗尽知识卡

当 Pod 运行进程数量（尤其 nginx 等长驻进程的子进程、Node.js child_process、或任何 `fork()` 为主调的多进程服务）出现「无限增长」导致 node 节点 crash（疑似 OOM / 容器被 SIGKILL / 内核 OOM-killer 命中）时，加载本卡。本卡片聚焦「内核版本 + 进程数上限」两个常量变量导致的常见崩溃路径，插件只做取证与判定，改写 Pod 配置需要人工操作。

## 能力边界

- 本插件只读：`k8s_list_nodes` 看节点内核版本、CPU 核数；`k8s_list_pods` 查是否有批量崩溃 Pod；`k8s_pod_exec` 在疑似崩溃容器内拿 `ps -ef` / `ps -eLf` 进程数快照。
- 不能直接改内核或重启节点，能明确给出「需要人工改 Pod spec 或升级节点内核」的判断依据。
- 卡片适用对象：近期部署过 `worker_processes auto` / `cgroup` 未设 `cpus` 上限 / 或 Node 多进程模式的服务 Pod。

## 固定取证序列

1. `k8s_list_nodes`，参数：`cluster` / `name=<疑似崩溃的节点名>`。
   - 重点看每个节点的 `nodeInfo.osImage` 与 `nodeInfo.vcpus`（真实 CPU 核数）。
   - 关键：内核版本是否在 LTS 之外、是否低于 5.4 / 6.x 小版本（旧内核线程上限偏低，默认 `max_threads` 较小）。
   - 取数口径：内核版本字符串，按 `/^(\d+)\.(\d+)\.(\d+)/` 取出 minor 版本，当 minor < 10 时记为「低版本」。
2. `k8s_list_pods`，查看同一命名空间下是否有大量 `CrashLoopBackOff` / `Error` Pod；若有，`cluster` / `name=<首个异常 Pod>`，再读 `k8s_diagnose_pod`。
3. 对一个异常 Pod 做一次进程快照：`k8s_pod_exec`，`cluster` / `namespace` / `pod` / `command=["sh","-c","ps -ef | wc -l"]`，记录进程总数 N。
4. 顺着 `ps -ef` 找主进程子树（nginx 则是 `nginx: worker process` 反复 grep），统计 nginx worker 数或 node 子进程数。
   - 常见模式：`ps -ef` 里 nginx 主进程 + worker*N 个，N 与 `vcpus` 成正比，即使 CPU quota 给够了也仍然 fork 出来。

## 判读要点

**路径 A：nginx `worker_processes auto` 在低版本内核上无限增长。**
- 根因：`worker_processes auto` 按 `psutil.pids()` 数量 fork，未受 cgroup cpu.cfs_quota 硬控；低内核（≤5.4 / ≤6.8）、或节点 cgroup `cpu.shares` 小默认值、或 cgroups v1 而未设 `cpu.cfs_quota_us`，导致 fork 出来进程数等于 CPU 核数——足以耗尽 node 的 `max_threads`（默认 4096，旧内核甚至更小）触发 OOM-kill。
- 取数口径：`worker_processes` 设为 auto / off 时，worker 数≈节点 `vcpus`；`ps -ef` 中 nginx*2 + worker*N 个进程；内核 `max_threads`（`sysctl kernel.pid_max`，旧值 < 4096）。
- 粗判：`ps -ef` 进程数 / 节点 vcpus > 2 且仍在增长 → 嫌疑极大。

**路径 B：Node 多进程（Cluster 模式或 `child_process.fork()`）在同 Pod 内 fork 过多 worker。**
- 根因：集群大小未受 `vcpus` 或 CPU request 约束；低版本内核 thread table 大小小，fork 出多个进程后总线程数逼近 `max_threads`，`clone()` 系统调用返回 EAGAIN，进程静默失败不报错，最终 segfault。
- 典型触发：静态文件服务 / 中间件多 worker 每实例开启 `cluster`，每个实例生产 N 个核心线程。
- 取数口径：`ps -eLf` 行数含 threads，或 `cat /proc/<pid>/status | grep Threads`；容器内主进程数 / 单进程线程数换算。

**路径 C：总进程数耗尽 `ulimit -u`（默认 4096）而非内核 max_threads。**
- 旧内核默认 `pid_max=4096`，fork 孤儿进程累积后进程数达到 `max_tasks` 被内核 kill。常见被某些 CRI（containerd runtime）忽略 cgroup pid limit。
- 取数口径：exec 拿 `ulimit -u`（默认值）；同时看 cgroup `pids.max`（v1）/ `pids.max`（v2）是否有设置。

**趋势判断：** Pod 重启时进程数聚集上升（CrashLoopBackOff 的瞬态尾部），加上同节点其他 Pod 也在暴涨 → 典型「Cascade 级联崩溃」，非单 Pod 问题，需逐Pod排查对应业务 Deployment。

**常见误判：**
- 看不到 `worker_processes auto` 字段只归因于内存泄漏（实际上是 fork 爆炸，内存只是被丢的副作用）。
- 把 Linux 内核 OOM-killer 事件当成 Pod 自身的 OOM 而忽略「内核已杀容器」。`k8s_get_events` 查 `Killing` / `OOMKilled` / `OutOfMemory` 印证。
- 不检查 cgroup `pids.max`，认为 cgroup v2 会自动兜底（有时 `pids.max=-1` 视为不限）。

## 相邻 Skill 分流

- 若确认是 `worker_processes auto` 无硬控，结论应为 **「nginx spec 里显式设 `worker_processes`（推荐 1 或按 vcpus 线性但不要 auto / even）」**，这是 Deployment spec 修改，需人工编辑 YAML。
- 若确认是 node cluster 大小失控，结论同上：改 Deployment 的 `replicas` 和 `-w`（cluster flag）或 Python 多进程 `num_workers`。
- 若内核版本确认为低版本且该节点是所有集群的 node，结论升级为 **「把待调度 Pod 批量标 priorityClass 并加强 cgroup cpu.cfs_quota；或升级节点内核到 ≥5.4 / ≥6.1」**，此改动跨集群生效，优先人工决策。
- 同场景并发到 `dmesg` 里有 `SIGKILL` / `Out of memory: Kill process` / `Nice: killing` 的 warning，则按 `K8s 内核 OOM vs Pod OOM` 二分图证。

## 附录：可人工补执行的命令清单

```bash
# 节点内核版本与 vcpus
uname -r && cat /proc/cpuinfo | grep -c processor
# cgroup pid limit（v1）
cat /sys/fs/cgroup/pids/pids.max
# cgroup pid limit（v2）
cat /sys/fs/cgroup/pids.max
# node 内核 pid_max
sysctl kernel.pid_max
# nginx 进程明细（目标 Pod 内）
sh -c "ps -ef | grep nginx | grep -v grep | wc -l; ps -ef | grep nginx.*worker | wc -l"
```
