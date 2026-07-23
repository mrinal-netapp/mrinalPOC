package activities

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	"go.temporal.io/sdk/activity"
)

// DeleteTableFromCatalogActivity deletes a table from the Lakekeeper catalog
func DeleteTableFromCatalogActivity(ctx context.Context, input types.DeleteTableFromCatalogRequest) error {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[DeleteTableFromCatalogActivity] Starting activity for table: %s, project: %s", input.TableName, input.ProjectId)
	log.Printf("[DeleteTableFromCatalogActivity] WorkflowID: %s, RunID: %s, ActivityID: %s",
		activityInfo.WorkflowExecution.ID, activityInfo.WorkflowExecution.RunID, activityInfo.ActivityID)

	// Get Lakekeeper URL
	lakekeeperURL := os.Getenv("LAKEKEEPER_URL")
	if lakekeeperURL == "" {
		lakekeeperURL = "http://lakekeeper:8181"
	}

	// Get OAuth token for Lakekeeper using service account client
	authClient, err := clients.NewServiceAccountClient()
	if err != nil {
		log.Printf("[DeleteTableFromCatalogActivity] ERROR: Failed to create auth client: %v", err)
		return fmt.Errorf("failed to create auth client: %w", err)
	}

	token, err := authClient.GetAccessToken()
	if err != nil {
		log.Printf("[DeleteTableFromCatalogActivity] ERROR: Failed to get OAuth token: %v", err)
		return fmt.Errorf("failed to get OAuth token: %w", err)
	}

	// Get warehouse UUID - Lakekeeper requires UUID, not project ID
	// The warehouse name is the same as the project ID
	lakekeeperClient := clients.NewLakekeeperClient(lakekeeperURL)
	warehouseId := input.WarehouseId

	// Check if warehouseId looks like a UUID (contains dashes and is ~36 chars)
	if warehouseId == "" || (len(warehouseId) < 32 && !strings.Contains(warehouseId, "-")) {
		// Need to look up the warehouse UUID by name (project ID)
		warehouseName := input.ProjectId
		log.Printf("[DeleteTableFromCatalogActivity] Looking up warehouse UUID for name: %s", warehouseName)

		var lookupErr error
		warehouseId, lookupErr = lakekeeperClient.GetWarehouseByName(warehouseName)
		if lookupErr != nil {
			log.Printf("[DeleteTableFromCatalogActivity] WARN: Failed to look up warehouse UUID: %v", lookupErr)
			// Warehouse might not exist or already deleted, continue with S3 deletion
			log.Printf("[DeleteTableFromCatalogActivity] Continuing - warehouse may already be deleted")
			return nil
		}
		log.Printf("[DeleteTableFromCatalogActivity] Found warehouse UUID: %s", warehouseId)
	}

	// Build catalog API path for table deletion
	namespacePath := strings.ReplaceAll(input.Namespace, ".", "/")

	// Iceberg REST API: DELETE /catalog/v1/{prefix}/namespaces/{namespace}/tables/{table}?purgeRequested=true
	// purgeRequested=true tells the catalog to also delete the underlying data files
	url := fmt.Sprintf("%s/catalog/v1/%s/namespaces/%s/tables/%s?purgeRequested=true", lakekeeperURL, warehouseId, namespacePath, input.TableName)
	log.Printf("[DeleteTableFromCatalogActivity] Deleting table at: %s", url)

	// Create HTTP request
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, url, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	// Execute request
	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("[DeleteTableFromCatalogActivity] ERROR: Request failed: %v", err)
		return fmt.Errorf("failed to delete table from catalog: %w", err)
	}
	defer resp.Body.Close()

	// Read response body for error logging
	bodyBytes, _ := io.ReadAll(resp.Body)
	bodyStr := string(bodyBytes)

	// Check response
	if resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusOK {
		log.Printf("[DeleteTableFromCatalogActivity] Successfully deleted table %s from catalog", input.TableName)
		return nil
	}

	if resp.StatusCode == http.StatusNotFound {
		log.Printf("[DeleteTableFromCatalogActivity] Table %s not found in catalog (already deleted)", input.TableName)
		return nil // Table doesn't exist, that's fine
	}

	log.Printf("[DeleteTableFromCatalogActivity] ERROR: Failed to delete table, status: %d, body: %s", resp.StatusCode, bodyStr)
	return fmt.Errorf("failed to delete table from catalog: status %d, body: %s", resp.StatusCode, bodyStr)
}

