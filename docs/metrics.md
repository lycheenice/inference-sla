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

对应 `SlaSnapshot` 字段：`l1HitRate` / `l1HitRateGauge` / `l1PrefillCacheTokens` / `l1PrefillComputeTokens` / `l1UsedTokens` / `l1TotalTokens` / `l1Usage` / `l2Usage` / `l2UsedTokens` / `l2TotalTokens` / `evictedTokensTotal` / `loadBackTokensTotal` / `evictedTokenRate` / `loadBackTokenRate` / `kvUsage`。
对应仪表盘面板：**CACHE**。

### 4.1 L1（GPU radix cache）命中率

| 仪表盘字段 | metric 名称 | 类型 | 标签 | 聚合方式 | 物理含义 |
|---|---|---|---|---|---|
| L1 hit（主显示） | `sglang:realtime_tokens_total{mode="prefill_cache"}` & `{mode="prefill_compute"}` | gauge | `dp_rank, tp_rank, engine_type, model_name, mode` | `sumGauge` 分 `prefill_cache` / `prefill_compute` 两次求和；`l1HitRate = prefill_cache / (prefill_cache + prefill_compute)`；若总量为 0 则回退到 `l1HitRateGauge` | **实测 L1 命中率**：prefill 阶段命中 GPU radix 缓存的 token 占 prefill 总 token 的比例（cache + compute）。 |
| prefill_cache | 同上 `mode="prefill_cache"` | gauge | 同上 | `sumGauge` | prefill 阶段从 GPU radix 缓存复用的 token 数。 |
| prefill_compute | 同上 `mode="prefill_compute"` | gauge | 同上 | `sumGauge` | prefill 阶段需要实际计算（未命中）的 token 数。 |
| L1 gauge（辅助显示） | `sglang:cache_hit_rate` | gauge | `dp_rank, tp_rank, engine_type, model_name` | `avgOverDp` | sglang 自报的瞬时命中率 gauge，跨 DP 平均。当 `realtime_tokens_total` 总量为 0 时作为回退。 |

**颜色阈值**：≥0.5 绿，≥0.2 黄，否则红。

### 4.2 L1（GPU KV cache pool）容量与占用

| 仪表盘字段 | metric 名称 | 类型 | 标签 | 聚合方式 | 物理含义 |
|---|---|---|---|---|---|
| L1 used | `sglang:num_used_tokens` | gauge | `dp_rank, tp_rank, engine_type, model_name [, moe_ep_rank, pp_rank]` | `sumOverDp`（按 dp_rank 去重跨 DP 求和） | GPU KV cache 池当前已用 token 数（含运行中请求 KV + radix 缓存占用；hybrid-SWA 模型取 `max(full_num_used, swa_num_used)`，不含 mamba 池）。 |
| L1 total | `sglang:max_total_num_tokens` | gauge | 同上 | `sumOverDp` | GPU KV cache 池总容量（token 数）。 |
| L1 usage | —（派生） | — | — | `l1UsedTokens / l1TotalTokens` | L1 GPU KV 池占用率。逼近 1 时显存接近饱和，可能触发 eviction 或拒绝新请求。 |

> 此处的 `l1UsedTokens` / `l1TotalTokens` 与 KV CACHE POOL 面板的 `kvPool.numUsedTokens` / `kvPool.maxTotalTokens` 同源（同一 metric），只是 CACHE 面板以「L1 容量」视角呈现、与 L2 对称；KV CACHE POOL 面板还会额外拆分 `kv_used`（运行中）/ `kv_available`（空闲）/ `kv_evictable`（可驱逐 radix 缓存）。
> 底部的 `KV usage` 来自引擎自报的 `sglang:token_usage` gauge（跨 DP 平均，PD 模式取 decode 端），作为 `l1Usage` 的交叉校验；二者聚合方式不同（sum 比 avg）可能有微小差异。

**颜色阈值**：≥0.9 红，≥0.7 黄，否则绿。

### 4.3 L2（host hierarchical cache）占用率

