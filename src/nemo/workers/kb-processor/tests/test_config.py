"""Unit tests for utils/config.py validation and parsing."""

import importlib.util
import json
from pathlib import Path
import sys

import pytest

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))

_config_spec = importlib.util.spec_from_file_location(
    "kb_processor_config",
    _ROOT / "utils" / "config.py",
)
_config_mod = importlib.util.module_from_spec(_config_spec)
assert _config_spec.loader is not None
_config_spec.loader.exec_module(_config_mod)

Config = _config_mod.Config
VALID_CHUNK_STRATEGIES = _config_mod.VALID_CHUNK_STRATEGIES
VALID_INDEXING_MODES = _config_mod.VALID_INDEXING_MODES
VALID_QUANTIZATION_TYPES = _config_mod.VALID_QUANTIZATION_TYPES


def _valid_dict(**overrides):
    base = {
        "kb_id": "kb12345678",
        "kb_name": "Test KB",
        "project_id": "proj-1",
        "source_dataset_id": "ds-1",
        "bucket_name": "bucket",
        "project_client_id": "client",
        "project_client_secret": "secret",
        "chunk_strategy": "fixed",
        "chunk_options": {"maxSentences": 3},
        "indexing_mode": "hybrid",
        "quantization_type": "auto",
        "quantization_options": {"numPartitions": 128},
    }
    base.update(overrides)
    return base


def test_from_dict_sets_chunk_and_index_fields():
    cfg = Config.from_dict(_valid_dict(
        chunk_strategy="sentence",
        chunk_options='{"maxTokens": 128}',
        indexing_mode="semantic",
        quantization_type="scalar",
        quantization_options='{"efConstruction": 200}',
    ))
    assert cfg.chunk_strategy == "sentence"
    assert cfg.chunk_options == {"maxTokens": 128}
    assert cfg.indexing_mode == "semantic"
    assert cfg.quantization_type == "scalar"
    assert cfg.quantization_options["efConstruction"] == 200


def test_validate_rejects_invalid_chunk_strategy():
    with pytest.raises(ValueError, match="Invalid CHUNK_STRATEGY"):
        Config.from_dict(_valid_dict(chunk_strategy="ngram"))


def test_validate_rejects_invalid_indexing_mode():
    with pytest.raises(ValueError, match="Invalid INDEXING_MODE"):
        Config.from_dict(_valid_dict(indexing_mode="vector_only"))


def test_validate_rejects_invalid_quantization_type():
    with pytest.raises(ValueError, match="Invalid QUANTIZATION_TYPE"):
        Config.from_dict(_valid_dict(quantization_type="hnsw_only"))


def test_parse_quantization_options_invalid_json_returns_empty():
    result = Config._parse_quantization_options("{not-json")
    assert result == {}


@pytest.mark.parametrize("strategy", VALID_CHUNK_STRATEGIES)
def test_all_valid_chunk_strategies_accepted(strategy):
    cfg = Config.from_dict(_valid_dict(chunk_strategy=strategy))
    assert cfg.chunk_strategy == strategy


@pytest.mark.parametrize("mode", VALID_INDEXING_MODES)
def test_all_valid_indexing_modes_accepted(mode):
    cfg = Config.from_dict(_valid_dict(indexing_mode=mode))
    assert cfg.indexing_mode == mode


@pytest.mark.parametrize("qtype", VALID_QUANTIZATION_TYPES)
def test_all_valid_quantization_types_accepted(qtype):
    cfg = Config.from_dict(_valid_dict(quantization_type=qtype))
    assert cfg.quantization_type == qtype


def test_from_environment_reads_chunk_and_quantization_env(monkeypatch):
    env = {
        "KB_ID": "kb12345678",
        "KB_NAME": "Env KB",
        "PROJECT_ID": "p1",
        "SOURCE_DATASET_ID": "ds-1",
        "BUCKET_NAME": "b1",
        "PROJECT_CLIENT_ID": "c",
        "PROJECT_CLIENT_SECRET": "s",
        "CHUNK_STRATEGY": "token",
        "CHUNK_OPTIONS": json.dumps({"maxTokens": 64}),
        "INDEXING_MODE": "fts",
        "QUANTIZATION_TYPE": "ivf_pq",
        "QUANTIZATION_OPTIONS": json.dumps({"numPartitions": 32}),
    }
    for key, value in env.items():
        monkeypatch.setenv(key, value)

    cfg = Config.from_environment()
    assert cfg.chunk_strategy == "token"
    assert cfg.chunk_options["maxTokens"] == 64
    assert cfg.indexing_mode == "fts"
    assert cfg.quantization_type == "ivf_pq"
    assert cfg.quantization_options["numPartitions"] == 32


