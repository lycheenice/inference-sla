export interface LabelSet {
  [key: string]: string
}

export interface MetricLine {
  name: string
  labels: LabelSet
  value: number
}

export interface Histogram {
  count: number
  sum: number
  buckets: { le: number; cum: number }[]
}

export interface CounterSnapshot {
  name: string
  labels: LabelSet
  value: number
  ts: number
}

const INF = Number.POSITIVE_INFINITY

function parseLabels(raw: string | undefined): LabelSet {
  const out: LabelSet = {}
  if (!raw) return out
  let i = 0
  const s = raw
  const n = s.length
  while (i < n) {
    while (i < n && (s[i] === " " || s[i] === ",")) i++
    if (i >= n) break
    const eq = s.indexOf("=", i)
    if (eq === -1) break
    const key = s.slice(i, eq)
    i = eq + 1
    if (i >= n || s[i] !== '"') break
    i++
    let val = ""
    while (i < n) {
      const c = s[i]
      if (c === "\\") {
        const next = s[i + 1]
        if (next === "n") val += "\n"
        else if (next === '"') val += '"'
        else if (next === "\\") val += "\\"
        else val += next ?? ""
        i += 2
        continue
      }
      if (c === '"') {
        i++
        break
      }
      val += c
      i++
    }
    out[key] = val
  }
  return out
}

export function parsePrometheus(text: string): MetricLine[] {
  const out: MetricLine[] = []
  const lines = text.split("\n")
  for (const line of lines) {
    if (line.length === 0) continue
    if (line[0] === "#") continue
    let spaceIdx = line.lastIndexOf(" ")
    if (spaceIdx === -1) continue
    const valueStr = line.slice(spaceIdx + 1).trim()
    if (valueStr.length === 0) continue
    const value = Number(valueStr)
    if (Number.isNaN(value)) continue
    const namePart = line.slice(0, spaceIdx)
    let name = namePart
    let labels: LabelSet = {}
    const braceStart = namePart.indexOf("{")
    if (braceStart !== -1) {
      const braceEnd = namePart.lastIndexOf("}")
      if (braceEnd !== -1 && braceEnd > braceStart) {
        name = namePart.slice(0, braceStart)
        const labelRaw = namePart.slice(braceStart + 1, braceEnd)
        labels = parseLabels(labelRaw)
      }
    }
    name = name.trim()
    if (name.length === 0) continue
    out.push({ name, labels, value })
  }
  return out
}

export class MetricsStore {
  private index = new Map<string, MetricLine[]>()
  lastCounters = new Map<string, CounterSnapshot>()
  rawText = ""

  ingest(text: string): void {
    this.rawText = text
    const lines = parsePrometheus(text)
    const idx = new Map<string, MetricLine[]>()
    for (const l of lines) {
      const arr = idx.get(l.name)
      if (arr) arr.push(l)
      else idx.set(l.name, [l])
    }
    this.index = idx
  }

  lines(name: string): MetricLine[] {
    return this.index.get(name) ?? []
  }

  sumGauge(name: string, labelFilter?: (l: LabelSet) => boolean): number {
    let total = 0
    for (const l of this.lines(name)) {
      if (labelFilter && !labelFilter(l.labels)) continue
      total += l.value
    }
    return total
  }

  maxGauge(name: string, labelFilter?: (l: LabelSet) => boolean): number {
    let m = -INF
    for (const l of this.lines(name)) {
      if (labelFilter && !labelFilter(l.labels)) continue
      if (l.value > m) m = l.value
    }
    return m === -INF ? 0 : m
  }

  avgGauge(name: string, labelFilter?: (l: LabelSet) => boolean): number {
    let total = 0
    let n = 0
    for (const l of this.lines(name)) {
      if (labelFilter && !labelFilter(l.labels)) continue
      total += l.value
      n++
    }
    return n === 0 ? 0 : total / n
  }

  anyGauge(name: string, labelFilter?: (l: LabelSet) => boolean): number {
    for (const l of this.lines(name)) {
      if (labelFilter && !labelFilter(l.labels)) continue
      return l.value
    }
    return 0
  }

