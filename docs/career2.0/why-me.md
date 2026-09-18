# Why Leave NetApp / Why Adobe — Interview Script

**Context:** Adobe, Unified Platform team (Engineering Manager round).
The team builds **agent and compute infrastructure** natively for Adobe's own products — custom scheduler, queue-based coordination, self-hosted models (e.g. Firefly). The EM's background also covers **Blob Store** (100PB, dedup/GC/encryption/virus-scan) and the **Hierarchy Service** (Adobe Content Platform).

**Why this matters:** because their work is *similar* to mine, the story must be **continuity, not escape**.

---

## 0. The opening intro (deliver first)

**Positioning:** a **platform infrastructure engineer who currently builds for AI workloads** — *not* "an AI engineer." Their team owns scheduling, capacity, and multi-tenancy; speak their vocabulary.

### ~60-second version

> "I'm Mrinal — senior software engineer, about eight years, mostly backend and distributed systems, with Java as my core.
>
> Right now I'm at NetApp on a greenfield enterprise agent platform, where I own the platform infrastructure layer. Concretely: a Temporal-based orchestration system running around 10,000 long-running workloads a day across three task queues, dynamic Kubernetes provisioning for ephemeral compute, autoscaling driven off queue backlog rather than CPU, and the zero-trust security model across a 15-service mesh — mTLS with workload identities and per-project RBAC. I also built the ingestion and retrieval pipeline that shards document sets into a couple of thousand parallel work units.
>
> Before that I was four years at Microsoft in Commerce Cloud, building large-scale data and telemetry platforms. The piece I'm proudest of is a Service Fabric API layer that translated T-SQL to SparkSQL and took about $1.6M a year out of our Azure spend. Prior to that, Goldman Sachs and Oracle — reliability engineering and cloud backend work.
>
> The through-line is platform infrastructure: scheduling, orchestration, multi-tenancy, and the operational side of running it. That's why this team interested me — you build that layer for Adobe's own products, at real scale."

### ~30-second version (if he says "briefly")

> "Mrinal — eight years, backend and distributed systems, Java core. Currently at NetApp building the platform layer for an enterprise agent product: Temporal orchestration running about 10,000 workloads a day, dynamic Kubernetes provisioning, queue-backlog-driven autoscaling, and the zero-trust model across a 15-service mesh. Before that, four years at Microsoft in Commerce Cloud on large-scale data and telemetry platforms — including an API layer that saved roughly $1.6M a year in Azure spend. The through-line is platform infrastructure: scheduling, orchestration, multi-tenancy, and running it in production."

### Delivery rules

1. **Lead with "backend and distributed systems," never "AI."** The AI part is the *workload*; the layer I own is infrastructure. Framing myself as an AI engineer makes me a domain switcher instead of a direct fit.
2. **Don't list frameworks.** No LangGraph / LlamaIndex / Semantic Kernel name-dropping — it reads as tool tourism. Name systems and numbers instead.
3. **One number per claim, and only numbers I can defend.** 10,000 workloads/day, 2,000 parallel units, 15 services, $1.6M, 60% idle reduction.
4. **End on the bridge to their team**, then **stop talking.** The bridge invites his next question; filling silence is what caused the rambling last round.
5. **Four years at Microsoft is load-bearing** — it is the anti-job-hopper evidence. Always say the number.

### Resume fix

Microsoft currently reads **"June 2022 - Present"** while NetApp reads **"March 2026 - Present"** — both can't be Present. Change Microsoft to **June 2022 – March 2026**. Overlapping dates read as careless at best.

---

## 1. The core strategic principle

> **"I'm not changing direction — I'm doubling down on the same direction, in an environment where it can actually compound."**

This does three jobs simultaneously:

1. Kills the short-tenure objection (deepening, not flip-flopping)
2. Makes me a **fast-ramp hire**, not a domain switcher
3. Turns the NetApp constraint into the reason *this specific team* is the fix

---

## 2. Post-mortem of the first attempt (what went wrong)

Grade of the original answer: **~5/10.** The idea was good, the delivery worked against me.

### What worked
The central argument was genuinely sophisticated and true: shipping into a customer's **air-gapped tenant destroys the engineering feedback loop**. Can't see production data or real failure modes — only thin logs. For a quality-driven agent/RAG system, that structurally limits iteration speed. It's a systems-level reason, not a complaint about people or pay.

