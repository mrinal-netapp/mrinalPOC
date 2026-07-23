# Vector Indexing Strategies — IVF, PQ, HNSW (with AgentStudio's actual usage)

> **Scope:** Conceptual notes on Approximate Nearest Neighbor (ANN) vector
> indexing, built from a walkthrough of how AgentStudio's own KB/RAG pipeline
> ([kb-processor/processing/lancedb_writer.py](../../src/nemo/workers/kb-processor/processing/lancedb_writer.py),
> [kb-retrieval-service](../../src/nemo/kb-retrieval-service/)) uses LanceDB
> indexes. Written for interview prep / personal reference.

---

## 1. Why ANN indexes exist

Comparing a query embedding against every stored vector ("brute force" / "flat"
search) is exact but doesn't scale — for millions of vectors at real
dimensionality (384–1536+), a linear scan is too slow for interactive use.
**Approximate Nearest Neighbor (ANN)** indexes trade a small amount of recall
for large speed/memory wins by avoiding that full scan. Two independent
techniques get combined to do this: **narrowing the candidate set** (IVF,
HNSW) and **compressing each vector** (PQ, Scalar Quantization).

---

## 2. IVF — Inverted File Index (candidate narrowing via clustering)

**Idea:** partition the entire vector space into `N` clusters (via k-means),
so a query only needs to compare against the vectors in the few nearest
clusters (`nprobes`) instead of the whole dataset.

### How the codebook (cluster centroids) is trained

1. **Collect training vectors** — a sample of the real dataset.
2. **Run k-means** with `k = num_partitions`:
   - **Initialize** `k` centroids (random or k-means++).
   - **Assign** — every vector joins its *nearest* centroid (by distance —
     computed to *every* centroid, then take the minimum: `argmin`).
   - **Update** — recompute each centroid as the **component-wise mean** of
     its currently assigned members:
     ```
     centroid[j] = (v1[j] + v2[j] + ... + vn[j]) / n      for each dimension j
     ```
     (For cosine-metric indexes — as AgentStudio uses — this is typically a
     *spherical* k-means: normalize vectors before averaging, then
     re-normalize the resulting centroid.)
   - **Repeat** assign → update until centroids **stop moving** (converge):
     running the loop again reproduces the same centroid coordinates, so
     there's nothing left to improve.
3. Training happens **once**, at index-build time, using a sample of the
   dataset — not per query, not per insert.

### Worked example (why {A,B}, {C,D}, {E,F}, {G,H} cluster together)

Assignment is never "obvious grouping" — it's the literal minimum of computed
distances to *every* centroid:

```
B = [1.1, 0.9, 5.1, 4.9]

dist²(B, c0=[1.0,1.0,5.0,5.0]) = 0.04    ← smallest, B joins c0
dist²(B, c1=[0.0,0.1,0.0,0.0]) = 51.87
dist²(B, c2=[3.0,3.1,2.9,3.0]) = 16.90
dist²(B, c3=[9.0,9.1,8.9,9.0]) = 160.90
```

### Query-time knob: `nprobes`

How many of the `N` clusters get scanned per query. Low `nprobes` = fast but
risks missing the true nearest neighbor (if it's in an unscanned cluster);
high `nprobes` = slower but more accurate.

---

## 3. Product Quantization (PQ) — vector compression

**Idea:** split each vector into `num_sub_vectors` chunks, and replace each
chunk with a small integer code pointing into a tiny per-subspace codebook —
trading a little accuracy for large memory savings and much cheaper distance
math.

### Codebook training (independent k-means per subspace)

Each subspace gets its **own** codebook, trained via the *same* k-means
process as IVF above, but run separately on just that subspace's slice of the
training vectors.

```
Codebook-1 (subspace 1, dims 0-3)     Codebook-2 (subspace 2, dims 4-7)
  code0 = [1,1,5,5]                     code0 = [9,9,2,2]
  code1 = [0,0,0,0]                     code1 = [0,0,0,0]
  code2 = [3,3,3,3]                     code2 = [5,5,5,5]
  code3 = [9,9,9,9]                     code3 = [1,1,1,1]
```

### Encoding (compressing a vector)

```
v = [1.0, 1.1, 5.0, 5.2, 9.0, 8.8, 2.0, 2.1]
  split → sub1=[1.0,1.1,5.0,5.2] → nearest = code 0
  split → sub2=[9.0,8.8,2.0,2.1] → nearest = code 0

stored as PQ codes = [0, 0]      (32 bytes float32 → ~2 bytes of codes)
```

With this repo's real default (`num_sub_vectors=96`, ~256 centroids/subspace
→ 1 byte/code), a 768-dim float32 embedding (3072 bytes) compresses to
~96 bytes — **~32x smaller**.

### Query-time search — Asymmetric Distance Computation (ADC)

**Key math fact:** squared Euclidean distance is *additive* across
independent subspaces — so distance can be computed as a sum of per-subspace
distances.

**Step 1 — build lookup tables once per query** (fixed, small cost —
`num_sub_vectors × num_centroids` distance calcs, independent of dataset
size):

