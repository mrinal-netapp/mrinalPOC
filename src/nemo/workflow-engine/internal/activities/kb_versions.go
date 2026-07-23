package activities

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"regexp"
	"sort"
	"strings"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/internal/util"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// versionDirNamePattern matches both blue-green prefixes written by the KB
// processor:
//   - lancedb-run-{temporalRunID}              (scatter-gather merge path)
//   - lancedb-{YYYYMMDD-HHMMSS}                (legacy / standalone path)
var versionDirNamePattern = regexp.MustCompile(`^lancedb-(run-.+|\d{8}-\d{6})$`)

// KBVersionsListInput is the payload for ListKBVersionsActivity.
type KBVersionsListInput struct {
	ProjectId       string `json:"projectId"`
	KnowledgeBaseId string `json:"knowledgeBaseId"`
	BucketName      string `json:"bucketName"`
	PathPrefix      string `json:"pathPrefix,omitempty"`
}

// KBVersion describes one historical sync version on storage.
type KBVersion struct {
	VersionId      string `json:"versionId"`
	Prefix         string `json:"prefix"`
	LanceTablePath string `json:"lanceTablePath"`
	IsActive       bool   `json:"isActive"`
	CreatedAt      string `json:"createdAt,omitempty"`
}

// KBVersionsListResult is what ListKBVersionsActivity returns.
type KBVersionsListResult struct {
	Versions        []KBVersion `json:"versions"`
	ActiveVersionId string      `json:"activeVersionId,omitempty"`
}

// KBVersionRollbackInput is the payload for RollbackKBVersionActivity.
type KBVersionRollbackInput struct {
	ProjectId       string `json:"projectId"`
	KnowledgeBaseId string `json:"knowledgeBaseId"`
	BucketName      string `json:"bucketName"`
	PathPrefix      string `json:"pathPrefix,omitempty"`
	TargetVersionId string `json:"targetVersionId"`
}

// KBVersionRollbackChange captures the version that became active and the
// previous active version so the caller can render a "rolled back from X to Y"
// affordance in the UI.
type KBVersionRollbackChange struct {
	VersionId      string `json:"versionId"`
	LanceTablePath string `json:"lanceTablePath"`
}

// KBVersionRollbackResult is what RollbackKBVersionActivity returns.
type KBVersionRollbackResult struct {
	RolledBackTo KBVersionRollbackChange  `json:"rolledBackTo"`
	Previous     *KBVersionRollbackChange `json:"previous,omitempty"`
}

// ListKBVersionsActivity scans the KB's S3/MinIO root for `lancedb-*`
// subdirectories and reports each as a sync version. The active version is
// resolved from `metadata.json#lanceTablePath`.
func ListKBVersionsActivity(ctx context.Context, input KBVersionsListInput) (KBVersionsListResult, error) {
	result := KBVersionsListResult{Versions: []KBVersion{}}

	s3Client, err := newS3Client(ctx)
	if err != nil {
		return result, err
	}

	bucket := input.BucketName
	if bucket == "" {
		bucket = input.ProjectId
	}

	rootPrefix := buildKBRootPrefix(input.PathPrefix, input.KnowledgeBaseId)

	activePath, err := readActiveLanceTablePath(ctx, s3Client, bucket, rootPrefix)
	if err != nil {
		log.Printf("[ListKBVersionsActivity] Failed to read metadata.json (continuing): %v", err)
	}

	versionDirs, err := listVersionDirectories(ctx, s3Client, bucket, rootPrefix)
	if err != nil {
		return result, err
	}

	bucketSchemePrefix := fmt.Sprintf("s3://%s/", bucket)
	for _, dir := range versionDirs {
		versionId := strings.TrimPrefix(strings.TrimSuffix(dir, "/"), rootPrefix)
		lanceTablePath := bucketSchemePrefix + strings.TrimSuffix(dir, "/")
		isActive := activePath != "" && pathsEqual(activePath, lanceTablePath, dir, rootPrefix+versionId)

		createdAt, _ := mostRecentObjectTimestamp(ctx, s3Client, bucket, dir)

		v := KBVersion{
			VersionId:      versionId,
			Prefix:         strings.TrimSuffix(dir, "/"),
			LanceTablePath: lanceTablePath,
			IsActive:       isActive,
			CreatedAt:      createdAt,
		}
		result.Versions = append(result.Versions, v)
		if isActive {
			result.ActiveVersionId = versionId
		}
	}

	// Sort newest-first by createdAt (fall back to versionId desc when missing).
	sort.SliceStable(result.Versions, func(i, j int) bool {
		if result.Versions[i].CreatedAt != result.Versions[j].CreatedAt {
			return result.Versions[i].CreatedAt > result.Versions[j].CreatedAt
		}
		return result.Versions[i].VersionId > result.Versions[j].VersionId
	})

	log.Printf("[ListKBVersionsActivity] Found %d versions for KB %s (active=%s)",
		len(result.Versions), util.SanitizeLog(input.KnowledgeBaseId), util.SanitizeLog(result.ActiveVersionId))
	return result, nil
}

