"""Unit tests for Iceberg/catalog helpers in processing.files:

- `pyarrow_type_to_iceberg` (all type-mapping branches)
- `build_iceberg_schema`
- `pyarrow_to_pyiceberg_type` / `build_pyiceberg_schema` (require pyiceberg)
- `_iceberg_type_to_pyarrow`
- `_cast_parquet_table_to_iceberg_schema`
- `_configure_table_io_for_static_credentials`
- `register_table_with_pyiceberg` (deeper: namespace/create-table, schema evolution,
  RestCatalog construction, HAS_PYICEBERG guard)
"""

import unittest
from types import SimpleNamespace
from unittest import mock

import pyarrow as pa
import pytest

from processing.config import Config
from processing import files as files_mod
from processing.files import (
    _cast_parquet_table_to_iceberg_schema,
    _configure_table_io_for_static_credentials,
    _iceberg_type_to_pyarrow,
    build_iceberg_schema,
    build_pyiceberg_schema,
    pyarrow_to_pyiceberg_type,
    pyarrow_type_to_iceberg,
    register_table_with_pyiceberg,
)

pyiceberg = pytest.importorskip("pyiceberg", reason="pyiceberg not installed")
from pyiceberg.types import (
    BinaryType, BooleanType, DateType, DoubleType, FloatType, IntegerType,
    LongType, StringType, TimestampType, TimestamptzType,
)


def _minimal_config(**overrides) -> Config:
    base = {
        "dataset_id": "ds-test",
        "dataset_name": "test-ds",
        "project_id": "proj-1",
        "bucket_name": "bucket",
        "project_client_id": "cid",
        "project_client_secret": "secret",
        "aws_access_key_id": "ak",
        "aws_secret_access_key": "sk",
        "s3_endpoint": "http://s3:7070",
    }
    base.update(overrides)
    return Config.from_dict(base)


class TestPyarrowTypeToIcebergAllBranches(unittest.TestCase):
    def test_integer_variants(self):
        self.assertEqual(pyarrow_type_to_iceberg(pa.int8()), "int")
        self.assertEqual(pyarrow_type_to_iceberg(pa.int16()), "int")
        self.assertEqual(pyarrow_type_to_iceberg(pa.int32()), "int")
        self.assertEqual(pyarrow_type_to_iceberg(pa.int64()), "long")
        self.assertEqual(pyarrow_type_to_iceberg(pa.uint8()), "int")
        self.assertEqual(pyarrow_type_to_iceberg(pa.uint16()), "int")
        self.assertEqual(pyarrow_type_to_iceberg(pa.uint32()), "long")
        self.assertEqual(pyarrow_type_to_iceberg(pa.uint64()), "long")

    def test_float_variants(self):
        # NB: str(pa.float16()) == "halffloat", which doesn't match the
        # "float16" key in the mapping table, so it falls through to the
        # generic "string" default -- this reflects actual current behavior.
        self.assertEqual(pyarrow_type_to_iceberg(pa.float16()), "string")
        self.assertEqual(pyarrow_type_to_iceberg(pa.float32()), "float")
        self.assertEqual(pyarrow_type_to_iceberg(pa.float64()), "double")

    def test_bool_and_string_and_binary(self):
        self.assertEqual(pyarrow_type_to_iceberg(pa.bool_()), "boolean")
        self.assertEqual(pyarrow_type_to_iceberg(pa.string()), "string")
        self.assertEqual(pyarrow_type_to_iceberg(pa.large_string()), "string")
        self.assertEqual(pyarrow_type_to_iceberg(pa.binary()), "binary")
        self.assertEqual(pyarrow_type_to_iceberg(pa.large_binary()), "binary")

    def test_date_variants(self):
        # NB: str(pa.date32()) == "date32[day]" (with a unit suffix), which
        # doesn't match the exact "date32"/"date64" keys in the mapping table
        # and there's no prefix-check for dates, so both fall through to the
        # generic "string" default -- this reflects actual current behavior.
        self.assertEqual(pyarrow_type_to_iceberg(pa.date32()), "string")
        self.assertEqual(pyarrow_type_to_iceberg(pa.date64()), "string")

    def test_timestamp_without_tz(self):
        self.assertEqual(pyarrow_type_to_iceberg(pa.timestamp("us")), "timestamp")

    def test_timestamp_with_tz(self):
        self.assertEqual(pyarrow_type_to_iceberg(pa.timestamp("us", tz="UTC")), "timestamptz")

    def test_time_variants(self):
        self.assertEqual(pyarrow_type_to_iceberg(pa.time32("s")), "time")
        self.assertEqual(pyarrow_type_to_iceberg(pa.time64("us")), "time")

    def test_decimal_with_precision_scale(self):
        self.assertEqual(pyarrow_type_to_iceberg(pa.decimal128(10, 2)), "decimal(10, 2)")

    def test_unknown_type_falls_back_to_string(self):
        # struct types have no explicit mapping and don't match any prefix rule.
        self.assertEqual(pyarrow_type_to_iceberg(pa.struct([("a", pa.string())])), "string")


