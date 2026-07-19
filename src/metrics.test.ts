import { describe, test, expect } from "bun:test"
import {
  MetricsStore,
  buildSnapshot,
  histogramQuantile,
  mergePdSnapshots,
  parsePrometheus,
  fmtMs,
  fmtPct,
  fmtNum,
} from "./metrics.js"

const SAMPLE = `
# HELP sglang:num_running_reqs The number of running requests.
# TYPE sglang:num_running_reqs gauge
sglang:num_running_reqs{dp_rank="0",engine_type="unified",model_name="glm",tp_rank="0"} 2.0
sglang:num_running_reqs{dp_rank="0",engine_type="unified",model_name="glm",tp_rank="1"} 2.0
sglang:num_running_reqs{dp_rank="1",engine_type="unified",model_name="glm",tp_rank="2"} 0.0
sglang:num_running_reqs{dp_rank="1",engine_type="unified",model_name="glm",tp_rank="3"} 0.0
sglang:num_queue_reqs{dp_rank="0",engine_type="unified",model_name="glm",tp_rank="0"} 3.0
sglang:num_queue_reqs{dp_rank="0",engine_type="unified",model_name="glm",tp_rank="1"} 3.0
sglang:num_queue_reqs{dp_rank="1",engine_type="unified",model_name="glm",tp_rank="2"} 1.0
sglang:num_queue_reqs{dp_rank="1",engine_type="unified",model_name="glm",tp_rank="3"} 1.0
sglang:cache_hit_rate{dp_rank="0",engine_type="unified",model_name="glm",tp_rank="0"} 0.0
sglang:cache_hit_rate{dp_rank="0",engine_type="unified",model_name="glm",tp_rank="1"} 0.0
sglang:cache_hit_rate{dp_rank="1",engine_type="unified",model_name="glm",tp_rank="2"} 0.0
sglang:cache_hit_rate{dp_rank="1",engine_type="unified",model_name="glm",tp_rank="3"} 0.0
sglang:token_usage{dp_rank="0",engine_type="unified",model_name="glm",tp_rank="0"} 0.10
sglang:token_usage{dp_rank="1",engine_type="unified",model_name="glm",tp_rank="2"} 0.20
sglang:realtime_tokens_total{dp_rank="0",engine_type="unified",mode="prefill_cache",model_name="glm",tp_rank="0"} 900.0
sglang:realtime_tokens_total{dp_rank="0",engine_type="unified",mode="prefill_compute",model_name="glm",tp_rank="0"} 100.0
sglang:realtime_tokens_total{dp_rank="1",engine_type="unified",mode="prefill_cache",model_name="glm",tp_rank="2"} 800.0
sglang:realtime_tokens_total{dp_rank="1",engine_type="unified",mode="prefill_compute",model_name="glm",tp_rank="2"} 200.0
sglang:gen_throughput{dp_rank="0",engine_type="unified",model_name="glm",tp_rank="0"} 100.0
sglang:gen_throughput{dp_rank="1",engine_type="unified",model_name="glm",tp_rank="2"} 50.0
sglang:http_requests_active{endpoint="/v1/chat/completions",method="POST"} 1.0
sglang:http_requests_active{endpoint="/metrics",method="GET"} 1.0
sglang:num_requests_total{engine_type="unified",model_name="glm"} 12345.0
sglang:num_aborted_requests_total{engine_type="unified",model_name="glm"} 7.0
sglang:generation_tokens_total{engine_type="unified",model_name="glm"} 1000.0
sglang:prompt_tokens_total{engine_type="unified",model_name="glm"} 5000.0
sglang:hicache_host_used_tokens{dp_rank="0",engine_type="unified",model_name="glm",tp_rank="0"} 3000000.0
sglang:hicache_host_total_tokens{dp_rank="0",engine_type="unified",model_name="glm",tp_rank="0"} 3908736.0
sglang:hicache_host_used_tokens{dp_rank="1",engine_type="unified",model_name="glm",tp_rank="2"} 2000000.0
sglang:hicache_host_total_tokens{dp_rank="1",engine_type="unified",model_name="glm",tp_rank="2"} 3908736.0
sglang:cached_tokens_total{cache_source="device",engine_type="unified",model_name="glm"} 5.11430304e+09
sglang:cached_tokens_total{cache_source="host",engine_type="unified",model_name="glm"} 1.729396096e+09
sglang:evicted_tokens_total{engine_type="unified",model_name="glm"} 12345.0
sglang:load_back_tokens_total{engine_type="unified",model_name="glm"} 6789.0
sglang:spec_accept_rate{dp_rank="0",engine_type="unified",model_name="glm",tp_rank="0"} 0.55
sglang:spec_accept_length{dp_rank="0",engine_type="unified",model_name="glm",tp_rank="0"} 1.55
sglang:time_to_first_token_seconds_sum{engine_type="unified",model_name="glm"} 1.0e+06
sglang:time_to_first_token_seconds_count{engine_type="unified",model_name="glm"} 100.0
sglang:time_to_first_token_seconds_bucket{engine_type="unified",le="0.1",model_name="glm"} 10.0
sglang:time_to_first_token_seconds_bucket{engine_type="unified",le="0.4",model_name="glm"} 50.0
sglang:time_to_first_token_seconds_bucket{engine_type="unified",le="1.0",model_name="glm"} 90.0
sglang:time_to_first_token_seconds_bucket{engine_type="unified",le="2.0",model_name="glm"} 100.0
sglang:time_to_first_token_seconds_bucket{engine_type="unified",le="+Inf",model_name="glm"} 100.0
sglang:inter_token_latency_seconds_sum{engine_type="unified",model_name="glm"} 500.0
sglang:inter_token_latency_seconds_count{engine_type="unified",model_name="glm"} 1000.0
sglang:inter_token_latency_seconds_bucket{engine_type="unified",le="0.01",model_name="glm"} 500.0
sglang:inter_token_latency_seconds_bucket{engine_type="unified",le="0.02",model_name="glm"} 800.0
sglang:inter_token_latency_seconds_bucket{engine_type="unified",le="0.04",model_name="glm"} 950.0
sglang:inter_token_latency_seconds_bucket{engine_type="unified",le="0.1",model_name="glm"} 1000.0
sglang:inter_token_latency_seconds_bucket{engine_type="unified",le="+Inf",model_name="glm"} 1000.0
sglang:queue_time_seconds_count{dp_rank="0",engine_type="unified",model_name="glm",tp_rank="0"} 50.0
sglang:queue_time_seconds_sum{dp_rank="0",engine_type="unified",model_name="glm",tp_rank="0"} 25.0
sglang:queue_time_seconds_bucket{dp_rank="0",le="0.5",model_name="glm",tp_rank="0"} 30.0
sglang:queue_time_seconds_bucket{dp_rank="0",le="2.0",model_name="glm",tp_rank="0"} 45.0
sglang:queue_time_seconds_bucket{dp_rank="0",le="10.0",model_name="glm",tp_rank="0"} 50.0
sglang:queue_time_seconds_bucket{dp_rank="0",le="+Inf",model_name="glm",tp_rank="0"} 50.0
sglang:queue_time_seconds_count{dp_rank="1",engine_type="unified",model_name="glm",tp_rank="2"} 50.0
sglang:queue_time_seconds_sum{dp_rank="1",engine_type="unified",model_name="glm",tp_rank="2"} 15.0
sglang:queue_time_seconds_bucket{dp_rank="1",le="0.5",model_name="glm",tp_rank="2"} 40.0
sglang:queue_time_seconds_bucket{dp_rank="1",le="2.0",model_name="glm",tp_rank="2"} 48.0
sglang:queue_time_seconds_bucket{dp_rank="1",le="10.0",model_name="glm",tp_rank="2"} 50.0
sglang:queue_time_seconds_bucket{dp_rank="1",le="+Inf",model_name="glm",tp_rank="2"} 50.0
`

