package handlers

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/apache/arrow-go/v18/arrow"
	"github.com/apache/arrow-go/v18/arrow/array"
	"github.com/apache/arrow-go/v18/arrow/memory"
)

// --- isPiiColumn ---

func TestIsPiiColumn_PiiColumns(t *testing.T) {
	piiCols := []string{"pii_entities", "pii_count", "pii_risk_level", "sensitivity_class", "has_pii"}
	for _, col := range piiCols {
		if !isPiiColumn(col) {
			t.Errorf("expected isPiiColumn(%q) = true", col)
		}
		if !isPiiColumn(strings.ToUpper(col)) {
			t.Errorf("expected isPiiColumn(%q) = true (uppercase)", strings.ToUpper(col))
		}
	}
}

func TestIsPiiColumn_NonPiiColumns(t *testing.T) {
	nonPii := []string{"id", "name", "email", "amount", "created_at", ""}
	for _, col := range nonPii {
		if isPiiColumn(col) {
			t.Errorf("expected isPiiColumn(%q) = false", col)
		}
	}
}

// --- projectionFromColumns ---

func TestProjectionFromColumns_WithView(t *testing.T) {
	cols := []string{"id", "name", "pii_entities", "has_pii", "amount"}
	result := projectionFromColumns(cols, "with")
	if result != nil {
		t.Error("expected nil for piiView='with' (select all)")
	}
}

func TestProjectionFromColumns_EmptyView(t *testing.T) {
	cols := []string{"id", "name", "pii_entities"}
	result := projectionFromColumns(cols, "")
	if result != nil {
		t.Error("expected nil for empty piiView")
	}
}

func TestProjectionFromColumns_WithoutView(t *testing.T) {
	cols := []string{"id", "name", "pii_entities", "has_pii", "amount"}
	result := projectionFromColumns(cols, "without")
	if result == nil {
		t.Fatal("expected non-nil result for piiView='without'")
	}
	for _, c := range result {
		if isPiiColumn(c) {
			t.Errorf("PII column %q should be excluded", c)
		}
	}
	if len(result) != 3 { // id, name, amount
		t.Errorf("expected 3 columns, got %d: %v", len(result), result)
	}
}

func TestProjectionFromColumns_BothView(t *testing.T) {
	// "both" is handled at the handler level; projectionFromColumns returns nil
	cols := []string{"id", "pii_entities"}
	result := projectionFromColumns(cols, "both")
	if result != nil {
		t.Errorf("expected nil for piiView='both' (handled elsewhere), got %v", result)
	}
}

// --- filterRowToColumns ---

func TestFilterRowToColumns_KeepAll(t *testing.T) {
	cols := []string{"a", "b", "c"}
	row := []interface{}{1, 2, 3}
	keep := map[string]struct{}{"a": {}, "b": {}, "c": {}}
	result := filterRowToColumns(row, cols, keep)
	if len(result) != 3 {
		t.Errorf("expected 3 values, got %d", len(result))
	}
}

func TestFilterRowToColumns_KeepSome(t *testing.T) {
	cols := []string{"id", "pii_entities", "name"}
	row := []interface{}{1, "entities", "alice"}
	keep := map[string]struct{}{"id": {}, "name": {}}
	result := filterRowToColumns(row, cols, keep)
	if len(result) != 2 {
		t.Errorf("expected 2 values, got %d: %v", len(result), result)
	}
}

func TestFilterRowToColumns_KeepNone(t *testing.T) {
	cols := []string{"a", "b"}
	row := []interface{}{1, 2}
	keep := map[string]struct{}{}
	result := filterRowToColumns(row, cols, keep)
	if len(result) != 0 {
		t.Errorf("expected empty result, got %d", len(result))
	}
}

// --- isNumericType ---

