package clients

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// S3Client wraps AWS S3 operations for S3-compatible storage
type S3Client struct {
	client *s3.Client
}

// ResolveS3Endpoint returns the S3-compatible API base URL from the environment.
// Resolution order: S3_ENDPOINT, AWS_ENDPOINT_URL, then default http://s3gateway:7070.
// Activities must use this (or equivalent) when building aws-sdk-go-v2 S3 clients; if the
// endpoint is omitted, the SDK targets public AWS S3 and Versity/minio-style keys fail with
// InvalidAccessKeyId even though in-cluster uploads succeed via the gateway.
func ResolveS3Endpoint() string {
	endpoint := os.Getenv("S3_ENDPOINT")
	if endpoint == "" {
		endpoint = os.Getenv("AWS_ENDPOINT_URL")
	}
	if endpoint == "" {
		endpoint = "http://s3gateway:7070"
	}
	return endpoint
}

// NewS3Client creates a new S3 client configured for S3-compatible storage.
// It supports both AWS_* and S3_* environment variable naming conventions.
// Returns nil if credentials are not configured - callers should check for nil.
func NewS3Client() *S3Client {
	endpoint := ResolveS3Endpoint()

	region := os.Getenv("AWS_REGION")
	if region == "" {
		region = os.Getenv("S3_REGION")
	}
	if region == "" {
		region = "us-east-1"
	}

	// Get credentials - support both AWS_* and S3_* naming conventions
	accessKey := os.Getenv("AWS_ACCESS_KEY_ID")
	if accessKey == "" {
		accessKey = os.Getenv("S3_ACCESS_KEY")
	}

	secretKey := os.Getenv("AWS_SECRET_ACCESS_KEY")
	if secretKey == "" {
		secretKey = os.Getenv("S3_SECRET_KEY")
	}

	// Validate credentials are configured
	if accessKey == "" || secretKey == "" {
		log.Printf("[S3Client] ERROR: S3 credentials not configured. Set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or S3_ACCESS_KEY/S3_SECRET_KEY")
		return nil
	}

	cfg, err := config.LoadDefaultConfig(context.Background(),
		config.WithRegion(region),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(accessKey, secretKey, "")),
	)
	if err != nil {
		log.Printf("[S3Client] ERROR: Failed to load AWS config: %v", err)
		return nil
	}

	// Configure for S3-compatible storage with path-style access
	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(endpoint)
		o.UsePathStyle = true // Required for S3-compatible storage (MinIO, VersityGW, etc.)
	})

	log.Printf("[S3Client] Initialized: endpoint=%s, region=%s, credentials=configured", endpoint, region)
	return &S3Client{client: client}
}

// ReadJSON reads a JSON file from S3 and returns the raw bytes.
func (c *S3Client) ReadJSON(bucket, key string) ([]byte, error) {
	resp, err := c.client.GetObject(context.Background(), &s3.GetObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to get object s3://%s/%s: %w", bucket, key, err)
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

// ReadProcessingResult reads the processing result JSON from S3
func (c *S3Client) ReadProcessingResult(bucket, key string) (types.ProcessingResult, error) {
	log.Printf("[S3Client] Reading processing result from s3://%s/%s", bucket, key)

	resp, err := c.client.GetObject(context.Background(), &s3.GetObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return types.ProcessingResult{}, fmt.Errorf("failed to get object: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return types.ProcessingResult{}, fmt.Errorf("failed to read body: %w", err)
	}

	var result types.ProcessingResult
	if err := json.Unmarshal(body, &result); err != nil {
		return types.ProcessingResult{}, fmt.Errorf("failed to unmarshal result: %w", err)
	}

	log.Printf("[S3Client] Successfully read processing result: status=%s", result.Status)
	return result, nil
}
