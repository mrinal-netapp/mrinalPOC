# Cloud Billing & Metering Pipeline — Technical Writeup
## Oracle | Backend & Cloud Billing/Metering (Nov 2019 – Oct 2021)

---

## Overview

This document describes the design, implementation, and operational concepts behind a high-scale usage-cost metering pipeline built for Oracle Cloud SaaS. The system ingested high-volume usage events via Apache Kafka, aggregated per customer per day, applied pricing rules, and persisted daily cost records — with accuracy as a first-class concern since errors directly affect revenue.

**Honesty anchor:** Early-career role. Owned specific consumers and services within the broader billing pipeline, not the full architecture. Scope is "I built [specific component]" not "I architected billing."

> **⚠️ Verify before claiming:** confirm which components were *actually yours* — this writeup labels the **ingestion/dedup consumer** and **test automation** as yours and reconciliation as collaborative; adjust if your real scope differed. Also confirm the specific mechanisms described here match what was truly built vs. reconstructed: the **`processed_events` dedup table**, **grace-period** finalization, **reconciliation/adjustment** jobs, and **partition-by-`customerId`**.

---

## Problem Statement

```
Oracle Cloud SaaS:

  Thousands of enterprise customers
  Each consuming cloud resources: compute, storage, network, DB
  Usage events generated continuously — millions per day

  Problem 1: Accuracy = revenue
    Double-counting a usage event → customer overcharged → legal risk
    Missing a usage event → Oracle undercharges → revenue loss
    Either way: billing disputes, SLA penalties, trust damage

  Problem 2: Scale
    Millions of usage events per day across thousands of customers
    Single-threaded processing won't keep up
    Must scale horizontally without losing events or order guarantees

  Problem 3: Late and out-of-order events
    Cloud usage events don't always arrive in order
    Network delays, retries, buffering → events arrive late
    Daily cost calculation must handle this correctly

  Problem 4: Schema evolution over time
    Billing rules change, new services launch, pricing tiers shift
    DB schema must evolve without downtime or data loss
```

**Goal:** Build a metering pipeline that is accurate at scale — idempotent ingestion, correct aggregation, daily cost persistence, reconciliation to catch anything that slips through.

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                      INGESTION LAYER                                 │
│                                                                      │
│  Oracle Cloud SaaS Services                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│  │ Compute  │  │ Storage  │  │ Network  │  │Database  │  ...         │
│  │ service  │  │ service  │  │ service  │  │ service  │             │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘             │
│       │             │             │             │                   │
│       └─────────────┴─────────────┴─────────────┘                   │
│                           │                                          │
│                    usage events                                      │
│                    (customerId, serviceId,                           │
│                     quantity, timestamp,                             │
│                     eventId)                                         │
└───────────────────────────┼──────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       KAFKA LAYER                                    │
│                                                                      │
│  Topic: oracle.usage.events                                          │
│  Partitioned by: customerId (same customer → same partition)         │
│                                                                      │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                 │
│  │ Partition 0  │ │ Partition 1  │ │ Partition 2  │  ... N           │
│  │ customer A   │ │ customer B   │ │ customer C   │                  │
│  │ customer D   │ │ customer E   │ │ customer F   │                  │
│  │ offset 0..n  │ │ offset 0..n  │ │ offset 0..n  │                  │
│  └──────────────┘ └──────────────┘ └──────────────┘                 │
│                                                                      │
└───────────────────────────┬──────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    PROCESSING LAYER                                  │
│              (Spring Boot microservices)                             │
│                                                                      │
│  Consumer Group: billing-aggregation-group                           │
│                                                                      │
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐            │
│  │  Consumer 0    │ │  Consumer 1    │ │  Consumer 2    │  ...        │
│  │  reads P0      │ │  reads P1      │ │  reads P2      │            │
│  │                │ │                │ │                │            │
│  │  1. dedupe     │ │  1. dedupe     │ │  1. dedupe     │            │
│  │     by eventId │ │     by eventId │ │     by eventId │            │
│  │  2. aggregate  │ │  2. aggregate  │ │  2. aggregate  │            │
│  │     per        │ │     per        │ │     per        │            │
│  │     customer/  │ │     customer/  │ │     customer/  │            │
│  │     day        │ │     day        │ │     day        │            │
│  │  3. apply      │ │  3. apply      │ │  3. apply      │            │
│  │     pricing    │ │     pricing    │ │     pricing    │            │
│  └───────┬────────┘ └───────┬────────┘ └───────┬────────┘            │
│          └─────────────────┬┘─────────────────-┘                    │
│                            │                                         │
└────────────────────────────┼─────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    PERSISTENCE LAYER                                 │
│                                                                      │
│  Oracle DB (schema managed by Liquibase)                             │
│                                                                      │
│  ┌─────────────────────────────────────────────┐                     │
│  │ daily_usage_cost                            │                     │
│  │  customerId | date       | service | cost   │                     │
│  │  cust-001   | 2021-05-01 | compute | $142.5 │                     │
│  │  cust-001   | 2021-05-01 | storage | $23.8  │                     │
│  │  cust-002   | 2021-05-01 | compute | $891.2 │                     │
│  └─────────────────────────────────────────────┘                     │
│                                                                      │
│  ┌─────────────────────────────────────────────┐                     │
│  │ processed_events (dedup table)              │                     │
│  │  eventId (PK, unique) | processedAt         │                     │
│  │  evt-abc-123          | 2021-05-01 14:32:01 │                     │
│  └─────────────────────────────────────────────┘                     │
│                                                                      │
└───────────────────────────┬──────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│                   RECONCILIATION LAYER                               │
│                                                                      │
│  Nightly reconciliation job:                                         │
│  compare computed daily costs vs source usage logs                   │
│  flag discrepancies → alert → adjustment job                         │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Apache Kafka — Core Concepts