def test_from_environment_bad_quantization_options_uses_empty_dict(monkeypatch):
    monkeypatch.setenv("KB_ID", "kb12345678")
    monkeypatch.setenv("KB_NAME", "KB")
    monkeypatch.setenv("PROJECT_ID", "p1")
    monkeypatch.setenv("SOURCE_DATASET_ID", "ds-1")
    monkeypatch.setenv("BUCKET_NAME", "b1")
    monkeypatch.setenv("PROJECT_CLIENT_ID", "c")
    monkeypatch.setenv("PROJECT_CLIENT_SECRET", "s")
    monkeypatch.setenv("QUANTIZATION_OPTIONS", "{bad")

    cfg = Config.from_environment()
    assert cfg.quantization_options == {}


class TestParseEmbeddingBatchSize:
    def test_valid_positive_string(self):
        assert Config._parse_embedding_batch_size("128") == 128

    def test_non_positive_defaults_to_64(self):
        assert Config._parse_embedding_batch_size("0") == 64
        assert Config._parse_embedding_batch_size("-5") == 64

    def test_non_numeric_defaults_to_64(self):
        assert Config._parse_embedding_batch_size("not-a-number") == 64

    def test_none_defaults_to_64(self):
        assert Config._parse_embedding_batch_size(None) == 64


class TestParseQuantizationOptions:
    def test_empty_string_returns_empty_dict(self):
        assert Config._parse_quantization_options("") == {}

    def test_valid_json_string(self):
        assert Config._parse_quantization_options('{"numPartitions": 4}') == {"numPartitions": 4}


class TestFromDictEdgeCases:
    def test_text_columns_as_actual_list_passthrough(self):
        cfg = Config.from_dict(_valid_dict(
            dataset_kind="structured",
            catalog_table_ref="ns.tbl",
            text_columns=["title", "body"],
        ))
        assert cfg.text_columns == ["title", "body"]

    def test_text_columns_as_comma_separated_string(self):
        cfg = Config.from_dict(_valid_dict(
            dataset_kind="structured",
            catalog_table_ref="ns.tbl",
            text_columns="title, body ,  summary",
        ))
        assert cfg.text_columns == ["title", "body", "summary"]

    def test_invalid_chunk_options_json_string_falls_back_to_empty_dict(self):
        cfg = Config.from_dict(_valid_dict(chunk_options="{not-valid-json"))
        assert cfg.chunk_options == {}

    def test_legacy_s3_credential_keys_used_as_fallback(self):
        # aws_access_key_id/aws_secret_access_key have an empty-string default,
        # so a missing key is falsy and the legacy key is consulted. aws_region's
        # default ('us-east-1') is non-empty, so it is always truthy and the
        # 's3_region' legacy fallback for it can never actually trigger -- this
        # documents that real (if perhaps unintended) behavior.
        cfg = Config.from_dict(_valid_dict(
            s3_access_key="legacy-ak",
            s3_secret_key="legacy-sk",
            s3_region="us-west-2",
        ))
        assert cfg.aws_access_key_id == "legacy-ak"
        assert cfg.aws_secret_access_key == "legacy-sk"
        assert cfg.aws_region == "us-east-1"

    def test_new_style_credential_keys_take_precedence_over_legacy(self):
        cfg = Config.from_dict(_valid_dict(
            aws_access_key_id="new-ak",
            s3_access_key="legacy-ak",
        ))
        assert cfg.aws_access_key_id == "new-ak"

    def test_legacy_keycloak_issuer_key_has_non_empty_default_so_never_falls_back(self):
        # Same non-empty-default limitation as aws_region above: the default
        # cluster-local URL is truthy, so 'keycloak_issuer' legacy fallback is
        # unreachable in practice. Documents actual behavior.
        cfg = Config.from_dict(_valid_dict(keycloak_issuer="http://legacy-issuer"))
        assert cfg.keycloak_internal_issuer == (
            "http://keycloak.agentstudio-identity.svc.cluster.local:8080/realms/nemo"
        )

    def test_blank_values_fall_through_to_defaults(self):
        cfg = Config.from_dict(_valid_dict(dataset_kind="", quantization_type=""))
        assert cfg.dataset_kind == "unstructured"
        assert cfg.quantization_type == "auto"

    def test_empty_catalog_table_ref_and_warehouse_id_become_none(self):
        cfg = Config.from_dict(_valid_dict(catalog_table_ref="", warehouse_id=""))
        assert cfg.catalog_table_ref is None
        assert cfg.warehouse_id is None

    def test_gateway_embedding_fields_fall_back_to_env(self, monkeypatch):
        monkeypatch.setenv("LLM_GATEWAY_URL", "http://gateway-from-env")
        monkeypatch.setenv("EMBEDDING_DIMENSIONS", "768")
        cfg = Config.from_dict(_valid_dict())
        assert cfg.llm_gateway_url == "http://gateway-from-env"
        assert cfg.embedding_dimensions == 768

    def test_gateway_embedding_fields_from_dict_take_precedence_over_env(self, monkeypatch):
        monkeypatch.setenv("LLM_GATEWAY_URL", "http://gateway-from-env")
        cfg = Config.from_dict(_valid_dict(llm_gateway_url="http://gateway-from-dict"))
        assert cfg.llm_gateway_url == "http://gateway-from-dict"