func TestIsNumericType_Numeric(t *testing.T) {
	numericTypes := []string{
		"INTEGER", "BIGINT", "SMALLINT", "TINYINT",
		"DOUBLE", "FLOAT", "REAL", "DECIMAL(10,2)",
		"HUGEINT", "UBIGINT", "UINTEGER", "USMALLINT", "UTINYINT", "NUMERIC",
		"integer", "bigint",
	}
	for _, typ := range numericTypes {
		if !isNumericType(typ) {
			t.Errorf("expected isNumericType(%q) = true", typ)
		}
	}
}

func TestIsNumericType_NonNumeric(t *testing.T) {
	nonNumericTypes := []string{
		"VARCHAR", "TEXT", "BOOLEAN", "DATE", "TIMESTAMP", "BLOB", "JSON", "",
	}
	for _, typ := range nonNumericTypes {
		if isNumericType(typ) {
			t.Errorf("expected isNumericType(%q) = false", typ)
		}
	}
}

// --- normalizeValue ---

func TestNormalizeValue_Nil(t *testing.T) {
	if normalizeValue(nil) != nil {
		t.Error("expected nil for nil input")
	}
}

func TestNormalizeValue_ByteSlice(t *testing.T) {
	got := normalizeValue([]byte("hello"))
	if got != "hello" {
		t.Errorf("expected string %q, got %v", "hello", got)
	}
}

func TestNormalizeValue_Time(t *testing.T) {
	ts := time.Date(2024, 1, 15, 12, 0, 0, 0, time.UTC)
	got := normalizeValue(ts)
	s, ok := got.(string)
	if !ok {
		t.Fatalf("expected string, got %T", got)
	}
	if s != "2024-01-15T12:00:00Z" {
		t.Errorf("expected RFC3339, got %q", s)
	}
}

func TestNormalizeValue_Int(t *testing.T) {
	got := normalizeValue(42)
	if got != 42 {
		t.Errorf("expected 42, got %v", got)
	}
}

func TestNormalizeValue_String(t *testing.T) {
	got := normalizeValue("hello")
	if got != "hello" {
		t.Errorf("expected %q, got %v", "hello", got)
	}
}

func TestNormalizeValue_Float(t *testing.T) {
	got := normalizeValue(3.14)
	if got != 3.14 {
		t.Errorf("expected 3.14, got %v", got)
	}
}

// --- writeTempFile ---

func TestWriteTempFile_CreatesFile(t *testing.T) {
	data := []byte("test content")
	path, err := writeTempFile(data, "test_*.txt")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer os.Remove(path)

	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("failed to read temp file: %v", err)
	}
	if string(content) != "test content" {
		t.Errorf("expected %q, got %q", "test content", content)
	}
}

func TestWriteTempFile_EmptyData(t *testing.T) {
	path, err := writeTempFile([]byte{}, "empty_*.txt")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer os.Remove(path)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() != 0 {
		t.Errorf("expected empty file, got size %d", info.Size())
	}
}

// --- min ---

func TestMin(t *testing.T) {
	cases := []struct{ a, b, want int }{
		{1, 2, 1},
		{5, 3, 3},
		{4, 4, 4},
		{-1, 0, -1},
	}
	for _, tc := range cases {
		got := min(tc.a, tc.b)
		if got != tc.want {
			t.Errorf("min(%d, %d) = %d, want %d", tc.a, tc.b, got, tc.want)
		}
	}
}

// --- convertArrowValueToInterface ---

func TestConvertArrowValueToInterface_Null(t *testing.T) {
	bldr := array.NewInt64Builder(memory.DefaultAllocator)
	bldr.AppendNull()
	arr := bldr.NewArray()
	defer arr.Release()
	bldr.Release()

	got := convertArrowValueToInterface(arr, 0)
	if got != nil {
		t.Errorf("expected nil for null value, got %v", got)
	}
}

func TestConvertArrowValueToInterface_Bool(t *testing.T) {
	bldr := array.NewBooleanBuilder(memory.DefaultAllocator)
	bldr.Append(true)
	arr := bldr.NewArray()
	defer arr.Release()
	bldr.Release()

	got := convertArrowValueToInterface(arr, 0)
	if got != true {
		t.Errorf("expected true, got %v", got)
	}
}

