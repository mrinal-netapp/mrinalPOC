#!/usr/bin/env bash
# Parse the TOTAL line-coverage percentage from a coverage report and compare it
# against COVERAGE_MIN.
#
# Usage:
#   scripts/ci/coverage-total.sh <format> <file>
#
# <format> is one of:
#   istanbul  - Istanbul json-summary (.total.lines.pct)
#   cobertura - Cobertura XML (<coverage line-rate="...">)
#   go        - `go tool cover -func` text output (total: ... NN.N%)  [statement %]
#   lcov      - lcov.info (LF/LH line totals)
#
# Prints the total line % (e.g. "88.57") to stdout, then exits:
#   0  coverage >= COVERAGE_MIN   (pass)
#   2  coverage <  COVERAGE_MIN   (below threshold)
#   3  missing / unparseable coverage (fail-closed; prints "N/A")
#   4  unknown format
#
# COVERAGE_MIN defaults to 85. This is shared by the touched-package gate and can
# be reused by the future diff-coverage gate / merged workflow with a different
# threshold.
set -euo pipefail

fmt="${1:?usage: coverage-total.sh <format> <file>}"
file="${2:?usage: coverage-total.sh <format> <file>}"
COVERAGE_MIN="${COVERAGE_MIN:-85}"

fail_closed() {
  printf '%s\n' "N/A"
  exit 3
}

[ -s "$file" ] || fail_closed

pct=""
case "$fmt" in
  istanbul)
    pct="$(jq -r '.total.lines.pct // empty' "$file" 2>/dev/null || true)"
    ;;
  cobertura)
    tag="$(grep -oE '<coverage[^>]+>' "$file" | head -1 || true)"
    lr="$(printf '%s' "$tag" | grep -oE 'line-rate="[^"]+"' | head -1 | cut -d'"' -f2 || true)"
    [ -n "$lr" ] && pct="$(awk -v r="$lr" 'BEGIN { printf "%.2f", r * 100 }')"
    ;;
  go)
    pct="$(awk '/^total:/ { gsub(/%/, "", $NF); print $NF; exit }' "$file" || true)"
    ;;
  lcov)
    lf="$(grep -E '^LF:' "$file" | awk -F: '{ s += $2 } END { print s + 0 }')"
    lh="$(grep -E '^LH:' "$file" | awk -F: '{ s += $2 } END { print s + 0 }')"
    [ "${lf:-0}" -gt 0 ] && pct="$(awk -v h="$lh" -v f="$lf" 'BEGIN { printf "%.2f", (h / f) * 100 }')"
    ;;
  *)
    printf 'unknown coverage format: %s\n' "$fmt" >&2
    exit 4
    ;;
esac

if [ -z "$pct" ] || [ "$pct" = "null" ]; then
  fail_closed
fi

printf '%s\n' "$pct"

if awk -v p="$pct" -v m="$COVERAGE_MIN" 'BEGIN { exit !((p + 0) >= (m + 0)) }'; then
  exit 0
fi
exit 2