```
q_sub1 = [1.2, 0.8, 4.9, 5.1]         q_sub2 = [8.8, 9.2, 1.9, 2.2]

LUT1 = [0.10, 52.10, 16.10, 160.10]   LUT2 = [0.13, 170.53, 49.53, 130.33]
        (dist² to each of the 4 subspace-1/2 centroids)
```

**Step 2 — reuse the tables for every stored vector, via pure array lookup:**

```python
LUT1 = [0.10, 52.10, 16.10, 160.10]
LUT2 = [0.13, 170.53, 49.53, 130.33]

i, j = 0, 0                 # this vector's stored PQ codes
distance = LUT1[i] + LUT2[j]   # 0.10 + 0.13 = 0.23 — 2 array reads + 1 add
```

No subtraction, no squaring, no looping over real dimensions — the expensive
math was already done once when building the tables. Array indexing is
**O(1)** (constant time, regardless of array size), vs. `O(d)` operations to
recompute a full-dimension distance from scratch:

| Operation | Cost per comparison |
|---|---|
| Array read (`LUT1[i]`) | 1 memory fetch, ~1 CPU cycle |
| Full recompute (8-dim toy example) | ~23 floating-point ops |
| Full recompute (real 768-dim embedding) | ~2,300 floating-point ops |

**Important:** the lookup tables are **rebuilt for every new query** (they
depend on that query's distance to the centroids) — but that rebuild cost is
small and *fixed*, then amortized across every one of the (potentially
millions of) stored vectors compared against it in that same query:

```
Brute force:          N vectors × full-dim distance calc                  ← huge
PQ + lookup tables:    (fixed table-build cost) + N × (cheap lookup+add)   ← tiny per-vector cost
```

**Caveat:** this measures distance to the *reconstructed/quantized* version
of a vector (its centroids glued back together), not the true original — a
lossy approximation. That's why a **refine** step often follows: re-rank the
top-K approximate candidates using their real, uncompressed vectors.

---

## 4. IVF-PQ (the classic combo — FAISS-style)

IVF narrows the candidate set (skip most of the dataset); PQ compresses what's
left and makes per-candidate distance cheap via lookup tables. Big speed +
memory wins, at some recall cost from the double approximation (coarse
partitioning + lossy compression).

```python
# lancedb_writer.py — this repo's actual IVF-PQ index creation
if quantization_type == 'ivf_pq':
    num_partitions = options.get('numPartitions', 256)
    num_sub_vectors = options.get('numSubVectors', 96)
    lance_table.create_index(metric="cosine", num_partitions=num_partitions, num_sub_vectors=num_sub_vectors)
```

---

## 5. IVFFlat (IVF without compression)

Same IVF clustering/`nprobes` mechanism, but **no PQ step** — each cluster
stores full, exact, uncompressed vectors. Within the probed clusters,
distance is computed **exactly** (not via lookup-table approximation).

| | IVFFlat | IVF-PQ |
|---|---|---|
| Storage per vector | Full size | ~32x smaller |
| Distance within probed buckets | Exact | Approximate (lookup tables) |
| Speed per candidate | Slower (real full-dim math) | Faster (array reads) |
| Accuracy | Higher | Slightly lossy |

Used in this repo's own **benchmark harness**
([docs/design/vector-db-comparison.md](../design/vector-db-comparison.md))
as the fair, apples-to-apples baseline between LanceDB and pgvector, since
each store's native compression schemes aren't directly comparable:

> Both stores use **IVFFlat**-class indexes: Lance `IVF_FLAT` with
> `num_partitions=100` and query-time `nprobes=10`, and pgvector `ivfflat`
> with `lists=100` and `SET ivfflat.probes = 10`.

---

## 6. HNSW — Hierarchical Navigable Small World graph

A completely different paradigm from IVF's clustering approach: build a
**graph** where each vector is a node connected to a handful of its nearest
neighbors, then organize that graph into **layers**:

```
Layer 2 (top)     ●───────────────●            few nodes, long-range links
                   │               │
Layer 1           ●──●────●───────●──●          more nodes, medium-range links
                   │  │    │       │   │
Layer 0 (bottom)  ●─●─●──●─●──●──●─●──●─●        ALL nodes, only short local links
```

(Highway-system analogy: top layer = interstate highways for fast long-range
jumps, bottom layer = local streets for final precision.)

**Search:** start at the sparse top layer, greedily walk toward whichever
neighbor is closest to the query, repeat until no closer neighbor exists at
that layer, then **drop down** a layer and continue — refining until the
bottom (all-nodes) layer gives the final answer. Avoids scanning most of the
graph, same goal as IVF, via traversal instead of clustering.

**Key parameters:** `m` (max neighbor connections per node — more = better
recall, more memory) and `ef_construction` (search breadth while *building*
each node's connections — higher = better graph quality, slower build).

| | IVF-PQ | HNSW |
|---|---|---|
| Structure | Flat clusters (buckets) | Multi-layer graph |
| Compression | Yes (~32x) | Usually none |
| Typical accuracy | Good | Usually higher recall at similar speed |
| Memory cost | Low | Higher (graph edges + full vectors) |
| Build time | Fast (k-means) | Slower (graph construction) |

---

## 7. Scalar Quantization (SQ) — the simpler compression alternative to PQ

Instead of PQ's "group dimensions + learned per-subspace codebook", SQ works
**dimension-by-dimension, independently**, with plain linear rounding — no
clustering/training needed.

```
Dimension #3 ranges from -2.0 to +2.0 across the dataset.
8-bit (256-level) scalar quantization splits that range into 256 buckets:
  bucket 0   → -2.0
  bucket 128 →  0.0  (approx)
  bucket 255 → +2.0

Stored value 0.013 → rounds to nearest bucket (~128) → store "128" (1 byte)
instead of the full float 0.013 (4 bytes).
```

Applied independently per dimension → float32 (4 bytes) → 1 byte → **~4x
compression** (vs. PQ's ~32x). Less aggressive, but simpler (no k-means
training step) and avoids PQ's cross-dimension information loss from
grouping.

---

## 8. IVF_HNSW_SQ — AgentStudio's actual default index

```python
# lancedb_writer.py — 'auto' quantization resolves to this, once a KB is
# large enough (see §9)
kwargs = {"metric": "cosine", "index_type": "IVF_HNSW_SQ"}
if options.get('efConstruction'):
    kwargs["ef_construction"] = options['efConstruction']
if options.get('m'):
    kwargs["m"] = options['m']
lance_table.create_index(**kwargs)
```

Three techniques layered together:

1. **IVF** — partitions vectors into clusters, same as always.
2. **HNSW** — instead of brute-force comparing a query against every
   partition centroid to find the nearest one (slow with many partitions),
   an HNSW graph over the centroids lets you *navigate* to the right
   partition(s) quickly.
3. **SQ** — the vectors stored within each partition are compressed via
   simple per-dimension rounding (not PQ's learned sub-vector codebooks).

**Why this is a sensible default over IVF-PQ:**

| | IVF_HNSW_SQ (default) | IVF-PQ |
|---|---|---|
| Partition lookup | HNSW graph (fast even with many partitions) | Brute-force centroid comparison |
| Compression | SQ (~4x, no training) | PQ (~32x, needs codebook training) |
| Recall/accuracy | Typically higher | Good, but more lossy |
| Build complexity | No PQ codebook training | Requires k-means training per subspace |

Better accuracy and simpler index-building than IVF-PQ, at the cost of a
larger memory footprint — a reasonable general-purpose default, reserving
IVF-PQ for users who explicitly need the extra memory savings at scale.

---

## 9. How AgentStudio actually resolves this at runtime

```python
# kb-processor/utils/config.py
VALID_QUANTIZATION_TYPES = ['auto', 'none', 'ivf_pq', 'scalar', 'ivf_rq']
quantization_type = os.environ.get('QUANTIZATION_TYPE', '') or 'auto'   # default: 'auto'

AUTO_INDEX_MIN_ROWS = 1000
```

`'auto'` resolution logic (`lancedb_writer.py::_ensure_vector_index`):

```
if quantization_type == 'auto':
    if indexing_mode not in ('hybrid', 'semantic'):
        skip — no vector index
    elif row_count >= 1000:
        build IVF_HNSW_SQ   ← the actual default in practice
    else:
        skip — too few rows for meaningful clustering
```

**Small KB (< 1,000 rows):** no vector index at all — search is a plain
brute-force/exact scan. Confirmed at query time in `kb-retrieval-service`:

```rust
// store_metadata.rs
if has_vector_index == Some(false) {
    nprobe = None; refine_factor = None;
    debug!("Dropping nprobe/refine_factor: KB has no vector index (brute-force scan)");
}
```

**Larger KB (≥ 1,000 rows, indexing mode `hybrid`/`semantic`):** auto-builds
**`IVF_HNSW_SQ`** — not IVF-PQ. IVF-PQ, `ivf_rq` (residual quantization), and
plain flat (`none`) remain available, but only via explicit user choice in
the Knowledge Base creation wizard (`quantizationType` field), never as the
default.

**Query-time `nprobe`/`refine_factor`** are `Option<u32>` in the Rust API —
no AgentStudio-hardcoded number. If omitted, LanceDB's own internal default
applies (or they're dropped entirely if the KB has no index, per above).

---

## 10. Quick comparison — all five options exposed in the KB creation wizard

| `quantizationType` | Mechanism | Compression | Notes |
|---|---|---|---|
| `none` | Flat/brute-force | None | Exact, slow at scale |
| `auto` (default) | → `IVF_HNSW_SQ` once ≥1,000 rows | ~4x (SQ) | This repo's real default |
| `ivf_pq` | IVF + Product Quantization | ~32x | Best memory savings, more lossy |
| `scalar` | → `IVF_HNSW_SQ` (explicit) | ~4x (SQ) | Same engine as `auto`'s resolved choice |
| `ivf_rq` | IVF + Residual Quantization | Configurable (`numBits`) | Alternative compression scheme |
