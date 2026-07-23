"""Generate markdown-formatted result tables from benchmark JSON output."""

import json
import logging
from pathlib import Path

from tabulate import tabulate

logger = logging.getLogger(__name__)


def load_results(results_dir: str) -> list[dict]:
    results = []
    for p in Path(results_dir).glob("*.json"):
        with open(p) as f:
            results.append(json.load(f))
    return sorted(results, key=lambda r: (r.get("scenario", ""), r.get("store_type", "")))


def format_latency_table(results: list[dict], title: str = "") -> str:
    headers = ["Store", "Index", "p50 (ms)", "p95 (ms)", "p99 (ms)", "QPS"]
    rows = []
    for r in results:
        lat = r.get("latency", {})
        rows.append([
            r.get("store_type", ""),
            r.get("index_type", ""),
            f"{lat.get('p50_ms', 0):.2f}",
            f"{lat.get('p95_ms', 0):.2f}",
            f"{lat.get('p99_ms', 0):.2f}",
            f"{r.get('qps', 0):.1f}",
        ])
    header = f"### {title}\n\n" if title else ""
    return header + tabulate(rows, headers=headers, tablefmt="pipe") + "\n"


def format_quality_table(results: list[dict], title: str = "") -> str:
    headers = ["Store", "Index", "Recall@1", "Recall@10", "Recall@50", "NDCG@10", "MRR"]
    rows = []
    for r in results:
        q = r.get("quality", {})
        rows.append([
            r.get("store_type", ""),
            r.get("index_type", ""),
            f"{q.get('recall@1', 0):.4f}",
            f"{q.get('recall@10', 0):.4f}",
            f"{q.get('recall@50', 0):.4f}",
            f"{q.get('ndcg@10', 0):.4f}",
            f"{q.get('mrr', 0):.4f}",
        ])
    header = f"### {title}\n\n" if title else ""
    return header + tabulate(rows, headers=headers, tablefmt="pipe") + "\n"


def format_scale_table(results: list[dict], title: str = "") -> str:
    headers = [
        "Store", "Index", "Count", "Insert (vec/s)",
        "Build (s)", "Size (MB)", "p50 (ms)", "Recall@10",
    ]
    rows = []
    for r in results:
        p = r.get("params", {})
        lat = r.get("latency", {})
        q = r.get("quality", {})
        rows.append([
            r.get("store_type", ""),
            r.get("index_type", ""),
            p.get("count", ""),
            f"{r.get('insert_throughput', 0):.0f}",
            f"{r.get('index_build_seconds', 0):.2f}",
            f"{r.get('index_size_mb', 0):.1f}",
            f"{lat.get('p50_ms', 0):.2f}",
            f"{q.get('recall@10', 0):.4f}",
        ])
    header = f"### {title}\n\n" if title else ""
    return header + tabulate(rows, headers=headers, tablefmt="pipe") + "\n"


def generate_report(results_dir: str, output_path: str) -> None:
    results = load_results(results_dir)
    if not results:
        logger.warning("No results found in %s", results_dir)
        return

    sections = []
    sections.append("# Vector DB Benchmark Results\n")

    scenarios = {}
    for r in results:
        s = r.get("scenario", "unknown")
        scenarios.setdefault(s, []).append(r)

    for scenario_name, scenario_results in sorted(scenarios.items()):
        sections.append(f"\n## {scenario_name.replace('_', ' ').title()}\n")
        if any("quality" in r for r in scenario_results):
            sections.append(format_quality_table(scenario_results, "Quality"))
        sections.append(format_latency_table(scenario_results, "Latency"))
        if any("insert_throughput" in r and r["insert_throughput"] > 0 for r in scenario_results):
            sections.append(format_scale_table(scenario_results, "Throughput"))

    report = "\n".join(sections)
    Path(output_path).write_text(report)
    logger.info("Report written to %s", output_path)
