# Mermaid Diagram Guidelines

Reusable instructions for producing **coloured, readable, non-overlapping** Mermaid diagrams in HLDs, architecture docs, and AI-assisted design sessions.

Use this file when:

- Writing or reviewing architecture diagrams in `docs/`
- Asking an AI agent to generate HLD / system-design diagrams
- Debugging diagrams that render black-and-white or with overlapping nodes

---

## Quick prompt (copy-paste for AI)

Paste this at the start of any request that should produce a Mermaid diagram:

```text
When you produce architecture/HLD or any Mermaid diagram, ALWAYS follow these rules:

1. COLOR BY DEFAULT
   Never give plain black-and-white diagrams. Assign a distinct color per logical
   layer/group using `classDef` with fill + stroke + color:#000.
   Use a light fill + darker matching stroke (e.g. fill:#DBEAFE, stroke:#1D4ED8).

2. NO OVERLAP
   - Use ONE direction for the whole graph (`flowchart TB` or `flowchart LR`).
     Do NOT put `direction` statements inside subgraphs.
   - Do NOT use <br/> or multi-line text inside cylinder [( )] or database shapes.
   - Keep node labels short (2–4 words). Put detail in a separate legend table.
   - Prefer no subgraphs if the graph is dense; if grouping is needed, keep all
     subgraphs in the same direction as the parent.

3. STYLING METHOD
   - Apply colors via `classDef` + `class`, NOT via the `%%{init}%%` theme hack
     (that directive is fragile and often renders black-and-white).
   - Make arrows black: `linkStyle default stroke:#000,stroke-width:1.5px`.

4. ALWAYS include a small color legend table below the diagram mapping
   layer → color → components.

5. VALIDATE
   - Every node id referenced in a `class` line must be defined.
   - No duplicate ids; no trailing spaces after node definitions.

6. LARGE DIAGRAMS
   If the diagram is large, provide both:
   - a "clean / no-subgraph" version (best layout), and
   - a "grouped / subgraph" version (best readability).
```

Reference this file in a prompt:

```text
Follow docs/design/mermaid-diagram-guidelines.md when generating the diagram.
```

---

## Why diagrams break

| Symptom | Root cause | Fix |
| ------- | ---------- | --- |
| Black and white | No `classDef` styling; or reliance on `%%{init}%%` theme | Use `classDef` + `class` on every layer |
| Overlapping nodes | Mixed `direction` inside subgraphs; dense cross-edges | Single `flowchart TB` or `LR`; avoid nested directions |
| Broken cylinder shapes | `<br/>` inside `[( )]` nodes | Short single-line labels; details in legend |
| Layout fights itself | Too many subgraphs + long labels | Offer a flat (no-subgraph) version |

---

## Standard colour palette

Use one colour per logical layer. Text inside boxes should always be black (`color:#000`).

| Layer | Fill | Stroke | Example components |
| ----- | ---- | ------ | ------------------ |
| Clients / UI | `#DBEAFE` | `#1D4ED8` | Web, Mobile, Recruiter Portal |
| Edge / Gateway | `#D1FAE5` | `#059669` | API Gateway, CDN, Auth |
| Online serving | `#FEF3C7` | `#D97706` | Feed API, Ranker, Cache |
| Offline / ML | `#EDE9FE` | `#7C3AED` | Kafka, ETL, Training, Indexer |
| Data stores | `#FCE7F3` | `#BE123C` | PostgreSQL, Elasticsearch, S3, Redis |

### Minimal styling template

```mermaid
flowchart TB
    A["Service A"]
    B["Service B"]
    A --> B

    classDef serving fill:#FEF3C7,stroke:#D97706,stroke-width:2px,color:#000
    class A,B serving

    linkStyle default stroke:#000,stroke-width:1.5px
```

---

## Layout rules (detailed)

### 1. One direction only

```mermaid
flowchart TB   ✅ good — one direction for entire graph
flowchart LR   ✅ good
```

Avoid:

```mermaid
flowchart TB
    subgraph X
        direction LR   ❌ causes overlap when parent is TB
    end
```

### 2. Short labels in nodes

Put long descriptions in prose or a legend table — not inside the node.

```text
✅ PG[("PostgreSQL")]
❌ PG[("PostgreSQL<br/>profiles, jobs")]
```

### 3. Prefer flat layout for dense graphs

If a diagram has more than ~12 nodes or many cross-layer edges, use the **flat version** (no subgraphs) as the primary diagram. Add a grouped subgraph version only if readability benefits outweigh layout risk.

### 4. Black arrows

Always end coloured diagrams with:

```text
linkStyle default stroke:#000,stroke-width:1.5px
```

---

## Example: Job recommendation system (flat — recommended)

Best layout when many cross-layer connections exist.

