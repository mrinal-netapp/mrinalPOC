// Package enums provides canonical log level strings aligned with the Python and Node runtimes.
package enums

import "fmt"

// LogLevel is a stable level identifier stored on log events and in JSON config.
type LogLevel string

const (
	LogLevelDebug     LogLevel = "debug"
	LogLevelInfo      LogLevel = "info"
	LogLevelWarning   LogLevel = "warning"
	LogLevelError     LogLevel = "error"
	LogLevelCritical  LogLevel = "critical"
	LogLevelException LogLevel = "exception"
)

// LevelRank maps normalized level names to verbosity rank (higher = more severe).
var LevelRank = map[string]int{
	string(LogLevelDebug):     10,
	string(LogLevelInfo):      20,
	string(LogLevelWarning):   30,
	"warn":                    30,
	string(LogLevelError):     40,
	string(LogLevelException): 40,
	string(LogLevelCritical):  50,
}

// ValidMinLogLevelKeys is the set of accepted min_log_level configuration values.
var ValidMinLogLevelKeys = func() map[string]struct{} {
	m := make(map[string]struct{}, len(LevelRank))
	for k := range LevelRank {
		m[k] = struct{}{}
	}
	return m
}()

// LogEventMethods are levels accepted by LogEvent after normalization.
var LogEventMethods = map[string]struct{}{
	string(LogLevelDebug):     {},
	string(LogLevelInfo):      {},
	string(LogLevelWarning):   {},
	string(LogLevelError):     {},
	string(LogLevelCritical):  {},
	string(LogLevelException): {},
}

// NormalizeLevelName lowercases and maps warn → warning.
func NormalizeLevelName(raw string) string {
	s := trimLower(raw)
	if s == "warn" {
		return string(LogLevelWarning)
	}
	return s
}

func trimLower(s string) string {
	start := 0
	end := len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t') {
		end--
	}
	if start == end {
		return ""
	}
	b := []byte(s[start:end])
	for i := range b {
		if b[i] >= 'A' && b[i] <= 'Z' {
			b[i] += 'a' - 'A'
		}
	}
	return string(b)
}

// ValidateMinLogLevel returns an error when the level is not a known floor.
func ValidateMinLogLevel(level string) error {
	if _, ok := ValidMinLogLevelKeys[NormalizeLevelName(level)]; !ok {
		return fmt.Errorf("min_log_level must be one of debug, info, warning, error, critical, exception; got %q", level)
	}
	return nil
}