| 仪表盘字段 | metric 名称 | 类型 | 标签 | 聚合方式 | 物理含义 |
|---|---|---|---|---|---|
| L2 used | `sglang:hicache_host_used_tokens` | gauge | `dp_rank, tp_rank, engine_type, model_name` | `sumOverDp` | L2 主机层级缓存当前已占用的 token 数。 |
| L2 total | `sglang:hicache_host_total_tokens` | gauge | 同上 | `sumOverDp` | L2 主机层级缓存的总容量（token 数）。 |
| L2 usage | —（派生） | — | — | `l2UsedTokens / l2TotalTokens` | L2 缓存占用率 = used / total。 |

> 注：sglang 当前未暴露独立的 L2 命中计数器，故 L2 以「占用率」形式呈现，而非命中率。

**颜色阈值**：≥0.9 红，≥0.7 黄，否则绿。

### 4.4 L1↔L2 迁移（hierarchical cache token flow）

| 仪表盘字段 | metric 名称 | 类型 | 标签 | 聚合方式 | 物理含义 |
|---|---|---|---|---|---|
| L1→L2 evict total | `sglang:evicted_tokens_total` | counter | `engine_type, model_name [, moe_ep_rank, pp_rank, tp_rank]` | `counterValue`（汇总所有样本） | 累计被从 GPU（L1）驱逐到 CPU/host（L2）的 token 数。 |
| L1→L2 evict rate | 同上 | counter | 同上 | `counterRate`（Δ/Δt） | 单位时间内从 L1 迁出到 L2 的 token 速率（tok/s）；首采样为 0。 |
| L2→L1 load total | `sglang:load_back_tokens_total` | counter | 同上 | `counterValue` | 累计被从 CPU/host（L2）加载回 GPU（L1）复用的 token 数。 |
| L2→L1 load rate | 同上 | counter | 同上 | `counterRate` | 单位时间内从 L2 迁回 L1 的 token 速率（tok/s）；首采样为 0。 |

> sglang 同时暴露迁移耗时直方图 `sglang:eviction_duration_seconds` / `sglang:load_back_duration_seconds`，本仪表盘当前未渲染，仅消费 token 计数与速率。
> PD 模式下 `mergePdSnapshots` 对两端计数与速率分别求和（prefill 与 decode 各自独立迁移）。

**L1→L2 evict rate 颜色阈值**：≥1000 tok/s 红，≥100 tok/s 黄，否则灰（0 时亦灰）。
**L2→L1 load rate 颜色阈值**：>0 绿（说明 L2 在被复用），否则灰。

### 4.5 KV cache 显存使用（引擎自报 gauge）

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
| `sglang:num_used_tokens` | gauge | CACHE / KV CACHE POOL | `l1UsedTokens`, `kvPool.numUsedTokens` |
| `sglang:max_total_num_tokens` | gauge | CACHE / KV CACHE POOL | `l1TotalTokens`, `kvPool.maxTotalTokens` |
| `sglang:evicted_tokens_total` | counter | CACHE | `evictedTokensTotal` (累计) / `evictedTokenRate` (Δ/Δt) |
| `sglang:load_back_tokens_total` | counter | CACHE | `loadBackTokensTotal` (累计) / `loadBackTokenRate` (Δ/Δt) |
| `sglang:token_usage` | gauge | CACHE / PER-DEGREE | `kvUsage`, `perDp.kv` |
| `sglang:spec_accept_rate` | gauge | SPECULATIVE | `specAcceptRate` |
| `sglang:spec_accept_length` | gauge | SPECULATIVE | `specAcceptLength` |

---

## 八、PD 分离部署（Prefill / Decode Disaggregated）

sglang 的 PD 分离部署把 prefill 与 decode 拆到两套 worker（同机或跨机），通过 KV cache 转移协同。本工具通过 `engine_type` 标签自动识别角色，并支持双端点合并视图。

### 8.1 角色探测

`detectEngineRole` 从 `sglang:num_running_reqs` / `gen_throughput` / `token_usage` 的 `engine_type` 标签推断：

| engine_type | EngineRole | 含义 |
|---|---|---|
| `unified` | `unified` | 单体部署（原模式） |
| `prefill` | `prefill` | PD 分离的 prefill worker |
| `decode` | `decode` | PD 分离的 decode worker |
| 两者同时出现或缺失 | `unknown` | 未知 |

多端点输入且分别为 prefill + decode 时，`mergePdSnapshots` 产出的合并 snapshot 角色标为 `pd-disagg`，仪表盘标题栏显示 `[PD-DISAGG]`。

