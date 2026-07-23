package workflows

import (
	"fmt"
	"log"
	"os"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/internal/activities"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

const kbProcessingQueue = "kb-processing"

// clampDuration constrains d to the range [lo, hi].
func clampDuration(d, lo, hi time.Duration) time.Duration {
	if d < lo {
		return lo
	}
	if d > hi {
		return hi
	}
	return d
}

func getEnvOrDefault(key, defaultVal string) string {
	v := os.Getenv(key)
	if v == "" {
		return defaultVal
	}
	return v
}

// KnowledgeBaseCreationWorkflow orchestrates knowledge base creation using
// Temporal worker activities via the ScatterGather pattern.
func KnowledgeBaseCreationWorkflow(ctx workflow.Context, input types.KnowledgeBaseCreationWorkflowInput) (types.KnowledgeBaseCreationWorkflowResult, error) {
	workflowID := workflow.GetInfo(ctx).WorkflowExecution.ID
	runID := workflow.GetInfo(ctx).WorkflowExecution.RunID

	log.Printf("[KnowledgeBaseCreationWorkflow] Starting workflow for KB: %s, project: %s, source dataset: %s, workflowID: %s, runID: %s",
		input.KnowledgeBaseId, input.ProjectId, input.SourceDatasetId, workflowID, runID)

	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    3,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	result := types.KnowledgeBaseCreationWorkflowResult{
		ProjectId:       input.ProjectId,
		KnowledgeBaseId: input.KnowledgeBaseId,
		Status:          "running",
	}

	// Step 0: Clear stale progress files from any previous processing run
	log.Printf("[KnowledgeBaseCreationWorkflow] Step 0: Clearing stale progress files")
	clearProgressAO := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 2},
	}
	clearProgressCtx := workflow.WithActivityOptions(ctx, clearProgressAO)
	err := workflow.ExecuteActivity(clearProgressCtx, "ClearStaleProgressActivity", input.BucketName, input.KnowledgeBaseId, input.PathPrefix).Get(ctx, nil)
	if err != nil {
		log.Printf("[KnowledgeBaseCreationWorkflow] WARNING: Step 0 failed (continuing): %v", err)
	}

	// Step 1: Fetch project credentials
	log.Printf("[KnowledgeBaseCreationWorkflow] Step 1: Fetching project credentials")
	var creds types.ProjectCredentials
	err = workflow.ExecuteActivity(ctx, "FetchProjectCredentialsActivity", input.ProjectId).Get(ctx, &creds)
	if err != nil {
		log.Printf("[KnowledgeBaseCreationWorkflow] ERROR: Failed to fetch credentials: %v", err)
		result.Status = "failed"
		result.ErrorMessage = fmt.Sprintf("failed to fetch project credentials: %v", err)
		workflow.ExecuteActivity(ctx, "UpdateKBStatusActivity", input.ProjectId, input.KnowledgeBaseId, "errored", "", result.ErrorMessage).Get(ctx, nil)
		return result, err
	}

	// Step 2: Full path continues below; incremental mode returns early (single activity, no scatter).
	processingMode := input.ProcessingMode
	if processingMode == "" {
		processingMode = "full"
	}

	if processingMode == "incremental" {
		return runSingleUnitKBCreation(ctx, input, creds)
	}

	// Step 3: Create work plan
	// Route to kb-processing queue where the Python activity is registered.
	log.Printf("[KnowledgeBaseCreationWorkflow] Step 3: Creating work plan")
	wpAO := workflow.ActivityOptions{
		TaskQueue:              kbProcessingQueue,
		StartToCloseTimeout:    30 * time.Minute,
		ScheduleToStartTimeout: 5 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    3,
		},
	}
	wpCtx := workflow.WithActivityOptions(ctx, wpAO)
	var plan types.WorkPlan
	err = workflow.ExecuteActivity(wpCtx, "CreateWorkPlanActivity", types.CreateWorkPlanInput{
		BucketName:   input.BucketName,
		PathPrefix:   input.PathPrefix,
		DatasetId:    input.SourceDatasetId,
		JobId:        workflowID,
		WorkloadType: "kb",
	}).Get(ctx, &plan)
	if err != nil {
		log.Printf("[KnowledgeBaseCreationWorkflow] ERROR: Failed to create work plan: %v", err)
		result.Status = "failed"
		result.ErrorMessage = fmt.Sprintf("failed to create work plan: %v", err)
		workflow.ExecuteActivity(ctx, "UpdateKBStatusActivity", input.ProjectId, input.KnowledgeBaseId, "errored", "", result.ErrorMessage).Get(ctx, nil)
		return result, err
	}

	log.Printf("[KnowledgeBaseCreationWorkflow] Work plan: %d file sets for %d files", len(plan.FileSets), plan.TotalFiles)

	// Set initial progress with job-level totalFiles so the progress store shows total job size
	// and merged updates from activities keep this total (max merge).
	initialProgress := types.KBProgressInfo{
		Phase:      "initializing",
		Status:     "in_progress",
		TotalFiles: plan.TotalFiles,
	}
	workflow.ExecuteActivity(ctx, "UpdateKBProgressActivity", input.ProjectId, input.KnowledgeBaseId, initialProgress).Get(ctx, nil)

	// Step 4: Build work unit inputs
	workUnits := make([]interface{}, len(plan.FileSets))
	for i, fs := range plan.FileSets {
		workUnits[i] = buildKBWorkUnitInput(input, creds, fs, plan.JobOutputPrefix, workflowID)
	}

	// Seed progress store with totalUnits and pending unit slots so GUI shows "0 of N units" before any activity POSTs
	seedUnits := make([]activities.UnitProgressSeed, len(plan.FileSets))
	for i, fs := range plan.FileSets {
		seedUnits[i] = activities.UnitProgressSeed{UnitID: fs.SetID, Status: "pending"}
	}
	_ = workflow.ExecuteActivity(ctx, "PostWorkflowProgressActivity", activities.PostWorkflowProgressInput{
		TotalUnits: len(plan.FileSets),
		Units:      seedUnits,
	}).Get(ctx, nil)

	// Step 5: ScatterGather - fan out ProcessKBDocuments activities
	// Accumulate completed-only stats so job-level progress shows sum of finished units, not per-activity.
	var totalProcessedDocs, totalChunksCreated int
	log.Printf("[KnowledgeBaseCreationWorkflow] Step 5: Running ScatterGather with %d units", len(workUnits))
	sgResult, err := RunScatterGather(ctx, ScatterGatherParams{
		ProcessActivityName: "ProcessKBDocuments",
		MergeActivityName:   "",
		TaskQueue:           kbProcessingQueue,
		ProcessTimeout:      6 * time.Hour,
		HeartbeatTimeout:    5 * time.Minute,
		// ScheduleToStartTimeout left unset (0): allow multi-hour queue waits when workers are scarce.
		MergeTimeout: 2 * time.Hour,
		WorkUnits:    workUnits,
		OnUnitComplete: func(completed, total int) {
			_ = workflow.ExecuteActivity(ctx, "PostWorkflowProgressActivity", activities.PostWorkflowProgressInput{
				Phase:      "processing",
				Percentage: float64(completed) / float64(total) * 85,
				Message:    fmt.Sprintf("Completed %d of %d work units", completed, total),
			}).Get(ctx, nil)
		},
		OnUnitCompleteWithResult: func(completed, total int, wuResult *types.WorkUnitResult) {
			if wuResult != nil {
				unitStatus := "completed"
				if wuResult.Status != "success" {
					unitStatus = "failed"
				}
				unitMetrics := map[string]interface{}{"fileCount": wuResult.FileCount, "rowCount": wuResult.RowCount}
				_ = workflow.ExecuteActivity(ctx, "PostWorkflowProgressActivity", activities.PostWorkflowProgressInput{
					UnitID:      wuResult.SetID,
					UnitStatus:  unitStatus,
					UnitMetrics: unitMetrics,
				}).Get(ctx, nil)
				if wuResult.Status == "success" {
					totalProcessedDocs += wuResult.FileCount
					totalChunksCreated += wuResult.RowCount
				}
			}
			_ = workflow.ExecuteActivity(ctx, "UpdateKBProgressActivity", input.ProjectId, input.KnowledgeBaseId, types.KBProgressInfo{
				Phase:              "processing",
				Status:             "in_progress",
				TotalFiles:         plan.TotalFiles,
				DocumentsProcessed: totalProcessedDocs,
				ChunksCreated:      totalChunksCreated,
				VectorsCreated:     totalChunksCreated,
				DocumentCount:      totalProcessedDocs,
				ChunkCount:         totalChunksCreated,
				VectorCount:        totalChunksCreated,
				ReplaceProgress:    true,
			}).Get(ctx, nil)
		},
	})
	if err != nil {
		log.Printf("[KnowledgeBaseCreationWorkflow] ERROR: ScatterGather failed: %v", err)
		result.Status = "failed"
		result.ErrorMessage = fmt.Sprintf("processing failed: %v", err)
		workflow.ExecuteActivity(ctx, "UpdateKBStatusActivity", input.ProjectId, input.KnowledgeBaseId, "errored", "", result.ErrorMessage).Get(ctx, nil)
		return result, err
	}

	log.Printf("[KnowledgeBaseCreationWorkflow] ScatterGather complete: %d succeeded, %d failed",
		sgResult.Succeeded, sgResult.Failed)

	// Step 6: Merge results
	_ = workflow.ExecuteActivity(ctx, "PostWorkflowProgressActivity", activities.PostWorkflowProgressInput{
		Phase:      "aggregating",
		Percentage: 88,
		Message:    "Merging results from all work units",
	}).Get(ctx, nil)

	mergeInput := buildKBMergeInput(input, creds, plan.JobOutputPrefix, workflowID)

	mergeOpts := workflow.ActivityOptions{
		TaskQueue:           kbProcessingQueue,
		StartToCloseTimeout: 4 * time.Hour,
		HeartbeatTimeout:    10 * time.Minute,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 2},
	}
	mergeCtx := workflow.WithActivityOptions(ctx, mergeOpts)
	var mergeResult map[string]interface{}
	err = workflow.ExecuteActivity(mergeCtx, "MergeKBResults", mergeInput).Get(ctx, &mergeResult)
	if err != nil {
		result.Status = "failed"
		result.ErrorMessage = fmt.Sprintf("merge failed: %v", err)
		workflow.ExecuteActivity(ctx, "UpdateKBStatusActivity", input.ProjectId, input.KnowledgeBaseId, "errored", "", result.ErrorMessage).Get(ctx, nil)
		return result, err
	}

	// Step 7: Resolve KB metadata. Prefer the in-memory merge return so we
	// don't race the tmp-rename on the S3 write; fall back to reading the
	// unified metadata.json when the merge activity didn't include it.
	log.Printf("[KnowledgeBaseCreationWorkflow] Step 7: Resolving KB metadata")
	processingResult := kbMetadataFromMergeResult(mergeResult)
	if processingResult == nil || processingResult.LanceTablePath == "" {
		var fromS3 types.KBMetadata
		err = workflow.ExecuteActivity(ctx, "ReadKBMetadataActivity", input.BucketName, input.KnowledgeBaseId, input.PathPrefix).Get(ctx, &fromS3)
		if err != nil {
			result.Status = "failed"
			result.ErrorMessage = fmt.Sprintf("failed to read KB metadata: %v", err)
			workflow.ExecuteActivity(ctx, "UpdateKBStatusActivity", input.ProjectId, input.KnowledgeBaseId, "errored", "", result.ErrorMessage).Get(ctx, nil)
			return result, err
		}
		processingResult = &fromS3
	}

	if processingResult.Status != "" && processingResult.Status != "success" {
		result.Status = "failed"
		result.ErrorMessage = fmt.Sprintf("KB processing failed: %s", processingResult.Error)
		workflow.ExecuteActivity(ctx, "UpdateKBStatusActivity", input.ProjectId, input.KnowledgeBaseId, "errored", "", result.ErrorMessage).Get(ctx, nil)
		return result, fmt.Errorf("KB processing failed: %s", processingResult.Error)
	}

	// Step 8: Update KB status with counts (top-level) + storage stats (nested) + deferred config.
	log.Printf("[KnowledgeBaseCreationWorkflow] Step 8: Updating KB status")
	updateInput := activities.UpdateKBStatusInput{
		ProjectId:           input.ProjectId,
		KbId:                input.KnowledgeBaseId,
		Status:              "ready",
		LanceTablePath:      processingResult.LanceTablePath,
		DocumentCount:       processingResult.DocumentCount,
		ChunkCount:          processingResult.ChunkCount,
		VectorCount:         processingResult.VectorCount,
		Stats:               processingResult.Stats,
		SourceDataset:       input.SourceDatasetId,
		EmbeddingModel:      input.EmbeddingModel,
		EmbeddingModelId:    input.EmbeddingModelId,
		DataType:            input.DataType,
		TextColumns:         input.TextColumns,
		ChunkSize:           input.ChunkSize,
		ChunkStrategy:       input.ChunkStrategy,
		ChunkOverlap:        input.ChunkOverlap,
		ChunkOptions:        input.ChunkOptions,
		IndexingMode:        input.IndexingMode,
		QuantizationType:    input.QuantizationType,
		QuantizationOptions: input.QuantizationOptions,
		VectorSize:          input.VectorSize,
	}
	err = workflow.ExecuteActivity(ctx, "UpdateKBStatusWithStatsActivity", updateInput).Get(ctx, nil)
	if err != nil {
		log.Printf("[KnowledgeBaseCreationWorkflow] WARNING: Step 8 failed (continuing): %v", err)
	}

	finalProgress := types.KBProgressInfo{
		Phase:          "completed",
		Status:         "success",
		VectorCount:    processingResult.VectorCount,
		ChunkCount:     processingResult.ChunkCount,
		DocumentCount:  processingResult.DocumentCount,
		LanceTablePath: processingResult.LanceTablePath,
	}
	workflow.ExecuteActivity(ctx, "UpdateKBProgressActivity", input.ProjectId, input.KnowledgeBaseId, finalProgress).Get(ctx, nil)

	result.Status = "completed"
	result.LanceTablePath = processingResult.LanceTablePath

	_ = workflow.ExecuteActivity(ctx, "PostWorkflowProgressActivity", activities.PostWorkflowProgressInput{
		Phase:      "completed",
		Percentage: 100,
		Message:    "KB creation completed successfully",
	}).Get(ctx, nil)

	log.Printf("[KnowledgeBaseCreationWorkflow] Workflow completed for KB: %s", input.KnowledgeBaseId)
	return result, nil
}