### What hurt — ranked

| # | Problem | Why it cost me |
|---|---|---|
| 1 | **Raised short tenure, never resolved it** | EM instantly thinks *"will he leave us in 6 months too?"* I surfaced the objection and walked past it — while having a perfect defence unused (**4 years at Microsoft** right before) |
| 2 | "The infra needed for AI systems, I already know" | Reads as *bored easily* or *overestimates himself*. **Fatal** when the target team does similar work — implies I'd be bored at Adobe too |
| 3 | "Unclear what this project will do at scale" | Reads as *leaves when outcomes are uncertain*. Adobe has uncertainty too — this pre-announces my exit |
| 4 | Opened with a non-reason, then retracted it | Led with "we move fast, lots of competitors," then said "that's not the reason." Retracted complaints still register. Residue: *pace is a problem for him* |
| 5 | ~90% push, ~10% pull | Almost entirely what's wrong at NetApp, nearly nothing about Adobe specifically — and I later admitted I wasn't clear what the team does |

---

## 3. Framing rules for the "consolidation" reason

The organizational consolidation is the **strongest card** — it converts "why leave after 6 months?" into an **externally caused, entirely reasonable** trigger. But framed wrong it becomes three red flags at once.

| Do say | Don't say | Why |
|---|---|---|
| "There's been organizational consolidation" (say it **once**) | "There are many reorgs happening" | Adobe reorgs too. Pattern-complaining ⇒ *"he'll leave when we reorg"* |
| "Our platform is being folded into a broader internal effort" | "Our project got cancelled / isn't launching" | "Cancelled" invites *was he on a failing team? is he being pushed out?* |
| "The company is removing duplicate effort" | "The AID team has a better KB, ours may be fully gone" | Naming a rival team sounds like sour grapes **and leaks internal roadmap** |
| "That's a reasonable call for the company" | Bitterness / victim framing | I want *"the role changed under me,"* not *"I got beaten"* |

**Critical:** never name the other team, the product decision, or launch timing. Discretion about a current employer is itself being evaluated — he's silently asking *"will he talk about our internals in his next interview?"*

---

## 4. THE SCRIPT (~60 seconds)

> "I've had a good run at NetApp. I own the security architecture and the ingestion platform for a greenfield agent product — Temporal-based orchestration, dynamic Kubernetes workload provisioning, an LLM gateway with provider failover, MCP tool provisioning. That's the layer I want to keep building; it's not what I'm moving away from.
>
> What changed is the direction. There's been organizational consolidation, and our platform is being folded into a broader internal effort rather than launching the way it was originally scoped. That's a reasonable call for the company, but it does mean the charter I joined for is changing shape — so this felt like the honest moment to think about where I go deepest next.
>
> The other thing building it taught me is about feedback loops. Our platform ships into the customer's own cloud tenant — their data never leaves, which is the entire value proposition. But the engineering consequence is that the platform can't learn from its own usage: we see limited logs, not real production behaviour or failure modes. For agent infrastructure — where scheduling, retrieval quality, and failure handling all improve by observing real workloads — that's a hard ceiling.
>
> Your team is the inverse: building agent and compute infrastructure natively for Adobe's own products, on your own scheduler, at a scale where those problems are real. Same layer I've been building, but with first-party scale and a genuine feedback loop.
>
> And on tenure, I'll be direct — I joined NetApp recently and it isn't a pattern; I was four years at Microsoft before this. The trigger was the direction changing, not restlessness. I want to go deep on this problem space somewhere for the long term."

### Compact version (~30 seconds, if cut off)

> "Two things. The direction changed — there's been organizational consolidation and our platform is being folded into a broader internal effort, so the charter I joined for is changing shape. And building it clarified what I want next: to go deep on one layer of platform infrastructure and make it excellent at scale, with a real feedback loop. Today we ship into customer-owned tenants — their data never leaves, which is the whole value proposition — but the engineering consequence is the platform can't observe its own production workloads, so there's a ceiling on how good you can make it. Your team builds the same layer natively for Adobe's products, on your own scheduler, at real scale. Same work, no ceiling. On tenure — four years at Microsoft before this; the trigger was external, not restlessness."

---

## 4b. "Why do you want to join Adobe?" — the standalone answer

**This is a different question from "why are you leaving."** It is **purely affirmative** — no push factors, no mention of NetApp. Answering it with "NetApp has a ceiling" answers the wrong question and loses the room.