class TestBuildIcebergSchema(unittest.TestCase):
    def test_required_flag_reflects_nullability(self):
        schema = pa.schema([
            pa.field("id", pa.int64(), nullable=False),
            pa.field("name", pa.string(), nullable=True),
        ])
        out = build_iceberg_schema(schema)
        self.assertTrue(out["fields"][0]["required"])
        self.assertFalse(out["fields"][1]["required"])
        self.assertEqual(out["fields"][0]["id"], 1)
        self.assertEqual(out["fields"][1]["id"], 2)


class TestPyarrowToPyicebergType(unittest.TestCase):
    def test_raises_when_pyiceberg_unavailable(self):
        with mock.patch.object(files_mod, "HAS_PYICEBERG", False):
            with self.assertRaises(RuntimeError):
                pyarrow_to_pyiceberg_type(pa.int64())

    def test_int64_maps_to_long(self):
        self.assertIsInstance(pyarrow_to_pyiceberg_type(pa.int64()), LongType)

    def test_uint64_maps_to_long(self):
        self.assertIsInstance(pyarrow_to_pyiceberg_type(pa.uint64()), LongType)

    def test_generic_int_maps_to_integer(self):
        self.assertIsInstance(pyarrow_to_pyiceberg_type(pa.int32()), IntegerType)

    def test_float32_maps_to_float(self):
        self.assertIsInstance(pyarrow_to_pyiceberg_type(pa.float32()), FloatType)

    def test_double_maps_to_double(self):
        self.assertIsInstance(pyarrow_to_pyiceberg_type(pa.float64()), DoubleType)

    def test_bool_maps_to_boolean(self):
        self.assertIsInstance(pyarrow_to_pyiceberg_type(pa.bool_()), BooleanType)

    def test_timestamp_with_tz_maps_to_timestamptz(self):
        self.assertIsInstance(pyarrow_to_pyiceberg_type(pa.timestamp("us", tz="UTC")), TimestamptzType)

    def test_timestamp_without_tz_maps_to_timestamp(self):
        self.assertIsInstance(pyarrow_to_pyiceberg_type(pa.timestamp("us")), TimestampType)

    def test_date_maps_to_date(self):
        self.assertIsInstance(pyarrow_to_pyiceberg_type(pa.date32()), DateType)

    def test_binary_maps_to_binary(self):
        self.assertIsInstance(pyarrow_to_pyiceberg_type(pa.binary()), BinaryType)

    def test_unknown_defaults_to_string(self):
        self.assertIsInstance(pyarrow_to_pyiceberg_type(pa.struct([("a", pa.string())])), StringType)


class TestBuildPyicebergSchema(unittest.TestCase):
    def test_raises_when_pyiceberg_unavailable(self):
        with mock.patch.object(files_mod, "HAS_PYICEBERG", False):
            with self.assertRaises(RuntimeError):
                build_pyiceberg_schema(pa.schema([("id", pa.int64())]))

    def test_builds_schema_with_field_ids(self):
        schema = pa.schema([
            pa.field("id", pa.int64(), nullable=False),
            pa.field("name", pa.string(), nullable=True),
        ])
        iceberg_schema = build_pyiceberg_schema(schema)
        fields = list(iceberg_schema.fields)
        self.assertEqual(len(fields), 2)
        self.assertEqual(fields[0].field_id, 1)
        self.assertEqual(fields[0].name, "id")
        self.assertTrue(fields[0].required)
        self.assertFalse(fields[1].required)


