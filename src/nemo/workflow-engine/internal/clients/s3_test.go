package clients

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestResolveS3Endpoint_PrecedenceMatrix(t *testing.T) {
	cases := []struct {
		name string
		s3   string
		aws  string
		want string
	}{
		{"S3_ENDPOINT wins", "http://s3.local", "http://aws.local", "http://s3.local"},
		{"AWS_ENDPOINT_URL when S3_ENDPOINT empty", "", "http://aws.local", "http://aws.local"},
		{"default when both empty", "", "", "http://s3gateway:7070"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("S3_ENDPOINT", tc.s3)
			t.Setenv("AWS_ENDPOINT_URL", tc.aws)
			assert.Equal(t, tc.want, ResolveS3Endpoint())
		})
	}
}

func TestNewS3Client_ReturnsNilWhenNoCreds(t *testing.T) {
	t.Setenv("S3_ENDPOINT", "http://s3.local")
	t.Setenv("AWS_ENDPOINT_URL", "")
	t.Setenv("AWS_REGION", "")
	t.Setenv("S3_REGION", "")
	t.Setenv("AWS_ACCESS_KEY_ID", "")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "")
	t.Setenv("S3_ACCESS_KEY", "")
	t.Setenv("S3_SECRET_KEY", "")

	got := NewS3Client()
	assert.Nil(t, got, "missing credentials must yield nil S3Client (caller responsibility)")
}

func TestNewS3Client_PrefersAWSCreds(t *testing.T) {
	t.Setenv("S3_ENDPOINT", "http://s3.local")
	t.Setenv("AWS_REGION", "us-west-2")
	t.Setenv("AWS_ACCESS_KEY_ID", "AKIA")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "secret")
	t.Setenv("S3_ACCESS_KEY", "")
	t.Setenv("S3_SECRET_KEY", "")

	got := NewS3Client()
	if got == nil {
		t.Fatalf("expected non-nil S3Client")
	}
}

func TestNewS3Client_FallsBackToS3PrefixedCreds(t *testing.T) {
	t.Setenv("S3_ENDPOINT", "http://s3.local")
	t.Setenv("AWS_REGION", "")
	t.Setenv("S3_REGION", "us-east-2")
	t.Setenv("AWS_ACCESS_KEY_ID", "")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "")
	t.Setenv("S3_ACCESS_KEY", "k")
	t.Setenv("S3_SECRET_KEY", "s")

	got := NewS3Client()
	if got == nil {
		t.Fatalf("expected non-nil S3Client")
	}
}
