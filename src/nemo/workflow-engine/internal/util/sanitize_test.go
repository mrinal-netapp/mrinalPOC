package util

import (
	"strings"
	"testing"
)

func TestSanitizeLog(t *testing.T) {
	cases := []struct {
		name  string
		in    string
		want  string
		check func(t *testing.T, got string)
	}{
		{name: "empty string returned unchanged", in: "", want: ""},
		{name: "plain ASCII returned unchanged", in: "hello world", want: "hello world"},
		{name: "newline replaced with space", in: "a\nb", want: "a b"},
		{name: "carriage return replaced with space", in: "a\rb", want: "a b"},
		{name: "tab replaced with space", in: "a\tb", want: "a b"},
		{name: "CRLF and tab all replaced", in: "x\r\n\ty", want: "x   y"},
		{name: "log injection attempt is neutralized",
			in:   "id=42\nFAKE log line",
			want: "id=42 FAKE log line"},
		{
			name: "exactly 500 chars passes through untouched",
			in:   strings.Repeat("a", 500),
			want: strings.Repeat("a", 500),
		},
		{
			name: "501 chars is truncated and ellipsised",
			in:   strings.Repeat("b", 501),
			check: func(t *testing.T, got string) {
				if !strings.HasSuffix(got, "…") {
					t.Fatalf("expected ellipsis suffix, got %q", got[len(got)-4:])
				}
				bare := strings.TrimSuffix(got, "…")
				if len(bare) != 500 {
					t.Fatalf("expected 500-char prefix before ellipsis, got %d", len(bare))
				}
			},
		},
		{
			name: "very long mixed control input is sanitized then truncated",
			in:   strings.Repeat("c\nd\t", 200),
			check: func(t *testing.T, got string) {
				if strings.ContainsAny(got, "\r\n\t") {
					t.Fatalf("control char survived sanitization: %q", got)
				}
				if !strings.HasSuffix(got, "…") {
					t.Fatalf("expected ellipsis suffix on truncation")
				}
			},
		},
		{
			name: "unicode multi-byte input survives untouched when within length",
			in:   "ünîcödé✓",
			want: "ünîcödé✓",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			got := SanitizeLog(tc.in)
			if tc.check != nil {
				tc.check(t, got)
				return
			}
			if got != tc.want {
				t.Fatalf("SanitizeLog(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