### What Kafka Is

```
Kafka is a distributed event streaming platform.

Think of it as a highly durable, ordered, replayable log:

Producer                Topic (log)               Consumer
┌──────┐    publish     ┌─────────────────┐  read  ┌──────────┐
│ SaaS │ ─────────────► │ [e1][e2][e3]... │ ──────► │ Billing  │
│ svc  │                │  (append-only)  │        │ consumer │
└──────┘                └─────────────────┘        └──────────┘

Key properties:
  - Events are PERSISTED (not lost after consumption)
  - Events are ORDERED within a partition
  - Events can be REPLAYED (reprocess from offset 0)
  - Multiple consumers can read the same topic independently
```

### Topics and Partitions

```
Topic: oracle.usage.events
Purpose: scale throughput by splitting one topic into N partitions

Without partitions (single log):
  all events → one consumer → bottleneck

With partitions:
  Topic
  ├── Partition 0 → Consumer A  (customer IDs 0000-0999)
  ├── Partition 1 → Consumer B  (customer IDs 1000-1999)
  ├── Partition 2 → Consumer C  (customer IDs 2000-2999)
  └── Partition N → Consumer N  ...

Partition key: customerId
  → all events for the same customer land on the same partition
  → same consumer processes all events for that customer
  → ordering preserved per customer (important for billing)
  → scale: add partitions + consumers to handle more load
```

### Consumer Groups

```
Consumer Group: billing-aggregation-group

Kafka assigns each partition to exactly ONE consumer in the group:

  Partition 0 → Consumer A  ┐
  Partition 1 → Consumer B  ├── Consumer Group
  Partition 2 → Consumer C  │   (billing-aggregation-group)
  Partition 3 → Consumer A  ┘   (A handles 2 partitions if #consumers < #partitions)

Benefits:
  - Scale out: add more consumer instances → more partitions served in parallel
  - Fault tolerance: consumer dies → Kafka rebalances → another consumer takes over
  - Independent groups: a second group (e.g. analytics) reads the same topic
    without affecting billing consumers
```

### Offsets

```
Each event in a partition has an OFFSET — its position in the log

Partition 0:
  offset 0: {customerId: A, service: compute, qty: 4, eventId: evt-001}
  offset 1: {customerId: A, service: storage, qty: 100, eventId: evt-002}
  offset 2: {customerId: A, service: compute, qty: 2, eventId: evt-003}
            ↑
        consumer reads here (committed offset)

Consumer commits offset after processing:
  "I have processed up to offset 2"
  
If consumer crashes and restarts:
  reads from last committed offset (2)
  → no events lost (may reprocess offset 2 → idempotency handles it)
```