class TestFromEnvironmentEdgeCases:
    def _set_required(self, monkeypatch):
        monkeypatch.setenv("KB_ID", "kb12345678")
        monkeypatch.setenv("KB_NAME", "KB")
        monkeypatch.setenv("PROJECT_ID", "p1")
        monkeypatch.setenv("SOURCE_DATASET_ID", "ds-1")
        monkeypatch.setenv("BUCKET_NAME", "b1")
        monkeypatch.setenv("PROJECT_CLIENT_ID", "c")
        monkeypatch.setenv("PROJECT_CLIENT_SECRET", "s")

    def test_text_columns_env_parsed_as_comma_list(self, monkeypatch):
        self._set_required(monkeypatch)
        monkeypatch.setenv("TEXT_COLUMNS", "a, b ,c")
        monkeypatch.setenv("DATASET_KIND", "structured")
        monkeypatch.setenv("CATALOG_TABLE_REF", "ns.tbl")
        cfg = Config.from_environment()
        assert cfg.text_columns == ["a", "b", "c"]

    def test_bad_chunk_options_json_uses_empty_dict(self, monkeypatch):
        self._set_required(monkeypatch)
        monkeypatch.setenv("CHUNK_OPTIONS", "{not-valid")
        cfg = Config.from_environment()
        assert cfg.chunk_options == {}


class TestEffectiveWarehouseId:
    def test_returns_configured_warehouse_id(self):
        cfg = Config.from_dict(_valid_dict(warehouse_id="wh-explicit"))
        assert cfg.effective_warehouse_id() == "wh-explicit"

    def test_falls_back_to_warehouse_name_env(self, monkeypatch):
        cfg = Config.from_dict(_valid_dict())
        monkeypatch.setenv("WAREHOUSE_NAME", "wh-from-env")
        assert cfg.effective_warehouse_id() == "wh-from-env"

    def test_falls_back_to_deployment_name_env(self, monkeypatch):
        cfg = Config.from_dict(_valid_dict())
        monkeypatch.delenv("WAREHOUSE_NAME", raising=False)
        monkeypatch.setenv("DEPLOYMENT_NAME", "deployment-1")
        assert cfg.effective_warehouse_id() == "deployment-1"

    def test_raises_when_no_warehouse_id_available(self, monkeypatch):
        cfg = Config.from_dict(_valid_dict())
        monkeypatch.delenv("WAREHOUSE_NAME", raising=False)
        monkeypatch.delenv("DEPLOYMENT_NAME", raising=False)
        with pytest.raises(ValueError, match="warehouse_id is required"):
            cfg.effective_warehouse_id()


class TestValidate:
    def test_missing_required_field_raises(self):
        with pytest.raises(ValueError, match="Missing required config fields"):
            Config.from_dict(_valid_dict(kb_id=""))

    def test_structured_without_catalog_table_ref_raises(self):
        with pytest.raises(ValueError, match="CATALOG_TABLE_REF is required"):
            Config.from_dict(_valid_dict(dataset_kind="structured", text_columns=["a"]))

    def test_structured_without_text_columns_raises(self):
        with pytest.raises(ValueError, match="TEXT_COLUMNS is required"):
            Config.from_dict(_valid_dict(dataset_kind="structured", catalog_table_ref="ns.tbl"))

    def test_structured_with_catalog_ref_and_text_columns_succeeds(self):
        cfg = Config.from_dict(_valid_dict(
            dataset_kind="structured", catalog_table_ref="ns.tbl", text_columns=["a"],
        ))
        assert cfg.dataset_kind == "structured"

    def test_invalid_processing_mode_raises(self):
        with pytest.raises(ValueError, match="Invalid PROCESSING_MODE"):
            Config.from_dict(_valid_dict(processing_mode="partial"))

    def test_negative_embedding_batch_size_resets_to_64_with_warning(self):
        cfg = Config.from_dict(_valid_dict())
        cfg.embedding_batch_size = -1
        cfg.validate()
        assert cfg.embedding_batch_size == 64

    def test_very_large_embedding_batch_size_logs_warning_but_keeps_value(self):
        cfg = Config.from_dict(_valid_dict(embedding_batch_size=8192))
        assert cfg.embedding_batch_size == 8192
