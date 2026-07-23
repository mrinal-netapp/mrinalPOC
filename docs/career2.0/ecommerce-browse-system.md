# E-Commerce Merchandise Browsing System — System Design

---

## 1. Problem Statement

Design a backend system for an e-commerce website that shows a list of merchandise to users when they browse a category (e.g., Shoes, T-shirts, Jackets).

**Requirements:**

| Requirement | Detail |
|---|---|
| Browse products by category | Paginated list, sorted by popularity |
| Popularity = views in last 24 hours | Sliding window, not calendar day |
| Near real-time updates | Ranking updates within ~1-2 minutes of a click |
| Scale | 10M DAU, 50k product view events/sec at peak |
| Read-heavy | Browse: 100k req/sec, Write (views): 50k events/sec |
| Fault tolerant | Redis crash must not lose data permanently |

**Out of scope:** Personalized recommendations, search (full-text), checkout, inventory.

---

## 2. High Level Design

```
                        ┌────────────────────────────────────────────────────┐
                        │                   CLIENT                           │
                        │          Browser / Mobile App                      │
                        └───────────────────┬────────────────────────────────┘
                                            │
                                    HTTP / REST
                                            │
                        ┌───────────────────▼────────────────────────────────┐
                        │              API GATEWAY                           │
                        │   Rate limiting · Auth · SSL termination           │
                        └──────────┬────────────────────┬────────────────────┘
                                   │                    │
                    ┌──────────────▼───┐      ┌─────────▼───────────┐
                    │  Browse Service  │      │   Event Service      │
                    │  (Read Path)     │      │   (Write Path)       │
                    │                 │      │                      │
                    │ GET /browse     │      │ POST /events/view    │
                    └──────┬──────────┘      └──────────┬───────────┘
                           │                            │
                    ┌──────▼──────┐              ┌──────▼──────┐
                    │    Redis    │              │    Kafka    │
                    │ (Sorted Set)│              │  (category  │
                    │  Rankings   │              │  partitioned│
                    └──────┬──────┘              └──────┬──────┘
                           │                            │
                    ┌──────▼──────┐              ┌──────▼──────┐
                    │ PostgreSQL  │◄─────────────│    Flink    │
                    │   (Source   │              │   (Stream   │
                    │  of Truth)  │              │  Processor) │
                    └─────────────┘              └─────────────┘
```

### Component Responsibilities

| Component | Role |
|---|---|
| **API Gateway** | Rate limiting (100 req/s per user), auth, routing |
| **Browse Service** | Reads ranked product list from Redis, fetches product metadata from DB |
| **Event Service** | Accepts view events, validates, pushes to Kafka |
| **Kafka** | Durable event stream, partitioned by category_id |
| **Flink** | Consumes Kafka, 1-min window writes hourly keys, 1-hour window maintains 24h deque and writes shoes:today |
| **Redis** | Stores hourly sorted sets per category for fast ranking reads |
| **PostgreSQL** | Product catalog + hourly view count aggregates (crash recovery) |

---

## 3. APIs

### 3.1 Browse Products

```
GET /api/v1/browse?category=shoes&page=1&limit=20

Request Headers:
  Authorization: Bearer <JWT>

Response 200:
{
  "category": "shoes",
  "total": 1500,
  "page": 1,
  "limit": 20,
  "products": [
    {
      "productId": "prod_001",
      "name": "Nike Air Max 270",
      "price": 149.99,
      "imageUrl": "https://cdn.example.com/prod_001.jpg",
      "views_24h": 52400,
      "rank": 1
    },
    {
      "productId": "prod_002",
      "name": "Adidas Ultraboost",
      "price": 179.99,
      "imageUrl": "https://cdn.example.com/prod_002.jpg",
      "views_24h": 41200,
      "rank": 2
    }
    ...
  ]
}
```

**How Browse Service resolves this:**

```
1. ZREVRANGE category:shoes:today 0 19 WITHSCORES   ← top 20 product IDs from Redis
2. SELECT * FROM products WHERE product_id IN (...)  ← fetch metadata from DB
3. Merge and return
```

---

### 3.2 Record Product View

```
POST /api/v1/events/view

Request Body:
{
  "productId": "prod_001",
  "categoryId": "shoes",
  "userId": "user_abc",
  "sessionId": "sess_xyz",
  "source": "browse_page",        ← browse | search | recommendation
  "timestamp": "2026-07-18T14:30:00Z"
}

Response 202 Accepted:
{
  "eventId": "evt_k7m2p9xq"
}
```

**Event Service:**
- Validates productId exists (cache lookup)
- Deduplicates: Redis NX with key `dedup:{userId}:{productId}` TTL=5min (prevent double-count from rapid refreshes)
- Publishes to Kafka topic `product-views` with partition key = `categoryId`

---

---

## 4. Kafka Events

### Topic: `product-views`

