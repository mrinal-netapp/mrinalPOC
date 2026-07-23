# Behavioural / Motivation — Interview Answers

Prepared talking points for behavioural and "why this role" questions. Say them naturally; don't recite.

---

## "Why do you want to leave NetApp / why Adobe?"

### Main version (~60–80 seconds)

> "For the last two years I've been building AgentStudio — NetApp's Kubernetes-native platform for running AI agents over private enterprise data. I owned three core pieces of the infrastructure: the MCP runtime that dynamically provisions containerized tool servers on Kubernetes on demand; the credential pipeline that materializes enterprise credentials into scoped Kubernetes secrets; and the knowledge-base ingestion pipeline — chunking, embedding, and writing vectors at scale on Temporal workflows.
>
> I've learned a tremendous amount about enterprise AI infrastructure. But I've come to see a ceiling that's structural to NetApp's position in the market — it's not about the team, and not about me.
>
> AgentStudio's whole premise is data sovereignty — the customer runs it inside their own perimeter because they won't hand their data to a SaaS vendor. It's a real, valuable market. But NetApp doesn't own the intelligence: the platform routes to OpenAI, Anthropic, or a self-hosted open model. Its moat is storage and data proximity, not AI research. So any feedback loop I build can only improve the plumbing — retrieval, orchestration, governance — it can never reach the model. The product's ceiling is set by whatever the model vendors ship next.
>
> And there's a deeper irony: the sovereignty promise that *defines* the market is fundamentally at odds with a data flywheel — the data we sit closest to is exactly the data we're contractually forbidden to learn from. So NetApp structurally can't turn its position into better intelligence.
>
> Adobe is the inverse on every axis. You have Firefly — a first-party model you actually train, on data Adobe controls: Adobe Stock, openly-licensed, and public-domain content, so it's commercially safe by design. You have a platform team building the intelligence, not just routing to someone else's. You own the proprietary creative data and the distribution — Stock, Behance, Creative Cloud — and millions of creative users whose engagement you can measure and learn from directly. The feedback loop runs all the way to the model — data to model to users and back. That's the loop I want to build in."

### Compressed version (~25 seconds)

> "I've spent two years building NetApp's AgentStudio — a Kubernetes platform for running AI agents over private enterprise data, where I owned the MCP provisioning, credential, and knowledge-base ingestion systems. I've hit a structural ceiling, though: NetApp rents its intelligence — it routes to OpenAI or Anthropic — and its data-sovereignty model actually forbids using customer data to improve a model. So the feedback loop can only ever improve the plumbing. Adobe is the opposite — you own the model in Firefly, you own the training data, and you have millions of users to learn from. The loop closes at the model, and that's what I want to build in."

---

## If they push back — keep these ready

### "Couldn't NetApp just add a hosted control plane like Databricks and get that feedback?"

> "For their cloud customers, yes — and honestly they should; the platform's already instrumented with Phoenix and OpenTelemetry, so phoning home scrubbed operational metrics and running eval inside the data plane is very doable. But two things: their most differentiated customers are air-gapped and reject any hosted control plane by definition; and more importantly, telemetry only ever closes the loop on the *platform* — reliability, usage, retrieval quality. It still can't close it on the *intelligence*, because there's no first-party model to improve. That's the part a hosted control plane doesn't fix."

### "What did you actually own / go deep on?"

> "The MCP runtime drives the Kubernetes API directly — creates Deployments, Services, and service accounts on demand, materializes per-server credential secrets with checksum-based rolling so a rotated credential redeploys cleanly, and polls readiness before wiring the server into the gateway. The KB pipeline is a Temporal scatter/gather: a work-planner shards the documents, workers chunk and embed and write vectors to LanceDB, with durable retries and heartbeats so a crash mid-embedding replays from the last completed activity instead of duplicating vectors."

### If it edges toward "are you just frustrated with your job?"

> "Not at all — I'd make the same architectural calls again for that market, and I'm proud of the infra. My reason for moving is purely about where the ceiling is. I want to work where the feedback loop reaches the model, not just the plumbing."

---

## Delivery notes

- **Keep the "we're blind / no telemetry" claim out of the main pitch.** It's the one leg an interviewer can knock over with "just build a hosted control plane like Databricks." Its real essence is already folded into *"the loop can only improve the plumbing."*
- **Lead with the two unassailable points:** rented intelligence (no first-party model), and the sovereignty-vs-data-flywheel contradiction. Those survive any rebuttal.
- **Tone: analytical and respectful of NetApp.** Frame the ceiling as structural to the market position, not as a complaint about the team or the work.
- **Accuracy guardrails:** Firefly is trained on **Adobe Stock, openly-licensed, and public-domain** content — *not* on customer Creative Cloud work (a sensitive, public topic at Adobe). Frame Behance / Creative Cloud as proprietary data + user-signal assets, not training data. Avoid claiming "decades" for those specific properties. The AgentStudio ownership claims (MCP runtime, credential materialization, KB ingestion) are all verifiable in the codebase.
