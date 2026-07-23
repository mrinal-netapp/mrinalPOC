package activities

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"go.temporal.io/sdk/activity"
)

// kbSyncServiceAccountClient is a lazily-initialized service account client
// used to attach a bearer token to KB sync trigger requests. config-service
// installs an AuthMiddleware globally when Keycloak is configured, so this
// activity must present a service-account JWT or the request will be rejected
// with 401 and the schedule will never fire.
//
// We initialize on first use (instead of at package init) so that workflow
// worker startup does not fail in environments where Keycloak credentials
// are intentionally absent.
var (
	kbSyncSAClientOnce sync.Once
	kbSyncSAClient     *clients.ServiceAccountClient
)

func getKBSyncServiceAccountClient() *clients.ServiceAccountClient {
	kbSyncSAClientOnce.Do(func() {
		c, err := clients.NewServiceAccountClient()
		if err != nil {
			log.Printf("[TriggerKBSyncActivity] Service account client unavailable: %v", err)
			return
		}
		kbSyncSAClient = c
	})
	return kbSyncSAClient
}

// TriggerKBSyncInput is the payload for TriggerKBSyncActivity.
//
// ConfigServiceURL is captured at schedule-creation time and persisted in the
// Temporal Schedule action so the worker does not need to know the
// config-service URL at runtime.
type TriggerKBSyncInput struct {
	ProjectId        string `json:"projectId"`
	KnowledgeBaseId  string `json:"knowledgeBaseId"`
	ConfigServiceURL string `json:"configServiceURL,omitempty"`
}

// TriggerKBSyncActivity invokes the config-service KB reprocess endpoint with
// an empty body. The config-service reads the persisted KB row to build the
// full workflow input, then starts the real KnowledgeBaseCreationWorkflow on
// the workflow-engine. This indirection lets a Temporal Schedule fire long
// after schedule-creation time and still pick up the latest KB chunking /
// embedding / quantization configuration.
func TriggerKBSyncActivity(ctx context.Context, input TriggerKBSyncInput) error {
	info := activity.GetInfo(ctx)
	log.Printf("[TriggerKBSyncActivity] project=%s kb=%s workflow=%s",
		input.ProjectId, input.KnowledgeBaseId, info.WorkflowExecution.ID)

	configServiceURL := input.ConfigServiceURL
	if configServiceURL == "" {
		configServiceURL = os.Getenv("CONFIG_SERVICE_URL")
	}
	if configServiceURL == "" {
		configServiceURL = "http://config-service:3000"
	}

	url := fmt.Sprintf(
		"%s/api/v1/projects/%s/knowledgebases/%s/create",
		configServiceURL, input.ProjectId, input.KnowledgeBaseId,
	)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewBufferString("{}"))
	if err != nil {
		return fmt.Errorf("failed to build trigger request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	// Attach a service-account bearer token when Keycloak is configured.
	// config-service installs an AuthMiddleware globally, so requests without
	// Authorization will return 401 and the schedule will silently no-op.
	if saClient := getKBSyncServiceAccountClient(); saClient != nil {
		if err := saClient.AddAuthHeader(req); err != nil {
			log.Printf("[TriggerKBSyncActivity] Warning: failed to add auth header: %v", err)
		}
	}

	httpClient := &http.Client{Timeout: 30 * time.Second}
	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to POST %s: %w", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("config-service returned %d for %s: %s", resp.StatusCode, url, string(body))
	}

	log.Printf("[TriggerKBSyncActivity] KB sync trigger accepted (status=%d) for kb=%s",
		resp.StatusCode, input.KnowledgeBaseId)
	return nil
}