```
Partitions: 50 (partitioned by categoryId hash)
Retention: 7 days
Replication factor: 3

Message schema (Avro):
{
  "eventId":   "evt_k7m2p9xq",
  "productId": "prod_001",
  "categoryId": "shoes",
  "userId":    "user_abc",
  "sessionId": "sess_xyz",
  "timestamp": 1721308200000,    ← epoch ms
  "source":    "browse_page"
}

Partition key: categoryId
→ All shoe events go to the same set of partitions
→ Flink consumer for that partition handles all shoe aggregation
```

---

## 5. Flink Stream Processing

### Pipeline

```
Kafka Source (product-views)
  │
  │ keyBy(productId)
  ▼
  ├── Level 1: TumblingEventTimeWindow(1 min)
  │     aggregate: count per productId per minute
  │     │
  │     ├── ZINCRBY Redis hourly key     ← category:shoes:top:2026-07-18-14
  │     └── UPSERT PostgreSQL            ← durability / crash recovery
  │
  └── Level 2: TumblingEventTimeWindow(1 hour)
        aggregate: count per productId per hour
        stateful: maintain deque of last 24 hourly counts (ValueState)
        │
        └── ZADD Redis today key         ← category:shoes:today
```

### Flink Pseudocode

```java
DataStream<ProductViewEvent> source = env
    .fromSource(kafkaSource, WatermarkStrategy.forBoundedOutOfOrderness(Duration.ofSeconds(5)), "kafka");

DataStream<WindowResult> keyed = source
    .keyBy(event -> event.productId);

// Level 1 — 1-min window → hourly Redis keys + DB
keyed
    .window(TumblingEventTimeWindows.of(Duration.ofMinutes(1)))
    .aggregate(new CountAggregator())
    .addSink(new HourlyRedisSink());       // ZINCRBY category:shoes:top:{YYYY-MM-DD-HH}
    .addSink(new PostgresSink());          // UPSERT category_popularity_hourly

// Level 2 — 1-hour window → today key via 24-bucket deque
keyed
    .window(TumblingEventTimeWindows.of(Duration.ofHours(1)))
    .process(new HourlyDequeProcessor())   // maintains deque in ValueState
    .addSink(new TodayRedisSink());        // ZADD category:shoes:today

// HourlyDequeProcessor per productId:
//   state: Deque<Long> last24Hours (max 24 entries)
//   on window close:
//     deque.addLast(windowCount)
//     if deque.size() > 24: deque.removeFirst()
//     rolling24h = deque.sum()
//     ZADD category:{categoryId}:today rolling24h productId
```

### Flink → Redis Level 1 Write (1-min window)

```
For event at 14:30:45:
  windowEnd   = 14:31:00
  windowStart = 14:30:00
  hourlyKey   = category:shoes:top:2026-07-18-14   ← floor(windowStart, hour)

ZINCRBY category:shoes:top:2026-07-18-14 <count> prod_001
  → accumulates 60 times per hour into the hourly key
```

### Flink → Redis Level 2 Write (1-hour window)

```
At 15:00:00 (hour 14 window closes):
  windowCount for prod_001 = 1840   (total for hour 14)

  deque state for prod_001:
    Before: [900, 1100, 1400, 1800, 2100, ... , 2200]  (23 entries)
    addLast(1840)
    After:  [900, 1100, 1400, 1800, 2100, ... , 2200, 1840]  (24 entries)

  rolling24h = sum(deque) = 30,820
  ZADD category:shoes:today 30820 prod_001
  EXPIRE category:shoes:today 7200   ← reset TTL to 2h
```

### Flink → DB Write (UPSERT)

```sql
INSERT INTO category_popularity_hourly
  (product_id, category_id, time_bucket, view_count)
VALUES
  ('prod_001', 'shoes', '2026-07-18 14:00:00', 450)
ON CONFLICT (product_id, time_bucket)
DO UPDATE SET view_count = category_popularity_hourly.view_count + EXCLUDED.view_count;
```

### Deque State Size

```
Per product: 24 Long values × 8 bytes = 192 bytes
100k products across 50 Flink tasks = 2000 products per task
State per task = 2000 × 192 bytes = 384 KB   ← negligible
```

---

## 6. Database Schema

### 6.1 Products Table

```sql
CREATE TABLE products (
  product_id    VARCHAR(50)    PRIMARY KEY,
  name          VARCHAR(255)   NOT NULL,
  category_id   VARCHAR(50)    NOT NULL,
  price         DECIMAL(10,2)  NOT NULL,
  image_url     TEXT,
  status        VARCHAR(20)    DEFAULT 'active',   -- active | inactive | deleted
  created_at    TIMESTAMP      DEFAULT NOW()
);

CREATE INDEX idx_products_category ON products(category_id) WHERE status = 'active';
```

---

### 6.2 Categories Table