### Order: team → company → personal

| Order | Why |
|---|---|
| **Team/role first** | He's hiring for *his* team. Leading with Adobe's AI strategy makes me sound like I want to work on Firefly, not his platform |
| **Company second** | Frames the infra as **load-bearing for Adobe's strategy** — a strategic asset, not a cost centre. Reinforces the role rather than competing with it |
| **Personal last** | Short. Signals commitment without being the main argument |

### The answer (~45s)

> "Three things, in the order they matter to me.
>
> First, the team. You're building agent and compute infrastructure natively for Adobe's own products — your own scheduler, queue-based coordination, at a scale where those problems are actually real. That's the exact layer I've been building: durable orchestration, dynamic Kubernetes workload provisioning, autoscaling driven off queue depth, multi-tenancy. The difference is you run the platform yourself for first-party workloads, so the load concentrates in one system and you can observe and improve it. The fact that you built your own scheduler is the tell — nobody does that unless the default has genuinely failed, which means the interesting problems are live here.
>
> Second, the work is consequential here in a way it isn't most places. You're not operating a platform that supports someone else's model — the compute platform underpins Adobe's own models and products, with data Adobe controls and distribution to millions of users. That makes the infrastructure a strategic asset rather than a cost centre, and it means the feedback loop can actually reach the thing being served.
>
> Third, personally — I want to go deep on one layer and own it long-term rather than keep adding surface area. This is that layer."

### Compact version (~20s)

> "The team builds the exact layer I've been working on — scheduling, orchestration, multi-tenancy for agent and compute workloads — but for Adobe's own products, at a scale where the hard problems are real and you can actually observe and improve the system. The fact you built your own scheduler tells me the default stopped being good enough, which is the work I want to be doing. And it's infrastructure that underpins Adobe's own models and products rather than supporting someone else's."

### Don't say

| Phrase | Why |
|---|---|
| "I've always wanted to work at Adobe" | Warmth, not substance. Never the reason |
| Anything about NetApp | This question is purely affirmative; push factors belong in §4 |
| "You have Firefly / great AI products" | Sounds like I want the ML team, not his |
| "Adobe is a great brand / great culture" | Generic — says nothing about why *this* team |
| "For the scale" (alone) | Every big company has scale. Name *which* problems the scale creates |

### Prepare the natural follow-up

**"What specifically do you know about what we do?"** — this matters because in the earlier round I admitted the recruiter hadn't made the team clear.

> "As I understand it, you own the compute and agent platform for Adobe's own products — a custom scheduler rather than off-the-shelf, queue-based coordination, serving self-hosted models like Firefly, and deliberately native to Adobe's infrastructure rather than built on a hyperscaler. I'd like to understand more about where the scheduler boundaries are — what you handle versus what the workloads handle."

Ending on a question converts "why us" into a technical conversation, which is the stronger ground.

---

## 5. Why I left Microsoft — keeping both stories consistent

### The trap to avoid

The naive answer — *"I wanted to work on AI and couldn't get that opportunity at Microsoft"* — sets up an arc that undercuts the NetApp story:

```
Microsoft (4 yrs) ──leaves──► "I wanted AI work"
NetApp (6 months) ──gets AI work──► leaves anyway
Adobe ──► ???
```

His immediate inference: **"He chased AI to NetApp, got it, left in six months. What does he chase out of here?"**

The two "why I left" stories must **reinforce** each other. Phrased naively they undercut each other.

### Two smaller problems with the naive version

1. **"Microsoft didn't have AI opportunities"** is factually weak — Microsoft is one of the largest AI companies on earth. Be **org-specific**: I was in **Commerce Cloud**, a data/billing platform org, not an AI org.
2. **"I wasn't able to get that opportunity"** is passive — sounds like something was withheld. Make it a decision I made, not a door that closed.

### The reframe: one trajectory, not three escapes

Position all three moves as steps in a **single direction** — toward large-scale platform infrastructure — with Adobe as the **destination**, not the next waypoint.