// RollbackKBVersionActivity rewrites metadata.json#lanceTablePath to point at
// the requested historical version. PutObject overwrites atomically at the
// object level, which is sufficient for the kb-retrieval-service pool: the
// next miss (or TTL expiry) re-resolves the active path.
func RollbackKBVersionActivity(ctx context.Context, input KBVersionRollbackInput) (KBVersionRollbackResult, error) {
	var out KBVersionRollbackResult
	if input.TargetVersionId == "" {
		return out, fmt.Errorf("targetVersionId is required")
	}
	if !versionDirNamePattern.MatchString(input.TargetVersionId) {
		return out, fmt.Errorf("targetVersionId %q does not match the expected lancedb-* naming pattern", input.TargetVersionId)
	}

	s3Client, err := newS3Client(ctx)
	if err != nil {
		return out, err
	}

	bucket := input.BucketName
	if bucket == "" {
		bucket = input.ProjectId
	}
	rootPrefix := buildKBRootPrefix(input.PathPrefix, input.KnowledgeBaseId)

	// Verify the target version directory exists.
	targetPrefix := rootPrefix + input.TargetVersionId + "/"
	exists, err := prefixHasObjects(ctx, s3Client, bucket, targetPrefix)
	if err != nil {
		return out, err
	}
	if !exists {
		return out, fmt.Errorf("version %q not found at s3://%s/%s", input.TargetVersionId, bucket, targetPrefix)
	}

	// Read current metadata to capture the prior active path.
	metaKey := rootPrefix + "metadata.json"
	metadata, prevPath, err := getMetadata(ctx, s3Client, bucket, metaKey)
	if err != nil {
		return out, fmt.Errorf("failed to read metadata.json: %w", err)
	}
	if metadata == nil {
		metadata = map[string]interface{}{}
	}

	newPath := fmt.Sprintf("s3://%s/%s%s", bucket, rootPrefix, input.TargetVersionId)
	metadata["lanceTablePath"] = newPath

	body, err := json.MarshalIndent(metadata, "", "  ")
	if err != nil {
		return out, fmt.Errorf("failed to marshal metadata.json: %w", err)
	}
	_, err = s3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(bucket),
		Key:         aws.String(metaKey),
		Body:        bytes.NewReader(body),
		ContentType: aws.String("application/json"),
	})
	if err != nil {
		return out, fmt.Errorf("failed to write metadata.json: %w", err)
	}

	out.RolledBackTo = KBVersionRollbackChange{
		VersionId:      input.TargetVersionId,
		LanceTablePath: newPath,
	}
	if prevPath != "" {
		out.Previous = &KBVersionRollbackChange{
			VersionId:      versionIdFromPath(prevPath, rootPrefix, bucket),
			LanceTablePath: prevPath,
		}
	}

	log.Printf("[RollbackKBVersionActivity] kb=%s rolledBackTo=%s previous=%s",
		util.SanitizeLog(input.KnowledgeBaseId), util.SanitizeLog(newPath), util.SanitizeLog(prevPath))
	return out, nil
}

// ─── helpers ────────────────────────────────────────────────────────────────

func newS3Client(ctx context.Context) (*s3.Client, error) {
	s3AccessKey := os.Getenv("S3_ACCESS_KEY")
	s3SecretKey := os.Getenv("S3_SECRET_KEY")
	if s3AccessKey == "" || s3SecretKey == "" {
		return nil, fmt.Errorf("S3 credentials not configured (S3_ACCESS_KEY, S3_SECRET_KEY)")
	}
	s3Region := os.Getenv("S3_REGION")
	if s3Region == "" {
		s3Region = "us-east-1"
	}
	s3Endpoint := clients.ResolveS3Endpoint()

	customResolver := aws.EndpointResolverWithOptionsFunc(func(service, region string, options ...interface{}) (aws.Endpoint, error) {
		return aws.Endpoint{URL: s3Endpoint, HostnameImmutable: true}, nil
	})

	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion(s3Region),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(s3AccessKey, s3SecretKey, "")),
		config.WithEndpointResolverWithOptions(customResolver),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create AWS config: %w", err)
	}

	return s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.UsePathStyle = true
	}), nil
}

