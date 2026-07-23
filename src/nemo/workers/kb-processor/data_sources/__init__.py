"""Data source modules for KB processor."""

from .base import DataSource, Document
from .unstructured import UnstructuredDataSource
from .structured import StructuredDataSource

__all__ = [
    'DataSource',
    'Document',
    'UnstructuredDataSource',
    'StructuredDataSource',
]