describe("parsePrometheus", () => {
  test("parses lines and labels", () => {
    const lines = parsePrometheus(SAMPLE)
    const running = lines.filter((l) => l.name === "sglang:num_running_reqs")
    expect(running.length).toBe(4)
    expect(running[0].labels["dp_rank"]).toBe("0")
    expect(running[0].labels["tp_rank"]).toBe("0")
    expect(running[0].value).toBe(2.0)
  })

  test("skips comments and blanks", () => {
    const lines = parsePrometheus("# HELP foo bar\n\n# TYPE foo gauge\nfoo 1.0")
    expect(lines.length).toBe(1)
    expect(lines[0].name).toBe("foo")
    expect(lines[0].value).toBe(1.0)
  })

  test("handles +Inf and scientific notation", () => {
    const lines = parsePrometheus('x{le="+Inf"} 5.11430304e+09')
    expect(lines[0].labels["le"]).toBe("+Inf")
    expect(lines[0].value).toBeCloseTo(5114303040)
  })
})

describe("MetricsStore", () => {
  test("sumGauge collapses duplicate dp_rank via sumOverDp", () => {
    const store = new MetricsStore()
    store.ingest(SAMPLE)
    const running = store.lines("sglang:num_running_reqs")
    expect(running.length).toBe(4)
  })

  test("histogramByName builds buckets", () => {
    const store = new MetricsStore()
    store.ingest(SAMPLE)
    const h = store.histogramByName("sglang:time_to_first_token_seconds")
    expect(h).not.toBeNull()
    expect(h!.count).toBe(100)
    expect(h!.sum).toBeCloseTo(1e6)
    expect(h!.buckets.length).toBe(5)
    expect(h!.buckets[0].le).toBe(0.1)
    expect(h!.buckets[h!.buckets.length - 1].le).toBe(Number.POSITIVE_INFINITY)
  })
})

