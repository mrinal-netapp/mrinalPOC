"""Abstract base class for data sources."""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Iterator, Dict, Any


@dataclass
class Document:
    """Represents a document to be processed for embeddings."""

    doc_id: str
    content: str
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        """Validate document after initialization."""
        if not self.doc_id:
            raise ValueError("Document doc_id cannot be empty")
        if not self.content:
            raise ValueError("Document content cannot be empty")


class DataSource(ABC):
    """Abstract base class for data sources."""

    @abstractmethod
    def connect(self) -> None:
        """
        Establish connection to the data source.

        This method should be called before accessing documents.
        May involve connecting to S3, catalogs, or other services.
        """
        pass

    @abstractmethod
    def get_documents(self) -> Iterator[Document]:
        """
        Yield documents from the data source.

        Returns:
            Iterator of Document objects
        """
        pass

    @abstractmethod
    def get_total_count(self) -> int:
        """
        Get total number of documents/items in the data source.

        This is used for progress tracking.

        Returns:
            Total count of items
        """
        pass

    @property
    @abstractmethod
    def source_type(self) -> str:
        """
        Get the type of this data source.

        Returns:
            'unstructured' or 'structured'
        """
        pass
