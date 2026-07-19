# PD KV Transfer / Cache 面板修正设计

基于 2026-07-20 对 h200-2 生产端点（prefill:8001 / decode:8002）的实际 `/metrics` 探测结果，识别出 3 个功能点。每个功能点按「设计 → 单测 → 实现+验证」独立交付。

## 探测事实基线

实际暴露的相关指标（仅列已确认存在的）：

| 指标 | prefill | decode | 备注 |
|---|---|---|---|
| `sglang:kv_transfer_total_mb` (histogram) | ✓ count=981, sum≈2.23e6 MB | ❌ | 跨 4 个 tp_rank 重复上报同一份数据 |
| `sglang:kv_transfer_speed_gb_s` (histogram) | ✓ | ❌ | 同上 4× 重复 |
| `sglang:kv_transfer_latency_ms` (histogram) | ✓ | ❌ | 同上 |
| `sglang:kv_transfer_bootstrap_ms` (histogram) | ✓ | ✓(仅 decode) | 同上 |
| `sglang:kv_transfer_alloc_ms` (histogram) | ✓ | ✓(仅 decode) | 同上 |
| `sglang:evicted_tokens_total{cache_type="RadixCache"}` | ✓ | ✓ | 仅 1 个样本（无 engine_type/dp_rank/tp_rank 标签） |
| `sglang:num_used_tokens` / `max_total_num_tokens` | ✓ | ✓ | 4× tp_rank 重复 |
| `sglang:per_stage_req_latency_seconds` | ✓ | ✓ | 含 `prefill_transfer_kv_cache` 等阶段 |

**未暴露**（确认缺失，对应行不应再显示为 0）：

- `sglang:hicache_host_used_tokens` / `hicache_host_total_tokens` — 说明未启用 `--enable-hierarchical-cache`，L2 host cache 不存在
- `sglang:load_back_tokens_total` — L2→L1 回载计数器不存在
- `sglang:prefetched_tokens_total` / `backuped_tokens_total` / `*_bandwidth` / `*_pgs` — L3 storage backend 未启用
- `sglang:cached_tokens_total{cache_source="host"}` — host 缓存命中计数不存在

---

## Feature 1: KV TRANSFER 面板 tp_rank 重复样本去重

### 问题

`buildSnapshot` 当前用 `store.histogramByName(base)` 取 5 个 `kv_transfer_*` 直方图：

```ts
const kvTransfer: KvTransferStats = {
  latencyMs: histToStats(store.histogramByName("sglang:kv_transfer_latency_ms")),
  totalMb: histToStats(store.histogramByName("sglang:kv_transfer_total_mb")),
  ...
}
```

生产端点 PD 模式下，每个 tp_rank（0/1/2/3）都上报一份 KV 转移直方图（同一 sglang scheduler 进程内 4 个 TP worker 共享同一转移统计，数据近乎相同但 cum 值因采样时刻略有差异，例如 le=5000 处 cum=200/201/202/204）。

`histogramByName` 的实现：

- `_count`：`hist.count = l.value`（**覆盖**，最后一个 tp_rank 胜出）→ count 不会被通胀
- `_sum`：`hist.sum = l.value`（**覆盖**）→ sum 不会被通胀
- `_bucket`：`hist.buckets.push({ le, cum })`（**全部 push，不去重**）→ buckets 数组含 4× 重复条目

真正的 bug 在 `_bucket` 重复条目：
- `buckets` 数组有 4× 重复 `{le, cum}` 条目（应去重为 1×）
- `histogramQuantile` 遍历重复条目时，`prevCum`/`prevLe` 被最后一个重复样本覆盖（取了 tp_rank="3" 的 cum，而非单一代表），导致 `bucketCumDiff = b.cum - prevCum` 与 `rankInBucket = target - prevCum` 计算错位
- 当 target 落入有限桶且各 tp_rank cum 有差异时，分位数插值偏差
- 当 target 落入 +Inf 桶时（upper=prevLe=lower），两条路径恰好返回相同值，bug 不显现——这是为什么生产 p50/p90 表面看起来"正常"

### 设计

复用已有的 `histSumBucketsAcrossDp(base, labelFilter?, groupBy?)`。该函数语义：

1. 按 `groupBy` 标签分组（默认 `dp_rank`）
2. 组内按 `le` 去重（保留首次出现的样本）—— **这就是我们需要的 tp_rank 去重**：PD 模式下 `dp_rank` 缺失，所有 tp_rank 样本 fallback 到同组 `"*"`，组内去重后只保留 tp_rank="0" 一份
3. 跨组求和（PD 仅 1 组，等同取代表）

这与 `queue_time_seconds` 的处理方式完全一致（已是 `histSumBucketsAcrossDp(base, undefined, "dp_rank")`）。

### 改动点

