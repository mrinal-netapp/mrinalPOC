package services

import (
	"fmt"
	"testing"

	"github.com/apache/arrow-go/v18/arrow"
	"github.com/apache/arrow-go/v18/arrow/array"
	"github.com/apache/arrow-go/v18/arrow/memory"
)

// mockArrowReader is a test implementation of ArrowReader.
type mockArrowReader struct {
	records []arrow.Record
	pos     int
	err     error
	schema  *arrow.Schema
}

func (m *mockArrowReader) Next() bool {
	if m.err != nil {
		return false
	}
	if m.pos < len(m.records) {
		m.pos++
		return true
	}
	return false
}

func (m *mockArrowReader) Record() arrow.Record {
	if m.pos == 0 || m.pos > len(m.records) {
		return nil
	}
	return m.records[m.pos-1]
}

func (m *mockArrowReader) Release() {}

func (m *mockArrowReader) Err() error { return m.err }

// buildInt64Record creates a simple Arrow record with one int64 column.
func buildInt64Record(t *testing.T, values []int64) arrow.Record {
	t.Helper()
	schema := arrow.NewSchema([]arrow.Field{
		{Name: "value", Type: arrow.PrimitiveTypes.Int64, Nullable: false},
	}, nil)

	bldr := array.NewInt64Builder(memory.DefaultAllocator)
	defer bldr.Release()
	bldr.AppendValues(values, nil)
	col := bldr.NewArray()
	defer col.Release()

	return array.NewRecord(schema, []arrow.Array{col}, int64(len(values)))
}

// --- ConvertToArrowIPC ---

func TestConvertToArrowIPC_Empty(t *testing.T) {
	reader := &mockArrowReader{}
	data, err := ConvertToArrowIPC(reader)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(data) == 0 {
		t.Error("expected non-empty IPC bytes even for empty reader")
	}
}

func TestConvertToArrowIPC_WithRecords(t *testing.T) {
	rec := buildInt64Record(t, []int64{1, 2, 3})
	defer rec.Release()

	reader := &mockArrowReader{records: []arrow.Record{rec}}
	data, err := ConvertToArrowIPC(reader)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(data) == 0 {
		t.Error("expected non-empty IPC bytes")
	}
}

func TestConvertToArrowIPC_ReaderError(t *testing.T) {
	reader := &mockArrowReader{err: fmt.Errorf("read failed")}
	_, err := ConvertToArrowIPC(reader)
	if err == nil {
		t.Error("expected error from reader, got nil")
	}
}

// --- ConvertArrowIPCToRecords ---

func TestConvertArrowIPCToRecords_RoundTrip(t *testing.T) {
	rec := buildInt64Record(t, []int64{10, 20, 30})
	defer rec.Release()

	reader := &mockArrowReader{records: []arrow.Record{rec}}
	ipcData, err := ConvertToArrowIPC(reader)
	if err != nil {
		t.Fatalf("ConvertToArrowIPC failed: %v", err)
	}

	records, err := ConvertArrowIPCToRecords(ipcData)
	if err != nil {
		t.Fatalf("ConvertArrowIPCToRecords failed: %v", err)
	}
	defer func() {
		for _, r := range records {
			r.Release()
		}
	}()

	if len(records) == 0 {
		t.Fatal("expected at least one record")
	}
	if records[0].NumRows() != 3 {
		t.Errorf("expected 3 rows, got %d", records[0].NumRows())
	}
}

func TestConvertArrowIPCToRecords_Malformed(t *testing.T) {
	_, err := ConvertArrowIPCToRecords([]byte("this is not arrow IPC"))
	if err == nil {
		t.Error("expected error for malformed IPC data, got nil")
	}
}

func TestConvertArrowIPCToRecords_Empty(t *testing.T) {
	_, err := ConvertArrowIPCToRecords([]byte{})
	if err == nil {
		t.Error("expected error for empty IPC data, got nil")
	}
}

func TestConvertArrowIPCToRecords_EmptyPayload(t *testing.T) {
	// Produce a legitimate IPC stream with zero records
	reader := &mockArrowReader{}
	ipcData, err := ConvertToArrowIPC(reader)
	if err != nil {
		t.Fatal(err)
	}

	records, err := ConvertArrowIPCToRecords(ipcData)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// May return 0 or 1 empty record depending on how the IPC was written
	_ = records
}
