#!/usr/bin/env bash
# Print the canonical content-hash tag for the integration-test image.
#
# The tag is the git tree object hash of tests/integration/ (truncated to 12
# chars). Because the tree hash is a pure function of the tracked content in
# that directory, it changes iff a tracked file under tests/integration/
# changes (the Dockerfile lives there too, so image changes are captured;
# .venv/ and reports/ are gitignored so they never perturb it).
#
# Both integration-image-build.yml (which builds/pushes this tag, skipping when
# it already exists in ACR) and integration-tests-container.yml (which pulls and
# runs exactly this tag) call this script, so the tag is computed one way in one
# place. `git rev-parse HEAD:<path>` resolves the path from the repo root
# regardless of the caller's working directory.
#
# Usage:
#   scripts/integration-image-tag.sh            # -> <12-char-tree-hash>
#   scripts/integration-image-tag.sh --ref HEAD # explicit git ref (default HEAD)
#
# Env:
#   INTEGRATION_TREE_PATH  path hashed (default: tests/integration)
#   INTEGRATION_TAG_LEN    tag length (default: 12)

set -euo pipefail

# Git 2.35+ refuses to operate on repos owned by a different user ("dubious
# ownership"). Self-hosted Actions runners commonly hit this when the checkout
# user differs from the job user; mark this repo safe before any git command.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
git config --global --add safe.directory "$repo_root" 2>/dev/null || true

REF="HEAD"
if [[ "${1:-}" == "--ref" ]]; then
  REF="${2:?--ref requires a value}"
fi

TREE_PATH="${INTEGRATION_TREE_PATH:-tests/integration}"
TAG_LEN="${INTEGRATION_TAG_LEN:-12}"

# `<ref>:<path>` names the tree object for that path; rev-parse prints its SHA.
full="$(git rev-parse "${REF}:${TREE_PATH}")"
printf '%s\n' "${full:0:TAG_LEN}"
