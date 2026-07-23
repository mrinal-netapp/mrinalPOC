import { IcebergSchema } from './LakekeeperCatalogService';
import { CreateDataSetRequest } from './DataSetService';

/**
 * Builder for creating Iceberg schemas for datasets
 * Extracted from DataSetService for separation of concerns
 */
export class DataSetSchemaBuilder {
  /**
   * Create default Iceberg schema for a dataset
   * For unstructured datasets, creates a minimal schema
   * For structured datasets, schema should be provided via sqlQuery
   */
  static createDefaultSchema(data: CreateDataSetRequest): IcebergSchema {
    if (data.kind === 'structured') {
      // Structured datasets need proper schema - return minimal for now
      // Schema should be inferred from sqlQuery or provided explicitly
      return {
        type: 'struct',
        fields: [
          {
            id: 1,
            name: 'data',
            type: 'string',
            required: false,
            doc: 'Structured data record',
          },
        ],
      };
    } else {
      // Unstructured datasets - metadata schema matching processor.py output
      // The processor creates the definitive Iceberg table; this serves as
      // documentation and schema preview for the config-service layer.
      return {
        type: 'struct',
        fields: [
          {
            id: 1,
            name: 'file_path',
            type: 'string',
            required: false,
            doc: 'S3 path to the file',
          },
          {
            id: 2,
            name: 'file_name',
            type: 'string',
            required: false,
            doc: 'Original file name',
          },
          {
            id: 3,
            name: 'file_size',
            type: 'long',
            required: false,
            doc: 'File size in bytes',
          },
          {
            id: 4,
            name: 'extension',
            type: 'string',
            required: false,
            doc: 'File extension (e.g. .pdf, .png)',
          },
          {
            id: 5,
            name: 'mime_type',
            type: 'string',
            required: false,
            doc: 'MIME type of the file',
          },
          {
            id: 6,
            name: 'checksum',
            type: 'string',
            required: false,
            doc: 'SHA-256 checksum',
          },
          {
            id: 7,
            name: 'created_time',
            type: 'timestamptz',
            required: false,
            doc: 'File creation timestamp',
          },
          {
            id: 8,
            name: 'modified_time',
            type: 'timestamptz',
            required: false,
            doc: 'File last-modified timestamp',
          },
          {
            id: 9,
            name: 'pii_entities',
            type: 'string',
            required: false,
            doc: 'JSON array of detected PII entity types (e.g. ["US_SSN","PERSON"])',
          },
          {
            id: 10,
            name: 'pii_count',
            type: 'long',
            required: false,
            doc: 'Total number of PII entities detected in this file',
          },
          {
            id: 11,
            name: 'sensitivity_class',
            type: 'string',
            required: false,
            doc: 'Image/content sensitivity: sensitive, public, unknown, or not_applicable',
          },
          {
            id: 12,
            name: 'has_pii',
            type: 'boolean',
            required: false,
            doc: 'True if any PII was detected in this file',
          },
        ],
      };
    }
  }
}