// runSingleUnitKBCreation handles incremental mode or small datasets as a
// single ProcessKBDocuments activity dispatched to the KB worker.
//
// KNOWN GAP — pre-dates the metadata-unification port, surfaced by it:
// `ProcessKBDocuments` writes a partition parquet at `outputPath`, NOT a
// LanceDB table and NOT the unified metadata.json. The multi-unit path
// has a follow-up `MergeKBResults` activity that does both; this path
// does not. Today incremental mode falls back to `ReadKBMetadataActivity`
// reading the PREVIOUS run's metadata.json — which means newly-ingested
// chunks aren't reflected in the KB record's counts / LanceDB table
// until the next full reprocess. Either (a) make `ProcessKBDocuments`
// do the full merge when there's only one partition, or (b) add a
// `MergeKBResults` call here after `ProcessKBDocuments`. Left as a
// follow-up because fixing it is a structural change orthogonal to the
// metadata-shape consolidation this port is about.
func runSingleUnitKBCreation(ctx workflow.Context, input types.KnowledgeBaseCreationWorkflowInput, creds types.ProjectCredentials) (types.KnowledgeBaseCreationWorkflowResult, error) {
	workflowID := workflow.GetInfo(ctx).WorkflowExecution.ID

	result := types.KnowledgeBaseCreationWorkflowResult{
		ProjectId:       input.ProjectId,
		KnowledgeBaseId: input.KnowledgeBaseId,
		Status:          "running",
	}

	log.Printf("[KnowledgeBaseCreationWorkflow] Running single-unit path for KB: %s", input.KnowledgeBaseId)

	unitInput := buildKBFullInput(input, creds, workflowID)

	actOpts := workflow.ActivityOptions{
		TaskQueue:           kbProcessingQueue,
		StartToCloseTimeout: 12 * time.Hour,
		HeartbeatTimeout:    5 * time.Minute,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 3},
	}
	actCtx := workflow.WithActivityOptions(ctx, actOpts)

	var actResult map[string]interface{}
	err := workflow.ExecuteActivity(actCtx, "ProcessKBDocuments", unitInput).Get(ctx, &actResult)
	if err != nil {
		result.Status = "failed"
		result.ErrorMessage = fmt.Sprintf("KB processing failed: %v", err)
		workflow.ExecuteActivity(ctx, "UpdateKBStatusActivity", input.ProjectId, input.KnowledgeBaseId, "errored", "", result.ErrorMessage).Get(ctx, nil)
		return result, err
	}

	// Single-unit path also writes the unified metadata.json on success; the
	// activity return carries the same dict, so prefer it over an S3 re-read.
	processingResult := kbMetadataFromMergeResult(actResult)
	if processingResult == nil || processingResult.LanceTablePath == "" {
		var fromS3 types.KBMetadata
		err = workflow.ExecuteActivity(ctx, "ReadKBMetadataActivity", input.BucketName, input.KnowledgeBaseId, input.PathPrefix).Get(ctx, &fromS3)
		if err != nil {
			result.Status = "failed"
			result.ErrorMessage = fmt.Sprintf("failed to read KB metadata: %v", err)
			workflow.ExecuteActivity(ctx, "UpdateKBStatusActivity", input.ProjectId, input.KnowledgeBaseId, "errored", "", result.ErrorMessage).Get(ctx, nil)
			return result, err
		}
		processingResult = &fromS3
	}

	if processingResult.Status != "" && processingResult.Status != "success" {
		result.Status = "failed"
		result.ErrorMessage = fmt.Sprintf("KB processing failed: %s", processingResult.Error)
		workflow.ExecuteActivity(ctx, "UpdateKBStatusActivity", input.ProjectId, input.KnowledgeBaseId, "errored", "", result.ErrorMessage).Get(ctx, nil)
		return result, fmt.Errorf("KB processing failed: %s", processingResult.Error)
	}

	updateInput := activities.UpdateKBStatusInput{
		ProjectId:           input.ProjectId,
		KbId:                input.KnowledgeBaseId,
		Status:              "ready",
		LanceTablePath:      processingResult.LanceTablePath,
		DocumentCount:       processingResult.DocumentCount,
		ChunkCount:          processingResult.ChunkCount,
		VectorCount:         processingResult.VectorCount,
		Stats:               processingResult.Stats,
		SourceDataset:       input.SourceDatasetId,
		EmbeddingModel:      input.EmbeddingModel,
		EmbeddingModelId:    input.EmbeddingModelId,
		DataType:            input.DataType,
		TextColumns:         input.TextColumns,
		ChunkSize:           input.ChunkSize,
		ChunkStrategy:       input.ChunkStrategy,
		ChunkOverlap:        input.ChunkOverlap,
		ChunkOptions:        input.ChunkOptions,
		IndexingMode:        input.IndexingMode,
		QuantizationType:    input.QuantizationType,
		QuantizationOptions: input.QuantizationOptions,
		VectorSize:          input.VectorSize,
	}
	_ = workflow.ExecuteActivity(ctx, "UpdateKBStatusWithStatsActivity", updateInput).Get(ctx, nil)

	finalProgress := types.KBProgressInfo{
		Phase:          "completed",
		Status:         "success",
		VectorCount:    processingResult.VectorCount,
		ChunkCount:     processingResult.ChunkCount,
		DocumentCount:  processingResult.DocumentCount,
		LanceTablePath: processingResult.LanceTablePath,
	}
	workflow.ExecuteActivity(ctx, "UpdateKBProgressActivity", input.ProjectId, input.KnowledgeBaseId, finalProgress).Get(ctx, nil)

	result.Status = "completed"
	result.LanceTablePath = processingResult.LanceTablePath
	return result, nil
}