describe("histogramQuantile", () => {
  test("p50 interpolates within bucket", () => {
    const h = { count: 100, sum: 0, buckets: [
      { le: 0.1, cum: 10 },
      { le: 0.4, cum: 50 },
      { le: 1.0, cum: 90 },
      { le: 2.0, cum: 100 },
      { le: Number.POSITIVE_INFINITY, cum: 100 },
    ] }
    const p50 = histogramQuantile(h, 0.5)
    expect(p50).toBeCloseTo(0.4, 1)
  })

  test("p99 falls within upper bucket", () => {
    const h = { count: 100, sum: 0, buckets: [
      { le: 0.1, cum: 10 },
      { le: 0.4, cum: 50 },
      { le: 1.0, cum: 90 },
      { le: 2.0, cum: 100 },
      { le: Number.POSITIVE_INFINITY, cum: 100 },
    ] }
    const p99 = histogramQuantile(h, 0.99)
    expect(p99).toBeGreaterThan(1.0)
    expect(p99).toBeLessThanOrEqual(2.0)
  })

  test("zero count returns 0", () => {
    const h = { count: 0, sum: 0, buckets: [{ le: 1, cum: 0 }] }
    expect(histogramQuantile(h, 0.5)).toBe(0)
  })
})

describe("buildSnapshot", () => {
  test("aggregates gauges across DP", () => {
    const store = new MetricsStore()
    store.ingest(SAMPLE)
    const snap = buildSnapshot(store, null)
    expect(snap.running).toBe(2)
    expect(snap.queued).toBe(4)
    expect(snap.concurrent).toBe(6)
    expect(snap.httpActive).toBe(1)
    expect(snap.totalRequests).toBe(12345)
    expect(snap.abortedRequests).toBe(7)
  })

  test("computes L1 hit rate from realtime_tokens (prefill_cache / cache+compute)", () => {
    const store = new MetricsStore()
    store.ingest(SAMPLE)
    const snap = buildSnapshot(store, null)
    // gauge is 0 in fixture; real L1 = (900+800) / (900+800+100+200) = 0.85
    expect(snap.l1HitRateGauge).toBe(0)
    expect(snap.l1HitRate).toBeCloseTo(0.85, 5)
    expect(snap.l1PrefillCacheTokens).toBeCloseTo(1700, 5)
    expect(snap.l1PrefillComputeTokens).toBeCloseTo(300, 5)
  })

  test("computes KV usage average", () => {
    const store = new MetricsStore()
    store.ingest(SAMPLE)
    const snap = buildSnapshot(store, null)
    expect(snap.kvUsage).toBeCloseTo(0.15, 5)
  })

  test("computes L2 occupancy", () => {
    const store = new MetricsStore()
    store.ingest(SAMPLE)
    const snap = buildSnapshot(store, null)
    expect(snap.l2UsedTokens).toBe(5000000)
    expect(snap.l2TotalTokens).toBeCloseTo(7817472, 0)
    expect(snap.l2Usage).toBeGreaterThan(0.5)
    expect(snap.l2Usage).toBeLessThan(0.7)
  })

  test("computes L1<->L2 migration totals; rate 0 on first sample, >0 after delta", async () => {
    const store = new MetricsStore()
    store.ingest(SAMPLE)
    const first = buildSnapshot(store, null)
    expect(first.evictedTokensTotal).toBe(12345)
    expect(first.loadBackTokensTotal).toBe(6789)
    expect(first.evictedTokenRate).toBe(0)
    expect(first.loadBackTokenRate).toBe(0)
    await new Promise((r) => setTimeout(r, 50))
    const sample2 = SAMPLE
      .replace(
        "sglang:evicted_tokens_total{engine_type=\"unified\",model_name=\"glm\"} 12345.0",
        "sglang:evicted_tokens_total{engine_type=\"unified\",model_name=\"glm\"} 12445.0",
      )
      .replace(
        "sglang:load_back_tokens_total{engine_type=\"unified\",model_name=\"glm\"} 6789.0",
        "sglang:load_back_tokens_total{engine_type=\"unified\",model_name=\"glm\"} 7989.0",
      )
    store.ingest(sample2)
    const second = buildSnapshot(store, first)
    expect(second.evictedTokenRate).toBeGreaterThan(0)
    expect(second.loadBackTokenRate).toBeGreaterThan(0)
  })

  test("computes TTFT percentiles", () => {
    const store = new MetricsStore()
    store.ingest(SAMPLE)
    const snap = buildSnapshot(store, null)
    expect(snap.ttft.count).toBe(100)
    expect(snap.ttft.p50).toBeGreaterThan(0)
    expect(snap.ttft.p50).toBeLessThanOrEqual(1.0)
    expect(snap.ttft.p99).toBeGreaterThan(0.4)
  })

  test("computes TPOT percentiles", () => {
    const store = new MetricsStore()
    store.ingest(SAMPLE)
    const snap = buildSnapshot(store, null)
    expect(snap.tpot.count).toBe(1000)
    expect(snap.tpot.p50).toBeGreaterThan(0)
    expect(snap.tpot.p50).toBeLessThanOrEqual(0.02)
  })

  test("sums queue buckets across DP", () => {
    const store = new MetricsStore()
    store.ingest(SAMPLE)
    const snap = buildSnapshot(store, null)
    expect(snap.queueTime.count).toBe(100)
  })

  test("counterRate returns 0 on first sample, then positive delta", async () => {
    const store = new MetricsStore()
    store.ingest(SAMPLE)
    const first = buildSnapshot(store, null)
    expect(first.outputTokenRate).toBe(0)
    await new Promise((r) => setTimeout(r, 50))
    const sample2 = SAMPLE.replace(
      "sglang:generation_tokens_total{engine_type=\"unified\",model_name=\"glm\"} 1000.0",
      "sglang:generation_tokens_total{engine_type=\"unified\",model_name=\"glm\"} 1100.0",
    )
    store.ingest(sample2)
    const second = buildSnapshot(store, first)
    expect(second.outputTokenRate).toBeGreaterThan(0)
  })

  test("per-DP breakdown has 2 entries", () => {
    const store = new MetricsStore()
    store.ingest(SAMPLE)
    const snap = buildSnapshot(store, null)
    expect(snap.perDp.running.length).toBe(2)
    expect(snap.perDp.running[0].dp).toBe("0")
    expect(snap.perDp.running[0].value).toBe(2)
    expect(snap.perDp.running[1].dp).toBe("1")
    expect(snap.perDp.running[1].value).toBe(0)
    expect(snap.perDp.l1.length).toBe(2)
    expect(snap.perDp.l1[0].dp).toBe("0")
    expect(snap.perDp.l1[0].value).toBeCloseTo(0.9, 5) // 900/(900+100)
    expect(snap.perDp.l1[1].dp).toBe("1")
    expect(snap.perDp.l1[1].value).toBeCloseTo(0.8, 5) // 800/(800+200)
  })
})

