package activities

import (
	"context"
	"fmt"
	"log"
	"os"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	"go.temporal.io/sdk/activity"
)

// DeleteKBFilesActivity deletes all KB files (LanceDB and metadata) from S3
func DeleteKBFilesActivity(ctx context.Context, input types.DeleteKBFilesRequest) (types.DeleteKBFilesResult, error) {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[DeleteKBFilesActivity] Starting activity for KB: %s, project: %s", input.KnowledgeBaseId, input.ProjectId)
	log.Printf("[DeleteKBFilesActivity] WorkflowID: %s, RunID: %s, ActivityID: %s",
		activityInfo.WorkflowExecution.ID, activityInfo.WorkflowExecution.RunID, activityInfo.ActivityID)

	result := types.DeleteKBFilesResult{
		FilesDeleted: 0,
		Success:      false,
	}

	// Get S3 configuration
	s3Endpoint := clients.ResolveS3Endpoint()

	s3Region := os.Getenv("S3_REGION")
	if s3Region == "" {
		s3Region = "us-east-1"
	}

	s3AccessKey := os.Getenv("S3_ACCESS_KEY")
	s3SecretKey := os.Getenv("S3_SECRET_KEY")

	if s3AccessKey == "" || s3SecretKey == "" {
		return result, fmt.Errorf("S3 credentials not configured (S3_ACCESS_KEY, S3_SECRET_KEY)")
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
		return result, fmt.Errorf("failed to create AWS config: %w", err)
	}

	s3Client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.UsePathStyle = true // Required for non-AWS S3 (MinIO, VersityGW)
	})

	// Bucket name
	bucketName := input.BucketName
	if bucketName == "" {
		bucketName = input.ProjectId
	}

	// KB files are stored at: [pathPrefix/]knowledgebases/{kbId}/
	// This includes:
	// - knowledgebases/{kbId}/lancedb/     (LanceDB table files)
	// - knowledgebases/{kbId}/metadata.json
	// - knowledgebases/{kbId}/progress.json
	// - knowledgebases/{kbId}/kb_processing_results.json
	var prefix string
	if input.PathPrefix != "" {
		prefix = fmt.Sprintf("%s/knowledgebases/%s/", input.PathPrefix, input.KnowledgeBaseId)
	} else {
		prefix = fmt.Sprintf("knowledgebases/%s/", input.KnowledgeBaseId)
	}
	log.Printf("[DeleteKBFilesActivity] Deleting files from s3://%s/%s", bucketName, prefix)

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
			log.Printf("[DeleteKBFilesActivity] ERROR: Failed to list objects: %v", err)
			return result, fmt.Errorf("failed to list objects: %w", err)
		}

		for _, obj := range page.Contents {
			objectsToDelete = append(objectsToDelete, s3types.ObjectIdentifier{
				Key: obj.Key,
			})
			totalObjects++
		}
	}

	if totalObjects == 0 {
		log.Printf("[DeleteKBFilesActivity] No files found at s3://%s/%s (KB may not have been processed yet)", bucketName, prefix)
		result.Success = true
		return result, nil
	}

	log.Printf("[DeleteKBFilesActivity] Found %d objects to delete", totalObjects)

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
			log.Printf("[DeleteKBFilesActivity] ERROR: Failed to delete batch: %v", err)
			return result, fmt.Errorf("failed to delete objects: %w", err)
		}

		log.Printf("[DeleteKBFilesActivity] Deleted batch of %d objects", len(batch))
	}

	result.FilesDeleted = totalObjects
	result.Success = true
	log.Printf("[DeleteKBFilesActivity] Successfully deleted %d files from s3://%s/%s", totalObjects, bucketName, prefix)
	return result, nil
}