```sql
CREATE TABLE categories (
  category_id   VARCHAR(50)   PRIMARY KEY,
  name          VARCHAR(255)  NOT NULL,
  parent_id     VARCHAR(50)   REFERENCES categories(category_id),
  created_at    TIMESTAMP     DEFAULT NOW()
);

-- Example data:
-- shoes, tshirts, jackets, socks, accessories
```

---

### 6.3 Category Popularity Hourly (Flink writes here)

```sql
CREATE TABLE category_popularity_hourly (
  product_id    VARCHAR(50)   NOT NULL,
  category_id   VARCHAR(50)   NOT NULL,
  time_bucket   TIMESTAMP     NOT NULL,   -- truncated to hour: 2026-07-18 14:00:00
  view_count    BIGINT        DEFAULT 0,
  PRIMARY KEY (product_id, time_bucket)
) PARTITION BY RANGE (time_bucket);       -- one partition per day

-- Daily partitions:
CREATE TABLE category_popularity_hourly_2026_07_18
  PARTITION OF category_popularity_hourly
  FOR VALUES FROM ('2026-07-18 00:00:00') TO ('2026-07-19 00:00:00');

CREATE TABLE category_popularity_hourly_2026_07_19
  PARTITION OF category_popularity_hourly
  FOR VALUES FROM ('2026-07-19 00:00:00') TO ('2026-07-20 00:00:00');

-- Index for 24h aggregate queries
CREATE INDEX idx_popularity_cat_bucket
  ON category_popularity_hourly (category_id, time_bucket);
```

**Query for Redis crash recovery (last 24h sum):**

```sql
SELECT product_id, SUM(view_count) AS total_views
FROM category_popularity_hourly
WHERE category_id = 'shoes'
  AND time_bucket >= NOW() - INTERVAL '24 hours'
GROUP BY product_id
ORDER BY total_views DESC
LIMIT 100;
```

---

### 6.4 Product View Events (Optional — for audit/replay)

```sql
CREATE TABLE product_view_events (
  event_id      VARCHAR(50)   PRIMARY KEY,
  product_id    VARCHAR(50)   NOT NULL,
  category_id   VARCHAR(50)   NOT NULL,
  user_id       VARCHAR(50),
  session_id    VARCHAR(100),
  source        VARCHAR(50),
  event_time    TIMESTAMP     NOT NULL
) PARTITION BY RANGE (event_time);

-- Kept 7 days, then dropped
-- Used only for Flink replay if reprocessing is needed
```

---

## 7. Redis Key Structure

### 7.1 Hourly Sorted Sets (Flink writes)

```
Key:     category:{categoryId}:top:{YYYY-MM-DD-HH}
Type:    Sorted Set
Score:   view count in that hour
Member:  productId
TTL:     24 hours (key expires after it falls outside the 24h window)

Example:
  KEY: category:shoes:top:2026-07-18-14
  
  MEMBERS (ZREVRANGE with scores):
    prod_001  →  score: 1840    (1840 views in 14:00–15:00 window)
    prod_002  →  score: 1210
    prod_003  →  score:  890
    prod_004  →  score:  450
    ...

ZINCRBY category:shoes:top:2026-07-18-14 450 prod_001
  → atomically adds 450 to prod_001's score in that hour
```

### 7.2 Today's 24h Sorted Set (Flink writes — hourly, via deque state)

```
Key:     category:{categoryId}:today
Type:    Sorted Set
Score:   rolling 24h total (sum of last 24 hourly counts, maintained in Flink state)
TTL:     2 hours (reset by Flink every hour; expires if Flink is down >2h)

Example:
  KEY: category:shoes:today

  MEMBERS (after Flink 1-hour window closes at 15:00):
    prod_001  →  score: 30820   (sum of prod_001's last 24 hourly counts)
    prod_002  →  score: 28400
    prod_003  →  score: 21300
    ...

Flink write command (once per hour per product):
  ZADD category:shoes:today 30820 prod_001
  EXPIRE category:shoes:today 7200

  ZADD overwrites score entirely (correct — Flink holds full 24h sum in deque state)
  ZINCRBY would be wrong here (score is not an increment, it's the full recomputed total)
```

### 7.3 Event Deduplication

```
Key:     dedup:{userId}:{productId}
Type:    String (any value, just existence matters)
TTL:     5 minutes

SET dedup:user_abc:prod_001 1 NX EX 300
  → NX: only set if not exists (dedup check)
  → returns nil if already counted in last 5 min → skip Kafka publish
```

### 7.4 Full Redis Key Inventory

```
category:shoes:top:2026-07-18-14   Sorted Set   24h TTL   hourly bucket (Flink ZINCRBY, 60x/hr)
category:shoes:top:2026-07-18-13   Sorted Set   24h TTL   hourly bucket
... (24 keys per category at any time)
category:shoes:today               Sorted Set    2h TTL   24h rolling ranking (Flink ZADD, 1x/hr)
dedup:user_abc:prod_001            String        5m TTL   click dedup
```