// addUnifiedEmbeddingFields stamps the workflow input's unified-embedding
// fields onto the activity payload map. Centralised so the three builder
// functions below stay consistent — adding a new field is a one-line edit
// here instead of three. The fields are no-ops when empty (kb-processor
// Config falls back to env) which keeps pre-Phase-5 dispatches working.
func addUnifiedEmbeddingFields(payload map[string]interface{}, input types.KnowledgeBaseCreationWorkflowInput) {
	payload["embedding_model_id"] = input.EmbeddingModelId
	payload["embedding_provider"] = input.EmbeddingProvider
	payload["embedding_provider_model_id"] = input.EmbeddingProviderModelId
	payload["embedding_gateway_model_id"] = input.EmbeddingGatewayModelId
	payload["embedding_endpoint"] = input.EmbeddingEndpoint
	payload["embedding_dimensions"] = input.EmbeddingDimensions
	payload["project_virtual_key_token"] = input.ProjectVirtualKeyToken
	payload["llm_gateway_url"] = input.LLMGatewayURL
}

func buildKBWorkUnitInput(input types.KnowledgeBaseCreationWorkflowInput, creds types.ProjectCredentials, fs types.FileSet, jobOutputPrefix, workflowID string) map[string]interface{} {
	payload := map[string]interface{}{
		"kb_id":                    input.KnowledgeBaseId,
		"kb_name":                  input.KBName,
		"project_id":               input.ProjectId,
		"source_dataset_id":        input.SourceDatasetId,
		"bucket_name":              input.BucketName,
		"s3_path_prefix":           input.PathPrefix,
		"embedding_model":          input.EmbeddingModel,
		"chunk_size":               input.ChunkSize,
		"chunk_strategy":           input.ChunkStrategy,
		"chunk_overlap":            input.ChunkOverlap,
		"vector_size":              input.VectorSize,
		"data_type":                input.DataType,
		"dataset_kind":             input.DatasetKind,
		"catalog_table_ref":        input.CatalogTableRef,
		"text_columns":             input.TextColumns,
		"warehouse_id":             input.WarehouseId,
		"indexing_mode":            input.IndexingMode,
		"quantization_type":        input.QuantizationType,
		"quantization_options":     input.QuantizationOptions,
		"embedding_batch_size":     input.EmbeddingBatchSize,
		"manifest_s3_key":          fs.ManifestS3Key,
		"output_prefix":            fs.OutputPrefix,
		"set_id":                   fs.SetID,
		"job_output_prefix":        jobOutputPrefix,
		"workflow_id":              workflowID,
		"project_client_id":        creds.ProjectClientId,
		"project_client_secret":    creds.ProjectClientSecret,
		"aws_access_key_id":        creds.S3AccessKey,
		"aws_secret_access_key":    creds.S3SecretKey,
		"s3_endpoint":              creds.S3Endpoint,
		"aws_region":               creds.S3Region,
		"config_service_url":       creds.ConfigServiceURL,
		"keycloak_internal_issuer": creds.KeycloakIssuer,
		"lakekeeper_url":           creds.LakekeeperURL,
	}
	addUnifiedEmbeddingFields(payload, input)
	return payload
}

