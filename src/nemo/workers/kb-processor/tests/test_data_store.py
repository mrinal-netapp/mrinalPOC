"""Unit tests for utils/data_store.py: POSIX storage helpers backed by
NEMO_DEFAULT_STORE_ROOT. None of these had direct test coverage before.
"""

import json
import os
import tempfile
from pathlib import Path

import pytest

from utils.data_store import (
    default_store_root,
    delete_tree,
    download_file,
    list_files,
    list_subdirs,
    posix_path,
    put_json_object,
    read_json_object,
    upload_directory,
)


@pytest.fixture
def mount(monkeypatch):
    tmp = tempfile.mkdtemp()
    monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", tmp)
    return Path(tmp)


class TestDefaultStoreRoot:
    def test_returns_configured_root(self, mount):
        assert default_store_root() == str(mount)

    def test_raises_when_unset(self, monkeypatch):
        monkeypatch.delenv("NEMO_DEFAULT_STORE_ROOT", raising=False)
        with pytest.raises(RuntimeError, match="NEMO_DEFAULT_STORE_ROOT"):
            default_store_root()

    def test_raises_when_blank(self, monkeypatch):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", "   ")
        with pytest.raises(RuntimeError):
            default_store_root()


class TestPosixPath:
    def test_joins_root_and_key(self, mount):
        assert posix_path("a/b.txt") == mount / "a/b.txt"


class TestUploadDirectory:
    def test_copies_nested_files_preserving_structure(self, mount):
        src = Path(tempfile.mkdtemp())
        (src / "sub").mkdir()
        (src / "top.txt").write_text("top")
        (src / "sub" / "nested.txt").write_text("nested")

        upload_directory(src, "dest")

        assert (mount / "dest" / "top.txt").read_text() == "top"
        assert (mount / "dest" / "sub" / "nested.txt").read_text() == "nested"

    def test_empty_directory_is_a_no_op(self, mount):
        src = Path(tempfile.mkdtemp())
        upload_directory(src, "dest")
        assert not (mount / "dest").exists() or list((mount / "dest").iterdir()) == []


class TestDownloadFile:
    def test_copies_from_mount_to_local_path(self, mount):
        src_key = "data/file.txt"
        (mount / "data").mkdir(parents=True)
        (mount / src_key).write_text("hello")

        local_dest = Path(tempfile.mkdtemp()) / "nested" / "out.txt"
        download_file(src_key, local_dest)

        assert local_dest.read_text() == "hello"

    def test_creates_parent_dirs_for_local_path(self, mount):
        (mount / "a.txt").write_text("x")
        local_dest = Path(tempfile.mkdtemp()) / "deep" / "nested" / "dir" / "a.txt"
        download_file("a.txt", local_dest)
        assert local_dest.read_text() == "x"


class TestJsonObjectRoundtrip:
    def test_put_then_read_roundtrip(self, mount):
        put_json_object("meta/info.json", {"a": 1, "b": [1, 2, 3]})
        result = read_json_object("meta/info.json")
        assert result == {"a": 1, "b": [1, 2, 3]}

    def test_put_creates_parent_directories(self, mount):
        put_json_object("deep/nested/path/info.json", {"x": 1})
        assert (mount / "deep/nested/path/info.json").is_file()

    def test_put_is_atomic_via_tmp_rename(self, mount):
        put_json_object("info.json", {"x": 1})
        assert not (mount / "info.json.tmp").exists()
        assert (mount / "info.json").is_file()

    def test_read_missing_returns_none(self, mount):
        assert read_json_object("does/not/exist.json") is None

    def test_read_raises_on_malformed_json(self, mount):
        p = mount / "bad.json"
        p.write_text("not valid json")
        with pytest.raises(json.JSONDecodeError):
            read_json_object("bad.json")


class TestListFiles:
    def test_lists_files_recursively_with_prefix(self, mount):
        (mount / "kb1" / "sub").mkdir(parents=True)
        (mount / "kb1" / "a.txt").write_text("a")
        (mount / "kb1" / "sub" / "b.txt").write_text("b")

        result = list_files("kb1")
        assert result == ["kb1/a.txt", "kb1/sub/b.txt"]

    def test_missing_prefix_returns_empty_list(self, mount):
        assert list_files("does/not/exist") == []

    def test_ignores_directories_in_listing(self, mount):
        (mount / "kb1" / "emptydir").mkdir(parents=True)
        (mount / "kb1" / "file.txt").write_text("x")
        result = list_files("kb1")
        assert result == ["kb1/file.txt"]


class TestListSubdirs:
    def test_lists_immediate_subdirs_only(self, mount):
        (mount / "kb1" / "run-1").mkdir(parents=True)
        (mount / "kb1" / "run-2" / "nested").mkdir(parents=True)
        (mount / "kb1" / "file.txt").write_text("x")

        result = list_subdirs("kb1")
        assert result == ["kb1/run-1", "kb1/run-2"]

    def test_missing_prefix_returns_empty_list(self, mount):
        assert list_subdirs("does/not/exist") == []

    def test_ignores_files_in_listing(self, mount):
        (mount / "kb1").mkdir(parents=True)
        (mount / "kb1" / "file.txt").write_text("x")
        assert list_subdirs("kb1") == []


class TestDeleteTree:
    def test_removes_directory_tree(self, mount):
        (mount / "kb1" / "sub").mkdir(parents=True)
        (mount / "kb1" / "sub" / "a.txt").write_text("a")

        delete_tree("kb1")

        assert not (mount / "kb1").exists()

    def test_removes_single_file(self, mount):
        (mount / "a.txt").write_text("a")
        delete_tree("a.txt")
        assert not (mount / "a.txt").exists()

    def test_missing_prefix_is_a_no_op(self, mount):
        delete_tree("does/not/exist")  # must not raise