class TestIcebergTypeToPyarrow(unittest.TestCase):
    def test_string_type(self):
        self.assertEqual(_iceberg_type_to_pyarrow(StringType()), pa.string())

    def test_long_type(self):
        self.assertEqual(_iceberg_type_to_pyarrow(LongType()), pa.int64())

    def test_integer_type(self):
        self.assertEqual(_iceberg_type_to_pyarrow(IntegerType()), pa.int32())

    def test_boolean_type(self):
        self.assertEqual(_iceberg_type_to_pyarrow(BooleanType()), pa.bool_())

    def test_timestamptz_type(self):
        self.assertEqual(_iceberg_type_to_pyarrow(TimestamptzType()), pa.timestamp("us", tz="UTC"))

    def test_timestamp_type(self):
        self.assertEqual(_iceberg_type_to_pyarrow(TimestampType()), pa.timestamp("us"))

    def test_date_type(self):
        self.assertEqual(_iceberg_type_to_pyarrow(DateType()), pa.date32())

    def test_float_type(self):
        self.assertEqual(_iceberg_type_to_pyarrow(FloatType()), pa.float32())

    def test_double_type(self):
        self.assertEqual(_iceberg_type_to_pyarrow(DoubleType()), pa.float64())

    def test_binary_type(self):
        self.assertEqual(_iceberg_type_to_pyarrow(BinaryType()), pa.binary())

    def test_unknown_defaults_to_string(self):
        self.assertEqual(_iceberg_type_to_pyarrow(object()), pa.string())


class _FakeIcebergField:
    def __init__(self, name, field_type):
        self.name = name
        self.field_type = field_type


class _FakeIcebergSchema:
    def __init__(self, fields):
        self.fields = fields


class TestCastParquetTableToIcebergSchema(unittest.TestCase):
    def _fake_table(self, fields):
        return SimpleNamespace(schema=lambda: _FakeIcebergSchema(fields))

    def test_missing_column_filled_with_nulls(self):
        parquet_table = pa.table({"a": [1, 2]})
        table = self._fake_table([_FakeIcebergField("b", StringType())])
        out = _cast_parquet_table_to_iceberg_schema(parquet_table, table)
        self.assertEqual(out.num_rows, 2)
        self.assertIsNone(out.column("b")[0].as_py())

    def test_matching_type_passthrough(self):
        parquet_table = pa.table({"a": pa.array([1, 2], type=pa.int64())})
        table = self._fake_table([_FakeIcebergField("a", LongType())])
        out = _cast_parquet_table_to_iceberg_schema(parquet_table, table)
        self.assertEqual(out.column("a").to_pylist(), [1, 2])

    def test_timestamp_to_string_conversion(self):
        parquet_table = pa.table({
            "a": pa.array([1704067200000000], type=pa.timestamp("us")),
        })
        table = self._fake_table([_FakeIcebergField("a", StringType())])
        out = _cast_parquet_table_to_iceberg_schema(parquet_table, table)
        self.assertIn("2024", out.column("a")[0].as_py())

    def test_timestamp_to_timestamp_cast(self):
        parquet_table = pa.table({
            "a": pa.array([1704067200000000], type=pa.timestamp("us", tz="UTC")),
        })
        table = self._fake_table([_FakeIcebergField("a", TimestampType())])
        out = _cast_parquet_table_to_iceberg_schema(parquet_table, table)
        self.assertEqual(out.schema.field("a").type, pa.timestamp("us"))

    def test_boolean_to_string_conversion(self):
        parquet_table = pa.table({"a": pa.array([True, False, None])})
        table = self._fake_table([_FakeIcebergField("a", StringType())])
        out = _cast_parquet_table_to_iceberg_schema(parquet_table, table)
        self.assertEqual(out.column("a").to_pylist(), ["True", "False", None])

    def test_integer_to_string_conversion(self):
        parquet_table = pa.table({"a": pa.array([1, 2, None])})
        table = self._fake_table([_FakeIcebergField("a", StringType())])
        out = _cast_parquet_table_to_iceberg_schema(parquet_table, table)
        self.assertEqual(out.column("a").to_pylist(), ["1", "2", None])

    def test_generic_cast_via_compute(self):
        parquet_table = pa.table({"a": pa.array([1, 2], type=pa.int32())})
        table = self._fake_table([_FakeIcebergField("a", LongType())])
        out = _cast_parquet_table_to_iceberg_schema(parquet_table, table)
        self.assertEqual(out.column("a").to_pylist(), [1, 2])

    def test_doubly_incompatible_cast_raises(self):
        # cast(list<int64>, int64) hits the generic `else` branch, fails with
        # ArrowNotImplementedError, and is caught -- but the fallback tries to
        # build a *string* representation into an int64-typed pa.array(), which
        # itself raises ArrowInvalid uncaught. This documents a real limitation
        # of the double-fallback path for list-typed columns rather than
        # asserting silently-corrupted output.
        parquet_table = pa.table({"a": pa.array([[1, 2]], type=pa.list_(pa.int64()))})
        table = self._fake_table([_FakeIcebergField("a", LongType())])
        with self.assertRaises(pa.lib.ArrowInvalid):
            _cast_parquet_table_to_iceberg_schema(parquet_table, table)


