#!/usr/bin/env python3
"""
lint-values-parity.py — Cross-cloud Helm values parity linter.

Detects two classes of problem in Helm overlay files:

  DRIFT   — A key appears in some values-<cloud>.yaml overlays but not
             all overlays for that tier. This is the #1 cause of "works
             on one cloud, broken on another" deployment failures.

  ORPHAN  — A key in a values-<cloud>.yaml overlay has no corresponding
             entry anywhere in the tier's base values.yaml. The overlay
             has no effect and is silently ignored by Helm's merge
             (usually a typo or a leftover from a renamed chart key).

Usage:
  python3 scripts/lint-values-parity.py <helm-root> [tier...]

  <helm-root>   path to deployments/helm/
  [tier...]     optional list of tier names to check (default: all tiers
                listed in DEFAULT_TIERS below)

Exit codes:
  0  no violations found
  1  one or more DRIFT or ORPHAN violations found
  2  usage / runtime error

Allow-listing intentional differences:
  Place a  .values-parity-allow.yaml  file in the tier directory to
  suppress known-intentional key differences from the report.

  Format::

    allow:
      # exact dotted path
      - global.storageClass

      # fnmatch wildcard — matches any path component at any depth
      - "*.serviceAccount.azureClientId"

      # prefix wildcard — matches the key itself or any child
      - s3gateway.*

      # suffix match — same as fnmatch with leading "*."
      - "*.workloadIdentity.enabled"

  Document the reason in a comment next to each entry so the intent
  is clear to future reviewers.

See docs/deployment/values-convergence-strategy.md for the full design.
"""

import sys
import fnmatch
from pathlib import Path

try:
    import yaml
except ImportError:
    print("ERROR: PyYAML not installed. Run: pip3 install pyyaml", file=sys.stderr)
    sys.exit(2)

# Overlay names collected from disk. Every overlay here is checked for ORPHAN
# keys (an overlay key with no corresponding entry in the tier's base
# values.yaml, which Helm silently ignores).
ALL_ENVS = ["local", "aks", "gke", "eks"]

# DRIFT (a key set on some overlays but not all) is compared ONLY across the
# hyperscalers. values-local.yaml is a deliberate strip-down of the
# cloud-shaped base (see docs/deployment/values-convergence-strategy.md), so
# parity-checking local against the clouds produces noise rather than signal.
# Local is still ORPHAN-checked via ALL_ENVS above.
HYPERSCALER_ENVS = ["aks", "gke", "eks"]

# Tiers linted by default when no [tier...] args are given.
# Must stay in sync with deployments/helm/ directory structure.
DEFAULT_TIERS = [
    "services",
    "platform",
    "workers",
    "llm-gateway",
    "console",
    "edge",
    "identity",
]


# ─── YAML helpers ─────────────────────────────────────────────────────────────

def load_yaml(path: Path) -> dict:
    """Load a YAML file, returning {} if missing, empty, or not a mapping."""
    if not path.exists():
        return {}
    with open(path) as f:
        data = yaml.safe_load(f)
    return data if isinstance(data, dict) else {}


def extract_leaf_paths(d: object, prefix: str = "") -> set:
    """
    Recursively walk a nested dict and return the set of dotted leaf paths.

    Lists are treated as atomic leaves — we never descend into list elements
    because Helm replaces lists wholesale (no index-merge), so there are no
    stable dotted paths inside a list.  An empty dict is also treated as a
    leaf (the key was explicitly set to {}).
    """
    paths: set = set()
    if not isinstance(d, dict):
        return paths
    for key, value in d.items():
        full = f"{prefix}.{key}" if prefix else str(key)
        if isinstance(value, dict) and value:
            sub = extract_leaf_paths(value, full)
            paths |= sub
        else:
            paths.add(full)
    return paths


def path_in_base(path: str, base: dict) -> bool:
    """
    Return True if the full dotted path exists in the base values dict.

    Stops early at a non-dict node (e.g. a scalar or list) and returns True
    — if the path prefix resolves to a leaf in base, any sub-key set by an
    overlay is structurally replacing the base value, not orphaning.
    """
    parts = path.split(".")
    current: object = base
    for part in parts:
        if not isinstance(current, dict):
            return True   # reached a base leaf — path is not orphaned
        if part not in current:
            return False
        current = current[part]
    return True


# ─── Allow-list helpers ───────────────────────────────────────────────────────

def load_allow_list(tier_dir: Path) -> list:
    """Load .values-parity-allow.yaml and return the list of allowed patterns."""
    allow_path = tier_dir / ".values-parity-allow.yaml"
    data = load_yaml(allow_path)
    allow = data.get("allow", [])
    if not isinstance(allow, list):
        print(
            f"WARNING: 'allow' in {allow_path} is not a list "
            f"(got {type(allow).__name__}); ignoring allow-list for this tier.",
            file=sys.stderr,
        )
        return []
    return [str(p) for p in allow]