### 8.2 PD 模式下的指标差异

| 指标 | prefill 端 | decode 端 | 合并策略 |
|---|---|---|---|
| `sglang:time_to_first_token_seconds` | ❌ 不存在 | ✓ 存在 | 取 decode |
| `sglang:inter_token_latency_seconds` | ❌ 不存在 | ✓ 存在 | 取 decode |
| `sglang:e2e_request_latency_seconds` | ✓（prefill 视角） | ✓（用户视角） | 取 decode |
| `sglang:gen_throughput` / 生成 token 速率 | 0 | >0 | 取 decode |
| `sglang:prompt_tokens_total` 速率 | >0 | >0 | 取 prefill（prefill 处理 prompt） |
| `sglang:cache_hit_rate` / L1 命中 | >0 | 0 | 取 prefill（radix cache 在 prefill 端） |
| `sglang:hicache_host_*` L2 | ✓ | ❌ | 取 prefill |
| `sglang:num_used_tokens` / `max_total_num_tokens` L1 容量 | ✓ | ✓ | 计数两端相加，占用率按合计重算 |
| `sglang:evicted_tokens_total` / `load_back_tokens_total` | ✓ | ✓ | 计数与速率两端分别相加（各自独立迁移） |
| `sglang:token_usage` | 0 | >0 | 取 decode（decode 端 KV 池是瓶颈） |
| `sglang:spec_accept_*` | 0 | >0 | 取 decode |
| `sglang:num_requests_total` / aborted | 各自计数 | 各自计数 | 取 max（避免双计同一请求） |

### 8.3 PD 专属指标

| metric | 类型 | 标签 | 聚合 | 物理含义 |
|---|---|---|---|---|
| `sglang:per_stage_req_latency_seconds` | histogram | `engine_type, model_name, moe_ep_rank, pp_rank, tp_rank, stage` | 按 `stage` 分组，每组建一条 histogram 后算分位数 | PD 各阶段延迟。prefill 端 stage：`prefill_bootstrap` / `prefill_forward` / `prefill_transfer_kv_cache` / `chunked_prefill`；decode 端 stage：`decode_prepare` / `decode_bootstrap` / `decode_transferred` / `decode_waiting` / `fake_output`。 |
| `sglang:kv_transfer_latency_ms` | histogram | `engine_type, model_name, moe_ep_rank, pp_rank, tp_rank` | `histogramByName` | 单次 KV cache 转移延迟（ms）。仅 prefill 端有样本（发送方视角）。 |
| `sglang:kv_transfer_total_mb` | histogram | 同上 | `histogramByName` | 单次 KV 转移总量（MB）。 |
| `sglang:kv_transfer_speed_gb_s` | histogram | 同上 | `histogramByName` | KV 转移吞吐速率（GB/s）。 |
| `sglang:kv_transfer_bootstrap_ms` | histogram | 同上 | `histogramByName` | KV 转移 bootstrap 延迟（ms），两端均有样本。 |
| `sglang:kv_transfer_alloc_ms` | histogram | 同上 | `histogramByName` | KV 转移内存分配延迟（ms）。 |
| `sglang:num_prefill_bootstrap_queue_reqs` | gauge | `engine_type, model_name, moe_ep_rank, pp_rank, tp_rank` | `sumOverDp`（按 tp_rank 去重） | 等待 prefill bootstrap 的请求数。 |
| `sglang:num_prefill_inflight_queue_reqs` | gauge | 同上 | `sumOverDp` | prefill inflight（正在 prefill）队列请求数。 |
| `sglang:num_decode_prealloc_queue_reqs` | gauge | 同上 | `sumOverDp` | 等待 decode 预分配的请求数。 |
| `sglang:num_decode_transfer_queue_reqs` | gauge | 同上 | `sumOverDp` | 等待 KV 转移到 decode 的请求数。 |
| `sglang:num_paused_reqs` | gauge | 同上 + `pid` | `sumOverDp` | 暂停请求数（被抢占等）。 |
| `sglang:num_retracted_reqs` | gauge | 同上 + `pid` | `sumOverDp` | 回退请求数。 |
| `sglang:kv_used_tokens` | gauge | 同上 | `sumOverDp` | KV cache 池已用 token 数。 |
| `sglang:kv_available_tokens` | gauge | 同上 | `sumOverDp` | KV cache 池可用 token 数。 |
| `sglang:kv_evictable_tokens` | gauge | 同上 | `sumOverDp` | KV cache 池可驱逐 token 数。 |
| `sglang:max_total_num_tokens` | gauge | 同上 | `sumOverDp` | KV cache 池总容量（token 数），合并时两端相加。 |
| `sglang:num_used_tokens` | gauge | 同上 | `sumOverDp` | 实际使用 token 数（含 radix cache 占用）。 |