### At-Least-Once vs Exactly-Once

```
AT-LEAST-ONCE (what you used):
  Consumer reads event → processes → commits offset
  If consumer crashes AFTER processing but BEFORE commit:
    → restarts → reprocesses same event
    → event processed TWICE
  
  Solution: idempotent consumers (dedup by eventId)
  "Process at least once, dedupe to get effectively-once"

EXACTLY-ONCE (Kafka transactions):
  Kafka guarantees each event processed exactly once
  via transactional producers + atomic offset commit
  
  More complex, higher overhead
  Used when dedup is hard or impossible

Honest framing:
  "We used at-least-once delivery with idempotent consumers —
   deduplication by eventId in the DB gave us effectively-once
   semantics without the overhead of Kafka transactions."
```

---

## Idempotency — The Core Billing Concern

```
Why idempotency matters more in billing than anywhere else:
  Double-count a usage event → customer overcharged → legal dispute
  This is money. Errors are not just bugs — they are incidents.

How deduplication works:

Event arrives: {eventId: "evt-abc-123", customerId: "C001", qty: 5}

Consumer checks processed_events table:
  SELECT 1 FROM processed_events WHERE eventId = 'evt-abc-123'

  ┌─────────────────────────┐
  │  Found → already done   │──► SKIP (no-op)
  │  Not found → new event  │──► INSERT into processed_events
  └─────────────────────────┘       then process billing

Atomicity (both or neither):
  INSERT into processed_events     ┐
  UPDATE daily_usage_cost          ├── single DB transaction
                                   ┘
  If transaction fails → rolled back → event not marked processed
  → retry will reprocess it → safe

Result:
  First delivery: INSERT succeeds → cost updated ✓
  Duplicate delivery: INSERT fails (PK violation) → SKIP → no double-count ✓
  Consumer crash mid-process: transaction rolled back → retry → processed once ✓
```

---

## Handling Late and Out-of-Order Events

```
Problem:
  Usage event from 2021-05-01 arrives at 2021-05-03 (2 days late)
  Daily cost for 2021-05-01 was already calculated and persisted
  
  Naive approach: ignore it → revenue loss
  Wrong approach: reopen closed billing period → audit problems

Solutions:

1. GRACE PERIOD WINDOW
   Don't close a billing day immediately at midnight
   Wait N hours (e.g. 6 hours) for stragglers before finalizing

   May-01 events window:
   |────────────────────────────────|──── grace ─────|
   00:00                          23:59            05:00 (May-02)
                                                       ↑
                                             finalize daily cost here

2. WINDOWED AGGREGATION
   Aggregate events into time windows
   Keep window open for grace period
   Late events within grace period → included in window
   Late events outside grace period → adjustment job

3. RECONCILIATION + ADJUSTMENT JOBS
   Nightly reconciliation compares:
     computed daily_cost (from Kafka pipeline)
     vs
     source usage logs (raw from services)
   
   Discrepancy found → adjustment entry created
   
   ┌───────────────────────────────────────────────────┐
   │ billing_adjustments                               │
   │ customerId | date     | service | adjustment      │
   │ C001       | May-01   | compute | +$2.40          │
   │             (late event arrived after window)     │
   └───────────────────────────────────────────────────┘
   
   Adjustment appears on next invoice with explanation.
   Audit trail preserved. No reopening of closed periods.
```

---

## Metering Pipeline — Event Flow Detail

```
Step 1: Usage event produced

  SaaS service → Kafka producer
  {
    eventId:    "evt-abc-123",  ← globally unique, used for dedup
    customerId: "C001",
    serviceId:  "compute-vm",
    quantity:   4.0,            ← CPU hours
    unit:       "cpu-hours",
    timestamp:  "2021-05-01T14:32:00Z",
    region:     "us-phoenix-1"
  }

Step 2: Kafka routes to partition

  partition = hash(customerId) % numPartitions
  → C001 always lands on same partition
  → ordering guaranteed for C001

Step 3: Spring Boot consumer processes

  a. Deduplicate: check processed_events by eventId → skip if seen
  b. Aggregate: accumulate quantity per (customerId, date, serviceId)
     running total in memory or DB staging table
  c. Rate lookup: fetch pricing for (serviceId, customerTier, date)
     pricing_rules table (Liquibase-managed)
  d. Cost calculation:
     cost = quantity × unit_price × tier_multiplier
     4.0 cpu-hours × $0.08/hr × 1.0 (standard tier) = $0.32
  e. Persist: UPSERT into daily_usage_cost
     (customerId, date, serviceId) → update cost atomically
  f. Commit Kafka offset

Step 4: Daily finalization (after grace period)

  Scheduler triggers at 05:00 for previous day
  Marks daily_usage_cost records as finalized
  Triggers reconciliation job

Step 5: Reconciliation

  Compare daily_usage_cost vs raw usage logs
  Flag discrepancies above threshold
  Create adjustment entries for late events
  Alert on anomalies (customer cost suddenly 10× normal)
```