func TestConvertArrowValueToInterface_Int64(t *testing.T) {
	bldr := array.NewInt64Builder(memory.DefaultAllocator)
	bldr.Append(42)
	arr := bldr.NewArray()
	defer arr.Release()
	bldr.Release()

	got := convertArrowValueToInterface(arr, 0)
	if got != int64(42) {
		t.Errorf("expected 42, got %v", got)
	}
}

func TestConvertArrowValueToInterface_Float64(t *testing.T) {
	bldr := array.NewFloat64Builder(memory.DefaultAllocator)
	bldr.Append(3.14)
	arr := bldr.NewArray()
	defer arr.Release()
	bldr.Release()

	got := convertArrowValueToInterface(arr, 0)
	if got != float64(3.14) {
		t.Errorf("expected 3.14, got %v", got)
	}
}

func TestConvertArrowValueToInterface_String(t *testing.T) {
	bldr := array.NewStringBuilder(memory.DefaultAllocator)
	bldr.Append("hello")
	arr := bldr.NewArray()
	defer arr.Release()
	bldr.Release()

	got := convertArrowValueToInterface(arr, 0)
	if got != "hello" {
		t.Errorf("expected %q, got %v", "hello", got)
	}
}

func TestConvertArrowValueToInterface_Int32(t *testing.T) {
	bldr := array.NewInt32Builder(memory.DefaultAllocator)
	bldr.Append(100)
	arr := bldr.NewArray()
	defer arr.Release()
	bldr.Release()
	got := convertArrowValueToInterface(arr, 0)
	if got != int32(100) {
		t.Errorf("expected 100, got %v", got)
	}
}

func TestConvertArrowValueToInterface_Int16(t *testing.T) {
	bldr := array.NewInt16Builder(memory.DefaultAllocator)
	bldr.Append(16)
	arr := bldr.NewArray()
	defer arr.Release()
	bldr.Release()
	got := convertArrowValueToInterface(arr, 0)
	if got != int16(16) {
		t.Errorf("expected 16, got %v", got)
	}
}

func TestConvertArrowValueToInterface_Int8(t *testing.T) {
	bldr := array.NewInt8Builder(memory.DefaultAllocator)
	bldr.Append(8)
	arr := bldr.NewArray()
	defer arr.Release()
	bldr.Release()
	got := convertArrowValueToInterface(arr, 0)
	if got != int8(8) {
		t.Errorf("expected 8, got %v", got)
	}
}

func TestConvertArrowValueToInterface_Uint64(t *testing.T) {
	bldr := array.NewUint64Builder(memory.DefaultAllocator)
	bldr.Append(99)
	arr := bldr.NewArray()
	defer arr.Release()
	bldr.Release()
	got := convertArrowValueToInterface(arr, 0)
	if got != uint64(99) {
		t.Errorf("expected 99, got %v", got)
	}
}

func TestConvertArrowValueToInterface_Float32(t *testing.T) {
	bldr := array.NewFloat32Builder(memory.DefaultAllocator)
	bldr.Append(1.5)
	arr := bldr.NewArray()
	defer arr.Release()
	bldr.Release()
	got := convertArrowValueToInterface(arr, 0)
	if got != float32(1.5) {
		t.Errorf("expected 1.5, got %v", got)
	}
}

func TestConvertArrowValueToInterface_Date32(t *testing.T) {
	bldr := array.NewDate32Builder(memory.DefaultAllocator)
	bldr.Append(arrow.Date32(19000))
	arr := bldr.NewArray()
	defer arr.Release()
	bldr.Release()
	got := convertArrowValueToInterface(arr, 0)
	s, ok := got.(string)
	if !ok || len(s) < 10 {
		t.Errorf("expected date string, got %v (%T)", got, got)
	}
}