---

## 8. Sequence Diagrams

### 8.1 User Browses Shoes (Read Path)

```
User          API GW       Browse Svc      Redis            PostgreSQL
 │               │               │            │                  │
 │ GET /browse   │               │            │                  │
 │ ?cat=shoes    │               │            │                  │
 │──────────────►│               │            │                  │
 │               │ auth, rate    │            │                  │
 │               │ limit check   │            │                  │
 │               │──────────────►│            │                  │
 │               │               │            │                  │
 │               │               │ ZREVRANGE  │                  │
 │               │               │ shoes:today│                  │
 │               │               │ 0 19       │                  │
 │               │               │───────────►│                  │
 │               │               │            │                  │
 │               │               │◄───────────│                  │
 │               │               │ [prod_001:52400,              │
 │               │               │  prod_002:41200, ...]         │
 │               │               │            │                  │
 │               │               │ SELECT * FROM products        │
 │               │               │ WHERE id IN (prod_001,...)    │
 │               │               │───────────────────────────────►
 │               │               │◄───────────────────────────────
 │               │               │ {name, price, image_url, ...} │
 │               │               │            │                  │
 │               │               │ merge ranks + metadata        │
 │               │               │            │                  │
 │◄──────────────│◄──────────────│            │                  │
 │ 200 {products │               │            │                  │
 │  sorted by    │               │            │                  │
 │  views_24h}   │               │            │                  │
```

---

### 8.2 User Clicks on Product (Write Path — Event to Redis)

```
User      Event Svc    Redis(dedup)   Kafka         Flink         Redis(rank)    DB
 │            │              │          │               │               │          │
 │ POST       │              │          │               │               │          │
 │ /events    │              │          │               │               │          │
 │ /view      │              │          │               │               │          │
 │───────────►│              │          │               │               │          │
 │            │ SET dedup:   │          │               │               │          │
 │            │ user:prod NX │          │               │               │          │
 │            │─────────────►│          │               │               │          │
 │            │◄─────────────│          │               │               │          │
 │            │ (nil = new)  │          │               │               │          │
 │            │              │          │               │               │          │
 │            │ PRODUCE {productId,     │               │               │          │
 │            │ categoryId, timestamp}  │               │               │          │
 │            │─────────────────────────►              │               │          │
 │◄───────────│              │          │               │               │          │
 │ 202        │              │          │               │               │          │
 │ Accepted   │              │          │               │               │          │
 │            │              │          │               │               │          │
 │            │              │          │ CONSUME       │               │          │
 │            │              │          │───────────────►               │          │
 │            │              │          │  (1 min tumbling window)      │          │
 │            │              │          │               │               │          │
 │            │              │          │               │ ZINCRBY       │          │
 │            │              │          │               │ shoes:top:    │          │
 │            │              │          │               │ 2026-07-18-14 │          │
 │            │              │          │               │ <count>       │          │
 │            │              │          │               │ prod_001      │          │
 │            │              │          │               │──────────────►│          │
 │            │              │          │               │               │          │
 │            │              │          │               │ UPSERT        │          │
 │            │              │          │               │ category_popularity      │
 │            │              │          │               │ _hourly       │          │
 │            │              │          │               │──────────────────────────►
```

---

### 8.3 Flink 1-Hour Window → shoes:today Update

```
(happens once per hour at hour boundary, e.g. 15:00:00)

Flink                    Redis(hourly)      Redis(today)
 │                            │                  │
 │  1-hour window closes      │                  │
 │  for prod_001 (hour 14)    │                  │
 │                            │                  │
 │  deque.addLast(1840)        │                  │
 │  deque.removeFirst(900)     │                  │  ← oldest hour dropped from deque
 │  rolling24h = sum = 30820   │                  │
 │                            │                  │
 │  ZADD shoes:today          │                  │
 │  30820 prod_001            │                  │
 │───────────────────────────────────────────────►│
 │                            │                  │
 │  EXPIRE shoes:today 7200   │                  │
 │───────────────────────────────────────────────►│
 │                            │                  │
 │  (repeat for every         │                  │
 │   product in this task)    │                  │

Note: shoes:today is updated once per hour, not every 5 min.
Rankings lag by up to 60 min from last click to visible rank change.
```

---

## 9. Concrete Example: Click at 2:30 PM

