package activities

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"go.temporal.io/sdk/testsuite"
)

func TestFetchProjectCredentialsActivity_S3CredentialsRequired(t *testing.T) {
	// Mock config service returns success so we reach the S3 check
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"projectId":    "test-project",
			"clientId":     "client-1",
			"clientSecret": "secret-1",
			"createdAt":    "",
		})
	}))
	defer srv.Close()

	origURL := os.Getenv("CONFIG_SERVICE_URL")
	origS3Key := os.Getenv("S3_ACCESS_KEY")
	origS3Secret := os.Getenv("S3_SECRET_KEY")
	defer func() {
		if origURL != "" {
			os.Setenv("CONFIG_SERVICE_URL", origURL)
		} else {
			os.Unsetenv("CONFIG_SERVICE_URL")
		}
		if origS3Key != "" {
			os.Setenv("S3_ACCESS_KEY", origS3Key)
		} else {
			os.Unsetenv("S3_ACCESS_KEY")
		}
		if origS3Secret != "" {
			os.Setenv("S3_SECRET_KEY", origS3Secret)
		} else {
			os.Unsetenv("S3_SECRET_KEY")
		}
	}()

	os.Setenv("CONFIG_SERVICE_URL", srv.URL)
	os.Unsetenv("S3_ACCESS_KEY")
	os.Unsetenv("S3_SECRET_KEY")

	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestActivityEnvironment()
	env.RegisterActivity(FetchProjectCredentialsActivity)
	val, err := env.ExecuteActivity(FetchProjectCredentialsActivity, "test-project")
	if err == nil {
		t.Fatal("expected error when S3_ACCESS_KEY is unset")
	}
	var creds types.ProjectCredentials
	if val != nil {
		_ = val.Get(&creds)
		if creds.ProjectClientId != "" {
			t.Errorf("expected zero creds on error, got ProjectClientId %q", creds.ProjectClientId)
		}
	}
	if !strings.Contains(err.Error(), "S3 credentials not configured") {
		t.Errorf("expected S3 credentials error, got: %v", err)
	}
}

func TestFetchProjectCredentialsActivity_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"projectId":    "p1",
			"clientId":     "cid",
			"clientSecret": "csecret",
			"createdAt":    "",
		})
	}))
	defer srv.Close()

	origURL := os.Getenv("CONFIG_SERVICE_URL")
	origS3Key := os.Getenv("S3_ACCESS_KEY")
	origS3Secret := os.Getenv("S3_SECRET_KEY")
	origIssuer := os.Getenv("KEYCLOAK_INTERNAL_ISSUER")
	defer func() {
		if origURL != "" {
			os.Setenv("CONFIG_SERVICE_URL", origURL)
		} else {
			os.Unsetenv("CONFIG_SERVICE_URL")
		}
		os.Setenv("S3_ACCESS_KEY", origS3Key)
		os.Setenv("S3_SECRET_KEY", origS3Secret)
		if origIssuer != "" {
			os.Setenv("KEYCLOAK_INTERNAL_ISSUER", origIssuer)
		} else {
			os.Unsetenv("KEYCLOAK_INTERNAL_ISSUER")
		}
	}()

	os.Setenv("CONFIG_SERVICE_URL", srv.URL)
	os.Setenv("S3_ACCESS_KEY", "test-key")
	os.Setenv("S3_SECRET_KEY", "test-secret")
	os.Setenv("KEYCLOAK_INTERNAL_ISSUER", "http://test-issuer/realms/test")

	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestActivityEnvironment()
	env.RegisterActivity(FetchProjectCredentialsActivity)
	val, err := env.ExecuteActivity(FetchProjectCredentialsActivity, "p1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var creds types.ProjectCredentials
	if err := val.Get(&creds); err != nil {
		t.Fatalf("get result: %v", err)
	}
	if creds.ProjectClientId != "cid" || creds.ProjectClientSecret != "csecret" {
		t.Errorf("project creds: got clientId=%q clientSecret=%q", creds.ProjectClientId, creds.ProjectClientSecret)
	}
	if creds.S3AccessKey != "test-key" || creds.S3SecretKey != "test-secret" {
		t.Errorf("S3 creds: got accessKey=%q secretKey=%q", creds.S3AccessKey, creds.S3SecretKey)
	}
	// Defaults
	if creds.S3Endpoint == "" {
		t.Error("expected default S3Endpoint")
	}
	if creds.ConfigServiceURL != srv.URL {
		t.Errorf("ConfigServiceURL = %q, want %q", creds.ConfigServiceURL, srv.URL)
	}
}