---

## Spring Boot Microservice Structure

```
Billing Pipeline — Microservices Decomposition

┌─────────────────────────────────────────────────────────────┐
│  usage-ingestion-service   (what you built)                 │
│  - Kafka consumer                                           │
│  - deduplication logic                                      │
│  - raw event validation                                     │
│  - publishes to internal aggregation topic                  │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  usage-aggregation-service                                  │
│  - windowed aggregation per customer/day/service            │
│  - grace period management                                  │
│  - staging table management                                 │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  rating-service                                             │
│  - applies pricing rules to aggregated usage                │
│  - handles tier lookups, discounts, committed use           │
│  - persists daily_usage_cost                                │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  reconciliation-service                                     │
│  - nightly reconciliation vs source logs                    │
│  - adjustment entry creation                                │
│  - anomaly detection (cost spike alerts)                    │
└─────────────────────────────────────────────────────────────┘

Each service:
  - Spring Boot REST API for internal calls
  - Kafka consumer/producer for event-driven communication
  - Own DB schema managed by Liquibase changesets
  - Deployed on OCI (Oracle Cloud Infrastructure)
```

---

## Liquibase — Schema Migrations

### What It Is

```
Liquibase manages database schema changes as versioned code.

Problem without it:
  Schema changes applied manually → no audit trail
  Deploy v2 → DB has wrong schema → runtime error
  Rollback needed → no automated way to undo

With Liquibase:
  Schema changes are CHANGESETS in XML/YAML/SQL files
  Committed to git alongside code
  Applied automatically on service startup
  Tracked in databasechangelog table
  Rollback defined alongside forward migration
```

### Changeset Example

```xml
<!-- changelog/v1.2.0-add-adjustment-table.xml -->
<databaseChangeLog>

  <!-- Forward migration -->
  <changeSet id="v1.2.0-add-billing-adjustments"
             author="mrinal">
    <createTable tableName="billing_adjustments">
      <column name="id" type="BIGINT" autoIncrement="true">
        <constraints primaryKey="true"/>
      </column>
      <column name="customer_id" type="VARCHAR(64)">
        <constraints nullable="false"/>
      </column>
      <column name="billing_date" type="DATE">
        <constraints nullable="false"/>
      </column>
      <column name="service_id" type="VARCHAR(64)"/>
      <column name="adjustment_amount" type="DECIMAL(18,4)"/>
      <column name="reason" type="VARCHAR(255)"/>
      <column name="created_at" type="TIMESTAMP"/>
    </createTable>
  </changeSet>

  <!-- Rollback (undo this changeset) -->
  <rollback>
    <dropTable tableName="billing_adjustments"/>
  </rollback>

</databaseChangeLog>
```

### How It Works in Practice

```
Service starts up:
  Liquibase reads all changeset files
  Checks databasechangelog table for what's already applied
  Applies only new changesets in order
  Records each applied changeset

  databasechangelog:
  ┌────────────────────────────────────┬────────────────┬──────────┐
  │ id                                 │ author         │ applied  │
  ├────────────────────────────────────┼────────────────┼──────────┤
  │ v1.0.0-create-daily-usage-cost     │ team           │ Nov 2019 │
  │ v1.1.0-add-processed-events        │ team           │ Jan 2020 │
  │ v1.2.0-add-billing-adjustments     │ mrinal         │ Mar 2020 │
  └────────────────────────────────────┴────────────────┴──────────┘

Rollback scenario:
  bad deployment → run: liquibase rollbackCount 1
  → drops billing_adjustments table
  → removes record from databasechangelog
  → DB back to v1.1.0 state
```

