package clients

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newS3StubClient sets up an httptest.Server that pretends to be an S3-compatible
// gateway and returns an S3Client wired to it via path-style addressing.
func newS3StubClient(t *testing.T, body string) *S3Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)

	cfg := aws.Config{
		Region:      "us-east-1",
		Credentials: credentials.NewStaticCredentialsProvider("ak", "sk", ""),
	}
	c := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(srv.URL)
		o.UsePathStyle = true
		o.Region = "us-east-1"
	})
	return &S3Client{client: c}
}

func TestS3Client_ReadJSON_Success(t *testing.T) {
	c := newS3StubClient(t, `{"a":1}`)
	got, err := c.ReadJSON("bucket", "key")
	require.NoError(t, err)
	assert.Equal(t, `{"a":1}`, string(got))
}

func TestS3Client_ReadProcessingResult_Success(t *testing.T) {
	body, _ := json.Marshal(types.ProcessingResult{Status: "ok"})
	c := newS3StubClient(t, string(body))
	got, err := c.ReadProcessingResult("bucket", "key")
	require.NoError(t, err)
	assert.Equal(t, "ok", got.Status)
}

func TestS3Client_ReadProcessingResult_BadJSON(t *testing.T) {
	c := newS3StubClient(t, "not-json")
	_, err := c.ReadProcessingResult("bucket", "key")
	require.Error(t, err)
}

func TestS3Client_ReadJSON_Errors(t *testing.T) {
	// stub that 404s — GetObject returns an error.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)

	cfg := aws.Config{
		Region:      "us-east-1",
		Credentials: credentials.NewStaticCredentialsProvider("ak", "sk", ""),
	}
	c := &S3Client{client: s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(srv.URL)
		o.UsePathStyle = true
		o.Region = "us-east-1"
	})}

	_, err := c.ReadJSON("bucket", "missing")
	require.Error(t, err)
}

func TestS3Client_ReadProcessingResult_GetObjectError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)

	cfg := aws.Config{
		Region:      "us-east-1",
		Credentials: credentials.NewStaticCredentialsProvider("ak", "sk", ""),
	}
	c := &S3Client{client: s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(srv.URL)
		o.UsePathStyle = true
		o.Region = "us-east-1"
	})}

	_, err := c.ReadProcessingResult("bucket", "missing")
	require.Error(t, err)
}

// silence linter on context import in case tests are extended later.
var _ = context.Background