```
Timeline: Friday, 2026-07-18

2:30:00 PM  — User clicks on Nike Air Max (prod_001, category: shoes)

2:30:00 PM  — Event Service receives POST /events/view
              Dedup check: SET dedup:user_abc:prod_001 NX → OK (new event)
              Publishes to Kafka topic=product-views, partition=prod_001_partition

2:30:01 PM  — Kafka delivers event to Flink consumer
              Event lands in both:
                Level 1 window [14:30 → 14:31]   (1-min)
                Level 2 window [14:00 → 15:00]   (1-hour)

2:31:00 PM  — Level 1 window closes (1-min boundary)
              Flink aggregates: prod_001 had 450 views in this minute
              ZINCRBY category:shoes:top:2026-07-18-14  450  prod_001
              UPSERT  category_popularity_hourly (prod_001, shoes, 2026-07-18 14:00, 450)

2:31:02 PM  — Hourly key updated in Redis.
              But shoes:today still shows OLD score (last updated at 14:00)
              User browsing now sees stale rank for prod_001.

3:00:00 PM  — Level 2 window closes (1-hour boundary)
              Flink aggregates: prod_001 had 1840 total views in hour 14
              deque.addLast(1840), deque.removeFirst(oldest_hour)
              rolling24h = 30,820
              ZADD category:shoes:today 30820 prod_001

3:00:02 PM  — shoes:today now reflects all views up to 3:00 PM
              Next user browsing sees updated rank for prod_001.

Lag from click to visible ranking change in shoes:today: up to ~60 minutes
Lag from click to hourly key update (shoes:top:...-14): ~1-2 minutes
```

---

### How Hour Rolling Works (Flink-Only Approach — Current Design)

```
At 2026-07-19 15:00:00 — Flink 1-hour window [14:00 → 15:00] closes:
  deque state for prod_001:
    oldest entry was hour 14 from yesterday (1840) → removeFirst()
    new entry is hour 14 from today → addLast(new_count)
  rolling24h recomputed → ZADD shoes:today new_total prod_001

Flink deque controls which hours are in the 24h window.
Redis hourly key TTL (24h) is only for memory cleanup — not relied on
for the 24h calculation.
```

---

### [OLD FLOW — Cron + ZUNIONSTORE Approach, No Longer Used]

> This section describes the cron-based approach that was replaced by the
> Flink deque approach. Kept here for reference and tradeoff understanding.
> See Section 15 for full comparison.

```
At 2026-07-19 14:00:00 (exactly 24h after creation):
  KEY category:shoes:top:2026-07-18-14 expires in Redis automatically (TTL=24h)
  → this key slides OUT of the 24h window

At 2026-07-19 15:00 (Flink creates new key):
  KEY category:shoes:top:2026-07-19-14 created
  → this key slides IN as the new current hour

Next cron run fires ZUNIONSTORE:
  Reads whatever 24 hourly keys currently exist in Redis
  Expired key (2026-07-18-14) is already gone → not included
  New key (2026-07-19-14) exists → included
  shoes:today score = old_total - 1840 (expired hour) + new_hour_count

In this approach:
  Redis TTL expiry IS the mechanism for sliding the window.
  ZUNIONSTORE reads whatever keys survive → result is naturally the last 24h.
  Flink holds no cross-hour state — fully stateless per 1-min window.
```
```

---

### Why Not Flink Sliding Window?

Flink natively supports sliding windows: `SlidingEventTimeWindows(size, slide)`.
The intuitive solution for a 24h rolling total would be:

```
SlidingEventTimeWindows(size=24h, slide=1min)
→ fires every 1 min with the last 24h of data
→ shoes:today updates every minute ← sounds perfect
```

**The problem — event fan-out:**

```
Every event belongs to multiple windows simultaneously:
  size=24h, slide=1min → 24h ÷ 1min = 1440 windows per event

Event at 14:30:
  counted in window [14:30 → next day 14:30]
  counted in window [14:29 → next day 14:29]
  counted in window [14:28 → next day 14:28]
  ...1440 windows total

Flink must buffer each event in 1440 window states simultaneously.
```

**State size math:**

```
50,000 events/sec × 1440 copies in state
= 72,000,000 state writes/sec

Events buffered in state at any time:
  24h × 3600 sec × 50,000 events/sec = 4.32 billion events

At ~100 bytes/event = 432 GB of Flink state

Not feasible for a standard Flink cluster.
```

**Why our deque approach achieves the same result with negligible state:**

```
Sliding window:  stores RAW EVENTS in state → 432 GB
Deque approach:  stores HOURLY AGGREGATES in state → 384 KB

Key insight:
  Pre-aggregate into 1-hour buckets first (Level 1 tumbling window).
  Slide over those 24 aggregated counts (deque of 24 Longs).

  Both compute the same 24h rolling total.
  Deque trades 1-minute freshness for 1-hour freshness,
  but reduces state by a factor of ~1 billion.

If you need 1-minute freshness with deque:
  Use 5-min tumbling window for Level 2.
  Deque size = 24h ÷ 5min = 288 entries per product.
  State = 288 × 8 bytes = 2.3 KB per product → still negligible.
```

**Summary:**

```
Approach                    State size       Freshness    Feasible?
──────────────────────────────────────────────────────────────────
Flink sliding (24h, 1min)   432 GB           1 min        No
Flink deque (1-hour window)  384 KB          60 min       Yes
Flink deque (5-min window)   ~120 MB         5 min        Yes
Cron + ZUNIONSTORE            0 (Flink)      5 min        Yes

