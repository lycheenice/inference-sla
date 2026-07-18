import { createCliRenderer, type CliRenderer, type KeyEvent } from "@opentui/core"
import { Dashboard } from "./dashboard.js"
import { MetricsStore, buildSnapshot, fetchMetrics, type SlaSnapshot } from "./metrics.js"

const DEFAULT_ENDPOINT = process.env.SGLANG_METRICS ?? "http://localhost:8001/metrics"
const DEFAULT_REFRESH = Number(process.env.SGLANG_REFRESH_MS ?? 1000)

function parseArgs(argv: string[]): { endpoint: string; refreshMs: number } {
  let endpoint = DEFAULT_ENDPOINT
  let refreshMs = DEFAULT_REFRESH
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === "-h" || a === "--help") {
      printHelp()
      process.exit(0)
    } else if (a === "--endpoint" || a === "-e") {
      endpoint = argv[++i] ?? endpoint
    } else if (a.startsWith("--endpoint=")) {
      endpoint = a.slice("--endpoint=".length)
    } else if (a === "--refresh" || a === "-r") {
      refreshMs = Number(argv[++i] ?? refreshMs)
    } else if (a.startsWith("--refresh=")) {
      refreshMs = Number(a.slice("--refresh=".length))
    } else if (/^https?:\/\//.test(a)) {
      endpoint = a
    } else if (/^\d+$/.test(a)) {
      refreshMs = Number(a)
    }
  }
  if (!endpoint.endsWith("/metrics")) {
    endpoint = endpoint.replace(/\/$/, "") + "/metrics"
  }
  if (!Number.isFinite(refreshMs) || refreshMs < 200) refreshMs = 1000
  return { endpoint, refreshMs }
}

function printHelp(): void {
  console.log(`inference-sla — terminal SLA dashboard for LLM inference serving

Usage:
  bun src/main.ts [endpoint] [refresh_ms]
  bun src/main.ts --endpoint <url> --refresh <ms>

Options:
  -e, --endpoint <url>   sglang /metrics URL (default: http://localhost:8001/metrics)
                          also accepts env SGLANG_METRICS
  -r, --refresh <ms>     refresh interval in ms (default: 1000, min: 200)
                          also accepts env SGLANG_REFRESH_MS
  -h, --help             show this help

Environment:
  SGLANG_METRICS         metrics endpoint URL
  SGLANG_REFRESH_MS      refresh interval in ms

Keys:
  q / Ctrl+C             quit

Metrics shown:
  Requests   running / queued / concurrent / HTTP in-flight / total / aborted
  TTFT       time-to-first-token p50/p90/p99/avg  (histogram_quantile of
             sglang:time_to_first_token_seconds)
  TPOT       time-per-output-token p50/p90/p99/avg (sglang:inter_token_latency_seconds)
  E2E        end-to-end request latency p50/p90/p99 (sglang:e2e_request_latency_seconds)
  Queue wait queueing time p50/p90/p99 (sglang:queue_time_seconds, summed across DP)
  Throughput output tok/s (Δ sglang:generation_tokens_total), input tok/s,
             gen throughput gauge (sum sglang:gen_throughput)
  Cache      L1 = sglang:cache_hit_rate (avg across DP)
             L2 = hicache_host occupancy (used / total)
             KV = sglang:token_usage (avg across DP)
  Speculative EAGLE accept rate / accept length (avg across DP)
  Per-DP     per degree parallel rank table (DP0–DP3)
`)
}

async function main(): Promise<void> {
  const { endpoint, refreshMs } = parseArgs(process.argv)

  const renderer: CliRenderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
  })

  const dashboard = new Dashboard(renderer, {
    endpoint,
    refreshMs,
    maxRunning: 64,
    maxQueued: 512,
  })
  dashboard.mount()

  const store = new MetricsStore()
  let last: SlaSnapshot | null = null

  const getSnapshot = async (): Promise<SlaSnapshot> => {
    const { text, error } = await fetchMetrics(endpoint, 5000)
    if (error) {
      if (last) {
        return { ...last, ts: Date.now(), fetchError: error } as SlaSnapshot
      }
      const empty = buildSnapshot(store, null)
      empty.fetchError = error
      return empty
    }
    store.ingest(text)
    const snap = buildSnapshot(store, last)
    last = snap
    return snap
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
