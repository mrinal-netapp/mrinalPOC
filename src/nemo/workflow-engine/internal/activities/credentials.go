package activities

import (
	"context"
	"fmt"
	"os"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"go.temporal.io/sdk/activity"
)

// FetchProjectCredentialsActivity retrieves OAuth2 project credentials from
// config-service and S3 credentials from the workflow-engine pod environment.
// This replaces the old BuildSecretSpecForProject + CommonS3EnvVars pattern
// that created ephemeral K8s Secrets.
func FetchProjectCredentialsActivity(ctx context.Context, projectId string) (types.ProjectCredentials, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("Fetching project credentials", "projectId", projectId)

	// Fetch OAuth2 credentials from config-service
	configServiceURL := os.Getenv("CONFIG_SERVICE_URL")
	if configServiceURL == "" {
		configServiceURL = "http://config-service:3000"
	}
	configClient := clients.NewConfigClient(configServiceURL)

	serviceAccount, err := configClient.GetProjectServiceAccount(projectId)
	if err != nil {
		return types.ProjectCredentials{}, fmt.Errorf("failed to get project service account: %w", err)
	}

	// Read S3 credentials from pod environment
	s3AccessKey := os.Getenv("S3_ACCESS_KEY")
	s3SecretKey := os.Getenv("S3_SECRET_KEY")
	if s3AccessKey == "" || s3SecretKey == "" {
		return types.ProjectCredentials{}, fmt.Errorf("S3 credentials not configured: S3_ACCESS_KEY and S3_SECRET_KEY are required")
	}

	s3Endpoint := os.Getenv("S3_ENDPOINT")
	if s3Endpoint == "" {
		s3Endpoint = "http://s3gateway:7070"
	}
	s3Region := os.Getenv("S3_REGION")
	if s3Region == "" {
		s3Region = "us-east-1"
	}

	keycloakIssuer := os.Getenv("KEYCLOAK_INTERNAL_ISSUER")
	if keycloakIssuer == "" {
		return types.ProjectCredentials{}, fmt.Errorf("KEYCLOAK_INTERNAL_ISSUER is required (set by Helm on workflow-engine)")
	}

	lakekeeperURL := os.Getenv("LAKEKEEPER_URL")
	if lakekeeperURL == "" {
		lakekeeperURL = "http://lakekeeper:8181"
	}

	creds := types.ProjectCredentials{
		ProjectClientId:     serviceAccount.ClientId,
		ProjectClientSecret: serviceAccount.ClientSecret,
		S3AccessKey:         s3AccessKey,
		S3SecretKey:         s3SecretKey,
		S3Endpoint:          s3Endpoint,
		S3Region:            s3Region,
		ConfigServiceURL:    configServiceURL,
		KeycloakIssuer:      keycloakIssuer,
		LakekeeperURL:       lakekeeperURL,
	}

	logger.Info("Project credentials fetched successfully", "projectId", projectId)
	return creds, nil
}
