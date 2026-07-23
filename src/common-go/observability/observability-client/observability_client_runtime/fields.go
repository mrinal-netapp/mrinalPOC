package observability_client_runtime

import (
	"strings"
	"time"

	"go.uber.org/zap"
)

// LogField is a type alias for zap.Field. Using the alias in service code means
// services never need to import go.uber.org/zap directly.
type LogField = zap.Field

// sanitizeLogString removes newline and carriage-return characters from s to
// prevent log-injection attacks where a caller could forge additional log lines.
func sanitizeLogString(s string) string {
	if !strings.ContainsAny(s, "\n\r") {
		return s
	}
	r := strings.NewReplacer("\n", " ", "\r", " ")
	return r.Replace(s)
}

// Field constructors — mirrors the most-used subset of go.uber.org/zap so
// service code can call obslib.String(...), obslib.Error(...), etc.

func String(key, val string) LogField           { return zap.String(key, sanitizeLogString(val)) }
func Int(key string, val int) LogField          { return zap.Int(key, val) }
func Int64(key string, val int64) LogField      { return zap.Int64(key, val) }
func Float64(key string, val float64) LogField  { return zap.Float64(key, val) }
func Bool(key string, val bool) LogField        { return zap.Bool(key, val) }
func Error(err error) LogField                  { return zap.Error(err) }
func NamedError(key string, err error) LogField { return zap.NamedError(key, err) }
func Strings(key string, val []string) LogField {
	sanitized := make([]string, len(val))
	for i, s := range val {
		sanitized[i] = sanitizeLogString(s)
	}
	return zap.Strings(key, sanitized)
}
func Duration(key string, val time.Duration) LogField { return zap.Duration(key, val) }
func Any(key string, val interface{}) LogField        { return zap.Any(key, val) }