describe("formatters", () => {
  test("fmtMs", () => {
    expect(fmtMs(0.005)).toBe("5.00ms")
    expect(fmtMs(0.5)).toBe("500ms")
    expect(fmtMs(1.5)).toBe("1.50s")
    expect(fmtMs(0)).toBe("0ms")
  })

  test("fmtPct", () => {
    expect(fmtPct(0.5)).toBe("50.00%")
    expect(fmtPct(1)).toBe("100.00%")
  })

  test("fmtNum", () => {
    expect(fmtNum(1500)).toBe("1.50k")
    expect(fmtNum(1_500_000)).toBe("1.50M")
    expect(fmtNum(0)).toBe("0")
  })
})

const PREFILL_FIXTURE = `
# TYPE sglang:num_running_reqs gauge
sglang:num_running_reqs{engine_type="prefill",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="0"} 0.0
# TYPE sglang:num_queue_reqs gauge
sglang:num_queue_reqs{engine_type="prefill",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="0"} 1.0
# TYPE sglang:http_requests_active gauge
sglang:http_requests_active{endpoint="/v1/completions",method="POST"} 1.0
sglang:http_requests_active{endpoint="/v1/chat/completions",method="POST"} 0.0
# TYPE sglang:num_prefill_bootstrap_queue_reqs gauge
sglang:num_prefill_bootstrap_queue_reqs{engine_type="prefill",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="0"} 2.0
# TYPE sglang:per_stage_req_latency_seconds histogram
sglang:per_stage_req_latency_seconds_bucket{engine_type="prefill",le="0.01",model_name="glm",moe_ep_rank="0",pp_rank="0",stage="prefill_bootstrap",tp_rank="0"} 5.0
sglang:per_stage_req_latency_seconds_bucket{engine_type="prefill",le="0.1",model_name="glm",moe_ep_rank="0",pp_rank="0",stage="prefill_bootstrap",tp_rank="0"} 10.0
sglang:per_stage_req_latency_seconds_bucket{engine_type="prefill",le="+Inf",model_name="glm",moe_ep_rank="0",pp_rank="0",stage="prefill_bootstrap",tp_rank="0"} 10.0
sglang:per_stage_req_latency_seconds_count{engine_type="prefill",model_name="glm",moe_ep_rank="0",pp_rank="0",stage="prefill_bootstrap",tp_rank="0"} 10.0
sglang:per_stage_req_latency_seconds_sum{engine_type="prefill",model_name="glm",moe_ep_rank="0",pp_rank="0",stage="prefill_bootstrap",tp_rank="0"} 0.5
# TYPE sglang:kv_transfer_latency_ms histogram
sglang:kv_transfer_latency_ms_bucket{engine_type="prefill",le="1000.0",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="0"} 0.0
sglang:kv_transfer_latency_ms_bucket{engine_type="prefill",le="5000.0",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="0"} 6.0
sglang:kv_transfer_latency_ms_bucket{engine_type="prefill",le="+Inf",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="0"} 12.0
sglang:kv_transfer_latency_ms_count{engine_type="prefill",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="0"} 12.0
sglang:kv_transfer_latency_ms_sum{engine_type="prefill",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="0"} 107754.0
# TYPE sglang:e2e_request_latency_seconds histogram
sglang:e2e_request_latency_seconds_count{engine_type="prefill",model_name="glm"} 13.0
sglang:e2e_request_latency_seconds_sum{engine_type="prefill",model_name="glm"} 510.0
sglang:e2e_request_latency_seconds_bucket{engine_type="prefill",le="10.0",model_name="glm"} 6.0
sglang:e2e_request_latency_seconds_bucket{engine_type="prefill",le="50.0",model_name="glm"} 13.0
sglang:e2e_request_latency_seconds_bucket{engine_type="prefill",le="+Inf",model_name="glm"} 13.0
# TYPE sglang:queue_time_seconds histogram
sglang:queue_time_seconds_count{engine_type="prefill",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="0"} 67.0
sglang:queue_time_seconds_sum{engine_type="prefill",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="0"} 0.03
sglang:queue_time_seconds_bucket{engine_type="prefill",le="0.001",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="0"} 64.0
sglang:queue_time_seconds_bucket{engine_type="prefill",le="0.01",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="0"} 67.0
sglang:queue_time_seconds_bucket{engine_type="prefill",le="+Inf",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="0"} 67.0
sglang:queue_time_seconds_count{engine_type="prefill",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="1"} 67.0
sglang:queue_time_seconds_sum{engine_type="prefill",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="1"} 0.03
sglang:queue_time_seconds_bucket{engine_type="prefill",le="0.001",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="1"} 64.0
sglang:queue_time_seconds_bucket{engine_type="prefill",le="0.01",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="1"} 67.0
sglang:queue_time_seconds_bucket{engine_type="prefill",le="+Inf",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="1"} 67.0
# TYPE sglang:cache_hit_rate gauge
sglang:cache_hit_rate{engine_type="prefill",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="0"} 0.76
# TYPE sglang:token_usage gauge
sglang:token_usage{engine_type="prefill",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="0"} 0.0
# TYPE sglang:realtime_tokens_total counter
sglang:realtime_tokens_total{engine_type="prefill",mode="prefill_cache",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="0"} 470.0
sglang:realtime_tokens_total{engine_type="prefill",mode="prefill_compute",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="0"} 146.0
# TYPE sglang:num_requests_total counter
sglang:num_requests_total{engine_type="prefill",model_name="glm"} 13.0
# TYPE sglang:num_aborted_requests_total counter
sglang:num_aborted_requests_total{engine_type="prefill",model_name="glm"} 1.0
# TYPE sglang:evicted_tokens_total counter
sglang:evicted_tokens_total{engine_type="prefill",model_name="glm"} 1000.0
# TYPE sglang:load_back_tokens_total counter
sglang:load_back_tokens_total{engine_type="prefill",model_name="glm"} 2000.0
`

