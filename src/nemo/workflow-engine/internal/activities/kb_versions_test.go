package activities

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestBuildKBRootPrefix(t *testing.T) {
	cases := []struct {
		name     string
		prefix   string
		kbId     string
		expected string
	}{
		{"no prefix", "", "kb-1", "knowledgebases/kb-1/"},
		{"trailing slash trimmed", "projects/p/", "kb-1", "projects/p/knowledgebases/kb-1/"},
		{"plain prefix", "projects/p", "kb-1", "projects/p/knowledgebases/kb-1/"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := buildKBRootPrefix(tc.prefix, tc.kbId)
			assert.Equal(t, tc.expected, got)
		})
	}
}

func TestPathsEqual(t *testing.T) {
	cases := []struct {
		name           string
		activePath     string
		lanceTablePath string
		dirPrefix      string
		dirNoSlash     string
		want           bool
	}{
		{"empty active returns false", "", "anything", "any/", "any", false},
		{"exact match", "s3://b/x/", "s3://b/x/", "x/", "x", true},
		{"strip s3 + trailing slash matches dirPrefix",
			"s3://b/foo/lancedb-run-abc/", "_unused", "foo/lancedb-run-abc/", "foo/lancedb-run-abc", true},
		{"strip s3 + trailing slash matches dirNoSlash",
			"s3://b/lancedb-run-abc", "_unused", "x/", "lancedb-run-abc", true},
		{"no match returns false",
			"s3://b/somethingelse", "_unused", "x/", "y", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := pathsEqual(tc.activePath, tc.lanceTablePath, tc.dirPrefix, tc.dirNoSlash)
			assert.Equal(t, tc.want, got)
		})
	}
}

func TestVersionIDFromPath(t *testing.T) {
	cases := []struct {
		path       string
		rootPrefix string
		bucket     string
		want       string
	}{
		{"s3://b/foo/kb-1/lancedb-run-abc/", "foo/kb-1/", "b", "lancedb-run-abc"},
		{"s3://b/foo/kb-1/lancedb-run-abc", "foo/kb-1/", "b", "lancedb-run-abc"},
		{"weird/path/lancedb-x", "foo/kb-1/", "b", "lancedb-x"},
		{"justname", "foo/kb-1/", "b", "justname"},
	}
	for _, tc := range cases {
		got := versionIdFromPath(tc.path, tc.rootPrefix, tc.bucket)
		assert.Equalf(t, tc.want, got, "path=%q", tc.path)
	}
}

func TestVersionDirNamePattern_MatchesExpectedNames(t *testing.T) {
	cases := []struct {
		name string
		ok   bool
	}{
		{"lancedb-run-abc", true},
		{"lancedb-run-foo123", true},
		{"lancedb-20260115-103000", true},
		{"lancedb-foo", false},
		{"lancedb-2026", false},
		{"random-other-thing", false},
	}
	for _, tc := range cases {
		got := versionDirNamePattern.MatchString(tc.name)
		assert.Equalf(t, tc.ok, got, "input=%q", tc.name)
	}
}