func TestConvertArrowValueToInterface_Binary(t *testing.T) {
	bldr := array.NewBinaryBuilder(memory.DefaultAllocator, arrow.BinaryTypes.Binary)
	bldr.Append([]byte{1, 2, 3})
	arr := bldr.NewArray()
	defer arr.Release()
	bldr.Release()
	got := convertArrowValueToInterface(arr, 0)
	if _, ok := got.([]byte); !ok {
		t.Errorf("expected []byte, got %T: %v", got, got)
	}
}

func TestConvertArrowValueToInterface_Uint16(t *testing.T) {
	bldr := array.NewUint16Builder(memory.DefaultAllocator)
	bldr.Append(5)
	arr := bldr.NewArray()
	defer arr.Release()
	bldr.Release()
	got := convertArrowValueToInterface(arr, 0)
	if got != uint16(5) {
		t.Errorf("expected uint16(5), got %v (%T)", got, got)
	}
}

// --- Metrics ---

func TestMetrics_NewMetrics(t *testing.T) {
	m := NewMetrics()
	if m == nil {
		t.Fatal("expected non-nil Metrics")
	}
	stats := m.GetStats()
	if stats["total_queries"].(int64) != 0 {
		t.Error("expected 0 total_queries on new Metrics")
	}
}

func TestMetrics_RecordRequest(t *testing.T) {
	m := NewMetrics()
	m.RecordRequest("/test", 100*time.Millisecond, nil)
	stats := m.GetStats()
	if stats["total_queries"].(int64) != 1 {
		t.Errorf("expected 1 query, got %v", stats["total_queries"])
	}
	if stats["query_errors"].(int64) != 0 {
		t.Error("expected 0 errors for nil error")
	}
}

func TestMetrics_RecordRequest_WithError(t *testing.T) {
	m := NewMetrics()
	m.RecordRequest("/test", 50*time.Millisecond, fmt.Errorf("test error"))
	stats := m.GetStats()
	if stats["query_errors"].(int64) != 1 {
		t.Errorf("expected 1 error, got %v", stats["query_errors"])
	}
}

func TestMetrics_RecordConnectionError(t *testing.T) {
	m := NewMetrics()
	m.RecordConnectionError()
	stats := m.GetStats()
	if stats["connection_errors"].(int64) != 1 {
		t.Errorf("expected 1 connection error, got %v", stats["connection_errors"])
	}
}

func TestMetrics_RecordQueryError(t *testing.T) {
	m := NewMetrics()
	m.RecordQueryError()
	stats := m.GetStats()
	if stats["query_errors"].(int64) != 1 {
		t.Errorf("expected 1 query error, got %v", stats["query_errors"])
	}
}

func TestMetrics_RecordCacheHit(t *testing.T) {
	m := NewMetrics()
	m.RecordCacheHit()
	stats := m.GetStats()
	if stats["cache_hits"].(int64) != 1 {
		t.Errorf("expected 1 cache hit, got %v", stats["cache_hits"])
	}
}

func TestMetrics_RecordCacheMiss(t *testing.T) {
	m := NewMetrics()
	m.RecordCacheMiss()
	stats := m.GetStats()
	if stats["cache_misses"].(int64) != 1 {
		t.Errorf("expected 1 cache miss, got %v", stats["cache_misses"])
	}
}

func TestMetrics_GetStats_ResponseTimes(t *testing.T) {
	m := NewMetrics()
	for i := 0; i < 10; i++ {
		m.RecordRequest("/test", time.Duration(i+1)*time.Millisecond, nil)
	}
	stats := m.GetStats()
	if stats["avg_response_time_seconds"].(float64) <= 0 {
		t.Error("expected positive avg response time")
	}
	if stats["p95_response_time_seconds"].(float64) <= 0 {
		t.Error("expected positive p95 response time")
	}
}

func TestMetrics_GetStats_TruncatesAt1000(t *testing.T) {
	m := NewMetrics()
	for i := 0; i < 1050; i++ {
		m.RecordRequest("/test", time.Millisecond, nil)
	}
	m.mu.RLock()
	count := len(m.responseTimes)
	m.mu.RUnlock()
	if count > 1000 {
		t.Errorf("response times should be capped at 1000, got %d", count)
	}
}