Rule of thumb:
  Never use a large sliding window on raw events at high throughput.
  Pre-aggregate first, then slide over aggregates.
```

---

## 10. Sharding and Partitioning

### 10.1 Kafka Partitioning

```
Topic: product-views
Partitions: 50

Partition assignment by categoryId hash:
  hash("shoes")    % 50 = 7    → Partition 7
  hash("tshirts")  % 50 = 23   → Partition 23
  hash("jackets")  % 50 = 41   → Partition 41

Why categoryId (not random):
  All shoe events land in the same set of partitions
  Flink consumer for partition 7 handles all shoe aggregation
  No cross-partition coordination needed

Hot Key Problem:
  If "shoes" gets 10x traffic → partition 7 is overwhelmed

Solution — partition by productId instead:
  hash("prod_001") % 50 = 3    → Partition 3
  hash("prod_002") % 50 = 18   → Partition 18
  hash("prod_003") % 50 = 31   → Partition 31

  100k+ products = very even distribution
  Redis ZINCRBY is atomic → multiple Flink tasks write to
  same category sorted set safely
```

### 10.2 Flink Partitioning

```
keyBy(productId):
  All events for prod_001 → Flink Task 3
  All events for prod_002 → Flink Task 18
  Aggregation is local, no cross-task coordination

Hot Key at Product Level (e.g., viral product):
  Two-phase aggregation with salting:

  Phase 1 — add random suffix:
    prod_001_0 → Task 1 (subset of prod_001 events)
    prod_001_1 → Task 2 (subset of prod_001 events)
    prod_001_2 → Task 3 (subset of prod_001 events)
    → each task counts its slice

  Phase 2 — strip suffix, merge:
    prod_001 → Task 5 receives 3 partial counts → sums them
    → single ZINCRBY with final count
```

### 10.3 Redis Sharding

```
Redis Cluster (16,384 hash slots):
  category:shoes:top:*  → hash slot for "shoes" → Node A
  category:tshirts:top:* → hash slot for "tshirts" → Node B

Use hash tags to co-locate related keys:
  {shoes}:top:2026-07-18-14   ← hash computed on "shoes" only
  {shoes}:top:2026-07-18-13   ← same hash slot as above
  {shoes}:today               ← same hash slot

  Flink writes to both hourly keys + today key for same category
  → hash tags ensure all are on same Redis node (no cross-slot ops)

6-node Redis Cluster (3 primary + 3 replica):
  Handles ~600k ops/sec, auto-failover in <30s
```

### 10.4 PostgreSQL Partitioning

```
category_popularity_hourly partitioned by RANGE(time_bucket):

  Partition 2026-07-18: 2026-07-18 00:00 → 2026-07-19 00:00
  Partition 2026-07-19: 2026-07-19 00:00 → 2026-07-20 00:00

Benefits:
  Query for last 24h scans at most 2 partitions (today + yesterday)
  Old partitions (>30 days) dropped instantly (DROP PARTITION, not DELETE)
  New partitions added by cron job at midnight

Read replicas:
  Browse Service → reads go to replica
  Flink UPSERT   → writes go to primary
```

---

## 11. Scalability

### 11.1 Read Path Scaling

```
Browse Service:
  Stateless pods → horizontal scaling behind load balancer
  50 pod replicas handle 100k req/sec

Redis (sorted set reads):
  ZREVRANGE is O(log N + M) → sub-millisecond at 100k members
  Read replicas serve Browse Service reads
  Cluster sharding across 6 nodes

Product metadata (DB):
  Browse Service maintains in-process cache (LRU, TTL=5min)
  Product names/prices change rarely → cache hit rate >95%
  Only 20 product metadata fetches per browse request
```

### 11.2 Write Path Scaling

```
Event Service:
  Stateless pods → horizontal scaling
  Kafka absorbs burst traffic (up to 10x normal rate)

Kafka:
  50 partitions → 50 parallel Flink tasks
  Throughput: 50k events/sec → 1k events/sec per partition (comfortable)

Flink:
  TaskManager scale-out: add nodes → more parallelism
  Exactly-once semantics via checkpointing
  Backpressure handling: if Redis is slow → Flink slows Kafka consumption
  Kafka retains 7 days → safe to replay if Flink falls behind

Redis writes:
  50k events/sec → after 1-min window aggregation →
  ~50k/60 = 833 ZINCRBY ops/sec (very manageable)
```

### 11.3 Numbers at Scale

```
10M DAU:
  Peak reads:  100,000 req/sec browse
  Peak writes:  50,000 view events/sec

Redis sorted set:
  100k products per category × 50 categories × 25 hourly keys
  = 125M entries in Redis (fine for 6-node cluster with 64GB RAM each)

Kafka lag at peak:
  50k events/sec, 1-min window, 50 partitions
  = 60k events buffered before Flink writes → 60MB in Kafka (tiny)