### 8.4 聚合行为修正（惠及统一模式）

- **`histSumBucketsAcrossDp` 桶通胀修复**：原实现直接累加所有 `_bucket` 样本，在「同 dp_rank 内多 tp_rank 重复上报」或「dp_rank 缺失（PD 模式）」时导致桶累积值 4× 膨胀，count 去重正确但分位数插值落点错位（p50 被低估至约 1/4 真实值）。修复后先按 `groupBy` 分组、组内按 `le` 去重再跨组求和，统一与 PD 模式均正确。
- **HTTP 端点回退**：`http_requests_active` 优先级 `/v1/chat/completions` → `/v1/completions` → `/generate`，PD prefill 端仅暴露 `/v1/completions` 时不再误报 0。
- **NaN 过滤**：`fwd_occupancy` 等可能为 NaN 的 gauge 通过 `safeNum` 归零。

### 8.5 mergePdSnapshots 字段映射

| 合并字段 | 来源 |
|---|---|
| `engineRole` | `"pd-disagg"` |
| `endpoint` | `P <p.endpoint> · D <d.endpoint>` |
| `running` / `queued` / `concurrent` / `httpActive` | p + d 求和 |
| `ttft` / `tpot` / `e2e` / `hasTtft` / `hasTpot` / `hasE2e` | 取 decode 端（decode 无样本时回退 prefill） |
| `queueTime` | 取 count 较大者 |
| `genThroughput` / `outputTokenRate` | 取 decode |
| `inputTokenRate` | 取 prefill |
| `totalRequests` / `abortedRequests` | max(p, d) |
| `l1HitRate` / `l1HitRateGauge` / `l2Usage` / `l2UsedTokens` / `l2TotalTokens` / `cachedDeviceTokens` / `cachedHostTokens` | 取 prefill（+ decode 加和，decode 端通常为 0） |
| `l1UsedTokens` / `l1TotalTokens` | p + d 求和 |
| `l1Usage` | 按 `(p Used + d Used) / (p Total + d Total)` 重算 |
| `evictedTokensTotal` / `loadBackTokensTotal` / `evictedTokenRate` / `loadBackTokenRate` | p + d 求和（两端各自的 L1↔L2 迁移独立累加） |
| `kvUsage` / `specAcceptRate` / `specAcceptLength` | 取 decode |
| `perStage` | `[...p.perStage, ...d.perStage]` |
| `kvTransfer.*` | 取有样本的一端（通常 prefill 端 4 个直方图齐全，decode 端仅 bootstrap/alloc） |
| `pdQueues.prefillBootstrap` / `prefillInflight` | 取 prefill |
| `pdQueues.decodePrealloc` / `decodeTransfer` | 取 decode |
| `pdQueues.paused` / `retracted` | p + d 求和 |
| `kvPool.*` | p + d 求和 |
| `perDp.*` | `[]`（PD 模式无 dp_rank 维度） |
| `fetchError` | 两端 error 拼接（` | `分隔） |

---

## 参考资料

- sglang 仓库：<https://github.com/sgl-project/sglang>（启动参数 `--enable-metrics`、`--enable-hierarchical-cache`）
- Prometheus 直方图分位数算法：<https://prometheus.io/docs/prometheus/latest/querying/functions/#histogram_quantile>
- 本仓库实现见 `src/metrics.ts` 的 `buildSnapshot`（含 PD 角色探测与 PD 指标采集）、`mergePdSnapshots`（PD 合并）、`perStageLatencies`（按 stage 分组），以及 `src/dashboard.ts` 的 `render` 与 PD 专用面板渲染函数（`renderPdQueues` / `renderKvTransfer` / `renderPerStage` / `renderKvPool`）。