func buildKBRootPrefix(pathPrefix, kbId string) string {
	if pathPrefix != "" {
		return fmt.Sprintf("%s/knowledgebases/%s/", strings.TrimSuffix(pathPrefix, "/"), kbId)
	}
	return fmt.Sprintf("knowledgebases/%s/", kbId)
}

func listVersionDirectories(ctx context.Context, s3Client *s3.Client, bucket, rootPrefix string) ([]string, error) {
	dirs := []string{}
	delimiter := "/"
	paginator := s3.NewListObjectsV2Paginator(s3Client, &s3.ListObjectsV2Input{
		Bucket:    aws.String(bucket),
		Prefix:    aws.String(rootPrefix),
		Delimiter: aws.String(delimiter),
	})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to list KB root: %w", err)
		}
		for _, cp := range page.CommonPrefixes {
			if cp.Prefix == nil {
				continue
			}
			name := strings.TrimSuffix(strings.TrimPrefix(*cp.Prefix, rootPrefix), "/")
			if versionDirNamePattern.MatchString(name) {
				dirs = append(dirs, *cp.Prefix)
			}
		}
	}
	return dirs, nil
}

func readActiveLanceTablePath(ctx context.Context, s3Client *s3.Client, bucket, rootPrefix string) (string, error) {
	_, path, err := getMetadata(ctx, s3Client, bucket, rootPrefix+"metadata.json")
	return path, err
}

func getMetadata(ctx context.Context, s3Client *s3.Client, bucket, key string) (map[string]interface{}, string, error) {
	resp, err := s3Client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, "", err
	}
	if len(body) == 0 {
		return map[string]interface{}{}, "", nil
	}
	var meta map[string]interface{}
	if err := json.Unmarshal(body, &meta); err != nil {
		return nil, "", fmt.Errorf("metadata.json is not a JSON object: %w", err)
	}
	path, _ := meta["lanceTablePath"].(string)
	return meta, path, nil
}

func prefixHasObjects(ctx context.Context, s3Client *s3.Client, bucket, prefix string) (bool, error) {
	maxKeys := int32(1)
	resp, err := s3Client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
		Bucket:  aws.String(bucket),
		Prefix:  aws.String(prefix),
		MaxKeys: &maxKeys,
	})
	if err != nil {
		return false, err
	}
	return len(resp.Contents) > 0, nil
}

func mostRecentObjectTimestamp(ctx context.Context, s3Client *s3.Client, bucket, prefix string) (string, error) {
	maxKeys := int32(1000)
	resp, err := s3Client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
		Bucket:  aws.String(bucket),
		Prefix:  aws.String(prefix),
		MaxKeys: &maxKeys,
	})
	if err != nil || len(resp.Contents) == 0 {
		return "", err
	}
	var latest string
	for _, obj := range resp.Contents {
		if obj.LastModified == nil {
			continue
		}
		t := obj.LastModified.UTC().Format("2006-01-02T15:04:05Z")
		if t > latest {
			latest = t
		}
	}
	return latest, nil
}

// pathsEqual normalizes the comparison between an `s3://bucket/...` URI written
// by the KB processor on cloud-only deployments and the bucket-relative paths
// surfaced through the directory listing. It is permissive on the URI/prefix
// boundary so a metadata file produced by either the standalone or merge path
// resolves correctly.
func pathsEqual(activePath, lanceTablePath, dirPrefix, dirNoSlash string) bool {
	if activePath == "" {
		return false
	}
	if activePath == lanceTablePath {
		return true
	}
	clean := strings.TrimSuffix(strings.TrimPrefix(activePath, "s3://"), "/")
	if strings.HasSuffix(clean, strings.TrimSuffix(dirPrefix, "/")) {
		return true
	}
	if strings.HasSuffix(clean, dirNoSlash) {
		return true
	}
	return false
}

func versionIdFromPath(path, rootPrefix, bucket string) string {
	clean := strings.TrimSuffix(path, "/")
	clean = strings.TrimPrefix(clean, fmt.Sprintf("s3://%s/", bucket))
	if strings.HasPrefix(clean, rootPrefix) {
		return strings.TrimPrefix(clean, rootPrefix)
	}
	if idx := strings.LastIndex(clean, "/"); idx >= 0 {
		return clean[idx+1:]
	}
	return clean
}
