"""Structured data source - reads from Iceberg tables via Lakekeeper catalog."""

from observability_client_runtime import get_logger
from typing import Iterator, List, Optional

from .base import DataSource, Document

logger = get_logger()


class StructuredDataSource(DataSource):
    """
    Data source for structured datasets.

    Reads data from Iceberg tables via Lakekeeper REST catalog
    and extracts text from user-specified columns.
    """

    def __init__(
        self,
        catalog_table_ref: str,
        lakekeeper_url: str,
        warehouse_id: str,
        token: str,
        text_columns: List[str],
        s3_endpoint: str,
        s3_access_key: str,
        s3_secret_key: str,
        s3_region: str = 'us-east-1'
    ):
        """
        Initialize structured data source.

        Args:
            catalog_table_ref: Full catalog reference (e.g., "namespace.table_name")
            lakekeeper_url: Lakekeeper catalog URL
            warehouse_id: Lakekeeper warehouse name (e.g. "nemo"), not project ID
            token: OAuth2 access token
            text_columns: List of column names to extract text from
            s3_endpoint: S3 endpoint URL
            s3_access_key: S3 access key
            s3_secret_key: S3 secret key
            s3_region: S3 region
        """
        self.catalog_table_ref = catalog_table_ref
        self.lakekeeper_url = lakekeeper_url
        self.warehouse_id = warehouse_id
        self.token = token
        self.text_columns = text_columns
        self.s3_endpoint = s3_endpoint
        self.s3_access_key = s3_access_key
        self.s3_secret_key = s3_secret_key
        self.s3_region = s3_region

        self._table = None
        self._arrow_table = None
        self._row_count = 0

    def connect(self) -> None:
        """Connect to Lakekeeper catalog and load the Iceberg table."""
        try:
            from pyiceberg.catalog.rest import RestCatalog
        except ImportError:
            raise RuntimeError("PyIceberg is required for structured datasets. Please install pyiceberg>=0.7.0")

        # Parse namespace and table name
        parts = self.catalog_table_ref.split('.', 1)
        if len(parts) != 2:
            raise ValueError(f"Invalid catalog_table_ref format: {self.catalog_table_ref}. Expected 'namespace.table_name'")

        namespace, table_name = parts
        logger.info(f"Connecting to table {namespace}.{table_name} in Lakekeeper catalog")

        # Build catalog URI
        catalog_uri = f"{self.lakekeeper_url}/catalog"

        # Catalog configuration with S3 credentials
        catalog_config = {
            "s3.endpoint": self.s3_endpoint,
            "s3.access-key-id": self.s3_access_key,
            "s3.secret-access-key": self.s3_secret_key,
            "s3.region": self.s3_region,
            "s3.path-style-access": "true",
            "s3.remote-signing-enabled": "false",
        }

        try:
            # Create PyIceberg REST catalog
            catalog = RestCatalog(
                name="lakekeeper",
                uri=catalog_uri,
                warehouse=self.warehouse_id,
                token=self.token,
                **catalog_config
            )
            logger.info(f"Connected to Lakekeeper catalog at {catalog_uri}")
        except Exception as e:
            logger.error(f"Failed to create PyIceberg catalog: {e}")
            raise

        # Load the table
        try:
            table_identifier = (namespace, table_name)
            self._table = catalog.load_table(table_identifier)
            logger.info(f"Loaded table {self.catalog_table_ref}")
        except Exception as e:
            raise RuntimeError(f"Table {self.catalog_table_ref} not found in catalog: {e}")

        # Validate text columns exist in schema
        schema_field_names = {field.name for field in self._table.schema().fields}
        missing_columns = set(self.text_columns) - schema_field_names
        if missing_columns:
            raise ValueError(
                f"Text columns not found in table schema: {missing_columns}. "
                f"Available columns: {schema_field_names}"
            )

        # Scan reads manifest and data files through the table FileIO, which does
        # not inherit RestCatalog s3.* kwargs. Reuse catalog_config so REST and
        # FileIO share the same S3 settings.
        logger.info(f"Scanning table {self.catalog_table_ref}...")
        self._table.io.properties.update(catalog_config)
        self._arrow_table = self._table.scan().to_arrow()
        self._row_count = self._arrow_table.num_rows

        logger.info(f"Connected to structured source: {self._row_count} rows, using columns: {self.text_columns}")

    def get_documents(self) -> Iterator[Document]:
        """Yield documents from Iceberg table rows."""
        if self._arrow_table is None:
            raise RuntimeError("DataSource not connected. Call connect() first.")

        for row_idx in range(self._arrow_table.num_rows):
            try:
                doc = self._process_row(row_idx)
                if doc:
                    yield doc
            except Exception as e:
                logger.warning(f"Error processing row {row_idx}: {e}")
                continue

    def _process_row(self, row_idx: int) -> Optional[Document]:
        """Extract text from a single row and create a Document."""
        # Extract values from specified text columns
        text_parts = []

        for col in self.text_columns:
            try:
                value = self._arrow_table.column(col)[row_idx].as_py()
                if value is not None:
                    # Format as "column_name: value" for semantic context
                    str_value = str(value).strip()
                    if str_value:
                        text_parts.append(f"{col}: {str_value}")
            except Exception as e:
                logger.debug(f"Could not extract column {col} from row {row_idx}: {e}")
                continue

        if not text_parts:
            logger.debug(f"No text content in row {row_idx}")
            return None

        # Combine text parts with newlines
        content = '\n'.join(text_parts)

        # Create document ID from row index
        doc_id = f"row_{row_idx}"

        # Build metadata
        metadata = {
            'row_index': row_idx,
            'table_ref': self.catalog_table_ref,
            'source_type': 'structured',
            'columns_used': self.text_columns,
        }

        return Document(doc_id=doc_id, content=content, metadata=metadata)

    def get_total_count(self) -> int:
        """Get total number of rows."""
        return self._row_count

    @property
    def source_type(self) -> str:
        """Return 'structured'."""
        return 'structured'