const DECODE_FIXTURE = `
# TYPE sglang:num_running_reqs gauge
sglang:num_running_reqs{engine_type="decode",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="0"} 1.0
# TYPE sglang:num_queue_reqs gauge
sglang:num_queue_reqs{engine_type="decode",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="0"} 0.0
# TYPE sglang:http_requests_active gauge
sglang:http_requests_active{endpoint="/v1/chat/completions",method="POST"} 1.0
# TYPE sglang:time_to_first_token_seconds histogram
sglang:time_to_first_token_seconds_count{engine_type="decode",model_name="glm"} 15.0
sglang:time_to_first_token_seconds_sum{engine_type="decode",model_name="glm"} 190.0
sglang:time_to_first_token_seconds_bucket{engine_type="decode",le="10.0",model_name="glm"} 3.0
sglang:time_to_first_token_seconds_bucket{engine_type="decode",le="20.0",model_name="glm"} 14.0
sglang:time_to_first_token_seconds_bucket{engine_type="decode",le="+Inf",model_name="glm"} 15.0
# TYPE sglang:inter_token_latency_seconds histogram
sglang:inter_token_latency_seconds_count{engine_type="decode",model_name="glm"} 1000.0
sglang:inter_token_latency_seconds_sum{engine_type="decode",model_name="glm"} 12.5
sglang:inter_token_latency_seconds_bucket{engine_type="decode",le="0.01",model_name="glm"} 500.0
sglang:inter_token_latency_seconds_bucket{engine_type="decode",le="0.02",model_name="glm"} 1000.0
sglang:inter_token_latency_seconds_bucket{engine_type="decode",le="+Inf",model_name="glm"} 1000.0
# TYPE sglang:per_stage_req_latency_seconds histogram
sglang:per_stage_req_latency_seconds_bucket{engine_type="decode",le="0.001",model_name="glm",moe_ep_rank="0",pp_rank="0",stage="decode_prepare",tp_rank="0"} 5.0
sglang:per_stage_req_latency_seconds_bucket{engine_type="decode",le="0.01",model_name="glm",moe_ep_rank="0",pp_rank="0",stage="decode_prepare",tp_rank="0"} 23.0
sglang:per_stage_req_latency_seconds_bucket{engine_type="decode",le="+Inf",model_name="glm",moe_ep_rank="0",pp_rank="0",stage="decode_prepare",tp_rank="0"} 23.0
sglang:per_stage_req_latency_seconds_count{engine_type="decode",model_name="glm",moe_ep_rank="0",pp_rank="0",stage="decode_prepare",tp_rank="0"} 23.0
sglang:per_stage_req_latency_seconds_sum{engine_type="decode",model_name="glm",moe_ep_rank="0",pp_rank="0",stage="decode_prepare",tp_rank="0"} 0.02
# TYPE sglang:gen_throughput gauge
sglang:gen_throughput{engine_type="decode",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="0"} 70.0
# TYPE sglang:token_usage gauge
sglang:token_usage{engine_type="decode",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="0"} 0.33
# TYPE sglang:num_requests_total counter
sglang:num_requests_total{engine_type="decode",model_name="glm"} 14.0
# TYPE sglang:num_aborted_requests_total counter
sglang:num_aborted_requests_total{engine_type="decode",model_name="glm"} 0.0
# TYPE sglang:num_decode_transfer_queue_reqs gauge
sglang:num_decode_transfer_queue_reqs{engine_type="decode",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="0"} 3.0
# TYPE sglang:kv_used_tokens gauge
sglang:kv_used_tokens{engine_type="decode",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="0"} 145856.0
# TYPE sglang:max_total_num_tokens gauge
sglang:max_total_num_tokens{engine_type="decode",model_name="glm",moe_ep_rank="0",pp_rank="0",tp_rank="0"} 441792.0
# TYPE sglang:evicted_tokens_total counter
sglang:evicted_tokens_total{engine_type="decode",model_name="glm"} 300.0
# TYPE sglang:load_back_tokens_total counter
sglang:load_back_tokens_total{engine_type="decode",model_name="glm"} 400.0
`

