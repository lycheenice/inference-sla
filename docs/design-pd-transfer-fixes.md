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

（待 F1 交付后补充本节）

---

## Feature 3: CACHE 面板动态隐藏未暴露的 L2 指标

（待 F2 交付后补充本节）