`src/metrics.ts` `buildSnapshot` 的 `kvTransfer` 构造，5 个直方图全部从 `histogramByName` 改为 `histSumBucketsAcrossDp`：

```ts
const kvTransfer: KvTransferStats = {
  latencyMs: histToStats(store.histSumBucketsAcrossDp("sglang:kv_transfer_latency_ms", undefined, "dp_rank")),
  totalMb: histToStats(store.histSumBucketsAcrossDp("sglang:kv_transfer_total_mb", undefined, "dp_rank")),
  speedGbS: histToStats(store.histSumBucketsAcrossDp("sglang:kv_transfer_speed_gb_s", undefined, "dp_rank")),
  bootstrapMs: histToStats(store.histSumBucketsAcrossDp("sglang:kv_transfer_bootstrap_ms", undefined, "dp_rank")),
  allocMs: histToStats(store.histSumBucketsAcrossDp("sglang:kv_transfer_alloc_ms", undefined, "dp_rank")),
}
```

无新增字段，无破坏性 API 变更。`KvTransferStats` 结构不变。

### 测试设计

在 `PREFILL_FIXTURE` 现有 kv_transfer_latency_ms 单 tp_rank 样本基础上，增加 tp_rank="1"/"2"/"3" 三个重复样本（cum 值略有差异，模拟生产），验证：

1. `histogramByName` 的 buckets 数组含 4× 重复条目（暴露 bug）
2. `histSumBucketsAcrossDp` 的 buckets 数组去重为 1×
3. `buildSnapshot` 产出的 `snap.kvTransfer.latencyMs.count` = 单值（覆盖语义，本来就对）
4. `snap.kvTransfer.latencyMs` 的 buckets.length = 单份桶数（3，非 12）

### 验证

`bun run typecheck` + `bun run lint` + `bun test`（含新增 test）。生产端点核对：修复后 buckets 不再重复，分位数插值在 target 落入有限桶时不再受 tp_rank="3" 的 cum 偏移影响。

---

## Feature 2: PD KV transfer 持续 MB/s 速率

### 问题

KV TRANSFER 面板当前只显示 5 个 histogram 的 p50/p90/p99 分位数（单次转移的总量/延迟/速率分布）。用户反馈"观察不到流量"——根本原因是面板缺少一个**持续吞吐速率**指标。当流量停止时，分位数表仍显示历史 p50/p90/p99（histogram 不会回退），看起来"有流量"但实际已停；反之启动初期 count=0 时显示"— (no samples)"，看不出是否开始流动。

sglang 未暴露 `kv_transfer_total_mb_total` 这样的持续 counter。但 `sglang:kv_transfer_total_mb_sum`（histogram 的 `_sum`）是累计转移量（MB），随每次 KV 转移单调递增。对它做 Δ/Δt 即得持续 MB/s。

生产数据：prefill 端 4 个 tp_rank 各报 `kv_transfer_total_mb_sum ≈ 2.226e6 MB`（count=981，约 2269 MB/次转移），完全相同——是 TP rank 间的复制上报。

### 现有帮手不足

`MetricsStore.counterRate(name, labelFilter)` 会对所有匹配 `_sum` 行求和（4× 通胀），且 `lastCounters` 的 key 含 `sample.labels`（首个匹配样本的完整标签，含 `tp_rank="0"`），若下次迭代首样本换 tp_rank 则 key 不匹配，速率断裂。

### 设计

新增 `MetricsStore.counterRateDedup(name, groupBy, labelFilter?)`：

1. 遍历 `lines(name)`，按 `groupBy` 标签分组（与 `sumOverDp` 同语义）
2. 组内取首个样本（去重 TP/EP 重复），跨组求和 → `currentValue`
3. `lastCounters` 的 key 用 `name` + groupBy 拓展（不含样本 labels），稳定不变
4. `rate = (currentValue - prev.value) / dt`，首次为 0

这本质是 `sumOverDp` 的 current value + rate 跟踪。

### 改动点

1. `src/metrics.ts` `MetricsStore` 新增 `counterRateDedup(name, groupBy, labelFilter?)` 方法
2. `SlaSnapshot` 新增 `kvTransferRateMbS: number`（持续 MB/s）
3. `buildSnapshot`：`const kvTransferRateMbS = store.counterRateDedup("sglang:kv_transfer_total_mb_sum", "dp_rank")`
4. `KvTransferStats` 新增 `rateMbS: number`（放在 `KvTransferStats` 里，与 histogram 同构）
5. `mergePdSnapshots`：取有样本端的 `rateMbS`（通常 prefill）—— 实际上两端都算（PD 合并前各自 buildSnapshot），取 `p.rateMbS || d.rateMbS`
6. `dashboard.ts` `renderKvTransfer`：表头下方新增一行 `rate (MB/s)  <fmtNum(rate)> n=<count>`（或放顶部作为醒目主指标），用 `fmtTokensPerSec` 的类比格式化器

