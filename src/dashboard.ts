import {
  type CliRenderer,
  type TextChunk,
  BoxRenderable,
  TextRenderable,
  RGBA,
  TextAttributes,
  StyledText,
  t,
  bold,
  fg,
  green,
  yellow,
  red,
  cyan,
} from "@opentui/core"
import {
  type SlaSnapshot,
  fmtMs,
  fmtNum,
  fmtPct,
  fmtTokensPerSec,
} from "./metrics.js"

export interface DashboardOptions {
  endpoint: string
  refreshMs: number
  maxRunning: number
  maxQueued: number
}

export class Dashboard {
  private renderer: CliRenderer
  private opts: DashboardOptions
  private root!: BoxRenderable
  private header!: TextRenderable
  private subHeader!: TextRenderable
  private statusLine!: TextRenderable

  private reqBox!: BoxRenderable
  private reqText!: TextRenderable
  private ttftBox!: BoxRenderable
  private ttftText!: TextRenderable
  private tpotBox!: BoxRenderable
  private tpotText!: TextRenderable
  private e2eBox!: BoxRenderable
  private e2eText!: TextRenderable
  private queueBox!: BoxRenderable
  private queueText!: TextRenderable

  private tputBox!: BoxRenderable
  private tputText!: TextRenderable
  private cacheBox!: BoxRenderable
  private cacheText!: TextRenderable
  private specBox!: BoxRenderable
  private specText!: TextRenderable

  private dpBox!: BoxRenderable
  private dpText!: TextRenderable

  private topRow!: BoxRenderable
  private midRow!: BoxRenderable
  private bottomRow!: BoxRenderable

  private interval: ReturnType<typeof setInterval> | null = null
  private running = false
  private destroyed = false

  constructor(renderer: CliRenderer, opts: DashboardOptions) {
    this.renderer = renderer
    this.opts = opts
  }

  mount(): void {
    this.renderer.setBackgroundColor(RGBA.fromInts(18, 22, 32, 255))

    this.root = new BoxRenderable(this.renderer, {
      id: "sla-root",
      flexDirection: "column",
      flexGrow: 1,
      flexShrink: 1,
      width: "auto",
      height: "auto",
    })

    this.header = new TextRenderable(this.renderer, {
      id: "sla-header",
      content: t`${bold(fg("#7dd3fc")("inference-sla"))} ${fg("#64748b")("· SLA dashboard for LLM inference serving")}`,
      fg: RGBA.fromInts(226, 232, 240),
      attributes: TextAttributes.BOLD,
      width: "auto",
    })

    this.subHeader = new TextRenderable(this.renderer, {
      id: "sla-sub",
      content: t`${fg("#94a3b8")("endpoint:")} ${fg("#cbd5e1")(this.opts.endpoint)}  ${fg("#94a3b8")("refresh:")} ${fg("#cbd5e1")(this.opts.refreshMs + "ms")}  ${fg("#94a3b8")("q/Ctrl+C: quit")}`,
      width: "auto",
    })

    this.statusLine = new TextRenderable(this.renderer, {
      id: "sla-status",
      content: t`${fg("#64748b")("initializing…")}`,
      width: "auto",
    })

    this.topRow = this.mkRow("sla-top-row")
    this.midRow = this.mkRow("sla-mid-row")
    this.bottomRow = this.mkRow("sla-bottom-row")

    this.reqBox = this.mkPanel("sla-req", "REQUESTS", "#38bdf8")
    this.reqText = this.mkPanelBody("sla-req-body")
    this.reqBox.add(this.reqText)
    this.ttftBox = this.mkPanel("sla-ttft", "TTFT", "#a78bfa")
    this.ttftText = this.mkPanelBody("sla-ttft-body")
    this.ttftBox.add(this.ttftText)
    this.tpotBox = this.mkPanel("sla-tpot", "TPOT", "#f472b6")
    this.tpotText = this.mkPanelBody("sla-tpot-body")
    this.tpotBox.add(this.tpotText)
    this.e2eBox = this.mkPanel("sla-e2e", "E2E LATENCY", "#34d399")
    this.e2eText = this.mkPanelBody("sla-e2e-body")
    this.e2eBox.add(this.e2eText)
    this.queueBox = this.mkPanel("sla-queue", "QUEUE WAIT", "#fbbf24")
    this.queueText = this.mkPanelBody("sla-queue-body")
    this.queueBox.add(this.queueText)

    this.tputBox = this.mkPanel("sla-tput", "THROUGHPUT", "#22d3ee")
    this.tputText = this.mkPanelBody("sla-tput-body")
    this.tputBox.add(this.tputText)
    this.cacheBox = this.mkPanel("sla-cache", "CACHE", "#f59e0b")
    this.cacheText = this.mkPanelBody("sla-cache-body")
    this.cacheBox.add(this.cacheText)
    this.specBox = this.mkPanel("sla-spec", "SPECULATIVE (EAGLE)", "#818cf8")
    this.specText = this.mkPanelBody("sla-spec-body")
    this.specBox.add(this.specText)

    this.dpBox = this.mkPanel("sla-dp", "PER-DEGREE (DP0–DP3)", "#94a3b8")
    this.dpText = this.mkPanelBody("sla-dp-body")
    this.dpBox.add(this.dpText)

    this.topRow.add(this.reqBox)
    this.topRow.add(this.ttftBox)
    this.topRow.add(this.tpotBox)
    this.topRow.add(this.e2eBox)
    this.topRow.add(this.queueBox)

    this.midRow.add(this.tputBox)
    this.midRow.add(this.cacheBox)
    this.midRow.add(this.specBox)

    this.bottomRow.add(this.dpBox)

    this.root.add(this.header)
    this.root.add(this.subHeader)
    this.root.add(this.statusLine)
    this.root.add(this.topRow)
    this.root.add(this.midRow)
    this.root.add(this.bottomRow)

    this.renderer.root.add(this.root)
  }