> "I was at Microsoft four years, in Commerce Cloud — telemetry, data quality, and large-scale data platform services. That's where my distributed systems grounding comes from, and I'm proud of the work; the T-SQL-to-SparkSQL API layer alone took about $1.6M a year out of our Azure spend.
>
> I moved because I wanted to build AI platform infrastructure end to end — the orchestration, gateway, and multi-tenancy layer, not just consume models. Within my org that would have meant a long internal transfer; NetApp was building one from scratch, which was the fastest path to real depth. And I got that — I own the ingestion platform and the security architecture.
>
> So the through-line is consistent: I've been deliberately moving toward large-scale platform infrastructure for AI workloads. This role is the continuation of that — same layer, at a scale that a customer-tenant deployment model can't reach."

**The four years does real work here** — it's the strongest evidence against job-hopping. Lead with it.

### The follow-up he will absolutely ask

**"You left Microsoft for AI, got it at NetApp, and you're leaving in six months. Why is Adobe different?"**

> "Fair question. The Microsoft move was about getting *into* this domain — and it worked; I got exactly the depth I wanted. This move isn't about the domain at all, it's the same domain. It's about the ceiling: the deployment model means the platform can't observe its own production, and the charter consolidated. Here the domain is the same and that ceiling doesn't exist — so there's nothing left for me to go looking for. That's why this is somewhere I'd stay."

> **"There's nothing left for me to go looking for"** is the line that closes it. It directly answers the unspoken fear.

### Don't say

| Phrase | Why |
|---|---|
| "Microsoft didn't have AI opportunities" | Factually weak — say *my org*, Commerce Cloud |
| "I wasn't able to get that opportunity" | Passive / blame-shifting — make it my decision |
| "I wanted to work on AI" *as the whole reason* | Too thin for four years, and it's the phrasing that sets the trap |

---

## 6. Make the overlap concrete

Because the work is similar, **name the mapping** — it converts "why you" into "he contributes on day one."

| What they do | What I've built |
|---|---|
| Custom scheduler for compute workloads | Dynamic K8s pod provisioning — 100+ ephemeral workloads/day via the K8s API, with secret materialization and NetworkPolicy enforcement |
| Queue-based coordination | HPA driven by **Temporal queue backlog** as a custom Prometheus metric, 1–5 replicas, sub-minute response |
| Orchestration at scale | 10,000+ long-running workloads/day across 3 task queues at 99.9%, scatter-gather into 2,000 parallel units |
| Serving self-hosted + external models | Unified LLM gateway across Azure OpenAI, Bedrock, Anthropic with failover |
| Agent tooling | MCP tool provisioning and standardized external tool execution |

---

## 7. "First-party scale" — the detailed argument

Used in the script. **Never use a term in an interview you can't define in one sentence** — so know this cold, or swap in the plain-English version below.

### Definition

**First-party** = your own company's products and users, as opposed to **third-party** (someone else's environment). So *first-party scale* = the platform serves **Adobe's own products** (Firefly, Photoshop, Creative Cloud, Express, Acrobat) on infrastructure **Adobe owns and operates**.

| | NetApp / AgentStudio (third-party, BYOC) | Adobe Unified Platform (first-party) |
|---|---|---|
| Who runs it | The **customer**, in their own tenant | **Adobe**, on Adobe's infra |
| Where the load is | Fragmented across N separate deployments | Aggregated in **one** platform |
| Can you observe it? | No — limited logs only | Yes — full instrumentation |
| Can you iterate on it? | No feedback loop | Ship → measure → improve |

Both halves of the script connect here: **first-party scale is what *creates* the feedback loop.** Because Adobe runs the platform itself, load concentrates in one system *and* you can watch it.

> ⚠️ **Ambiguity at Adobe:** "first-party" also means **first-party data** (Firefly trained on licensed Adobe Stock). Disambiguate by saying **"first-party workloads"** or "you run the platform for your own products."

### The core principle

> **The deployment model determines which engineering problems you're allowed to encounter.** Split into many small isolated installs, the hard problems never materialize — each install is individually small. Carry everything in one platform and real constraints bind.

### 1. Scheduling only gets hard when resources are scarce and contended

- **Isolated install:** a handful of workloads, ample headroom. Default Kubernetes scheduler is fine. You'd never write a custom scheduler — no pressure to.
- **Aggregate:** heterogeneous workloads — GPU training, low-latency inference, agent tasks, batch — competing for scarce accelerators. Forces you to solve:
  - **Bin-packing / fragmentation** — 40% free capacity and still unable to place a job
  - **Priority and preemption** — whose job dies when capacity runs out?
  - **Gang scheduling** — distributed training needs N GPUs *simultaneously or not at all*
  - **Fair-share and quota** so one product can't starve another
  - **Queue / backlog management** when demand exceeds supply

