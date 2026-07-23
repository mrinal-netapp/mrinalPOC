# Description

Please include a summary of the changes and the related issue. Please also include relevant motivation and context. List any dependencies that are required for this change.

Fixes # (issue)

## Type of change

Please tick the options that are relevant.
- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] This change requires a documentation update

## Focus Areas

Call out the parts of the diff that need the most reviewer attention. Point to specific files, functions, or line ranges. Write "Nothing in particular" for a straightforward change.

- `src/foo/bar.py::handle_request` — new retry loop; please verify the backoff and cancellation behavior.
- `deployments/helm/…/values.yaml` — defaults changed; check the upgrade path.

# How Has This Been Tested?

Please describe the tests that you ran to verify your changes. Provide instructions so we can reproduce. Please also list any relevant details for your test configuration.

- [ ] Test A
- [ ] Test B

**Test Configuration**:
* Component / service:
* Environment (local kind / dev cluster / staging / …):
* Make targets run (e.g. `make test`, `make lint`):
* Manual steps (if any):

# Risk Classification

Tick every box that applies. Any box ticked means this PR requires L3 review **and** a linked design doc (see the next section). If nothing applies, leave the boxes empty.

- [ ] New service, new major feature, or new interaction model (auth, transport, data flow, public API surface)
- [ ] Affects security (authn/authz, crypto, secrets, network policy, multi-tenant isolation, RBAC)
- [ ] Affects scalability (hot paths, queues, caches, fan-out, resource limits, autoscaling, storage growth)
- [ ] Affects correctness (storage layout, migrations, schema, consistency model, data integrity, durability)

To declare risk, comment `/requires-l3 <reason>`. Reviewers may also add labels post-hoc; the gate re-evaluates automatically.

# Linked Design Documents

Please link the design doc(s), ADR(s), or spec(s) this PR implements or alters. Auto-satisfied if this PR touches `docs/design/**`. **Required** when any Risk Classification box above is ticked. If there's no design footprint, write `N/A — <one-line reason>`.

- docs/design/foo.md
- docs/design/adr-bar.md
- Confluence: https://…
- Figma: https://…
