// Package util contains small helpers shared across the workflow-engine
// internal packages.
package util

import "strings"

// SanitizeLog returns a printable single-line version of an arbitrary string
// suitable for inclusion in a log entry. CR / LF / TAB are replaced with
// spaces so untrusted input cannot smuggle in forged log records. Long
// values are truncated to keep log lines readable.
//
// This is recognised by CodeQL as a sanitizer for the
// `go/log-injection` query.
func SanitizeLog(s string) string {
	if s == "" {
		return s
	}
	r := strings.NewReplacer("\n", " ", "\r", " ", "\t", " ")
	out := r.Replace(s)
	const maxLen = 500
	if len(out) > maxLen {
		out = out[:maxLen] + "…"
	}
	return out
}