**Proof point:** he confirmed they **built their own scheduler**. Nobody does that for fun — you do it when the default demonstrably fails. Direct evidence these problems materialized.

### 2. Capacity economics invert

- **Isolated installs:** each provisioned for *its own peak*. Aggregate waste is enormous but invisible. Capacity is **stranded** per install and unreclaimable.
- **Aggregate:** pool capacity and exploit **statistical multiplexing** — different products peak at different times, so pooled capacity ≪ sum of individual peaks. The largest cost lever in the system.

Once pooled, utilization becomes a first-class metric: idle GPU-hours, oversubscription, burst absorption, spot/preemptible. **None of this is even expressible in a fragmented model.**

### 3. Multi-tenancy becomes real instead of trivial

- **Isolated installs:** one tenant per install — isolation is *physical*, therefore free. You don't engineer it.
- **Aggregate:** logical isolation, which is genuinely hard:
  - **Noisy neighbours** — batch must not starve interactive inference
  - **Quota enforcement**, weighted fair queuing
  - **Blast radius** — one pathological job must not destabilize the platform
  - **Security isolation** between tenants sharing hardware
  - **Cost attribution / chargeback** per tenant

My project-scoped isolation and quota work bridges here — but at one-tenant-per-install the *hard* version never arises.

### 4. Failure modes need volume to become visible

Tail latency, thundering herds, correlated failures, cold-start effects, the long tail of pathological workloads — **statistical phenomena**. At low volume there aren't enough samples to see them. p99 is meaningless at a hundred requests/day and existential at a billion.

### 5. The killer example — and it's *his* domain

**Deduplication gets better as scale grows.** Fragmented, you dedup only *within* each deployment. Consolidated, you dedup across the whole corpus — dramatically higher ratio. Same for GC efficiency and tiering.

Cleanest illustration of the principle: **scale doesn't just make problems harder, it creates capabilities that are impossible when fragmented.** His Blob Store runs dedup at 100PB — that ratio cannot exist in a fragmented model. Using this shows I've thought about *his* systems.

### How to say it out loud

> "The deployment model decides which problems you get to solve. When you ship into many isolated customer tenants, each install is small — capacity is stranded per install, multi-tenancy is trivial because it's one tenant per deployment, and the default scheduler is always good enough. The hard problems never show up.
>
> When one platform carries all of Adobe's products, they all bind at once: bin-packing and preemption on scarce accelerators, pooled capacity and statistical multiplexing, real noisy-neighbour and fair-share problems, and failure modes you only see at volume. The fact that you built your own scheduler is the tell — nobody does that unless the default has genuinely failed.
>
> And some capabilities only exist at aggregate scale at all. Dedup is the clearest case: fragmented, you can only dedup within each install; consolidated, you dedup across the whole corpus. That's not a harder version of the same problem, it's a different problem — and it's the kind I want to work on."

### Plain-English substitute (safer, zero risk)

Swap this line in the script:

> ~~"but with first-party scale and a genuine feedback loop"~~
> **"but where you run the platform yourself for your own products — so the scale is real and you can actually see and improve it."**

### Two cautions

1. **Don't imply my current work is trivial.** Frame as *the model constrains the problem set*, not *my job is easy*. Say "each deployment is individually small **by design** — the correct trade for the product promise."
2. **Prepare the counter-punch.** He will likely ask **"What scale problems have you actually hit?"** Concede the limit honestly:

> "At my scale the real ones were backlog-driven autoscaling — I drove HPA off Temporal queue depth as a custom Prometheus metric rather than CPU, because CPU is a lagging indicator for queue-backed work — and fan-out coordination, sharding ingestion into a couple of thousand parallel units with retry and idempotency. The right *shape* of problem at a smaller magnitude. I haven't operated at GPU-scarcity-and-preemption scale, and that's precisely the gap I want to close."

Credible because it concedes the limit while proving I understand the class of problem. Claiming I've already solved Adobe-scale problems is the fastest way to lose him.

---

## 8. Reserve bank — deploy ONLY when probed

Keep these **out** of the opening answer. Held in reserve, they land as substance; volunteered, they land as grievance.