```mermaid
flowchart TB
    Web["Web / Mobile"]
    Recruiter["Recruiter Portal"]

    GW["API Gateway + Auth"]
    CDN["CDN / Edge Cache"]

    FeedAPI["Feed API"]
    Ranker["Ranking Service"]
    FeatureStore[("Feature Store")]
    VectorDB[("Vector DB")]
    Cache[("Redis Cache")]

    Ingest["Event Ingestion"]
    Stream["Kafka / Pulsar"]
    ETL["Spark / Flink Jobs"]
    Train["Model Training"]
    Indexer["Search + Vector Indexer"]

    PG[("PostgreSQL")]
    ES[("Elasticsearch")]
    S3[("S3 Training Data")]
    DW[("Data Warehouse")]

    Web --> GW
    Recruiter --> GW
    Web --> CDN

    GW --> FeedAPI
    FeedAPI --> Cache
    FeedAPI --> Ranker
    Ranker --> FeatureStore
    Ranker --> VectorDB
    Ranker --> ES

    Web --> Ingest
    Recruiter --> Ingest
    Ingest --> Stream
    Stream --> ETL
    ETL --> DW
    ETL --> FeatureStore
    ETL --> Indexer
    Train --> S3
    Train --> Ranker
    Indexer --> ES
    Indexer --> VectorDB
    PG --> ETL

    classDef client fill:#DBEAFE,stroke:#1D4ED8,stroke-width:2px,color:#000
    classDef edge fill:#D1FAE5,stroke:#059669,stroke-width:2px,color:#000
    classDef serving fill:#FEF3C7,stroke:#D97706,stroke-width:2px,color:#000
    classDef offline fill:#EDE9FE,stroke:#7C3AED,stroke-width:2px,color:#000
    classDef data fill:#FCE7F3,stroke:#BE123C,stroke-width:2px,color:#000

    class Web,Recruiter client
    class GW,CDN edge
    class FeedAPI,Ranker,FeatureStore,VectorDB,Cache serving
    class Ingest,Stream,ETL,Train,Indexer offline
    class PG,ES,S3,DW data

    linkStyle default stroke:#000,stroke-width:1.5px
```

### Colour legend

| Layer | Colour | Components |
| ----- | ------ | ---------- |
| Clients | Light blue | Web / Mobile, Recruiter Portal |
| Edge | Light green | API Gateway, CDN |
| Online serving | Light amber | Feed API, Ranker, Feature Store, Vector DB, Redis |
| Offline / ML | Light purple | Ingestion, Kafka, ETL, Training, Indexer |
| Data stores | Light rose | PostgreSQL, Elasticsearch, S3, Warehouse |

---

## Example: Job recommendation system (grouped — use with care)

Use when layer grouping helps readability and the graph is not too dense.

```mermaid
flowchart TB
    subgraph Clients
        Web["Web / Mobile"]
        Recruiter["Recruiter Portal"]
    end
    subgraph Edge
        GW["API Gateway + Auth"]
        CDN["CDN / Edge Cache"]
    end
    subgraph Serving
        FeedAPI["Feed API"]
        Ranker["Ranking Service"]
        FeatureStore[("Feature Store")]
        VectorDB[("Vector DB")]
        Cache[("Redis")]
    end
    subgraph Offline
        Ingest["Event Ingestion"]
        Stream["Kafka / Pulsar"]
        ETL["Spark / Flink"]
        Train["Model Training"]
        Indexer["Vector Indexer"]
    end
    subgraph Data
        PG[("PostgreSQL")]
        ES[("Elasticsearch")]
        S3[("S3")]
        DW[("Warehouse")]
    end

    Web --> GW
    Recruiter --> GW
    GW --> FeedAPI
    FeedAPI --> Cache
    FeedAPI --> Ranker
    Ranker --> FeatureStore
    Ranker --> VectorDB
    Ranker --> ES
    Web --> Ingest
    Ingest --> Stream
    Stream --> ETL
    ETL --> DW
    ETL --> FeatureStore
    ETL --> Indexer
    Train --> S3
    Train --> Ranker
    Indexer --> ES
    Indexer --> VectorDB
    PG --> ETL

    classDef client fill:#DBEAFE,stroke:#1D4ED8,stroke-width:2px,color:#000
    classDef edge fill:#D1FAE5,stroke:#059669,stroke-width:2px,color:#000
    classDef serving fill:#FEF3C7,stroke:#D97706,stroke-width:2px,color:#000
    classDef offline fill:#EDE9FE,stroke:#7C3AED,stroke-width:2px,color:#000
    classDef data fill:#FCE7F3,stroke:#BE123C,stroke-width:2px,color:#000

    class Web,Recruiter client
    class GW,CDN edge
    class FeedAPI,Ranker,FeatureStore,VectorDB,Cache serving
    class Ingest,Stream,ETL,Train,Indexer offline
    class PG,ES,S3,DW data

    linkStyle default stroke:#000,stroke-width:1.5px
```

---

## Checklist before publishing

- [ ] Every layer has a `classDef` colour
- [ ] Arrows are black (`linkStyle default`)
- [ ] No `direction` inside subgraphs
- [ ] No `<br/>` inside `[( )]` shapes
- [ ] Colour legend table included below diagram
- [ ] Flat version provided if graph has 12+ nodes
- [ ] Node ids are unique and match `class` assignments

---

## Related docs

- [architecture-diagrams.md](../architecture-diagrams.md) — AgentStudio platform Mermaid sources
- [platform-hld.md](platform-hld.md) — Platform high-level design
- [HLD.md](../HLD.md) — Long-form subsystem detail
