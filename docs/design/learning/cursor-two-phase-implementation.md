# Two-phase Cursor prompts (minimum diff)

Use this when a design doc exists and you want Cursor to **think before coding** — not implement every section literally.

Copy the template below into chat. Fill in the `[brackets]`. Send **Phase 1 only** first; send Phase 2 in a **new message** after you agree with the answer.

---

## Fill-in template (copy/paste)

```text
Context:
- Active design doc: docs/design/[NAME].md
- Supersedes (if any): docs/design/[OLD].md — do not implement superseded sections
- Prerequisites already merged: [e.g. mesh allow-list #274]
- Explicitly NOT this PR: [e.g. mesh DENY #320, helm, SA-token removal #249]

Canonical rule (one sentence):
[e.g. email in JWT → user scope; no email → next(), mesh is the service gate]

---

Phase 1 (this message only — NO code, NO commits):
Read docs/design/[NAME].md and answer:

1. Minimum implementation — what is the smallest correct diff?
2. What should we DELETE from the old approach (files, flags, policy keys, URL twins)?
3. What breaks if we defer [DEFERRED ITEM] to a follow-up PR?
4. Exact files to touch in Phase 2 (list paths).
5. Tests to run in Phase 2.
6. Anything in the doc that conflicts with the canonical rule above — which wins?

Stop after answering. Do not edit files.

---

Phase 2 (send only after I reply "go"):
Implement docs/design/[NAME].md — approved slice only.

In scope:
- Files: [path1, path2, ...]
- Tests: [command or test files]

Out of scope (do not touch):
- [helm / other services / rename GLOBAL_RULES / ...]
- No new policy key names unless listed here: [...]
- No /internal URL twins unless I explicitly asked

Stop when tests pass. If diff exceeds ~300 lines, pause and explain.
```

---

## How a normal human produces this (5 minutes)

You do not need to write a perfect design doc first. You need **five decisions** before asking Cursor to code.

### 1. Pick one active doc

| Write this | Example |
|------------|---------|
| Path to the **only** spec Cursor should implement | `simplified-guard-mesh-first.md` |
| What is **historical** (do not implement) | `single-guard-mesh-identity.md` § service lane |

If two docs disagree, say which wins in **Context**. Otherwise Cursor implements the longer or older one.

### 2. State what is already true in the cluster/repo

| Write this | Why |
|------------|-----|
| Merged prerequisites | "#274 merged → mesh allow-list is real" |
| Not this PR | "#320 DENY later" — stops Cursor from adding compensating app logic now |

This is the line that would have saved the `internalAllowed` / `POL.service` expansion.

### 3. Write the canonical rule in one sentence

If you cannot say it in one sentence, you are not ready for Phase 2.

- Good: "Email → scope check; no email → pass through; mesh gates services."
- Bad: "Implement the guard design in section 5."

### 4. List non-goals (as important as goals)

Copy from your postmortem:

- No `/internal` twins  
- No `*Dual` / `internalAllowed`  
- No helm in this PR  
- No "complete" or "full coverage" in the same PR as the core shape change  

### 5. Split the conversation into two messages

| Message | You send | Cursor should |
|---------|----------|---------------|
| 1 | Phase 1 block only | Answer in prose, **no files** |
| 2 | "go" + Phase 2 block | Code only the listed files |

**Never** put "review the doc and implement it" in one message for auth/security work.

---

## Example (filled — guard PR #318 style)

```text
Context:
- Active design doc: docs/design/simplified-guard-mesh-first.md
- Supersedes: single-guard-mesh-identity.md service lane / internalAllowed
- Prerequisites merged: mesh allow-list #274
- NOT this PR: mesh DENY (#320), PR #249 SA removal, helm

Canonical rule:
JWT with email → user scope; no email → next(); mesh allow-list gates services.

Phase 1 (NO code):
Read simplified-guard-mesh-first.md. Minimum impl? What to delete?
Risks if DENY deferred? Files + tests for Phase 2? Doc conflicts?

Phase 2 (after "go"):
Files: unifiedGuard.ts, guard.go, guard_policy.go, both guard test files.
No helm. No *Dual keys. No new /internal routes. Stop at test green.
```

---

## Example (filled — generic feature, not auth)

```text
Context:
- Active design doc: docs/design/widget-export.md
- Prerequisites: API v2 already shipped
- NOT this PR: UI polish, migration script

Canonical rule:
Export is async job + poll; no synchronous large payloads.

Phase 1 (NO code):
Minimum impl? Delete old sync export path? Files + tests?

Phase 2 (after "go"):
Files: src/nemo/config-service/routes/exportRoutes.ts, ExportService.ts, one test file.
No frontend. No helm. Max 2 new env vars.
```

---

## Red flags — stop Cursor if it does this

| Cursor behavior | You say |
|-----------------|---------|
| Starts editing in Phase 1 | "Stop. Phase 1 is questions only." |
| Adds policy keys / URL twins you did not list | "Out of scope. Revert. Minimum diff only." |
| "Defense in depth" → more app layers | "Mesh owns that. Name the follow-up PR or drop it." |
| Implements whole doc | "Approved slice only: [files]." |
| >300 lines for one decision | "Pause. Explain why it cannot be smaller." |

---

## Optional: proposed Cursor project rule (review)

A draft Cursor rule for guard work lives next to this doc:

- [`proposed-cursor-rule-auth-guard-challenge-first.mdc`](./proposed-cursor-rule-auth-guard-challenge-first.mdc)

**Status:** proposal only — not installed in the repo (`.cursor/` is gitignored).

**After approval:** copy that file to `.cursor/rules/auth-guard-challenge-first.mdc` in a small follow-up commit (or a separate tooling PR).

See [Cursor rules docs](https://cursor.com/docs/rules) for how rules activate (`alwaysApply`, `globs`, or `@` Rules in chat).

---

## One-line habit

**Doc + constraints in message 1 → agree minimum → `go` + file list in message 2.**

That is the difference between "implement the design" (maximum diff) and "implement the decision" (minimum diff).