---

## Test Automation — 100-200 Hours Saved

```
Before automation:
  QA team manually tests billing scenarios:
  - does event A get deduplicated correctly?
  - does late event fall into adjustment correctly?
  - does pricing apply correct tier?
  - does reconciliation catch discrepancy?

  Each scenario: set up data → run pipeline → verify DB → repeat
  Time: hours per release cycle × many releases = 100-200 hrs/year

After automation (what you built):
  Integration tests spin up:
    - embedded Kafka (or Testcontainers Kafka)
    - in-memory DB with Liquibase migrations applied
    - Spring Boot test context

  Test: produce events → run consumer → assert DB state

  @Test
  void deduplicatesDuplicateEvent() {
    // produce same event twice
    kafkaTemplate.send("usage.events", duplicateEvent);
    kafkaTemplate.send("usage.events", duplicateEvent);

    // wait for processing
    await().atMost(5, SECONDS).until(() ->
      processedEventsRepo.count() == 1
    );

    // assert only one cost entry
    assertThat(dailyCostRepo.findByCustAndDate("C001", TODAY))
      .hasSize(1)
      .extracting(DailyCost::getAmount)
      .containsExactly(new BigDecimal("0.32"));
  }

Result:
  Tests run in CI on every commit
  No manual QA for covered scenarios
  100-200 hours of manual testing eliminated
  Regressions caught before production
```

---

## Microservices Concepts

### Decomposition

```
Monolith (before):
  one big service handles ingestion + aggregation + rating + reconciliation
  → changes to pricing rules require full redeploy
  → one team owns everything
  → scaling means scaling everything

Microservices (after):
  ingestion-service  → scales independently (high Kafka throughput)
  aggregation-service → scales independently (CPU intensive)
  rating-service     → scales independently (pricing lookups)
  reconciliation-service → runs nightly, minimal resource needs

  Each service:
    owns its schema (Liquibase changesets)
    deploys independently
    scales independently
    fails independently (rating service down ≠ ingestion stops)
```

### REST vs Events

```
REST (synchronous):
  service A calls service B → waits for response
  
  ingestion → [HTTP] → rating → response → ingestion continues
  
  Problem: if rating is slow → ingestion backs up
           if rating is down → ingestion fails

Events (asynchronous via Kafka):
  service A publishes event → continues immediately
  service B processes event when ready
  
  ingestion → [Kafka] → rating (processes at own pace)
  
  Benefit: ingestion is decoupled from rating speed
           Kafka buffers events if rating is slow
           rating restarts → replays from last offset → no loss

Billing pipeline uses events between services:
  tight coupling (REST) only for synchronous queries (pricing lookup)
  loose coupling (Kafka) for data flow (usage events, aggregated results)
```

### Resilience Patterns

```
1. RETRY WITH BACKOFF
   Pricing API temporarily unavailable → retry 3× with backoff
   (same pattern as Goldman K8s operator — idempotency recurs)

2. CIRCUIT BREAKER
   Pricing API consistently failing → circuit opens
   Consumer pauses, alert fires, falls back to cached pricing
   (same concept as Goldman wave gating)

3. DEAD LETTER TOPIC
   Event cannot be processed after max retries
   → moved to oracle.usage.events.DLT (dead letter topic)
   → alert fires → human investigates
   → no silent data loss

4. IDEMPOTENT CONSUMERS
   At-least-once delivery + dedup by eventId
   → duplicate delivery safe to retry
   (same pattern: Goldman patching, DIME DQ — thread across career)
```

---

## Career Through-Lines

### Idempotency Recurs Everywhere

```
Oracle billing:       dedup by eventId → no double-counting
Goldman patching:     Ansible state: latest → retry-safe patches
DIME DQ:              reconcile loop → safe to re-run
NetApp (Temporal):    workflow IDs → exactly-once workflow execution

"Idempotency is the pattern that makes distributed systems reliable.
 I've applied it across every role — billing, infrastructure,
 data quality, workflow orchestration. The context changes;
 the pattern doesn't."
```

### Billing/Metering Expertise

