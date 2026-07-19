# inference-sla

面向 LLM 推理服务的终端 SLA 仪表盘，基于 [OpenTUI](https://github.com/anomalyco/opentui) 构建。

实时终端视图：请求并发、延迟分位数（TTFT / TPOT / E2E / 队列等待）、输出吞吐与缓存命中率——直接从推理引擎的 Prometheus `/metrics` 端点拉取，无需 sidecar。当前目标为 [sglang](https://github.com/sgl-project/sglang)；vLLM 支持规划中。

## 功能特性

- **Requests** — running / queued / concurrent / HTTP in-flight / total / aborted，附带 `max_running_requests` / `max_queued_requests` 容量条。
- **TTFT** — 首响时间 p50 / p90 / p99 / avg，来自 `sglang:time_to_first_token_seconds`。
- **TPOT** — 每 token 生成间隔 p50 / p90 / p99 / avg，来自 `sglang:inter_token_latency_seconds`。
- **E2E latency** — 端到端请求延迟 p50 / p90 / p99，来自 `sglang:e2e_request_latency_seconds`。
- **Queue wait** — 排队等待时间 p50 / p90 / p99，来自 `sglang:queue_time_seconds`，桶跨 DP 等级累加。
- **Throughput** — 输出 tok/s（`Δ sglang:generation_tokens_total`）、输入 tok/s（`Δ sglang:prompt_tokens_total`）、汇总 `sglang:gen_throughput` gauge。
- **Cache** — L1（GPU radix）命中率 = 跨 DP 平均 `sglang:cache_hit_rate`；L2（host）占用率 = `hicache_host_used_tokens / hicache_host_total_tokens`；KV 使用率 = 跨 DP 平均 `sglang:token_usage`。
- **Speculative (EAGLE)** — 跨 DP 的接受率与接受长度。
- **Per-Degree (DP0–DP3)** — 按 `dp_rank` 拆分的 running / queued / gen 吞吐 / L1 命中 / KV 使用率表。

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
```

按键：`q` / `Esc` / `Ctrl+C` 退出。

## 指标计算方式

- **DP 聚合** — 每个 worker 的 gauge 在同一 DP group 内跨 TP rank 重复，故 gauge 先按 `dp_rank` 去重（取组内 max）再跨 4 个 DP worker 求和（如总 running = Σ 跨 DP 取 max-跨-TP）。
- **分位数** — 类 `histogram_quantile` 的线性插值：`q_val = lower + (rank - cum_prev) / (cum_cur - cum_prev) * (upper - lower)`，`+Inf` 桶回退到前一有限上界。
- **吞吐速率** — 计数器（`generation_tokens_total`、`prompt_tokens_total`）在相邻两次采样间求差，除以 wall-clock 间隔；首次采样为 0。
- **L1 vs L2 缓存** — L1 是瞬时 radix 缓存命中率 gauge（`cache_hit_rate`）；L2 是分层 host 缓存占用率（`hicache_host_*`）。sglang 当前未暴露专门的 L2 命中计数器，故 L2 报为占用率。
- **跨 DP 队列时间** — 每个 DP 的 histogram 桶在计算分位数前先累加成一条虚拟 histogram。

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
