#!/usr/bin/env python3
"""CLI entry point for the LanceDB vs pgvector benchmark suite."""

import json
import logging
import sys
from pathlib import Path

import click
import yaml

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("benchmark")


def load_config(config_path: str = "config.yaml") -> dict:
    with open(config_path) as f:
        return yaml.safe_load(f)


def make_lancedb_store(cfg: dict):
    from harness.lancedb_store import LanceDBStore
    return LanceDBStore(data_dir=cfg.get("lancedb", {}).get("data_dir", "/tmp/lance-bench"))


def make_pgvector_store(cfg: dict):
    from harness.pgvector_store import PgvectorStore
    pg = cfg.get("pgvector", {})
    return PgvectorStore(
        host=pg.get("host", "localhost"),
        port=pg.get("port", 5432),
        database=pg.get("database", "vectorbench"),
        user=pg.get("user", "benchuser"),
        password=pg.get("password", "benchpass"),
    )


SCENARIOS = [
    "scale", "dimension", "content_type", "search_mode",
    "filter", "concurrent", "multi_kb", "versioning", "durability",
]


@click.command()
@click.option("--config", default="config.yaml", help="Path to config.yaml")
@click.option("--store", type=click.Choice(["lancedb", "pgvector", "both"]), default="both")
@click.option("--scenario", type=click.Choice(SCENARIOS + ["all"]), default="all")
@click.option("--output", default="./results", help="Output directory for results")
@click.option("--report", default="./results/report.md", help="Output report path")
def main(config: str, store: str, scenario: str, output: str, report: str):
    """Run LanceDB vs pgvector benchmark scenarios."""
    cfg = load_config(config)
    output_dir = cfg.get("results", {}).get("output_dir", output)
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    stores_to_run = []
    if store in ("lancedb", "both"):
        stores_to_run.append(("lancedb", make_lancedb_store, cfg))
    if store in ("pgvector", "both"):
        stores_to_run.append(("pgvector", make_pgvector_store, cfg))

    scenarios_to_run = SCENARIOS if scenario == "all" else [scenario]

    for store_type, store_factory, cfg in stores_to_run:
        for scenario_name in scenarios_to_run:
            logger.info("=" * 60)
            logger.info("Running %s on %s", scenario_name, store_type)
            logger.info("=" * 60)

            try:
                _run_scenario(scenario_name, store_type, store_factory, cfg, output_dir)
            except Exception:
                logger.exception("FAILED: %s / %s", scenario_name, store_type)

    logger.info("Generating report...")
    from harness.report import generate_report
    generate_report(output_dir, report)
    logger.info("Done. Report: %s", report)


def _run_scenario(scenario_name, store_type, store_factory, cfg, output_dir):
    scfg = cfg.get("scenarios", {}).get(scenario_name, {})

    if scenario_name == "scale":
        from scenarios.scale_test import run
        store = store_factory(cfg)
        try:
            run(store, store_type, output_dir,
                sizes=scfg.get("sizes"), dimension=scfg.get("dimension", 384),
                metric=scfg.get("metric", "cosine"), top_k=scfg.get("top_k", 10))
        finally:
            store.close()

    elif scenario_name == "dimension":
        from scenarios.dimension_test import run
        store = store_factory(cfg)
        try:
            run(store, store_type, output_dir,
                count=scfg.get("count", 100_000), dimensions=scfg.get("dimensions"),
                metric=scfg.get("metric", "cosine"), top_k=scfg.get("top_k", 10))
        finally:
            store.close()

    elif scenario_name == "content_type":
        from scenarios.content_type_test import run
        store = store_factory(cfg)
        try:
            run(store, store_type, output_dir,
                dimension=scfg.get("dimension", 384), metric=scfg.get("metric", "cosine"),
                top_k=scfg.get("top_k", 10))
        finally:
            store.close()

    elif scenario_name == "search_mode":
        from scenarios.search_mode_test import run
        store = store_factory(cfg)
        try:
            run(store, store_type, output_dir,
                count=scfg.get("count", 100_000), dimension=scfg.get("dimension", 384),
                num_queries=scfg.get("num_queries", 200),
                metric=scfg.get("metric", "cosine"), top_k=scfg.get("top_k", 10))
        finally:
            store.close()

    elif scenario_name == "filter":
        from scenarios.filter_test import run
        store = store_factory(cfg)
        try:
            run(store, store_type, output_dir,
                count=scfg.get("count", 100_000), dimension=scfg.get("dimension", 384),
                cardinalities=scfg.get("cardinalities"),
                metric=scfg.get("metric", "cosine"), top_k=scfg.get("top_k", 10))
        finally:
            store.close()

    elif scenario_name == "concurrent":
        from scenarios.concurrent_test import run
        store = store_factory(cfg)
        try:
            run(store, store_type, output_dir,
                count=scfg.get("count", 100_000), dimension=scfg.get("dimension", 384),
                thread_counts=scfg.get("thread_counts"),
                queries_per_thread=scfg.get("queries_per_thread", 50),
                metric=scfg.get("metric", "cosine"), top_k=scfg.get("top_k", 10))
        finally:
            store.close()

    elif scenario_name == "multi_kb":
        from scenarios.multi_kb_test import run
        run(lambda: store_factory(cfg), store_type, output_dir,
            kb_counts=scfg.get("kb_counts"), vectors_per_kb=scfg.get("vectors_per_kb", 50_000),
            dimension=scfg.get("dimension", 384),
            metric=scfg.get("metric", "cosine"), top_k=scfg.get("top_k", 10))

    elif scenario_name == "versioning":
        from scenarios.versioning_test import run
        store = store_factory(cfg)
        try:
            run(store, store_type, output_dir,
                count=scfg.get("count", 100_000), dimension=scfg.get("dimension", 384),
                num_versions=scfg.get("num_versions"),
                metric=scfg.get("metric", "cosine"), top_k=scfg.get("top_k", 10))
        finally:
            store.close()

    elif scenario_name == "durability":
        from scenarios.storage_durability_test import run
        store = store_factory(cfg)
        try:
            run(store, store_type, output_dir,
                count=scfg.get("count", 100_000), dimension=scfg.get("dimension", 384),
                metric=scfg.get("metric", "cosine"), top_k=scfg.get("top_k", 10))
        finally:
            store.close()


if __name__ == "__main__":
    main()
