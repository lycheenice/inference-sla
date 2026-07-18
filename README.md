# sglang-sla

Terminal SLA dashboard for [sglang](https://github.com/sgl-project/sglang) serving, built on [OpenTUI](https://github.com/anomalyco/opentui).

Live, in-terminal view of request concurrency, latency percentiles (TTFT / TPOT / E2E / queue wait), output throughput, and cache hit rates — pulling directly from sglang's Prometheus `/metrics` endpoint, no sidecar required.

## Features

- **Requests** — running / queued / concurrent / HTTP in-flight / total / aborted, with capacity bars against `max_running_requests` / `max_queued_requests`.
- **TTFT** — time-to-first-token p50 / p90 / p99 / avg from `sglang:time_to_first_token_seconds`.
- **TPOT** — time-per-output-token p50 / p90 / p99 / avg from `sglang:inter_token_latency_seconds`.
- **E2E latency** — end-to-end request latency p50 / p90 / p99 from `sglang:e2e_request_latency_seconds`.
- **Queue wait** — queueing time p50 / p90 / p99 from `sglang:queue_time_seconds`, buckets summed across DP ranks.
- **Throughput** — output tok/s (`Δ sglang:generation_tokens_total`), input tok/s (`Δ sglang:prompt_tokens_total`), summed `sglang:gen_throughput` gauge.
- **Cache** — L1 (GPU radix) hit rate = avg `sglang:cache_hit_rate` across DP; L2 (host) occupancy = `hicache_host_used_tokens / hicache_host_total_tokens`; KV usage = avg `sglang:token_usage`.
- **Speculative (EAGLE)** — accept rate and accept length across DP.
- **Per-Degree (DP0–DP3)** — per-`dp_rank` running / queued / gen throughput / L1 hit / KV usage table.

Threshold-based color coding: green / yellow / red for capacity, latency, and cache saturation.

## Requirements

- **Bun ≥ 1.3** (TypeScript runtime; OpenTUI ships prebuilt linux-x64 native bindings, so no Zig/toolchain needed)
- A running sglang server launched with `--enable-metrics` (and `--enable-hierarchical-cache` for L2 metrics)

## Install

```bash
git clone <this-repo> sglang-sla
cd sglang-sla
bun install
```

Bun install note: if you cannot reach GitHub releases, `@opentui/core` and Bun itself are both available from the npm registry (`registry.npmjs.org`), which is typically reachable when GitHub is not.

## Run

```bash
# default: http://localhost:8001/metrics, 1000ms refresh
bun src/main.ts

# custom endpoint + refresh
bun src/main.ts http://host:8001/metrics 1000

# flags
bun src/main.ts --endpoint http://host:8001/metrics --refresh 1000

# env vars
SGLANG_METRICS=http://host:8001/metrics SGLANG_REFRESH_MS=1000 bun src/main.ts
```

Keys: `q` / `Esc` / `Ctrl+C` to quit.

## How metrics are computed

- **DP aggregation** — per-worker gauges repeat across TP ranks within a DP group, so gauges are de-duplicated by `dp_rank` (group max) then summed across the 4 DP workers (e.g. total running = Σ over DP of max-across-TP).
- **Percentiles** — `histogram_quantile`-style linear interpolation over the cumulative histogram buckets: `q_val = lower + (rank - cum_prev) / (cum_cur - cum_prev) * (upper - lower)`, with `+Inf` bucket falling back to the previous finite upper bound.
- **Throughput rates** — counters (`generation_tokens_total`, `prompt_tokens_total`) are differenced between successive samples and divided by the elapsed wall-clock interval; the first sample is 0.
- **L1 vs L2 cache** — L1 is the instantaneous radix cache hit rate gauge (`cache_hit_rate`); L2 is the hierarchical host cache occupancy (`hicache_host_*`). sglang's current metrics do not expose a dedicated L2 hit counter, so L2 is reported as occupancy.
- **Queue-time across DP** — per-DP histogram buckets are summed into a single virtual histogram before computing quantiles.

## Project layout

```
src/
  metrics.ts        Prometheus text parser, MetricsStore, histogram_quantile, buildSnapshot, formatters
  dashboard.ts      OpenTUI panels (BoxRenderable/TextRenderable), tick loop, color-coded rendering
  main.ts           CLI entry: arg/env parsing, renderer bootstrap, shutdown handling
  metrics.test.ts   unit tests (parser, quantiles, aggregation, formatters)
```

## Develop

```bash
bun run typecheck   # tsc --noEmit
bun run lint        # oxlint src
bun test            # unit tests
bun run dev         # launch dashboard against default endpoint
```

## License

MIT