**"What does the consolidation mean concretely?"**
> "The knowledge-base ingestion pipeline I built is being consolidated into another internal implementation — the company is removing duplicate effort across teams, which is a reasonable call. It does mean a significant piece of what I owned moves elsewhere."

**"What are you actually working on day to day?"**
> "Increasingly security hardening across the service mesh — mTLS with workload identities, authorization policies, per-project RBAC. Valuable work, and I'm glad I own it. But I want security to be one dimension of the platform I build, not the entirety of my scope. I want to be on the core compute, scheduling, and orchestration path."

> ⚠️ Don't disown security — my resume leads with the zero-trust architecture, and multi-tenant isolation matters for platform work. Frame it as **scope, not distaste**: "not *only* security."

**"Is your role at risk? Are you being laid off?"**
> "No. My role is secure and the work continues in a different form. This is my choice about where I go deep next, not a forced move."

> Answer this **instantly and flatly**. Any hesitation confirms the worst reading.

---

## 9. Follow-up landmines

**"We have uncertainty too. Why wouldn't you leave us in six months?"**
> "The difference isn't certainty, it's ceiling. At NetApp the limit is structural — the deployment model means the platform can't see its own production. That doesn't get fixed by waiting. Here the constraint doesn't exist, so effort compounds. That's a reason to stay, not leave."

**"Why not just push to improve telemetry at NetApp?"**
> "We are — I built the observability standards across 15 services and the OTLP pipeline. But you can't telemetry your way out of an air-gapped tenant; the customer owns the boundary, and that's the product promise, correctly so. It's a deliberate trade and I respect it. It's just not the environment I want to build platforms in."

**"Couldn't you just move to the other internal team?"**
> "Fair option, and I considered it. But it doesn't change the deployment model — the same customer-tenant constraint and feedback-loop ceiling apply company-wide, because that's the product strategy. What I want is first-party platform scale, and that's a different company, not a different team."

**"So you leave when a project gets deprioritized?"**
> "It's less the setback and more the charter. I joined specifically to build agent platform infrastructure end to end. When that consolidates into someone else's stack, the scope I signed up for narrows. I'd rather go somewhere that owns this layer outright and commit long-term than stay for a smaller version of the role."

---

## 10. Never say

| Phrase | Why it's disqualifying |
|---|---|
| "The infra needed for AI systems, I already know" | Arrogant / easily bored — **doubly fatal** when their work is similar |
| "It's unclear what this project will do at scale" | *Leaves when outcomes are uncertain* |
| "We ship too fast, quality is getting compromised" | Criticizes my own team's standards **and** implies I can't operate at pace. Everyone in AI infra ships fast. **Already tried this once and it landed badly** |
| "We're increasing breadth, not depth" (as a complaint) | Reframe as aspiration: *"I want to go deep on one layer and make it excellent at scale"* |
| "There are many reorgs happening" | Pattern-complaint ⇒ he'll leave us too |
| "I always wanted to be part of Adobe" | Fine as warmth, useless as substance. Never the *reason* |
| "I want to make the right decision at this point of time" | Vague — sounds like shopping offers |
| Framing BYOC as a **mistake** | Call it a deliberate, correct trade-off with an engineering cost. Criticizing the employer's strategy reads worse than describing a constraint neutrally |

---

## 11. Delivery discipline

1. **Order matters.** Positive + continuity → consolidation → forward-looking want → Adobe-specific → tenure. Opening with the reorg makes the whole answer read as a complaint.
2. **Give two reasons, then stop.** Stacking consolidation + security drift + pace + feedback loop stops sounding like a considered decision and starts sounding like a list of grievances. Let him pull the rest out.
3. **Answer in two levels.** 2–3 sentences, then pause. Let him ask for depth.
4. **Kill the tenure objection proactively** — don't wait to be asked. *Four years at Microsoft* is the whole defence.

### Adjacent risk: relocation / notice period

In the first round I hedged repeatedly — "I'll need time," "moving with family," "I'll check if it's negotiable," "I've seen people do it in one or two weeks." Individually fine; stacked next to a six-month tenure it compounds into **low certainty**.

Give one confident answer and stop:
> "I can relocate to Noida. My notice is X; I'll work to compress it and manage the family move in parallel."

### Also

Don't say "the recruiter wasn't clear what this team does." Reframe as homework:
> "I understand the team owns X — I'd love your view on where it's heading."