describe("PD-disaggregated mode", () => {
  test("prefill snapshot detects role, httpActive fallback, missing TTFT/TPOT", () => {
    const store = new MetricsStore()
    store.ingest(PREFILL_FIXTURE)
    const snap = buildSnapshot(store, null, "http://p/metrics")
    expect(snap.engineRole).toBe("prefill")
    expect(snap.httpActive).toBe(1)
    expect(snap.hasTtft).toBe(false)
    expect(snap.hasTpot).toBe(false)
    expect(snap.hasE2e).toBe(true)
    expect(snap.pdQueues.prefillBootstrap).toBe(2)
    expect(snap.perStage.length).toBe(1)
    expect(snap.perStage[0].stage).toBe("prefill_bootstrap")
    expect(snap.kvTransfer.latencyMs!.count).toBe(12)
    expect(snap.l1HitRate).toBeCloseTo(470 / (470 + 146), 5)
  })

  test("decode snapshot detects role and TTFT/TPOT present", () => {
    const store = new MetricsStore()
    store.ingest(DECODE_FIXTURE)
    const snap = buildSnapshot(store, null, "http://d/metrics")
    expect(snap.engineRole).toBe("decode")
    expect(snap.hasTtft).toBe(true)
    expect(snap.hasTpot).toBe(true)
    expect(snap.ttft.count).toBe(15)
    expect(snap.tpot.count).toBe(1000)
    expect(snap.genThroughput).toBe(70)
    expect(snap.kvUsage).toBeCloseTo(0.33, 5)
    expect(snap.pdQueues.decodeTransfer).toBe(3)
  })

  test("histSumBucketsAcrossDp dedups buckets across tp_rank (no 4x inflation)", () => {
    const store = new MetricsStore()
    store.ingest(PREFILL_FIXTURE)
    const h = store.histSumBucketsAcrossDp("sglang:queue_time_seconds", undefined, "dp_rank")
    expect(h).not.toBeNull()
    expect(h!.count).toBe(67)
    const cum = h!.buckets.find((b) => b.le === 0.001)!.cum
    expect(cum).toBe(64)
  })

  test("mergePdSnapshots combines prefill+decode into pd-disagg view", () => {
    const pStore = new MetricsStore()
    pStore.ingest(PREFILL_FIXTURE)
    const dStore = new MetricsStore()
    dStore.ingest(DECODE_FIXTURE)
    const p = buildSnapshot(pStore, null, "http://p/metrics")
    const d = buildSnapshot(dStore, null, "http://d/metrics")
    const m = mergePdSnapshots(p, d)
    expect(m.engineRole).toBe("pd-disagg")
    expect(m.running).toBe(1)
    expect(m.queued).toBe(1)
    expect(m.httpActive).toBe(2)
    expect(m.hasTtft).toBe(true)
    expect(m.ttft.count).toBe(15)
    expect(m.hasTpot).toBe(true)
    expect(m.tpot.count).toBe(1000)
    expect(m.genThroughput).toBe(70)
    expect(m.kvUsage).toBeCloseTo(0.33, 5)
    expect(m.l1HitRate).toBeCloseTo(470 / (470 + 146), 5)
    expect(m.pdQueues.prefillBootstrap).toBe(2)
    expect(m.pdQueues.decodeTransfer).toBe(3)
    expect(m.perStage.length).toBe(2)
    expect(m.kvPool.maxTotalTokens).toBe(441792)
    expect(m.kvPool.usedTokens).toBe(145856)
    expect(m.endpoint).toContain("P http://p/metrics")
    expect(m.endpoint).toContain("D http://d/metrics")
  })

  test("mergePdSnapshots sums L1<->L2 migration totals across prefill+decode", () => {
    const pStore = new MetricsStore()
    pStore.ingest(PREFILL_FIXTURE)
    const dStore = new MetricsStore()
    dStore.ingest(DECODE_FIXTURE)
    const p = buildSnapshot(pStore, null, "http://p/metrics")
    const d = buildSnapshot(dStore, null, "http://d/metrics")
    const m = mergePdSnapshots(p, d)
    expect(m.evictedTokensTotal).toBe(1300)
    expect(m.loadBackTokensTotal).toBe(2400)
  })
})