DB writes (Flink):
  1 UPSERT per (product, minute) → ~50k/60 = 833 writes/sec
  Well within PostgreSQL's 10k writes/sec capacity
```

---

## 12. Fault Tolerance

### 12.1 Flink Crashes

```
Problem: Flink task crashes — partial window state and deque state lost

Solution: Flink checkpointing

  Every 30 seconds, Flink snapshots:
    - Kafka consumer offsets
    - Level 1 window state (partial 1-min counts)
    - Level 2 window state (partial 1-hour counts)
    - Deque ValueState (last 24 hourly counts per product)
  → stored in S3 / HDFS (durable)

On restart:
  Flink rewinds Kafka to last checkpoint offset
  Level 1 + Level 2 window state restored from snapshot
  Deque state restored → 24h rolling total resumes correctly

  Result: at-least-once delivery
  ZINCRBY (hourly keys) is safe — Redis accumulates idempotently
  ZADD (today key) is safe — Flink holds full sum, ZADD overwrites
  UPSERT ON CONFLICT handles duplicate DB writes safely

If Flink is down for hours (no checkpoint recent enough):
  Rebuild deque from DB:
    For each of last 24 hours:
      SELECT SUM(view_count) FROM category_popularity_hourly
      WHERE product_id = ? AND time_bucket = ?
    Populate deque → ZADD shoes:today with rebuilt total
```

### 12.2 Redis Crashes

```
Problem: Redis goes down → Browse Service has no rankings

Recovery steps:

1. Browse Service detects Redis failure
   → Falls back to DB query:
     SELECT product_id, SUM(view_count)
     FROM category_popularity_hourly
     WHERE category_id = 'shoes'
       AND time_bucket >= NOW() - INTERVAL '24 hours'
     GROUP BY product_id
     ORDER BY SUM(view_count) DESC
     LIMIT 100;

2. Warm Redis from DB result:
   For each product in result:
     ZADD category:shoes:today <score> <productId>

3. Hourly keys can be rebuilt:
   For each hour in last 24:
     SELECT product_id, view_count
     FROM category_popularity_hourly
     WHERE category_id = 'shoes' AND time_bucket = '2026-07-18-14:00'
   → ZADD category:shoes:top:2026-07-18-14 <score> <productId>

Recovery time: ~2-5 minutes for full warm-up
Data loss: zero (DB is the source of truth)
```

### 12.3 Kafka Goes Down

```
Problem: Events cannot be published → view counts stall

Impact: Low — rankings are slightly stale but browse still works
  Browse Service still reads from Redis (which has last known state)
  Event Service returns 503, client retries

Recovery:
  Kafka restores from replicas (replication factor=3)
  Flink resumes from last checkpoint
  No events are permanently lost (Kafka is durable)
```

### 12.4 DB Goes Down

```
Problem: Browse Service cannot fetch product metadata

Solution:
  Browse Service LRU cache (5 min TTL) serves most requests
  For cache misses: return product with just productId + rank
  (name/price shown as loading)

Fallback: read replica promoted to primary (RDS Multi-AZ < 60s)
```

---

## 13. Design Decisions & Trade-offs

| Decision | Chosen | Alternative | Reason |
|---|---|---|---|
| Ranking store | Redis sorted set | Elasticsearch | ZINCRBY atomic, sub-ms reads |
| Time granularity | Hourly buckets | Per-minute buckets | 24 hourly keys vs 1440 per-minute keys in Redis |
| 24h merge strategy | Flink deque (1-hour window) | Cron + ZUNIONSTORE every 5 min | No cron dependency; tradeoff is 60 min staleness vs 5 min |
| Kafka partition key | productId | categoryId | Avoids hot key on popular categories |
| Window type (hourly) | Tumbling 1 min → ZINCRBY | Sliding window | Simpler, no per-event state duplication |
| Window type (daily) | Tumbling 1 hour + deque | Sliding window (24h, 1min slide) | Deque: 192 bytes/product; sliding: 1440× state overhead |
| Browse fallback | DB query | Stale Redis | Stale Redis is simpler; DB fallback only on crash |
| Dedup window | 5 min per user-product | No dedup | Prevents refresh spam inflating counts |

---

## 14. Summary

```
Click happens at 2:30 PM
    │
    ▼
Event Service validates + deduplicates (Redis NX 5min)
    │
    ▼
Kafka (partitioned by productId for even load distribution)
    │
    ▼
Flink keyBy(productId)
    │
    ├── Level 1: 1-min tumbling window
    │     ├──► ZINCRBY category:shoes:top:2026-07-18-14  count  prod_001  (lag: ~1 min)
    │     └──► UPSERT category_popularity_hourly (durability)
    │
    └── Level 2: 1-hour tumbling window + deque(24) state
          └──► ZADD category:shoes:today  rolling24h  prod_001  (lag: up to ~60 min)
    │
    ▼