  private mkRow(id: string): BoxRenderable {
    return new BoxRenderable(this.renderer, {
      id,
      flexDirection: "row",
      flexGrow: 1,
      flexShrink: 1,
      width: "auto",
      height: "auto",
      gap: 1,
    })
  }

  private mkPanel(id: string, title: string, color: string): BoxRenderable {
    return new BoxRenderable(this.renderer, {
      id,
      title,
      titleColor: color,
      borderColor: RGBA.fromInts(51, 61, 82, 255),
      border: true,
      borderStyle: "single",
      flexDirection: "column",
      flexGrow: 1,
      flexShrink: 1,
      width: "auto",
      height: "auto",
      padding: 1,
    })
  }

  private mkPanelBody(id: string): TextRenderable {
    return new TextRenderable(this.renderer, {
      id,
      content: "",
      fg: RGBA.fromInts(203, 213, 225),
      width: "auto",
    })
  }

  start(getSnapshot: () => Promise<SlaSnapshot>): void {
    if (this.running) return
    this.running = true
    this.tick(getSnapshot)
    this.interval = setInterval(() => this.tick(getSnapshot), this.opts.refreshMs)
  }

  stop(): void {
    this.running = false
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  private async tick(getSnapshot: () => Promise<SlaSnapshot>): Promise<void> {
    if (this.destroyed) return
    try {
      const snap = await getSnapshot()
      if (this.destroyed) return
      this.render(snap)
    } catch (e) {
      if (this.destroyed) return
      try {
        const msg = e instanceof Error ? e.message : String(e)
        this.statusLine.content = t`${red(bold("render error:"))} ${fg("#f87171")(msg)}`
      } catch {
        // renderer/text buffer already torn down during shutdown — ignore
      }
    }
  }

  private render(s: SlaSnapshot): void {
    const now = new Date()
    const ts = now.toLocaleTimeString()
    const err = s.fetchError

    this.header.content = t`${bold(fg("#7dd3fc")("inference-sla"))} ${fg("#64748b")("· SLA dashboard for LLM inference serving")}`
    this.subHeader.content = t`${fg("#94a3b8")("endpoint:")} ${fg("#cbd5e1")(this.opts.endpoint)}  ${fg("#94a3b8")("refresh:")} ${fg("#cbd5e1")(this.opts.refreshMs + "ms")}  ${fg("#94a3b8")("q/Ctrl+C: quit")}`

    if (err) {
      this.statusLine.content = t`${red(bold("ERROR"))} ${fg("#f87171")(err)}  ${fg("#64748b")(ts)}`
    } else {
      this.statusLine.content = t`${green(bold("LIVE"))} ${fg("#64748b")("·")} ${fg("#94a3b8")("updated")} ${fg("#cbd5e1")(ts)}`
    }

    this.reqText.content = this.renderRequests(s)
    this.ttftText.content = this.renderLatency(s.ttft)
    this.tpotText.content = this.renderLatency(s.tpot)
    this.e2eText.content = this.renderLatency(s.e2e)
    this.queueText.content = this.renderLatency(s.queueTime)
    this.tputText.content = this.renderThroughput(s)
    this.cacheText.content = this.renderCache(s)
    this.specText.content = this.renderSpec(s)
    this.dpText.content = this.renderPerDp(s)
  }

  private capBar(cur: number, max: number, width: number): string {
    const ratio = max > 0 ? Math.min(1, cur / max) : 0
    const filled = Math.round(ratio * width)
    return "#".repeat(filled) + "-".repeat(Math.max(0, width - filled))
  }

  private renderRequests(s: SlaSnapshot): StyledTextLike {
    const running = s.running
    const queued = s.queued
    const concurrent = s.concurrent
    const http = s.httpActive
    const cap = 20
    const runBar = this.capBar(running, s.maxRunning, cap)
    const qBar = this.capBar(queued, s.maxQueued, cap)

    const runColor = running >= s.maxRunning ? red : running > s.maxRunning * 0.8 ? yellow : green
    const qColor = queued >= s.maxQueued ? red : queued > s.maxQueued * 0.5 ? yellow : green

    return t`
${bold("Running ")} ${runColor(bold(String(running)))}${fg("#475569")("/" + s.maxRunning)}
${fg("#334155")(runBar)}
${bold("Queued  ")} ${qColor(bold(String(queued)))}${fg("#475569")("/" + s.maxQueued)}
${fg("#334155")(qBar)}
${bold("Concur. ")} ${cyan(bold(String(concurrent)))}
${bold("HTTP in-flight")} ${fg("#cbd5e1")(String(http))}
${bold("Total reqs")} ${fg("#cbd5e1")(fmtNum(s.totalRequests))}
${bold("Aborted  ")} ${s.abortedRequests > 0 ? red(fmtNum(s.abortedRequests)) : fg("#94a3b8")(fmtNum(s.abortedRequests))}
`
  }

  private renderLatency(l: { p50: number; p90: number; p99: number; avg: number; count: number }): StyledTextLike {
    const cntStr = l.count > 0 ? fmtNum(l.count) : "0"
    return t`
${fg("#94a3b8")("p50 ")} ${this.latencyColor(l.p50)(bold(fmtMs(l.p50)))}
${fg("#94a3b8")("p90 ")} ${this.latencyColor(l.p90, true)(bold(fmtMs(l.p90)))}
${fg("#94a3b8")("p99 ")} ${this.latencyColor(l.p99, true)(bold(fmtMs(l.p99)))}
${fg("#94a3b8")("avg ")} ${fg("#cbd5e1")(fmtMs(l.avg))}
${fg("#64748b")("samples ")} ${fg("#94a3b8")(cntStr)}
`
  }

  private latencyColor(v: number, warn = false): (input: import("@opentui/core").StylableInput) => import("@opentui/core").TextChunk {
    if (!Number.isFinite(v) || v <= 0) return fg("#475569")
    if (warn && v > 0) {
      if (v >= 2) return red
      if (v >= 0.8) return yellow
    }
    return green
  }

  private renderThroughput(s: SlaSnapshot): StyledTextLike {
    return t`
${bold("Output (gen)")}  ${cyan(bold(fmtTokensPerSec(s.outputTokenRate)))}
${bold("Input (prefill)")} ${fg("#a5f3fc")(fmtTokensPerSec(s.inputTokenRate))}
${bold("Gen gauge")}     ${fg("#cbd5e1")(fmtTokensPerSec(s.genThroughput))}
${fg("#64748b")("────")}
${bold("Total reqs")}   ${fg("#cbd5e1")(fmtNum(s.totalRequests))}
${bold("Aborted")}      ${s.abortedRequests > 0 ? red(fmtNum(s.abortedRequests)) : fg("#94a3b8")(fmtNum(s.abortedRequests))}
${bold("Cached device")} ${fg("#cbd5e1")(fmtNum(s.cachedDeviceTokens) + " tok")}
${bold("Cached host")}   ${fg("#cbd5e1")(fmtNum(s.cachedHostTokens) + " tok")}
`
  }

  private renderCache(s: SlaSnapshot): StyledTextLike {
    const l1Color = s.l1HitRate >= 0.5 ? green : s.l1HitRate >= 0.2 ? yellow : red
    const l2Color = s.l2Usage >= 0.9 ? red : s.l2Usage >= 0.7 ? yellow : green
    const kvColor = s.kvUsage >= 0.9 ? red : s.kvUsage >= 0.7 ? yellow : green
    return t`
${bold("L1 (GPU radix) hit")} ${l1Color(bold(fmtPct(s.l1HitRate)))}
${fg("#64748b")("  cache/cache+compute")}
${fg("#64748b")("  prefill_cache ")} ${fg("#94a3b8")(fmtNum(s.l1PrefillCacheTokens))}
${fg("#64748b")("  prefill_compute")} ${fg("#94a3b8")(fmtNum(s.l1PrefillComputeTokens))}
${fg("#64748b")("  gauge ")} ${fg("#475569")(fmtPct(s.l1HitRateGauge))}
${bold("L2 (host) used")} ${l2Color(bold(fmtPct(s.l2Usage)))}
${fg("#64748b")("L2 tokens")} ${fg("#94a3b8")(fmtNum(s.l2UsedTokens) + " / " + fmtNum(s.l2TotalTokens))}
${fg("#64748b")("────")}
${bold("KV usage")}      ${kvColor(bold(fmtPct(s.kvUsage)))}
`
  }

  private renderSpec(s: SlaSnapshot): StyledTextLike {
    const accColor = s.specAcceptRate >= 0.5 ? green : s.specAcceptRate >= 0.2 ? yellow : red
    return t`
${bold("Algorithm")}     ${fg("#cbd5e1")("EAGLE")}
${bold("Accept rate")}   ${accColor(bold(fmtPct(s.specAcceptRate)))}
${bold("Accept length")} ${fg("#cbd5e1")(s.specAcceptLength.toFixed(3))}
${fg("#64748b")("(accepted drafts + bonus")}
${fg("#64748b")("token per forward pass)")}
`
  }

  private renderPerDp(s: SlaSnapshot): StyledTextLike {
    const dpCount = Math.max(
      s.perDp.running.length,
      s.perDp.queued.length,
      s.perDp.gen.length,
      s.perDp.l1.length,
      s.perDp.kv.length,
    )
    const chunks: TextChunk[] = [bold(fg("#94a3b8")("DP   run  que  gen   L1%  KV%\n"))]
    for (let i = 0; i < dpCount; i++) {
      const dp = s.perDp.running[i]?.dp ?? s.perDp.gen[i]?.dp ?? String(i)
      const run = s.perDp.running[i]?.value ?? 0
      const que = s.perDp.queued[i]?.value ?? 0
      const gen = s.perDp.gen[i]?.value ?? 0
      const l1 = s.perDp.l1[i]?.value ?? 0
      const kv = s.perDp.kv[i]?.value ?? 0
      const runColor = run >= s.maxRunning ? red : run > s.maxRunning * 0.8 ? yellow : green
      const l1Color = l1 >= 0.5 ? green : l1 >= 0.2 ? yellow : red
      const kvColor = kv >= 0.9 ? red : kv >= 0.7 ? yellow : green
      const sep = fg("#475569")("  ")
      const nl = i === dpCount - 1 ? "" : "\n"
      chunks.push(
        fg("#7dd3fc")("DP" + dp + "  "),
        runColor(String(run).padStart(2)),
        sep,
        fg("#cbd5e1")(String(que).padStart(3)),
        sep,
        cyan(gen.toFixed(0).padStart(4)),
        sep,
        l1Color((l1 * 100).toFixed(0).padStart(3)),
        sep,
        kvColor((kv * 100).toFixed(0).padStart(3)),
        fg("#334155")(nl),
      )
    }
    return new StyledText(chunks)
  }

  destroy(): void {
    this.destroyed = true
    this.stop()
    try {
      this.renderer.root.remove(this.root)
    } catch {
      // renderer already torn down — ignore
    }
  }
}

type StyledTextLike = ReturnType<typeof t>