def is_allowed(path: str, patterns: list) -> bool:
    """Return True if path matches any allow-list pattern."""
    for pattern in patterns:
        # Exact match
        if path == pattern:
            return True
        # fnmatch wildcard (e.g. "*.serviceAccount.azureClientId")
        if fnmatch.fnmatch(path, pattern):
            return True
        # Explicit prefix wildcard: "s3gateway.*" → matches "s3gateway" itself
        # or any child key
        if pattern.endswith(".*"):
            prefix = pattern[:-2]
            if path == prefix or path.startswith(prefix + "."):
                return True
    return False


# ─── Per-tier linter ─────────────────────────────────────────────────────────

def lint_tier(tier_name: str, tier_dir: Path) -> tuple:
    """
    Lint a single tier.

    Returns (drift_count, orphan_count, messages) where messages is a list
    of pre-formatted strings to print.
    """
    base_path = tier_dir / "values.yaml"
    if not base_path.exists():
        return 0, 0, []

    base = load_yaml(base_path)
    allow = load_allow_list(tier_dir)

    # ── Collect overlay paths per cloud ──────────────────────────────────────
    overlay_paths: dict = {}
    for cloud in ALL_ENVS:
        overlay_file = tier_dir / f"values-{cloud}.yaml"
        if not overlay_file.exists():
            continue
        overlay = load_yaml(overlay_file)
        if overlay:
            overlay_paths[cloud] = extract_leaf_paths(overlay)
        else:
            overlay_paths[cloud] = set()

    if not overlay_paths:
        return 0, 0, []

    clouds_present = list(overlay_paths.keys())
    parity_present = [c for c in HYPERSCALER_ENVS if c in overlay_paths]
    all_paths: set = set()
    for paths in overlay_paths.values():
        all_paths |= paths

    # ── Check each path ───────────────────────────────────────────────────────
    drift_items = []
    orphan_items = []

    for path in sorted(all_paths):
        if is_allowed(path, allow):
            continue

        # DRIFT: key set on some hyperscaler overlays but not all. local is
        # intentionally excluded — it strips down the cloud-shaped base by design.
        drift_setting = [c for c in parity_present if path in overlay_paths[c]]
        drift_missing = [c for c in parity_present if path not in overlay_paths[c]]
        if drift_setting and drift_missing:
            drift_items.append((path, drift_setting, drift_missing))

        # ORPHAN: key not present anywhere in base values.yaml. Spans every
        # overlay (incl. local) so a typo/renamed key that Helm would silently
        # ignore is still caught.
        if not path_in_base(path, base):
            setting_clouds = [c for c in clouds_present if path in overlay_paths[c]]
            orphan_items.append((path, setting_clouds))

    # ── Format messages ───────────────────────────────────────────────────────
    messages = []
    if drift_items or orphan_items:
        messages.append(f"\n=== {tier_name} tier ===")
        if drift_items:
            messages.append(
                "  DRIFT — key set on some hyperscaler overlays but not all "
                f"(compared: {', '.join(parity_present)}):"
            )
            for path, has, missing in drift_items:
                messages.append(f"  ✗  {path}")
                messages.append(f"       present in : {', '.join(has)}")
                messages.append(f"       missing from: {', '.join(missing)}")
        if orphan_items:
            messages.append(
                "  ORPHAN — key not found in base values.yaml "
                "(silently ignored by Helm merge):"
            )
            for path, has in orphan_items:
                messages.append(f"  ⚠  {path}")
                messages.append(f"       set in: {', '.join(has)}")

    return len(drift_items), len(orphan_items), messages


# ─── Main ─────────────────────────────────────────────────────────────────────

def main() -> int:
    args = sys.argv[1:]
    if not args:
        print(
            "Usage: lint-values-parity.py <helm-root> [tier...]\n"
            "  helm-root  path to deployments/helm/\n"
            "  tier       optional tier name(s); default: all",
            file=sys.stderr,
        )
        return 2

    helm_root = Path(args[0])
    if not helm_root.is_dir():
        print(f"ERROR: helm root not found: {helm_root}", file=sys.stderr)
        return 2

    requested_tiers = args[1:] if len(args) > 1 else DEFAULT_TIERS

    total_drift = 0
    total_orphan = 0
    checked = 0
    all_messages = []

    for tier_name in requested_tiers:
        tier_dir = helm_root / tier_name
        if not tier_dir.is_dir():
            print(f"WARNING: tier directory not found: {tier_dir}", file=sys.stderr)
            continue
        drift, orphan, messages = lint_tier(tier_name, tier_dir)
        total_drift += drift
        total_orphan += orphan
        all_messages.extend(messages)
        checked += 1

    for msg in all_messages:
        print(msg)

    print(f"\n--- lint-values-parity: checked {checked} tier(s) ---")
    if total_drift == 0 and total_orphan == 0:
        print("OK: no drift or orphan-key violations found.")
        return 0

    summary_parts = []
    if total_drift:
        summary_parts.append(f"{total_drift} DRIFT violation(s)")
    if total_orphan:
        summary_parts.append(f"{total_orphan} ORPHAN violation(s)")
    print(
        f"FAIL: {' and '.join(summary_parts)} found.\n"
        "      Fix the drift or add an entry to the tier's "
        ".values-parity-allow.yaml to mark it intentional."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