// DeleteDatasetFilesActivity deletes all dataset files from S3
func DeleteDatasetFilesActivity(ctx context.Context, input types.DeleteDatasetFilesRequest) error {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[DeleteDatasetFilesActivity] Starting activity for dataset: %s, project: %s", input.DataSetId, input.ProjectId)
	log.Printf("[DeleteDatasetFilesActivity] WorkflowID: %s, RunID: %s, ActivityID: %s",
		activityInfo.WorkflowExecution.ID, activityInfo.WorkflowExecution.RunID, activityInfo.ActivityID)

	// Get S3 configuration
	s3Endpoint := clients.ResolveS3Endpoint()

	s3Region := os.Getenv("S3_REGION")
	if s3Region == "" {
		s3Region = "us-east-1"
	}

	s3AccessKey := os.Getenv("S3_ACCESS_KEY")
	s3SecretKey := os.Getenv("S3_SECRET_KEY")

	if s3AccessKey == "" || s3SecretKey == "" {
		return fmt.Errorf("S3 credentials not configured (S3_ACCESS_KEY, S3_SECRET_KEY)")
	}

	// Create S3 client
	customResolver := aws.EndpointResolverWithOptionsFunc(func(service, region string, options ...interface{}) (aws.Endpoint, error) {
		return aws.Endpoint{
			URL:               s3Endpoint,
			HostnameImmutable: true,
		}, nil
	})

	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion(s3Region),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(s3AccessKey, s3SecretKey, "")),
		config.WithEndpointResolverWithOptions(customResolver),
	)
	if err != nil {
		return fmt.Errorf("failed to create AWS config: %w", err)
	}

	s3Client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.UsePathStyle = true // Required for non-AWS S3 (MinIO, VersityGW)
	})

	// Bucket name is usually the project ID
	bucketName := input.BucketName
	if bucketName == "" {
		bucketName = input.ProjectId
	}

	// Dataset files are stored at: <pathPrefix>/datasets/{datasetId}/
	var prefix string
	if input.PathPrefix != "" {
		prefix = fmt.Sprintf("%s/datasets/%s/", input.PathPrefix, input.DataSetId)
	} else {
		prefix = fmt.Sprintf("datasets/%s/", input.DataSetId)
	}
	log.Printf("[DeleteDatasetFilesActivity] Deleting files from s3://%s/%s", bucketName, prefix)

	// List all objects with the prefix
	paginator := s3.NewListObjectsV2Paginator(s3Client, &s3.ListObjectsV2Input{
		Bucket: aws.String(bucketName),
		Prefix: aws.String(prefix),
	})

	var objectsToDelete []s3types.ObjectIdentifier
	totalObjects := 0

	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			log.Printf("[DeleteDatasetFilesActivity] ERROR: Failed to list objects: %v", err)
			return fmt.Errorf("failed to list objects: %w", err)
		}

		for _, obj := range page.Contents {
			objectsToDelete = append(objectsToDelete, s3types.ObjectIdentifier{
				Key: obj.Key,
			})
			totalObjects++
		}
	}

	if totalObjects == 0 {
		log.Printf("[DeleteDatasetFilesActivity] No files found at s3://%s/%s", bucketName, prefix)
		return nil
	}

	log.Printf("[DeleteDatasetFilesActivity] Found %d objects to delete", totalObjects)

	// Delete objects in batches of 1000 (S3 limit)
	batchSize := 1000
	for i := 0; i < len(objectsToDelete); i += batchSize {
		end := i + batchSize
		if end > len(objectsToDelete) {
			end = len(objectsToDelete)
		}

		batch := objectsToDelete[i:end]
		_, err := s3Client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
			Bucket: aws.String(bucketName),
			Delete: &s3types.Delete{
				Objects: batch,
				Quiet:   aws.Bool(true),
			},
		})
		if err != nil {
			log.Printf("[DeleteDatasetFilesActivity] ERROR: Failed to delete batch: %v", err)
			return fmt.Errorf("failed to delete objects: %w", err)
		}

		log.Printf("[DeleteDatasetFilesActivity] Deleted batch of %d objects", len(batch))
	}

	log.Printf("[DeleteDatasetFilesActivity] Successfully deleted %d files from s3://%s/%s", totalObjects, bucketName, prefix)
	return nil
}