class TestConfigureTableIoForStaticCredentials(unittest.TestCase):
    def test_sets_properties_dict(self):
        config = _minimal_config(aws_region="us-east-1")
        io_props = {"s3.signer": "x", "s3.signer.uri": "y", "s3.signer.endpoint": "z"}
        table = SimpleNamespace(io=SimpleNamespace(properties=io_props))
        _configure_table_io_for_static_credentials(table, config)
        self.assertEqual(io_props["s3.access-key-id"], "ak")
        self.assertEqual(io_props["s3.secret-access-key"], "sk")
        self.assertEqual(io_props["s3.path-style-access"], "true")
        self.assertNotIn("s3.signer", io_props)
        self.assertNotIn("s3.signer.uri", io_props)
        self.assertNotIn("s3.signer.endpoint", io_props)

    def test_falls_back_to_private_properties_attr(self):
        config = _minimal_config()
        io_props = {}
        # A Mock with an explicit spec has no "properties" attribute at all,
        # so hasattr(table_io, "properties") is False and the code must fall
        # back to the private "_properties" attribute.
        table_io = mock.Mock(spec=["_properties"])
        table_io._properties = io_props
        table = SimpleNamespace(io=table_io)
        _configure_table_io_for_static_credentials(table, config)
        self.assertEqual(io_props["s3.access-key-id"], "ak")

    def test_no_properties_attr_is_noop(self):
        config = _minimal_config()
        table = SimpleNamespace(io=mock.Mock(spec=[]))
        _configure_table_io_for_static_credentials(table, config)  # should not raise

    def test_default_s3_endpoint_used_when_not_configured(self):
        config = _minimal_config()
        config.s3_endpoint = ""
        io_props = {}
        table = SimpleNamespace(io=SimpleNamespace(properties=io_props))
        _configure_table_io_for_static_credentials(table, config)
        self.assertEqual(io_props["s3.endpoint"], "http://s3gateway:7070")