User browses → ZREVRANGE shoes:today → top products in <1ms
               + product metadata from DB (LRU cached)
```

**Lag to hourly key update: ~1-2 minutes (Level 1 window).**
**Lag to shoes:today ranking change: up to ~60 minutes (Level 2 window).**
**Read latency: <10ms (Redis ZREVRANGE + in-process cache).**
**Write throughput: 50k events/sec sustained, 500k peak (Kafka buffers).**

---

## 15. Tradeoff Analysis: Flink-Only vs Cron + ZUNIONSTORE

This section captures a design decision made during review. Both approaches are valid. The chosen approach is Flink-only.

---

### Approach A — Flink-Only (Chosen)

```
Flink Level 1: 1-min tumbling window → ZINCRBY hourly keys
Flink Level 2: 1-hour tumbling window + 24-bucket deque state → ZADD shoes:today
```

**How it works:**

```
Each Flink task maintains a deque of last 24 hourly counts per product (ValueState).
At every hour boundary:
  deque.addLast(new_hourly_count)
  if deque.size() > 24: deque.removeFirst()   ← oldest hour drops off automatically
  rolling24h = sum(deque)
  ZADD shoes:today rolling24h prod_001
```

**State size:**

```
24 Long values × 8 bytes = 192 bytes per product
100k products across 50 tasks = 2000 products/task
Memory per task = 384 KB   ← negligible
```

**Pros:**

```
+ No cron job needed — one less moving part
+ No ZUNIONSTORE — no Redis cross-slot operation concern
+ Self-contained in Flink — easier to reason about
+ Deque size is bounded — state never grows unboundedly
+ Crash recovery: checkpoint restores deque state fully
```

**Cons:**

```
- shoes:today updates once per hour → up to 60 min staleness in browse rankings
- Flink must maintain state across hour boundaries (vs stateless Level 1)
- If Flink is down for hours, deque must be rebuilt from DB before ZADD
- More complex Flink job (two window types + stateful operator)
```

---

### Approach B — Cron + ZUNIONSTORE

```
Flink: 1-min tumbling window → ZINCRBY hourly keys (stateless, simple)
Cron:  every 5 min → ZUNIONSTORE 24 hourly keys → shoes:today
```

**How it works:**

```
Flink writes to hourly keys every minute (no inter-window state needed).
Cron job (Kubernetes CronJob) runs every 5 minutes:
  ZUNIONSTORE category:shoes:today 24
    category:shoes:top:2026-07-19-14
    category:shoes:top:2026-07-19-13
    ...  (all 24 hourly keys currently in Redis)
  EXPIRE category:shoes:today 900   (15 min TTL)
```

**Pros:**

```
+ shoes:today updates every 5 min → fresher rankings
+ Flink is fully stateless (only Level 1 window, no deque)
+ Simpler Flink job — easier to maintain and debug
+ ZUNIONSTORE handles the 24h merge natively in Redis
+ TTL expiry on hourly keys automatically handles window sliding
  (expired key disappears from ZUNIONSTORE input naturally)
```

**Cons:**

```
- Requires a cron job — one more component to deploy and monitor
- ZUNIONSTORE must run on keys in same Redis slot → requires hash tags
- ZUNIONSTORE is O(N×K) — N products × K=24 keys → must not run on hot path
  (fine as cron, problematic if triggered on every browse request)
- If cron dies → shoes:today goes stale until TTL expires → Browse falls back to DB
```

---

### Side-by-Side Comparison

```
Dimension              Flink-Only              Cron + ZUNIONSTORE
────────────────────────────────────────────────────────────────────
shoes:today staleness  up to 60 min            up to 5 min
Flink complexity       Higher (2 window types, Lower (1 window type,
                       deque state)            stateless)
External components    Kafka, Redis, DB        Kafka, Redis, DB, CronJob
Crash recovery         Restore from checkpoint ZUNIONSTORE reads
                       + DB rebuild if needed  current Redis state
Redis state            Hourly keys + today key Hourly keys + today key
                       (same)                  (same)
Hot key avoidance      ZADD per product/hour   ZUNIONSTORE per category
                       (fine, atomic)          (once per 5 min, fine)
Operational risk       Flink deque divergence  Cron downtime
                       if state corrupted      → stale rankings
```

---

### When to Choose Which

```
Choose Flink-only when:
  - You want to minimise external dependencies (no cron)
  - 60 min staleness in browse rankings is acceptable
  - Team is comfortable with stateful Flink operators
  - Simpler infra > fresher rankings

Choose Cron + ZUNIONSTORE when:
  - Rankings must reflect clicks within 5 minutes
  - You want Flink to stay stateless and simple
  - Team already runs cron jobs for other tasks
  - Near-real-time ranking is a product requirement

In this design: Flink-only chosen.
Reasoning: no external cron dependency, state size is trivial,
and hourly ranking freshness is acceptable for browse (not search).
```
