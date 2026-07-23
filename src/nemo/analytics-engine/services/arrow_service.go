package services

import (
	"bytes"
	"fmt"
	"io"

	"github.com/apache/arrow-go/v18/arrow"
	"github.com/apache/arrow-go/v18/arrow/array"
	"github.com/apache/arrow-go/v18/arrow/ipc"
)

// ArrowReader interface matches what ExecuteQuery returns
type ArrowReader interface {
	Next() bool
	Record() arrow.Record
	Release()
	Err() error
}

// ConvertToArrowIPC converts an ArrowReader to Arrow IPC format
func ConvertToArrowIPC(reader ArrowReader) ([]byte, error) {
	var allRecords []arrow.Record
	var schema *arrow.Schema

	// Read all records from the reader
	for reader.Next() {
		record := reader.Record()
		if record == nil {
			continue
		}

		if schema == nil {
			schema = record.Schema()
		}

		// Retain the record since we're keeping it
		record.Retain()
		allRecords = append(allRecords, record)
	}

	if err := reader.Err(); err != nil {
		// Release all records on error
		for _, rec := range allRecords {
			rec.Release()
		}
		return nil, fmt.Errorf("error reading results: %w", err)
	}

	// If no records, create an empty record with the schema
	if len(allRecords) == 0 {
		if schema == nil {
			// Create a minimal schema if we have no records
			schema = arrow.NewSchema([]arrow.Field{}, nil)
		}
		// Create an empty record batch
		emptyRecord := array.NewRecord(schema, []arrow.Array{}, 0)
		emptyRecord.Retain()
		allRecords = append(allRecords, emptyRecord)
	}

	defer func() {
		// Release all records after serialization
		for _, rec := range allRecords {
			rec.Release()
		}
	}()

	// Serialize to Arrow IPC format
	var buf bytes.Buffer
	writer := ipc.NewWriter(&buf, ipc.WithSchema(schema))
	defer writer.Close()

	for _, record := range allRecords {
		if err := writer.Write(record); err != nil {
			return nil, fmt.Errorf("failed to write record: %w", err)
		}
	}

	if err := writer.Close(); err != nil {
		return nil, fmt.Errorf("failed to close writer: %w", err)
	}

	return buf.Bytes(), nil
}

// ConvertArrowIPCToRecords reads Arrow IPC format and returns records
// This is used for load-arrow endpoint
func ConvertArrowIPCToRecords(data []byte) ([]arrow.Record, error) {
	reader, err := ipc.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("failed to create IPC reader: %w", err)
	}
	defer reader.Release()

	var records []arrow.Record
	for reader.Next() {
		record := reader.Record()
		if record != nil {
			record.Retain()
			records = append(records, record)
		}
	}

	if err := reader.Err(); err != nil && err != io.EOF {
		// Release records on error
		for _, rec := range records {
			rec.Release()
		}
		return nil, fmt.Errorf("error reading IPC data: %w", err)
	}

	return records, nil
}
