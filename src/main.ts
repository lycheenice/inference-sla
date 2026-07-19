import { createCliRenderer, type CliRenderer, type KeyEvent } from "@opentui/core"
import { Dashboard } from "./dashboard.js"
import { MetricsStore, buildSnapshot, fetchMetrics, mergePdSnapshots, type SlaSnapshot } from "./metrics.js"

const DEFAULT_ENDPOINT = process.env.SGLANG_METRICS ?? "http://localhost:8001/metrics"
const DEFAULT_REFRESH = Number(process.env.SGLANG_REFRESH_MS ?? 1000)

function parseArgs(argv: string[]): { endpoints: string[]; refreshMs: number } {
  let endpoints: string[] = []
  let refreshMs = DEFAULT_REFRESH
  const normalize = (url: string) => {
    if (!url.endsWith("/metrics")) url = url.replace(/\/$/, "") + "/metrics"
    return url
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === "-h" || a === "--help") {
      printHelp()
      process.exit(0)
    } else if (a === "--endpoint" || a === "-e") {
      const v = argv[++i] ?? ""
      if (v) endpoints.push(...v.split(",").map((s) => s.trim()).filter(Boolean).map(normalize))
    } else if (a.startsWith("--endpoint=")) {
      const v = a.slice("--endpoint=".length)
      endpoints.push(...v.split(",").map((s) => s.trim()).filter(Boolean).map(normalize))
    } else if (a === "--refresh" || a === "-r") {
      refreshMs = Number(argv[++i] ?? refreshMs)
    } else if (a.startsWith("--refresh=")) {
      refreshMs = Number(a.slice("--refresh=".length))
    } else if (/^https?:\/\//.test(a)) {
      endpoints.push(normalize(a))
    } else if (/^\d+$/.test(a)) {
      refreshMs = Number(a)
    }
  }
  if (endpoints.length === 0) endpoints = [normalize(DEFAULT_ENDPOINT)]
  if (!Number.isFinite(refreshMs) || refreshMs < 200) refreshMs = 1000
  return { endpoints, refreshMs }
}

function printHelp(): void {
  console.log(`inference-sla — terminal SLA dashboard for LLM inference serving

Usage:
  bun src/main.ts [endpoint] [refresh_ms]
  bun src/main.ts --endpoint <url>[,<url>...] --refresh <ms>

Options:
  -e, --endpoint <url[,url2]>   sglang /metrics URL; comma-separated or repeatable
                                  for PD-disaggregated deployments (prefill,decode)
                                  (default: http://localhost:8001/metrics; env SGLANG_METRICS)
  -r, --refresh <ms>            refresh interval in ms (default: 1000, min: 200)
                                  (env SGLANG_REFRESH_MS)
  -h, --help                    show this help

Environment:
  SGLANG_METRICS                metrics endpoint URL (single)
  SGLANG_REFRESH_MS             refresh interval in ms

Keys:
  q / Ctrl+C / Esc              quit

Metrics shown:
  Requests   running / queued / concurrent / HTTP in-flight / total / aborted
  TTFT       time-to-first-token p50/p90/p99/avg  (decode-side in PD mode)
  TPOT       time-per-output-token p50/p90/p99/avg (decode-side in PD mode)
  E2E        end-to-end request latency p50/p90/p99
  Queue wait queueing time p50/p90/p99 (sglang:queue_time_seconds, summed across DP)
  Throughput output tok/s, input tok/s, gen throughput gauge
  Cache      L1 = sglang:cache_hit_rate (avg across DP) [prefill-side in PD]
             L2 = hicache_host occupancy (used / total) [prefill-side in PD]
             KV = sglang:token_usage (avg across DP) [decode-side in PD]
  Speculative EAGLE accept rate / accept length (decode-side in PD)
  PD Queues  prefill_bootstrap/inflight, decode_prealloc/transfer, paused/retracted
  KV Transfer latency/total/speed/bootstrap/alloc (prefill-side sender)
  Per-Stage  per_stage_req_latency p50/p90/p99 across PD stages
  KV Pool    used / max, available, evictable tokens
  Per-DP     per degree parallel rank table (DP0–DP3, unified mode only)
`)
}

async function main(): Promise<void> {
  const { endpoints, refreshMs } = parseArgs(process.argv)

  const renderer: CliRenderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
  })

  const dashboard = new Dashboard(renderer, {
    endpoint: endpoints.join(" + "),
    refreshMs,
    maxRunning: 64,
    maxQueued: 512,
  })
  dashboard.mount()

  const stores = endpoints.map(() => new MetricsStore())
  const lasts: (SlaSnapshot | null)[] = endpoints.map(() => null)

  const buildOne = (idx: number, text: string): SlaSnapshot => {
    const store = stores[idx]
    store.ingest(text)
    const snap = buildSnapshot(store, lasts[idx], endpoints[idx])
    lasts[idx] = snap
    return snap
  }

  const emptySnap = (idx: number, error: string): SlaSnapshot => {
    if (lasts[idx]) return { ...lasts[idx]!, ts: Date.now(), fetchError: error }
    const empty = buildSnapshot(stores[idx], null, endpoints[idx])
    empty.fetchError = error
    return empty
  }

  const getSnapshot = async (): Promise<SlaSnapshot> => {
    const results = await Promise.all(
      endpoints.map((ep) => fetchMetrics(ep, 5000)),
    )
    const snaps = results.map((r, idx) =>
      r.error ? emptySnap(idx, r.error) : buildOne(idx, r.text),
    )
    if (snaps.length === 1) return snaps[0]
    const p = snaps.find((s) => s.engineRole === "prefill")
    const d = snaps.find((s) => s.engineRole === "decode")
    if (p && d) return mergePdSnapshots(p, d)
    return snaps[0]
  }

  dashboard.start(getSnapshot)

  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    try {
      dashboard.destroy()
    } catch {
      // ignore teardown errors
    }
    try {
      renderer.destroy()
    } catch {
      // ignore
    }
    process.exit(0)
  }

  const onKey = (key: KeyEvent): void => {
    if (key.name === "q" || key.name === "escape") {
      shutdown()
    }
  }
  renderer.keyInput.on("keypress", onKey)

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