class TestRegisterTableWithPyicebergDeep(unittest.TestCase):
    def setUp(self):
        self.cfg = _minimal_config(warehouse_id="wh")

    def test_raises_when_pyiceberg_unavailable(self):
        with mock.patch.object(files_mod, "HAS_PYICEBERG", False):
            with self.assertRaises(RuntimeError):
                register_table_with_pyiceberg(self.cfg, object(), None)

    def test_creates_namespace_and_table_when_absent(self):
        table = mock.Mock()
        table.schema.return_value = SimpleNamespace(fields=[])
        catalog = mock.Mock()
        catalog.load_table.side_effect = Exception("not found")
        catalog.create_table.return_value = table

        with mock.patch.object(files_mod, "HAS_PYICEBERG", True), \
             mock.patch.object(files_mod, "RestCatalog", create=True, return_value=catalog) as rest_catalog_cls, \
             mock.patch.object(files_mod, "build_pyiceberg_schema", return_value=object()), \
             mock.patch.object(files_mod, "_configure_table_io_for_static_credentials"), \
             mock.patch.object(Config, "get_access_token", return_value="tok"):
            ref = register_table_with_pyiceberg(self.cfg, object(), None)

        catalog.create_namespace.assert_called_once_with(self.cfg.namespace)
        catalog.create_table.assert_called_once()
        self.assertEqual(ref, f"{self.cfg.namespace}.{self.cfg.dataset_name}")
        rest_catalog_cls.assert_called_once()

    def test_namespace_already_exists_error_is_swallowed(self):
        table = mock.Mock()
        table.schema.return_value = SimpleNamespace(fields=[])
        catalog = mock.Mock()
        catalog.load_table.side_effect = Exception("not found")
        catalog.create_namespace.side_effect = Exception("Namespace already exists")
        catalog.create_table.return_value = table

        with mock.patch.object(files_mod, "HAS_PYICEBERG", True), \
             mock.patch.object(files_mod, "RestCatalog", create=True, return_value=catalog), \
             mock.patch.object(files_mod, "build_pyiceberg_schema", return_value=object()), \
             mock.patch.object(files_mod, "_configure_table_io_for_static_credentials"), \
             mock.patch.object(Config, "get_access_token", return_value="tok"):
            register_table_with_pyiceberg(self.cfg, object(), None)
        # Should not raise even though create_namespace failed with "already exists".

    def test_namespace_other_error_is_logged_not_raised(self):
        table = mock.Mock()
        table.schema.return_value = SimpleNamespace(fields=[])
        catalog = mock.Mock()
        catalog.load_table.side_effect = Exception("not found")
        catalog.create_namespace.side_effect = Exception("permission denied")
        catalog.create_table.return_value = table

        with mock.patch.object(files_mod, "HAS_PYICEBERG", True), \
             mock.patch.object(files_mod, "RestCatalog", create=True, return_value=catalog), \
             mock.patch.object(files_mod, "build_pyiceberg_schema", return_value=object()), \
             mock.patch.object(files_mod, "_configure_table_io_for_static_credentials"), \
             mock.patch.object(Config, "get_access_token", return_value="tok"):
            register_table_with_pyiceberg(self.cfg, object(), None)

    def test_custom_location_uses_s3_path_prefix_when_set(self):
        table = mock.Mock()
        table.schema.return_value = SimpleNamespace(fields=[])
        catalog = mock.Mock()
        catalog.load_table.side_effect = Exception("not found")
        catalog.create_table.return_value = table
        cfg = _minimal_config(warehouse_id="wh", s3_path_prefix="prefix1")

        with mock.patch.object(files_mod, "HAS_PYICEBERG", True), \
             mock.patch.object(files_mod, "RestCatalog", create=True, return_value=catalog), \
             mock.patch.object(files_mod, "build_pyiceberg_schema", return_value=object()), \
             mock.patch.object(files_mod, "_configure_table_io_for_static_credentials"), \
             mock.patch.object(Config, "get_access_token", return_value="tok"):
            register_table_with_pyiceberg(cfg, object(), None)

        _, kwargs = catalog.create_table.call_args
        self.assertIn("prefix1/datasets", kwargs["location"])

    def test_schema_evolution_adds_missing_columns(self):
        table = mock.Mock()
        table.schema.return_value = SimpleNamespace(fields=[SimpleNamespace(name="existing")])
        schema_update_cm = mock.MagicMock()
        table.update_schema.return_value = schema_update_cm
        catalog = mock.Mock()
        catalog.load_table.return_value = table

        parquet_table = SimpleNamespace(
            column_names=["existing", "new_col"],
            schema=pa.schema([("existing", pa.string()), ("new_col", pa.int64())]),
        )

        with mock.patch.object(files_mod, "HAS_PYICEBERG", True), \
             mock.patch.object(files_mod, "RestCatalog", create=True, return_value=catalog), \
             mock.patch.object(files_mod, "build_pyiceberg_schema", return_value=object()), \
             mock.patch.object(files_mod, "_configure_table_io_for_static_credentials"), \
             mock.patch.object(files_mod, "_cast_parquet_table_to_iceberg_schema", return_value=parquet_table), \
             mock.patch.object(files_mod.pq, "read_table", return_value=parquet_table), \
             mock.patch.object(Config, "get_access_token", return_value="tok"):
            register_table_with_pyiceberg(self.cfg, object(), "/tmp/x.parquet")

        schema_update_cm.__enter__.return_value.add_column.assert_called_once()
        table.refresh.assert_called_once()

    def test_no_parquet_file_path_skips_write(self):
        table = mock.Mock()
        table.schema.return_value = SimpleNamespace(fields=[])
        catalog = mock.Mock()
        catalog.load_table.return_value = table

        with mock.patch.object(files_mod, "HAS_PYICEBERG", True), \
             mock.patch.object(files_mod, "RestCatalog", create=True, return_value=catalog), \
             mock.patch.object(files_mod, "build_pyiceberg_schema", return_value=object()), \
             mock.patch.object(files_mod, "_configure_table_io_for_static_credentials"), \
             mock.patch.object(Config, "get_access_token", return_value="tok"):
            register_table_with_pyiceberg(self.cfg, object(), None)

        table.append.assert_not_called()
        table.overwrite.assert_not_called()

    def test_session_token_env_var_popped(self):
        import os
        os.environ["AWS_SESSION_TOKEN"] = "stale-token"
        table = mock.Mock()
        table.schema.return_value = SimpleNamespace(fields=[])
        catalog = mock.Mock()
        catalog.load_table.return_value = table

        try:
            with mock.patch.object(files_mod, "HAS_PYICEBERG", True), \
                 mock.patch.object(files_mod, "RestCatalog", create=True, return_value=catalog), \
                 mock.patch.object(files_mod, "build_pyiceberg_schema", return_value=object()), \
                 mock.patch.object(files_mod, "_configure_table_io_for_static_credentials"), \
                 mock.patch.object(Config, "get_access_token", return_value="tok"):
                register_table_with_pyiceberg(self.cfg, object(), None)
            self.assertNotIn("AWS_SESSION_TOKEN", os.environ)
        finally:
            os.environ.pop("AWS_SESSION_TOKEN", None)


if __name__ == "__main__":
    unittest.main()
