# inference-sla

面向 LLM 推理服务的终端 SLA 仪表盘，基于 [OpenTUI](https://github.com/anomalyco/opentui) 构建。

实时终端视图：请求并发、延迟分位数（TTFT / TPOT / E2E / 队列等待）、输出吞吐与缓存命中率——直接从推理引擎的 Prometheus `/metrics` 端点拉取，无需 sidecar。支持 sglang 的统一（unified）部署与 **PD 分离（prefill / decode disaggregated）** 部署；当前目标为 [sglang](https://github.com/sgl-project/sglang)，vLLM 支持规划中。

## 功能特性

- **Requests** — running / queued / concurrent / HTTP in-flight / total / aborted，附带 `max_running_requests` / `max_queued_requests` 容量条。
- **TTFT** — 首响时间 p50 / p90 / p99 / avg，来自 `sglang:time_to_first_token_seconds`（PD 模式取自 decode 端）。
- **TPOT** — 每 token 生成间隔 p50 / p90 / p99 / avg，来自 `sglang:inter_token_latency_seconds`（PD 模式取自 decode 端）。
- **E2E latency** — 端到端请求延迟 p50 / p90 / p99，来自 `sglang:e2e_request_latency_seconds`。
- **Queue wait** — 排队等待时间 p50 / p90 / p99，来自 `sglang:queue_time_seconds`，桶跨 DP 等级累加。
- **Throughput** — 输出 tok/s（`Δ sglang:generation_tokens_total`）、输入 tok/s（`Δ sglang:prompt_tokens_total`）、汇总 `sglang:gen_throughput` gauge。
- **Cache** — L1（GPU radix）命中率 = 跨 DP 平均 `sglang:cache_hit_rate`（PD 模式取 prefill 端）；L2（host）占用率 = `hicache_host_used_tokens / hicache_host_total_tokens`；KV 使用率 = 跨 DP 平均 `sglang:token_usage`（PD 模式取 decode 端）。**L1↔L2 迁移**：`Δ sglang:evicted_tokens_total`（L1→L2）/ `Δ sglang:load_back_tokens_total`（L2→L1）算出 tok/s 速率，并展示累计迁移量。
- **Speculative (EAGLE)** — 跨 DP 的接受率与接受长度（PD 模式取 decode 端）。
- **Per-Degree (DP0–DP3)** — 按 `dp_rank` 拆分的 running / queued / gen 吞吐 / L1 命中 / KV 使用率表（统一模式）。
- **PD 模式专属面板** —
  - **PD QUEUES** — `num_prefill_bootstrap_queue_reqs` / `num_prefill_inflight_queue_reqs` / `num_decode_prealloc_queue_reqs` / `num_decode_transfer_queue_reqs` + paused / retracted。
  - **KV TRANSFER** — `kv_transfer_latency_ms` / `kv_transfer_total_mb` / `kv_transfer_speed_gb_s` / `kv_transfer_bootstrap_ms` / `kv_transfer_alloc_ms` 的 p50 / p90 / p99（取自 prefill 端发送方）。
  - **PER-STAGE LATENCY** — `sglang:per_stage_req_latency_seconds` 按 `stage` 拆分的分位数（prefill_bootstrap / prefill_forward / prefill_transfer_kv_cache / chunked_prefill / decode_prepare / decode_bootstrap / decode_transferred / decode_waiting / fake_output）。
  - **KV CACHE POOL** — `kv_used_tokens` / `kv_available_tokens` / `kv_evictable_tokens` / `max_total_num_tokens` + 占用率。

基于阈值的颜色编码：绿 / 黄 / 红，分别对应容量、延迟与缓存饱和度。

## 环境要求

- **Bun ≥ 1.3**（TypeScript 运行时；OpenTUI 预编译 linux-x64 原生绑定，无需 Zig 工具链）
- 运行中的 sglang 服务，启动参数需含 `--enable-metrics`（L2 指标还需 `--enable-hierarchical-cache`）

## 安装

```bash
git clone <this-repo> inference-sla
cd inference-sla
bun install
```

Bun 安装提示：若无法访问 GitHub releases，`@opentui/core` 与 Bun 本身均可从 npm registry（`registry.npmjs.org`）获取，通常在 GitHub 不通时仍可达。

## 运行

```bash
# 默认：http://localhost:8001/metrics，1000ms 刷新
bun src/main.ts

# 自定义端点 + 刷新间隔
bun src/main.ts http://host:8001/metrics 1000

# flag 形式
bun src/main.ts --endpoint http://host:8001/metrics --refresh 1000

# 环境变量
SGLANG_METRICS=http://host:8001/metrics SGLANG_REFRESH_MS=1000 bun src/main.ts

# PD 分离部署：逗号分隔传入 prefill + decode 两个端点（自动识别角色并合并视图）
bun src/main.ts --endpoint http://h200-2:8001/metrics,http://h200-2:8002/metrics --refresh 1000

# 或重复 --endpoint
bun src/main.ts -e http://h200-2:8001/metrics -e http://h200-2:8002/metrics
```

按键：`q` / `Esc` / `Ctrl+C` 退出。

### 部署模式识别

仪表盘根据 metrics 中 `engine_type` 标签自动识别部署模式，并在标题栏显示角色标签：

- `[UNIFIED]` — 单端点，`engine_type` 为 `unified`（或不带 rank 分离标签），按原有 DP 聚合逻辑。
- `[PREFILL]` — 单端点，`engine_type=prefill`（PD 分离的 prefill worker）。TTFT/TPOT 直方图在此端缺失，面板会显示提示并改由 PER-STAGE 面板呈现各阶段延迟。
- `[DECODE]` — 单端点，`engine_type=decode`（PD 分离的 decode worker）。
- `[PD-DISAGG]` — 传入两个端点且分别为 prefill + decode 时自动合并视图：TTFT/TPOT/吞吐/KV 使用率取 decode 端（用户视角），L1/L2 缓存取 prefill 端，per-stage 合并两端所有阶段，KV TRANSFER 取 prefill 端发送方。

## 指标计算方式

- **DP 聚合** — 每个 worker 的 gauge 在同一 DP group 内跨 TP rank 重复，故 gauge 先按 `dp_rank` 去重（取组内 max）再跨 4 个 DP worker 求和（如总 running = Σ 跨 DP 取 max-跨-TP）。当 `dp_rank` 标签缺失（PD 分离场景）时，所有样本被视为同一组 `"*"`，仅取首个 tp_rank 的值，避免 TP rank 重复导致 4× 通胀。
- **直方图桶跨 DP 求和（去重修复）** — `histSumBucketsAcrossDp` 在累加 `_bucket` 前先按 `groupBy`（默认 `dp_rank`）分组、组内按 `le` 去重，再跨组求和；`_count` / `_sum` 同样按 `groupBy` 去重。这样无论 dp_rank 存不存在、同组内是否有多个 tp_rank 重复上报，都不会出现桶累加膨胀导致分位数插值错位。
- **分位数** — 类 `histogram_quantile` 的线性插值：`q_val = lower + (rank - cum_prev) / (cum_cur - cum_prev) * (upper - lower)`，`+Inf` 桶回退到前一有限上界。
- **吞吐速率** — 计数器（`generation_tokens_total`、`prompt_tokens_total`）在相邻两次采样间求差，除以 wall-clock 间隔；首次采样为 0。
- **L1 vs L2 缓存** — L1 是瞬时 radix 缓存命中率 gauge（`cache_hit_rate`）；L2 是分层 host 缓存占用率（`hicache_host_*`）。sglang 当前未暴露专门的 L2 命中计数器，故 L2 报为占用率。
- **跨 DP 队列时间** — 每个 DP 的 histogram 桶在计算分位数前先累加成一条虚拟 histogram。
- **NaN 处理** — 个别 gauge（如 `fwd_occupancy`）在某些状态下可能为 NaN，聚合时以 0 替代以避免下游渲染异常。
- **HTTP 端点回退** — `http_requests_active` 优先取 `/v1/chat/completions`，其次 `/v1/completions`，最后 `/generate`。PD 下 prefill 端通常仅暴露 `/v1/completions`，回退保证 HTTP in-flight 不再误报 0。
- **PD 模式合并** — `mergePdSnapshots(p, d)` 把 prefill 与 decode 两个 snapshot 合并为单一 `[PD-DISAGG]` 视图：用户视角指标（TTFT / TPOT / E2E / genThroughput / outputTokenRate / kvUsage / spec）取 decode 端，prefill 侧输入与缓存（inputTokenRate / L1 / L2 / cached_* / evicted / load_back 迁移计数与速率）求和（两端各自独立迁移），per-stage 序列拼接两端所有阶段，KV TRANSFER 直方图取有样本的一端（通常 prefill 发送方），pdQueues 按角色分别取值，kvPool 与并发/HTTP 求和。totalRequests / abortedRequests 取两端 max 以避免双计。

## 项目结构

```
src/
  metrics.ts        Prometheus 文本解析、MetricsStore、histogram_quantile、buildSnapshot、格式化器
  dashboard.ts      OpenTUI 面板（BoxRenderable/TextRenderable）、tick 循环、颜色渲染
  main.ts           CLI 入口：参数/env 解析、渲染器引导、关闭处理
  metrics.test.ts   单元测试（解析器、分位数、聚合、格式化器）
```

## 开发

```bash
bun run typecheck   # tsc --noEmit
bun run lint        # oxlint src
bun test            # 单元测试
bun run dev         # 以默认端点启动仪表盘
```

## License

MIT