func buildKBMergeInput(input types.KnowledgeBaseCreationWorkflowInput, creds types.ProjectCredentials, jobOutputPrefix, workflowID string) map[string]interface{} {
	payload := map[string]interface{}{
		"kb_id":                    input.KnowledgeBaseId,
		"kb_name":                  input.KBName,
		"project_id":               input.ProjectId,
		"source_dataset_id":        input.SourceDatasetId,
		"bucket_name":              input.BucketName,
		"s3_path_prefix":           input.PathPrefix,
		"embedding_model":          input.EmbeddingModel,
		"chunk_size":               input.ChunkSize,
		"vector_size":              input.VectorSize,
		"data_type":                input.DataType,
		"dataset_kind":             input.DatasetKind,
		"catalog_table_ref":        input.CatalogTableRef,
		"text_columns":             input.TextColumns,
		"warehouse_id":             input.WarehouseId,
		"indexing_mode":            input.IndexingMode,
		"quantization_type":        input.QuantizationType,
		"quantization_options":     input.QuantizationOptions,
		"job_output_prefix":        jobOutputPrefix,
		"workflow_id":              workflowID,
		"project_client_id":        creds.ProjectClientId,
		"project_client_secret":    creds.ProjectClientSecret,
		"aws_access_key_id":        creds.S3AccessKey,
		"aws_secret_access_key":    creds.S3SecretKey,
		"s3_endpoint":              creds.S3Endpoint,
		"aws_region":               creds.S3Region,
		"config_service_url":       creds.ConfigServiceURL,
		"keycloak_internal_issuer": creds.KeycloakIssuer,
		"lakekeeper_url":           creds.LakekeeperURL,
	}
	addUnifiedEmbeddingFields(payload, input)
	return payload
}