### 格式化

新增 `fmtMbPerSec(n)`：`<n> MB/s`，≥1000 显示 `X.XX GB/s`。或直接复用 `fmtNum` + " MB/s"。

### 测试设计

1. `counterRateDedup` 首次采样返回 0
2. 第二次采样（_sum 增量已知、dt 已知）返回正速率
3. 4× tp_rank 重复样本下，`currentValue` = 单值（非 4×）
4. `buildSnapshot` 产出 `snap.kvTransfer.rateMbS`，首采为 0，二次 >0
5. `mergePdSnapshots` 合并后 `rateMbS` 取 prefill 端

### 验证

`bun run typecheck` + `bun run lint` + `bun test`。生产端点核对：面板顶部应显示持续 MB/s，与 `kv_transfer_total_mb_sum` 的 Δ/Δt 吻合。

---

## Feature 3: CACHE 面板动态隐藏未暴露的 L2 指标

### 问题

探测确认 h200-2 sglang **未启用 `--enable-hierarchical-cache`**，下列指标在 prefill/decode 端点都不存在：

- `sglang:hicache_host_used_tokens` / `hicache_host_total_tokens`
- `sglang:load_back_tokens_total`
- `sglang:cached_tokens_total{cache_source="host"}`

但当前 CACHE 面板硬编码渲染这些行，永远显示 0：

```
L2 (host) used  0.00%
L2 tokens       0 / 0
L1→L2 evict     0 tok/s  (87287296 tok)   ← 误导：evicted 是 L1 radix 自驱逐，非迁移到 L2
L2→L1 load      0 tok/s  (0 tok)          ← 永远 0，metric 不存在
```

**误导点**：

1. "L2 (host) used 0.00%" / "L2 tokens 0/0"：暗示 L2 存在但空，实际 L2 根本未启用
2. "L2→L1 load 0 tok/s (0 tok)"：永远 0，无意义
3. "L1→L2 evict" 标签：`evicted_tokens_total{cache_type="RadixCache"}` 是 GPU radix 缓存的驱逐计数，未启用 L2 时这些 token 直接丢弃（内存释放），并非迁移到 L2 host pool。只有启用 hierarchical cache 时才是 L1→L2 迁移

### 设计

在 `buildSnapshot` 检测指标是否暴露，`SlaSnapshot` 新增两个布尔标志：

- `hasL2Metrics: boolean` —— `store.lines("sglang:hicache_host_used_tokens").length > 0`
- `hasLoadBack: boolean` —— `store.lines("sglang:load_back_tokens_total").length > 0`

dashboard `renderCache` 根据标志动态渲染：

1. **L2 块（L2 used / L2 tokens）**：`hasL2Metrics` 为真才显示；否则显示一行 `fg("#475569")("L2 (host) — not enabled (--enable-hierarchical-cache)")`
2. **L2→L1 load 行**：`hasLoadBack` 为真才显示
3. **L1→L2 evict 行标签**：`hasL2Metrics` 为真 → "L1→L2 evict"（迁移语义）；为假 → "L1 evict"（radix 自驱逐语义）
4. **L1 容量行（L1 used / L1 tokens）**：始终显示（`num_used_tokens`/`max_total_num_tokens` 已确认暴露）
5. **evict 行本身**：始终显示（`evicted_tokens_total` 已确认暴露）

`mergePdSnapshots`：`hasL2Metrics = p.hasL2Metrics || d.hasL2Metrics`，`hasLoadBack = p.hasLoadBack || d.hasLoadBack`（任一端有则视为启用）。

### 改动点

1. `src/metrics.ts` `SlaSnapshot` 新增 `hasL2Metrics: boolean` / `hasLoadBack: boolean`
2. `buildSnapshot` 检测 `store.lines(...).length > 0` 填充
3. `mergePdSnapshots` 取两端 OR
4. `src/dashboard.ts` `renderCache` 条件渲染 + 标签动态切换
5. 无新格式化器

### 测试设计

1. 现有 `SAMPLE` fixture 含 `hicache_host_*` → `hasL2Metrics=true`
2. 新建无 L2 的极简 fixture → `hasL2Metrics=false`、`hasLoadBack=false`
3. `PREFILL_FIXTURE` / `DECODE_FIXTURE` 不含 `hicache_host_*` 不含 `load_back_tokens_total` → 两个标志为 false
4. `mergePdSnapshots`：两端都 false → 合并 false；任一端 true → 合并 true（新增一个带 L2 的 prefill fixture 变体验证）

### 验证

`bun run typecheck` + `bun run lint` + `bun test`。生产端点核对：CACHE 面板 L2 块显示 "not enabled" 提示，evict 行标签为 "L1 evict"，不再有永远为 0 的 "L2→L1 load" 行。
