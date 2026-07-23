# Progressive manifest population — critical gaps and additions

This document reviews the progressive manifest population plan (see `.cursor/plans/` or the plan "Progressive manifest population") and adds the following so implementation is complete and correct. Implement the plan **and** the items below.

---

## 1. Merge script: always include current arch (avoid registry race)

**Gap**: Relying on `imagetools inspect` to discover the **just-pushed** image can fail due to registry eventual consistency. The merge list might miss the current arch.

**Fix**: In `scripts/docker-manifest-merge.sh`:

- **Always** add `IMAGE_BASE:VERSION-CURRENT_ARCH` to the merge list first (the image we just pushed).
- **Discover** only the *other* arches: for each arch in `DOCKER_ARCHES` **except** `CURRENT_ARCH`, run `imagetools inspect` and add the tag if it exists.
- Never rely on inspect for the current arch.

---

## 2. Merge failure must fail the build

**Gap**: If the merge step fails (e.g. `imagetools create` fails), the build script should exit non-zero so CI and users see a failed build, not a half-updated registry.

**Fix**:

- In `docker-build.sh` and `docker-build-image.sh`, invoke the merge script and **check its exit code**. If non-zero, exit 1 (with `set -e` the script will already fail; ensure the merge script is not run in a subshell that swallows the exit code).
- In the merge script, use `set -e` and ensure `imagetools create` is run in the main shell so a failure propagates.

---

## 3. Invocation contract and script path

**Gap**: Plan does not specify how the build scripts call the merge script (path resolution, args vs env).

**Fix**:

- **Path**: Build scripts resolve the merge script relative to their own location, e.g. `SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"` then `"$SCRIPT_DIR/docker-manifest-merge.sh"`. Both `docker-build.sh` and `docker-build-image.sh` live in `scripts/`, so the merge script lives next to them.
- **Invocation**: Call the merge script with **positional args** for clarity and script portability:  
  `"$SCRIPT_DIR/docker-manifest-merge.sh" "$IMAGE_BASE" "$VERSION" "$CURRENT_ARCH"`  
  The merge script can also read `DOCKER_ARCHES` from the environment (default `amd64,arm64`).

---

## 4. Makefile and child Makefiles must pass new variables

**Gap**: `DOCKER_PROGRESSIVE_MANIFEST` and `DOCKER_ARCHES` must reach the build scripts. The top-level Makefile invokes `docker-build.sh` directly (bash) and invokes child Makefiles for workers/images; those children invoke `docker-build-image.sh`. Variables not passed explicitly are not visible to the scripts.

**Fix**:

- **Top-level Makefile**: In every place that runs a build, pass the new variables:
  - `docker-build` loop (line ~133): add `DOCKER_PROGRESSIVE_MANIFEST="$(DOCKER_PROGRESSIVE_MANIFEST)" DOCKER_ARCHES="$(DOCKER_ARCHES)"` to the `bash $(DOCKER_BUILD_SCRIPT)` invocation.
  - `docker-build-service` (line ~148): same.
  - `images-build` (line ~220): add `DOCKER_PROGRESSIVE_MANIFEST="$(DOCKER_PROGRESSIVE_MANIFEST)" DOCKER_ARCHES="$(DOCKER_ARCHES)"` to the `$(MAKE) -C src/images/$$img build ...` call.
  - `workers-build` (line ~250): same for `$(MAKE) -C src/nemo/workers/$$worker build ...`.
  - `image-build` (line ~282): same for the single-image build.
- **Child Makefiles** (every `src/images/*/Makefile` and `src/nemo/workers/*/Makefile` that invokes `$(BUILD_SCRIPT)`): When calling the build script, pass the new vars in the environment, e.g.:  
  `DOCKER_PLATFORMS="$(DOCKER_PLATFORMS)" DOCKER_PROGRESSIVE_MANIFEST="$(DOCKER_PROGRESSIVE_MANIFEST)" DOCKER_ARCHES="$(DOCKER_ARCHES)" $(BUILD_SCRIPT) ...`  
  so the script sees them. Child make receives them from the parent via the recursive `$(MAKE) ... DOCKER_PROGRESSIVE_MANIFEST=... DOCKER_ARCHES=...` call.

---

## 5. Registry auth and merge step

**Gap**: Merge step uses `docker buildx imagetools inspect` (pull) and `imagetools create` (push). These require the same registry auth as the build.

**Fix**: Document in `docs/docker/docker-multiarch-builds.md` that the merge step runs in the same environment as the build and requires the same registry credentials (no separate auth step). If the build could push, the merge step can push; if running in CI, ensure the job has registry login before any build.

---

## 6. docker-push when progressive manifest is enabled

**Gap**: With `DOCKER_PROGRESSIVE_MANIFEST=1` and single platform, the build script pushes arch-specific tags and updates the manifest. A subsequent `make docker-push` would try to push `repo/image:VERSION` and `repo/image:latest`, which are manifest lists (not local images), and may fail or be redundant.

**Fix**: In the top-level Makefile, extend the `docker-push` skip condition: when `DOCKER_PROGRESSIVE_MANIFEST=1` is set, skip the push step (or treat it as no-op) for the same reason as when multi-platform is set—images were already pushed during build. Document this in the help and in the doc.

---

## 7. Podman: skip merge and document

**Gap**: `docker buildx imagetools create` is Docker/Buildx-specific. With `CONTAINER=podman`, the merge step cannot run.

**Fix**: In both build scripts, only call the merge helper when `CONTAINER=docker`. When `CONTAINER=podman` and progressive manifest is requested, either skip the merge step and warn, or exit with a clear message that progressive manifest is not supported for Podman. Document in `docs/docker/docker-multiarch-builds.md` that progressive manifest requires Docker (Buildx).

---

## 8. DOCKER_ARCHES and platform mapping consistency

**Gap**: `DOCKER_ARCHES` (e.g. `amd64,arm64`) must match the arch suffixes produced by the platform-to-arch mapping in the build scripts. If a new platform is added (e.g. `linux/arm/v7` → `armv7`), `DOCKER_ARCHES` should include `armv7` for it to be discovered.

**Fix**: Document in the doc that `DOCKER_ARCHES` should list exactly the arch suffixes that the build can produce (from the platform mapping). Default `amd64,arm64` matches the default mapping.

---

## Summary checklist for implementation

| # | Item | Where |
|---|------|--------|
| 1 | Merge script: always add CURRENT_ARCH to list; discover only other arches | scripts/docker-manifest-merge.sh |
| 2 | Build scripts: fail if merge script fails (no swallowing exit code) | scripts/docker-build.sh, docker-build-image.sh |
| 3 | Resolve merge script path via SCRIPT_DIR; call with IMAGE_BASE VERSION CURRENT_ARCH | Both build scripts |
| 4 | Top-level Makefile: pass DOCKER_PROGRESSIVE_MANIFEST and DOCKER_ARCHES in all build invocations | Makefile |
| 5 | Child Makefiles: pass DOCKER_PROGRESSIVE_MANIFEST and DOCKER_ARCHES when invoking BUILD_SCRIPT | src/images/*/Makefile, src/nemo/workers/*/Makefile |
| 6 | Document registry auth requirement for merge | docs/docker/docker-multiarch-builds.md |
| 7 | docker-push: skip when DOCKER_PROGRESSIVE_MANIFEST=1 | Makefile |
| 8 | Only run merge when CONTAINER=docker; document Podman unsupported | Build scripts + docs |
| 9 | Document DOCKER_ARCHES vs platform mapping | docs/docker/docker-multiarch-builds.md |