```
Oracle (2019-2021):   built usage-cost metering pipeline for OCI SaaS
Microsoft (2022+):    worked on Commerce Cloud billing/analytics

Genuine specialization to claim:
  "High-scale billing and metering is something I've worked on
   across two companies — Oracle building the usage ingestion
   and cost calculation pipeline for OCI SaaS, and Microsoft
   on Commerce Cloud's analytics and data quality for billing
   data. I understand both the technical and business
   accuracy requirements that make billing different from
   other domains — errors are revenue, not just bugs."
```

### Kafka → Pub/Sub Design Pattern

```
Oracle:     Kafka for usage event ingestion at scale
Goldman:    Event Hub (Kafka-compatible) for pipeline completion events
DIME:       Event Hub pub/sub between Synapse and DIME DQ cluster

"My event-driven design experience started at Oracle with
 Kafka for high-scale metering. I've applied the same
 pub/sub patterns at Goldman with Event Hub for patch
 orchestration and at Microsoft for the DIME DQ pipeline."
```

---

## STAR Story

### Full Version (~60 seconds)

> "At Oracle I worked on the cloud billing and metering pipeline for Oracle Cloud SaaS. The core challenge was accuracy at scale — millions of usage events per day across thousands of enterprise customers, where a double-counted event means overcharging a customer and an undercount means revenue loss.
>
> I built Spring Boot consumers that ingested usage events from partitioned Kafka topics — partitioned by customerId so all events for a customer landed on the same consumer for ordering guarantees. The critical piece was idempotent processing: every event had a unique ID, and before processing we'd insert into a processed_events dedup table in the same transaction as the cost update. Duplicate events — which happen with at-least-once Kafka delivery — hit a PK violation on insert and got skipped cleanly. Nightly reconciliation jobs compared computed daily costs against source usage logs to catch any discrepancies from late-arriving events.
>
> I also built the test automation layer — integration tests with embedded Kafka that replaced 100 to 200 hours of manual QA cycles per year."

### 30-Second Version

> "I built the usage-cost metering pipeline at Oracle — Spring Boot consumers ingesting from partitioned Kafka topics, idempotent dedup by eventId to prevent double-billing, daily cost aggregation per customer with pricing applied, and nightly reconciliation to catch late events. Also built the integration test suite that replaced 100-200 hours of manual QA."

### Honesty Anchor

> "Early-career role — I owned specific services within the billing pipeline, the test automation layer, and contributed to the reconciliation design. The broader billing architecture was a team effort."

---

## Cheat Sheet for Follow-up Questions

| Question | Answer |
|---|---|
| "How did you avoid double-counting?" | "Idempotent consumers — dedup by eventId in a processed_events table, inserted in the same DB transaction as the cost update. PK violation on duplicate = skip cleanly." |
| "How did you handle scale?" | "Kafka partitioned by customerId — N partitions, N consumers in a consumer group, each handling a subset of customers. Scale out by adding partitions and consumer instances." |
| "What about late or out-of-order events?" | "Grace period before finalizing a daily window, plus nightly reconciliation jobs comparing pipeline output against source logs — late events become adjustment entries." |
| "Exactly-once or at-least-once?" | "At-least-once delivery with idempotent consumers — effectively-once semantics without the overhead of Kafka transactions. Honest version is still strong." |
| "What is a consumer group?" | "A named group of consumers sharing a topic. Kafka assigns each partition to exactly one consumer in the group — enables parallel processing and fault tolerance." |
| "What is Liquibase?" | "Versioned DB schema migrations as code — changesets committed to git, applied automatically on startup, with rollback defined alongside forward migration." |
| "What did you actually own?" | "The usage ingestion consumer, deduplication logic, and the integration test automation layer. Reconciliation design was collaborative with the team." |
| "What's the difference from a message queue?" | "Kafka is a durable log — events persist after consumption, can be replayed, multiple consumer groups read independently. A queue deletes after consumption." |
| "How does partitioning help ordering?" | "All events for a customer hash to the same partition, processed by the same consumer — ordering within a customer preserved. Cross-customer ordering not needed for billing." |
| "How did you test billing accuracy?" | "Integration tests with embedded Kafka and Liquibase-migrated in-memory DB — produce known events, assert exact cost values in DB. Deterministic, repeatable, automated." |
