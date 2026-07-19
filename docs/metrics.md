# 监控指标说明（Metrics Reference）

本文档罗列 `inference-sla` 仪表盘消费的所有 Prometheus 指标，给出其 metric 名称、类型、标签维度、物理含义、聚合方式以及在仪表盘中的对应字段。所有指标来自 sglang serving engine 的 `/metrics` 端点（需 `--enable-metrics`，L2 相关指标需额外 `--enable-hierarchical-cache`）。

## 目录

- [标签约定](#标签约定)
- [聚合方式](#聚合方式)
- [一、请求与并发（Requests）](#一请求与并发requests)
- [二、延迟分位数（Latency / Histograms）](#二延迟分位数latency--histograms)
- [三、吞吐量（Throughput）](#三吞吐量throughput)
- [四、缓存（Cache）](#四缓存cache)
- [五、推测解码（Speculative / EAGLE）](#五推测解码speculative--eagle)
- [六、按 DP 等级拆分（Per-Degree）](#六按-dp-等级拆分per-degree)
- [七、派生字段与硬编码阈值](#七派生字段与硬编码阈值)
- [附录：metric 与仪表盘字段对照表](#附录metric-与仪表盘字段对照表)

---

## 标签约定

sglang 暴露的指标通常带以下标签，本工具按这些标签做聚合 / 去重：

| 标签 | 含义 |
|---|---|
| `dp_rank` | Data Parallel rank（数据并行等级，0–3）。同一 DP group 内多个 TP rank 会重复上报相同 gauge 值，需按 `dp_rank` 去重。 |
| `tp_rank` | Tensor Parallel rank（张量并行等级）。同一 DP 内 TP rank 数值重复，聚合时被丢弃。 |
| `engine_type` | 引擎类型（如 `unified`）。本工具仅做透传，不做过滤。 |
| `model_name` | 模型名称（如 `glm`）。本工具仅做透传，不做过滤。 |
| `mode` | 用于 `sglang:realtime_tokens_total`，取值 `prefill_cache`（命中缓存的 prefill token）或 `prefill_compute`（需实际计算的 prefill token）。 |
| `cache_source` | 用于 `sglang:cached_tokens_total`，取值 `device`（GPU 设备缓存）或 `host`（主机缓存）。 |
| `le` | Histogram bucket 上界（`+Inf` 表示正无穷桶）。 |
| `endpoint` / `method` | 用于 `sglang:http_requests_active`，标识 HTTP 路由与方法。本工具仅取 `endpoint="/v1/chat/completions"`。 |

---

## 聚合方式

| 函数 | 含义 |
|---|---|
| `sumOverDp(name)` | 在每个 `dp_rank` 内取第一个出现的样本（去重 TP rank），再对所有 DP 求和。**用于跨 DP 同一语义的总数**（running、queued、gen_throughput、hicache tokens 等）。 |
| `avgOverDp(name)` | 在每个 `dp_rank` 内去重后取值，再对所有 DP 求平均。**用于跨 DP 的比率型 gauge**（cache_hit_rate、token_usage、spec_accept_rate、spec_accept_length）。 |
| `anyGauge(name, filter)` | 返回首个匹配样本值。**用于单实例 gauge**（http_requests_active）。 |
| `counterValue(name, filter)` | 对匹配样本求和。**用于累计计数器**（num_requests_total、num_aborted_requests_total、cached_tokens_total）。 |
| `counterRate(name, filter)` | 当前累计值减上一次采样值，除以 wall-clock 间隔秒数；首次采样返回 0。**用于吞吐速率**（generation_tokens_total、prompt_tokens_total）。 |
| `histogramByName(base, filter)` | 按 `<base>_bucket` / `_count` / `_sum` 重建单条 histogram。**用于无 dp_rank 维度的直方图**（TTFT / TPOT / E2E）。 |
| `histSumBucketsAcrossDp(base, filter, "dp_rank")` | 把每个 DP 的 `_bucket` 累加成一条虚拟 histogram，`_count` / `_sum` 按 `dp_rank` 去重再求和。**用于 per-DP 直方图的全局分位数估计**（queue_time_seconds）。 |
| `histogramQuantile(hist, q)` | 类 `histogram_quantile` 的线性插值：`q_val = lower + (rank - cum_prev) / (cum_cur - cum_prev) * (upper - lower)`；`+Inf` 桶回退到前一有限上界。 |
| `perDpValues(name)` | 按 `dp_rank` 去重后取值，按 rank 升序输出。**用于 Per-Degree 面板逐行渲染**。 |
| `perDpL1HitRate(metric, "prefill_cache", "prefill_compute")` | 每个 DP 内 `prefill_cache / (prefill_cache + prefill_compute)`。**用于 Per-Degree 面板的逐 DP L1 命中率**。 |
| `noDp` filter | 仅取 `dp_rank` 标签**不存在**的样本。sglang 把全局级 histogram（TTFT/TPOT/E2E）与 per-DP histogram（queue_time）分开上报，`noDp` 用来精确选中全局级那条。 |

---

## 一、请求与并发（Requests）

对应 `SlaSnapshot` 字段：`running` / `queued` / `concurrent` / `httpActive` / `maxRunning` / `maxQueued` / `totalRequests` / `abortedRequests`。
对应仪表盘面板：**REQUESTS**。

| 仪表盘字段 | metric 名称 | 类型 | 标签 | 聚合方式 | 物理含义 |
|---|---|---|---|---|---|
| Running | `sglang:num_running_reqs` | gauge | `dp_rank, tp_rank, engine_type, model_name` | `sumOverDp`（DP 内去重 TP 后求和） | 当前正在 GPU 上执行 decode / prefill 的请求数量（正在生成）。 |
| Queued | `sglang:num_queue_reqs` | gauge | 同上 | `sumOverDp` | 已接收但尚未被调度执行的排队请求数量。 |
| Concurrent | —（派生） | — | — | `running + queued` | 同时处于「执行中 + 排队中」的并发请求数，反映瞬时并发压力。 |
| HTTP in-flight | `sglang:http_requests_active` | gauge | `endpoint, method` | `anyGauge`，仅取 `endpoint="/v1/chat/completions"` | HTTP 层正在处理的 `/v1/chat/completions` 请求连接数。 |
| Total reqs | `sglang:num_requests_total` | counter | `engine_type, model_name` | `counterValue` | 引擎自启动以来累计接收的请求总数。 |
| Aborted | `sglang:num_aborted_requests_total` | counter | 同上 | `counterValue` | 引擎自启动以来累计被中断 / 取消的请求数（客户端断连等）。 |
| Max running | — | 常量 | — | 硬编码 `64` | Running 容量上限，用于容量条和红黄绿阈值。 |
| Max queued | — | 常量 | — | 硬编码 `512` | Queued 容量上限，用于容量条和红黄绿阈值。 |

**颜色阈值（dashboard.ts）**：Running ≥ max 红，>0.8×max 黄，否则绿。Queued ≥ max 红，>0.5×max 黄，否则绿；Aborted > 0 显示为红色。

---

## 二、延迟分位数（Latency / Histograms）

对应 `SlaSnapshot` 字段：`ttft` / `tpot` / `e2e` / `queueTime`，各含 `{ p50, p90, p99, avg, count }`。
对应仪表盘面板：**TTFT** / **TPOT** / **E2E LATENCY** / **QUEUE WAIT**。

| 面板 | metric 基名 | 类型 | 标签 | 直方图构建方式 | 物理含义 |
|---|---|---|---|---|---|
| TTFT | `sglang:time_to_first_token_seconds` | histogram | `engine_type, model_name`（无 `dp_rank`） | `histogramByName(base, noDp)` | **Time To First Token**：从请求提交到收到第一个输出 token 的耗时。衡量首响延迟。 |
| TPOT | `sglang:inter_token_latency_seconds` | histogram | 同上 | `histogramByName(base, noDp)` | **Time Per Output Token**：相邻两个输出 token 之间的生成间隔。衡量 decode 阶段逐 token 延迟。 |
| E2E LATENCY | `sglang:e2e_request_latency_seconds` | histogram | 同上 | `histogramByName(base, noDp)` | **端到端请求总延迟**：从请求接收到完成（最后一枚 token 输出）的全过程耗时。 |
| QUEUE WAIT | `sglang:queue_time_seconds` | histogram | `dp_rank, tp_rank, engine_type, model_name` | `histSumBucketsAcrossDp(base, undefined, "dp_rank")` | **排队等待时间**：请求在被调度执行前停留队列的时长。per-DP buckets 先跨 DP 累加成一条虚拟 histogram，再算分位数。 |

**计算细节**：
- `p50/p90/p99` 由 `histogramQuantile(hist, q)` 中线性插值得到。
- `avg = sum / count`（`avgOfHist`）；当 `count == 0` 时整组返回 0。
- `count` 取自 `<base>_count`，反映该指标累计采样数。
- QUEUE WAIT 跨 DP 求和时，`_count` / `_sum` 按 `dp_rank` 去重后再加，避免 TP rank 重复。
- **颜色阈值**：p90/p99 > 2s 红，>0.8s 黄，否则绿（仅 warn 模式启用）。

---

## 三、吞吐量（Throughput）

对应 `SlaSnapshot` 字段：`genThroughput` / `outputTokenRate` / `inputTokenRate` / `totalRequests` / `abortedRequests` / `cachedDeviceTokens` / `cachedHostTokens`。
对应仪表盘面板：**THROUGHPUT**。

| 仪表盘字段 | metric 名称 | 类型 | 标签 | 聚合方式 | 物理含义 |
|---|---|---|---|---|---|
| Output (gen) | `sglang:generation_tokens_total` | counter | `engine_type, model_name` | `counterRate`（Δ/Δt） | **输出 token 速率**：每秒生成的（输出侧）token 数；首采样为 0。 |
| Input (prefill) | `sglang:prompt_tokens_total` | counter | 同上 | `counterRate` | **输入 token 速率**：每秒 prefill 进入的 prompt token 数。 |
| Gen gauge | `sglang:gen_throughput` | gauge | `dp_rank, tp_rank, engine_type, model_name` | `sumOverDp` | 引擎自报的生成吞吐（tok/s），跨 DP 去重求和。与上面 counter 算出的速率互为印证。 |
| Total reqs | `sglang:num_requests_total` | counter | 同上 | `counterValue` | 累计请求总数（同上 Requests 面板）。 |
| Aborted | `sglang:num_aborted_requests_total` | counter | 同上 | `counterValue` | 累计中断请求数。 |
| Cached device | `sglang:cached_tokens_total{cache_source="device"}` | counter | `cache_source, engine_type, model_name` | `counterValue`，仅 `cache_source="device"` | 累计命中 GPU 设备（L1）缓存的 token 数。 |
| Cached host | `sglang:cached_tokens_total{cache_source="host"}` | counter | 同上 | `counterValue`，仅 `cache_source="host"` | 累计命中主机（L2）缓存的 token 数。 |

---

## 四、缓存（Cache）

对应 `SlaSnapshot` 字段：`l1HitRate` / `l1HitRateGauge` / `l1PrefillCacheTokens` / `l1PrefillComputeTokens` / `l2Usage` / `l2UsedTokens` / `l2TotalTokens` / `kvUsage`。
对应仪表盘面板：**CACHE**。

### 4.1 L1（GPU radix cache）命中率

| 仪表盘字段 | metric 名称 | 类型 | 标签 | 聚合方式 | 物理含义 |
|---|---|---|---|---|---|
| L1 hit（主显示） | `sglang:realtime_tokens_total{mode="prefill_cache"}` & `{mode="prefill_compute"}` | gauge | `dp_rank, tp_rank, engine_type, model_name, mode` | `sumGauge` 分 `prefill_cache` / `prefill_compute` 两次求和；`l1HitRate = prefill_cache / (prefill_cache + prefill_compute)`；若总量为 0 则回退到 `l1HitRateGauge` | **实测 L1 命中率**：prefill 阶段命中 GPU radix 缓存的 token 占 prefill 总 token 的比例（cache + compute）。 |
| prefill_cache | 同上 `mode="prefill_cache"` | gauge | 同上 | `sumGauge` | prefill 阶段从 GPU radix 缓存复用的 token 数。 |
| prefill_compute | 同上 `mode="prefill_compute"` | gauge | 同上 | `sumGauge` | prefill 阶段需要实际计算（未命中）的 token 数。 |
| L1 gauge（辅助显示） | `sglang:cache_hit_rate` | gauge | `dp_rank, tp_rank, engine_type, model_name` | `avgOverDp` | sglang 自报的瞬时命中率 gauge，跨 DP 平均。当 `realtime_tokens_total` 总量为 0 时作为回退。 |

**颜色阈值**：≥0.5 绿，≥0.2 黄，否则红。

### 4.2 L2（host hierarchical cache）占用率

| 仪表盘字段 | metric 名称 | 类型 | 标签 | 聚合方式 | 物理含义 |
|---|---|---|---|---|---|
| L2 used | `sglang:hicache_host_used_tokens` | gauge | `dp_rank, tp_rank, engine_type, model_name` | `sumOverDp` | L2 主机层级缓存当前已占用的 token 数。 |
| L2 total | `sglang:hicache_host_total_tokens` | gauge | 同上 | `sumOverDp` | L2 主机层级缓存的总容量（token 数）。 |
| L2 usage | —（派生） | — | — | `l2UsedTokens / l2TotalTokens` | L2 缓存占用率 = used / total。 |

> 注：sglang 当前未暴露独立的 L2 命中计数器，故 L2 以「占用率」形式呈现，而非命中率。

**颜色阈值**：≥0.9 红，≥0.7 黄，否则绿。

### 4.3 KV cache 显存使用

| 仪表盘字段 | metric 名称 | 类型 | 标签 | 聚合方式 | 物理含义 |
|---|---|---|---|---|---|
| KV usage | `sglang:token_usage` | gauge | `dp_rank, tp_rank, engine_type, model_name` | `avgOverDp` | KV cache 池在显存中的占用比例（0–1），跨 DP 取平均。逼近 1 时表示显存接近饱和，可能触发 eviction 或拒绝新请求。 |

**颜色阈值**：≥0.9 红，≥0.7 黄，否则绿。

---

## 五、推测解码（Speculative / EAGLE）

对应 `SlaSnapshot` 字段：`specAcceptRate` / `specAcceptLength`。
对应仪表盘面板：**SPECULATIVE (EAGLE)**。

| 仪表盘字段 | metric 名称 | 类型 | 标签 | 聚合方式 | 物理含义 |
|---|---|---|---|---|---|
| Accept rate | `sglang:spec_accept_rate` | gauge | `dp_rank, tp_rank, engine_type, model_name` | `avgOverDp` | EAGLE 推测解码中草稿 token 被接受的比率（0–1），跨 DP 平均。值越高代表草稿质量越好、加速越多。 |
| Accept length | `sglang:spec_accept_length` | gauge | 同上 | `avgOverDp` | 每次前向传播平均被接受的草稿 token 数（含 bonus token），跨 DP 平均。值越大代表每次 decode 步多产出 token 越多、加速比越高。 |

> 显示「(accepted drafts + bonus token per forward pass)」即「每次前向传播接受的草稿数 + bonus token」。

**Accept rate 颜色阈值**：≥0.5 绿，≥0.2 黄，否则红。

---

## 六、按 DP 等级拆分（Per-Degree）

对应 `SlaSnapshot.perDp`：`running / queued / gen / cache / l1 / kv`，每项为 `{ dp, value }[]`，按 `dp_rank` 升序。
对应仪表盘面板：**PER-DEGREE (DP0–DP3)**。

| 列 | 来源 metric | 聚合方式 | 物理含义 |
|---|---|---|---|
| run | `sglang:num_running_reqs` | `perDpValues` | 该 DP 等级当前正在执行的请求数。 |
| que | `sglang:num_queue_reqs` | `perDpValues` | 该 DP 等级当前排队请求数。 |
| gen | `sglang:gen_throughput` | `perDpValues` | 该 DP 等级的生成吞吐（tok/s）。 |
| L1% | `sglang:realtime_tokens_total` 经 `perDpL1HitRate` | `prefill_cache / (prefill_cache + prefill_compute)`（逐 DP） | 该 DP 等级的 L1 GPU radix 缓存命中率。 |
| KV% | `sglang:token_usage` | `perDpValues` | 该 DP 等级的 KV cache 显存占用率。 |

> 列 `cache` 字段（取自 `sglang:cache_hit_rate`）当前未在面板渲染，但已在 `perDp.cache` 中保留以备扩展。

**Per-DP 颜色阈值**：run ≥ max 红、>0.8×max 黄；L1% ≥0.5 绿、≥0.2 黄；KV% ≥0.9 红、≥0.7 黄。

---

## 七、派生字段与硬编码阈值

| 字段 | 来源 | 含义 |
|---|---|---|
| `concurrent` | `running + queued` | 并发请求数（执行中 + 排队中）。 |
| `maxRunning` | 硬编码 `64` | Running 容量条上限和颜色阈值基准。 |
| `maxQueued` | 硬编码 `512` | Queued 容量条上限和颜色阈值基准。 |
| `l1HitRate` | `l1PrefillCacheTokens / (l1PrefillCacheTokens + l1PrefillComputeTokens)` | 实测 L1 命中率，回退到 `l1HitRateGauge`。 |
| `l2Usage` | `l2UsedTokens / l2TotalTokens` | L2 缓存占用率。 |
| `fetchError` | `fetchMetrics` 异常 | 抓取失败时携带的 error 字符串；非 null 时状态栏显示 ERROR。 |
| `ts` | `Date.now()` | 快照时间戳。 |

---

## 附录：metric 与仪表盘字段对照表

| sglang metric | 类型 | 仪表盘面板 | `SlaSnapshot` 字段 |
|---|---|---|---|
| `sglang:num_running_reqs` | gauge | REQUESTS / PER-DEGREE | `running`, `perDp.running` |
| `sglang:num_queue_reqs` | gauge | REQUESTS / PER-DEGREE | `queued`, `perDp.queued` |
| `sglang:http_requests_active` | gauge | REQUESTS | `httpActive` |
| `sglang:num_requests_total` | counter | REQUESTS / THROUGHPUT | `totalRequests` |
| `sglang:num_aborted_requests_total` | counter | REQUESTS / THROUGHPUT | `abortedRequests` |
| `sglang:time_to_first_token_seconds` | histogram | TTFT | `ttft` |
| `sglang:inter_token_latency_seconds` | histogram | TPOT | `tpot` |
| `sglang:e2e_request_latency_seconds` | histogram | E2E LATENCY | `e2e` |
| `sglang:queue_time_seconds` | histogram | QUEUE WAIT | `queueTime` |
| `sglang:gen_throughput` | gauge | THROUGHPUT / PER-DEGREE | `genThroughput`, `perDp.gen` |
| `sglang:generation_tokens_total` | counter | THROUGHPUT | `outputTokenRate` (rate) |
| `sglang:prompt_tokens_total` | counter | THROUGHPUT | `inputTokenRate` (rate) |
| `sglang:cached_tokens_total{cache_source="device"}` | counter | THROUGHPUT | `cachedDeviceTokens` |
| `sglang:cached_tokens_total{cache_source="host"}` | counter | THROUGHPUT | `cachedHostTokens` |
| `sglang:cache_hit_rate` | gauge | CACHE / PER-DEGREE | `l1HitRateGauge`, `perDp.cache` |
| `sglang:realtime_tokens_total{mode="prefill_cache"}` | gauge | CACHE / PER-DEGREE | `l1PrefillCacheTokens`, `perDp.l1` |
| `sglang:realtime_tokens_total{mode="prefill_compute"}` | gauge | CACHE / PER-DEGREE | `l1PrefillComputeTokens`, `perDp.l1` |
| `sglang:hicache_host_used_tokens` | gauge | CACHE | `l2UsedTokens` |
| `sglang:hicache_host_total_tokens` | gauge | CACHE | `l2TotalTokens` |
| `sglang:token_usage` | gauge | CACHE / PER-DEGREE | `kvUsage`, `perDp.kv` |
| `sglang:spec_accept_rate` | gauge | SPECULATIVE | `specAcceptRate` |
| `sglang:spec_accept_length` | gauge | SPECULATIVE | `specAcceptLength` |

---

## 参考资料

- sglang 仓库：<https://github.com/sgl-project/sglang>（启动参数 `--enable-metrics`、`--enable-hierarchical-cache`）
- Prometheus 直方图分位数算法：<https://prometheus.io/docs/prometheus/latest/querying/functions/#histogram_quantile>
- 本仓库实现见 `src/metrics.ts:445`（`buildSnapshot`）与 `src/dashboard.ts:232`（`render`）。