func buildKBFullInput(input types.KnowledgeBaseCreationWorkflowInput, creds types.ProjectCredentials, workflowID string) map[string]interface{} {
	payload := map[string]interface{}{
		"kb_id":                    input.KnowledgeBaseId,
		"kb_name":                  input.KBName,
		"project_id":               input.ProjectId,
		"source_dataset_id":        input.SourceDatasetId,
		"bucket_name":              input.BucketName,
		"s3_path_prefix":           input.PathPrefix,
		"embedding_model":          input.EmbeddingModel,
		"chunk_size":               input.ChunkSize,
		"chunk_strategy":           input.ChunkStrategy,
		"chunk_overlap":            input.ChunkOverlap,
		"vector_size":              input.VectorSize,
		"data_type":                input.DataType,
		"processing_mode":          input.ProcessingMode,
		"dataset_kind":             input.DatasetKind,
		"catalog_table_ref":        input.CatalogTableRef,
		"text_columns":             input.TextColumns,
		"warehouse_id":             input.WarehouseId,
		"indexing_mode":            input.IndexingMode,
		"quantization_type":        input.QuantizationType,
		"quantization_options":     input.QuantizationOptions,
		"embedding_batch_size":     input.EmbeddingBatchSize,
		"workflow_id":              workflowID,
		"project_client_id":        creds.ProjectClientId,
		"project_client_secret":    creds.ProjectClientSecret,
		"aws_access_key_id":        creds.S3AccessKey,
		"aws_secret_access_key":    creds.S3SecretKey,
		"s3_endpoint":              creds.S3Endpoint,
		"aws_region":               creds.S3Region,
		"config_service_url":       creds.ConfigServiceURL,
		"keycloak_internal_issuer": creds.KeycloakIssuer,
		"lakekeeper_url":           creds.LakekeeperURL,
	}
	addUnifiedEmbeddingFields(payload, input)
	return payload
}