  counterValue(name: string, labelFilter?: (l: LabelSet) => boolean): number {
    let total = 0
    for (const l of this.lines(name)) {
      if (labelFilter && !labelFilter(l.labels)) continue
      total += l.value
    }
    return total
  }

  counterRate(name: string, labelFilter?: (l: LabelSet) => boolean): number {
    let currentValue = 0
    let sample: CounterSnapshot | undefined
    for (const l of this.lines(name)) {
      if (labelFilter && !labelFilter(l.labels)) continue
      currentValue += l.value
      if (!sample) sample = { name, labels: l.labels, value: 0, ts: 0 }
    }
    if (!sample) return 0
    const now = Date.now()
    const key = name + JSON.stringify(sample.labels)
    const prev = this.lastCounters.get(key)
    let rate = 0
    if (prev && now > prev.ts) {
      const dt = (now - prev.ts) / 1000
      const delta = currentValue - prev.value
      if (delta >= 0 && dt > 0) rate = delta / dt
    }
    this.lastCounters.set(key, { name, labels: sample.labels, value: currentValue, ts: now })
    return rate
  }

  histogram(name: string, labelFilter?: (l: LabelSet) => boolean): Histogram | null {
    let count = 0
    let sum = 0
    const buckets: { le: number; cum: number }[] = []
    let hasAny = false
    for (const l of this.lines(name)) {
      if (labelFilter && !labelFilter(l.labels)) continue
      const le = l.labels["le"]
      if (le !== undefined) {
        const leNum = le === "+Inf" ? INF : Number(le)
        if (!Number.isNaN(leNum)) {
          buckets.push({ le: leNum, cum: l.value })
          hasAny = true
        }
        continue
      }
      if (name.endsWith("_count") || l.name.endsWith("_count")) {
        count = l.value
        hasAny = true
      } else if (name.endsWith("_sum") || l.name.endsWith("_sum")) {
        sum = l.value
        hasAny = true
      }
    }
    if (!hasAny) return null
    buckets.sort((a, b) => a.le - b.le)
    return { count, sum, buckets }
  }

  histogramByName(metricBase: string, labelFilter?: (l: LabelSet) => boolean): Histogram | null {
    const hist: Histogram = { count: 0, sum: 0, buckets: [] }
    const seen = new Set<number>()
    let hasAny = false
    for (const l of this.lines(metricBase + "_bucket")) {
      if (labelFilter && !labelFilter(l.labels)) continue
      const le = l.labels["le"]
      if (le === undefined) continue
      const leNum = le === "+Inf" ? INF : Number(le)
      if (Number.isNaN(leNum)) continue
      hist.buckets.push({ le: leNum, cum: l.value })
      hasAny = true
    }
    for (const l of this.lines(metricBase + "_count")) {
      if (labelFilter && !labelFilter(l.labels)) continue
      hist.count = l.value
      hasAny = true
    }
    for (const l of this.lines(metricBase + "_sum")) {
      if (labelFilter && !labelFilter(l.labels)) continue
      hist.sum = l.value
      hasAny = true
    }
    if (!hasAny) return null
    hist.buckets.sort((a, b) => a.le - b.le)
    for (const b of hist.buckets) {
      if (!seen.has(b.le)) seen.add(b.le)
    }
    return hist
  }

  histSumBucketsAcrossDp(metricBase: string, labelFilter?: (l: LabelSet) => boolean, groupBy?: string): Histogram | null {
    const bucketMap = new Map<number, number>()
    let count = 0
    let sum = 0
    let hasAny = false
    for (const l of this.lines(metricBase + "_bucket")) {
      if (labelFilter && !labelFilter(l.labels)) continue
      const le = l.labels["le"]
      if (le === undefined) continue
      const leNum = le === "+Inf" ? INF : Number(le)
      if (Number.isNaN(leNum)) continue
      const cur = bucketMap.get(leNum) ?? 0
      bucketMap.set(leNum, cur + l.value)
      hasAny = true
    }
    const seenGroups = new Set<string>()
    for (const l of this.lines(metricBase + "_count")) {
      if (labelFilter && !labelFilter(l.labels)) continue
      const g = groupBy ? (l.labels[groupBy] ?? "*") : "*"
      if (seenGroups.has(g)) continue
      seenGroups.add(g)
      count += l.value
      hasAny = true
    }
    const seenSumGroups = new Set<string>()
    for (const l of this.lines(metricBase + "_sum")) {
      if (labelFilter && !labelFilter(l.labels)) continue
      const g = groupBy ? (l.labels[groupBy] ?? "*") : "*"
      if (seenSumGroups.has(g)) continue
      seenSumGroups.add(g)
      sum += l.value
      hasAny = true
    }
    if (!hasAny) return null
    const buckets = Array.from(bucketMap.entries()).map(([le, cum]) => ({ le, cum }))
    buckets.sort((a, b) => a.le - b.le)
    return { count, sum, buckets }
  }
}

export function histogramQuantile(hist: Histogram, q: number): number {
  if (hist.count <= 0) return 0
  if (hist.buckets.length === 0) return 0
  const target = q * hist.count
  let prevLe = 0
  let prevCum = 0
  for (const b of hist.buckets) {
    if (b.cum >= target) {
      const bucketCumDiff = b.cum - prevCum
      if (bucketCumDiff <= 0) return b.le === INF ? prevLe : b.le
      const rankInBucket = target - prevCum
      const upper = b.le === INF ? prevLe : b.le
      const lower = prevLe
      if (upper <= lower) return lower
      return lower + (rankInBucket / bucketCumDiff) * (upper - lower)
    }
    prevLe = b.le === INF ? prevLe : b.le
    prevCum = b.cum
  }
  return prevLe
}

export function avgOfHist(hist: Histogram): number {
  return hist.count > 0 ? hist.sum / hist.count : 0
}

export function fmtNum(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return "—"
  if (n === 0) return "0"
  const abs = Math.abs(n)
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "G"
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M"
  if (abs >= 1e3) return (n / 1e3).toFixed(2) + "k"
  return n.toFixed(digits)
}

export function fmtMs(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0ms"
  const ms = seconds * 1000
  if (ms < 10) return ms.toFixed(2) + "ms"
  if (ms < 1000) return ms.toFixed(0) + "ms"
  return (ms / 1000).toFixed(2) + "s"
}

export function fmtPct(ratio: number, digits = 2): string {
  if (!Number.isFinite(ratio)) return "—"
  return (ratio * 100).toFixed(digits) + "%"
}

export function fmtTokensPerSec(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 tok/s"
  if (n >= 1000) return (n / 1000).toFixed(2) + "k tok/s"
  return n.toFixed(0) + " tok/s"
}

export function sumOverDp(store: MetricsStore, name: string): number {
  const seen = new Set<string>()
  let total = 0
  for (const l of store.lines(name)) {
    const dp = l.labels["dp_rank"] ?? "*"
    if (seen.has(dp)) continue
    seen.add(dp)
    total += l.value
  }
  return total
}

export function avgOverDp(store: MetricsStore, name: string): number {
  const seen = new Set<string>()
  let total = 0
  let n = 0
  for (const l of store.lines(name)) {
    const dp = l.labels["dp_rank"] ?? "*"
    if (seen.has(dp)) continue
    seen.add(dp)
    total += l.value
    n++
  }
  return n === 0 ? 0 : total / n
}

export function perDpValues(store: MetricsStore, name: string): { dp: string; value: number }[] {
  const seen = new Set<string>()
  const out: { dp: string; value: number }[] = []
  for (const l of store.lines(name)) {
    const dp = l.labels["dp_rank"] ?? "*"
    if (seen.has(dp)) continue
    seen.add(dp)
    out.push({ dp, value: l.value })
  }
  out.sort((a, b) => Number(a.dp) - Number(b.dp))
  return out
}