// kbMetadataFromMergeResult decodes the MergeKBResults activity return value
// into the unified KBMetadata struct. Prefer this over the S3 re-read on the
// happy path — the merge activity returns exactly the dict it wrote to
// metadata.json, so we save one S3 round-trip and avoid the stale-read race
// where the workflow reads before kb-processor's tmp-rename completes.
//
// Counts come from the top-level keys (KBMetadata shape); storage / file
// info comes from the nested `stats` map (KBStats shape). For forward-compat
// with legacy returns that still carry counts inside `stats`, the helper
// reads top-level first and falls back to nested when absent.
//
// Returns nil if the result lacks BOTH `lanceTablePath` AND counts —
// signalling the caller to fall back to the S3 read. Without this guard
// a future activity that returns just `{status: "success"}` would
// short-circuit the fallback and we'd write zero counts to the KB record.
//
// The struct only carries the workflow-result subset of the unified shape.
// The same in-memory dict also has embedding identity + index capability
// fields that kb-retrieval-service reads from the on-disk metadata.json
// directly — by design; the Go workflow doesn't need them.
func kbMetadataFromMergeResult(mergeResult map[string]interface{}) *types.KBMetadata {
	if mergeResult == nil {
		return nil
	}
	m := &types.KBMetadata{}
	if s, ok := mergeResult["status"].(string); ok {
		m.Status = s
	}
	if s, ok := mergeResult["knowledgeBaseId"].(string); ok {
		m.KnowledgeBaseId = s
	}
	if s, ok := mergeResult["projectId"].(string); ok {
		m.ProjectId = s
	}
	if s, ok := mergeResult["lanceTablePath"].(string); ok {
		m.LanceTablePath = s
	}
	if s, ok := mergeResult["sourceType"].(string); ok {
		m.SourceType = s
	}
	if s, ok := mergeResult["error"].(string); ok {
		m.Error = s
	}
	// Counts: prefer top-level (unified shape), fall back to nested (legacy).
	nested, _ := mergeResult["stats"].(map[string]interface{})
	if v, ok := toInt(mergeResult["documentCount"]); ok {
		m.DocumentCount = v
	} else if nested != nil {
		if v, ok := toInt(nested["documentCount"]); ok {
			m.DocumentCount = v
		}
	}
	if v, ok := toInt(mergeResult["chunkCount"]); ok {
		m.ChunkCount = v
	} else if nested != nil {
		if v, ok := toInt(nested["chunkCount"]); ok {
			m.ChunkCount = v
		}
	}
	if v, ok := toInt(mergeResult["vectorCount"]); ok {
		m.VectorCount = v
	} else if nested != nil {
		if v, ok := toInt(nested["vectorCount"]); ok {
			m.VectorCount = v
		}
	}
	// Storage / file info: only from nested `stats`.
	if nested != nil {
		stats := &types.KBStats{}
		populated := false
		if v, ok := toInt64(nested["storageBytes"]); ok {
			stats.StorageBytes = v
			populated = true
		}
		if v, ok := toFloat64(nested["storageMB"]); ok {
			stats.StorageMB = v
			populated = true
		}
		if v, ok := toInt(nested["fileCount"]); ok {
			stats.FileCount = v
			populated = true
		}
		if s, ok := nested["lastProcessedAt"].(string); ok {
			stats.LastProcessedAt = s
			populated = true
		}
		if populated {
			m.Stats = stats
		}
	}
	// Refuse to return a partially-populated struct that would let the
	// caller skip the S3 fallback and write zero counts to the KB record.
	// "Useful" means we have at least the path AND a real chunk count.
	if m.LanceTablePath == "" || m.ChunkCount == 0 {
		return nil
	}
	return m
}

func toInt(v interface{}) (int, bool) {
	switch x := v.(type) {
	case float64:
		return int(x), true
	case int:
		return x, true
	case int64:
		return int(x), true
	default:
		return 0, false
	}
}

func toInt64(v interface{}) (int64, bool) {
	switch x := v.(type) {
	case float64:
		return int64(x), true
	case int:
		return int64(x), true
	case int64:
		return x, true
	default:
		return 0, false
	}
}

func toFloat64(v interface{}) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	default:
		return 0, false
	}
}