export function perDpL1HitRate(
  store: MetricsStore,
  metric: string,
  cacheMode: string,
  computeMode: string,
): { dp: string; value: number }[] {
  const cache = new Map<string, { dp: string; value: number }>()
  const compute = new Map<string, { dp: string; value: number }>()
  for (const l of store.lines(metric)) {
    const dp = l.labels["dp_rank"] ?? "*"
    const mode = l.labels["mode"]
    if (mode === cacheMode && !cache.has(dp)) cache.set(dp, { dp, value: l.value })
    else if (mode === computeMode && !compute.has(dp)) compute.set(dp, { dp, value: l.value })
  }
  const dps = new Set<string>([...cache.keys(), ...compute.keys()])
  const out: { dp: string; value: number }[] = []
  for (const dp of dps) {
    const c = cache.get(dp)?.value ?? 0
    const cc = compute.get(dp)?.value ?? 0
    const total = c + cc
    out.push({ dp, value: total > 0 ? c / total : 0 })
  }
  out.sort((a, b) => Number(a.dp) - Number(b.dp))
  return out
}

export interface SlaSnapshot {
  ts: number
  running: number
  queued: number
  concurrent: number
  httpActive: number
  maxRunning: number
  maxQueued: number
  ttft: { p50: number; p90: number; p99: number; avg: number; count: number }
  tpot: { p50: number; p90: number; p99: number; avg: number; count: number }
  e2e: { p50: number; p90: number; p99: number; avg: number; count: number }
  queueTime: { p50: number; p90: number; p99: number; avg: number; count: number }
  genThroughput: number
  outputTokenRate: number
  inputTokenRate: number
  totalRequests: number
  abortedRequests: number
  l1HitRate: number
  l1HitRateGauge: number
  l1PrefillCacheTokens: number
  l1PrefillComputeTokens: number
  l2Usage: number
  l2UsedTokens: number
  l2TotalTokens: number
  kvUsage: number
  cachedDeviceTokens: number
  cachedHostTokens: number
  specAcceptRate: number
  specAcceptLength: number
  perDp: {
    running: { dp: string; value: number }[]
    queued: { dp: string; value: number }[]
    gen: { dp: string; value: number }[]
    cache: { dp: string; value: number }[]
    l1: { dp: string; value: number }[]
    kv: { dp: string; value: number }[]
  }
  fetchError: string | null
}

export function buildSnapshot(store: MetricsStore, _prev: SlaSnapshot | null): SlaSnapshot {
  const noDp = (l: LabelSet) => l["dp_rank"] === undefined
  const running = sumOverDp(store, "sglang:num_running_reqs")
  const queued = sumOverDp(store, "sglang:num_queue_reqs")
  const httpActive = store.anyGauge("sglang:http_requests_active", (l) => l["endpoint"] === "/v1/chat/completions")
  const maxRunning = 64
  const maxQueued = 512

  const ttftH = store.histogramByName("sglang:time_to_first_token_seconds", noDp)
  const tpotH = store.histogramByName("sglang:inter_token_latency_seconds", noDp)
  const e2eH = store.histogramByName("sglang:e2e_request_latency_seconds", noDp)
  const queueH = store.histSumBucketsAcrossDp("sglang:queue_time_seconds", undefined, "dp_rank")

  const ttft = ttftH
    ? { p50: histogramQuantile(ttftH, 0.5), p90: histogramQuantile(ttftH, 0.9), p99: histogramQuantile(ttftH, 0.99), avg: avgOfHist(ttftH), count: ttftH.count }
    : { p50: 0, p90: 0, p99: 0, avg: 0, count: 0 }
  const tpot = tpotH
    ? { p50: histogramQuantile(tpotH, 0.5), p90: histogramQuantile(tpotH, 0.9), p99: histogramQuantile(tpotH, 0.99), avg: avgOfHist(tpotH), count: tpotH.count }
    : { p50: 0, p90: 0, p99: 0, avg: 0, count: 0 }
  const e2e = e2eH
    ? { p50: histogramQuantile(e2eH, 0.5), p90: histogramQuantile(e2eH, 0.9), p99: histogramQuantile(e2eH, 0.99), avg: avgOfHist(e2eH), count: e2eH.count }
    : { p50: 0, p90: 0, p99: 0, avg: 0, count: 0 }
  const queueTime = queueH
    ? { p50: histogramQuantile(queueH, 0.5), p90: histogramQuantile(queueH, 0.9), p99: histogramQuantile(queueH, 0.99), avg: avgOfHist(queueH), count: queueH.count }
    : { p50: 0, p90: 0, p99: 0, avg: 0, count: 0 }

  const genThroughput = sumOverDp(store, "sglang:gen_throughput")
  const outputTokenRate = store.counterRate("sglang:generation_tokens_total")
  const inputTokenRate = store.counterRate("sglang:prompt_tokens_total")
  const totalRequests = store.counterValue("sglang:num_requests_total")
  const abortedRequests = store.counterValue("sglang:num_aborted_requests_total")

  const l1HitRateGauge = avgOverDp(store, "sglang:cache_hit_rate")
  const l1PrefillCacheTokens = store.sumGauge(
    "sglang:realtime_tokens_total",
    (l) => l["mode"] === "prefill_cache",
  )
  const l1PrefillComputeTokens = store.sumGauge(
    "sglang:realtime_tokens_total",
    (l) => l["mode"] === "prefill_compute",
  )
  const l1Total = l1PrefillCacheTokens + l1PrefillComputeTokens
  const l1HitRate = l1Total > 0 ? l1PrefillCacheTokens / l1Total : l1HitRateGauge
  const l2UsedTokens = sumOverDp(store, "sglang:hicache_host_used_tokens")
  const l2TotalTokens = sumOverDp(store, "sglang:hicache_host_total_tokens")
  const l2Usage = l2TotalTokens > 0 ? l2UsedTokens / l2TotalTokens : 0
  const kvUsage = avgOverDp(store, "sglang:token_usage")
  const cachedDeviceTokens = store.counterValue("sglang:cached_tokens_total", (l) => l["cache_source"] === "device")
  const cachedHostTokens = store.counterValue("sglang:cached_tokens_total", (l) => l["cache_source"] === "host")
  const specAcceptRate = avgOverDp(store, "sglang:spec_accept_rate")
  const specAcceptLength = avgOverDp(store, "sglang:spec_accept_length")

  return {
    ts: Date.now(),
    running,
    queued,
    concurrent: running + queued,
    httpActive,
    maxRunning,
    maxQueued,
    ttft,
    tpot,
    e2e,
    queueTime,
    genThroughput,
    outputTokenRate,
    inputTokenRate,
    totalRequests,
    abortedRequests,
    l1HitRate,
    l1HitRateGauge,
    l1PrefillCacheTokens,
    l1PrefillComputeTokens,
    l2Usage,
    l2UsedTokens,
    l2TotalTokens,
    kvUsage,
    cachedDeviceTokens,
    cachedHostTokens,
    specAcceptRate,
    specAcceptLength,
    perDp: {
      running: perDpValues(store, "sglang:num_running_reqs"),
      queued: perDpValues(store, "sglang:num_queue_reqs"),
      gen: perDpValues(store, "sglang:gen_throughput"),
      cache: perDpValues(store, "sglang:cache_hit_rate"),
      l1: perDpL1HitRate(
        store,
        "sglang:realtime_tokens_total",
        "prefill_cache",
        "prefill_compute",
      ),
      kv: perDpValues(store, "sglang:token_usage"),
    },
    fetchError: null,
  }
}

export async function fetchMetrics(endpoint: string, timeoutMs = 5000): Promise<{ text: string; error: string | null }> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(endpoint, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return { text: "", error: `HTTP ${res.status} ${res.statusText}` }
    const text = await res.text()
    return { text, error: null }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { text: "", error: msg }
  }
}

