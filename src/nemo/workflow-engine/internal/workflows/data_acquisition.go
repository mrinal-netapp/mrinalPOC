package workflows

import (
	"fmt"
	"log"
	"math"
	"path/filepath"
	"strings"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/internal/activities"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

const connectorOperationsQueue = "connector-operations"

// objectStoreSetIDPrefix is used both as the unit ID for ScatterGather and as a
// suffix on the Redis consumer name. Keep stable -- referenced by progress callbacks.
const objectStoreSetIDPrefix = "acq-s"

// DataAcquisitionWorkflowInput is the input to the acquisition workflow.
type DataAcquisitionWorkflowInput struct {
	ProjectID        string `json:"projectId"`
	DatasetID        string `json:"datasetId"`
	ConfigServiceURL string `json:"configServiceURL"` // Base URL for connector-worker to call credential secret-data (e.g. http://config-service:3000)
}

// DataAcquisitionWorkflowResult is the result of the acquisition workflow.
type DataAcquisitionWorkflowResult struct {
	ProjectID    string `json:"projectId"`
	DatasetID    string `json:"datasetId"`
	RowCount     int    `json:"rowCount,omitempty"`
	FilesCopied  int    `json:"filesCopied,omitempty"`
	Status       string `json:"status"`
	ErrorMessage string `json:"errorMessage,omitempty"`
}

// DataAcquisitionWorkflow fetches config, dispatches typed acquisition activity,
// chains DatasetImportWorkflow as a child, and updates watermark/status.
//
// Phase 1b refactor: object-store acquisition runs through the streaming pipeline
// (DiscoverSourceItems -> N parallel AcquireBatch -> FinalizeAcquisition) so a
// single 11k-file job no longer rides one long-lived activity. Database
// acquisition still uses the legacy single-shot AcquireFromDatabase. Behind
// ACQ_USE_PIPELINE flag (default true); set to false to fall back to the
// legacy AcquireFromObjectStore activity (e.g., if Redis is unavailable).
func DataAcquisitionWorkflow(ctx workflow.Context, input DataAcquisitionWorkflowInput) (DataAcquisitionWorkflowResult, error) {
	workflowID := workflow.GetInfo(ctx).WorkflowExecution.ID
	runID := workflow.GetInfo(ctx).WorkflowExecution.RunID
	logger := workflow.GetLogger(ctx)
	log.Printf("[DataAcquisitionWorkflow] Starting: project=%s, dataset=%s, workflowID=%s runID=%s",
		input.ProjectID, input.DatasetID, workflowID, runID)

	result := DataAcquisitionWorkflowResult{
		ProjectID: input.ProjectID,
		DatasetID: input.DatasetID,
		Status:    "running",
	}

	localAO := workflow.ActivityOptions{
		StartToCloseTimeout: 2 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    3,
		},
	}
	// Root ctx has no ActivityOptions; Temporal rejects ExecuteActivity without timeouts.
	// localCtx = short calls on default task queue (config, status, progress). connCtx
	// and other *Ctx below are siblings from ctx, each with their own queue/timeouts.
	localCtx := workflow.WithActivityOptions(ctx, localAO)

	// Cancel/timeout cleanup: if the workflow is cancelled or times out we still
	// want to GC the per-job Redis stream. Run CleanupAcquisitionStream from a
	// disconnected context (the parent ctx is cancelled in this branch). Safe
	// to keep around even when we never actually create the stream -- destroy() is idempotent.
	pipelineCfg := activities.GetAcquisitionPipelineConfigFromEnv()
	if pipelineCfg.UsePipeline {
		workflow.Go(ctx, func(gCtx workflow.Context) {
			gCtx.Done().Receive(gCtx, nil)
			cleanupCtx, _ := workflow.NewDisconnectedContext(gCtx)
			cleanupAO := workflow.ActivityOptions{
				TaskQueue:           connectorOperationsQueue,
				StartToCloseTimeout: 2 * time.Minute,
				RetryPolicy: &temporal.RetryPolicy{
					InitialInterval:    time.Second,
					BackoffCoefficient: 2.0,
					MaximumAttempts:    2,
				},
			}
			cCtx := workflow.WithActivityOptions(cleanupCtx, cleanupAO)
			err := workflow.ExecuteActivity(cCtx, "CleanupAcquisitionStream",
				map[string]string{"workflowId": workflowID, "runId": runID}).Get(cCtx, nil)
			if err != nil {
				logger.Warn("CleanupAcquisitionStream on cancel/timeout failed; EXPIRE will GC keys",
					"error", err.Error())
			}
		})
	}

	// Step 1: Set status to in_progress
	_ = workflow.ExecuteActivity(localCtx, "UpdateDatasetStatusActivity",
		input.ProjectID, input.DatasetID, "in_progress", "").Get(ctx, nil)

	// Step 1b: Mark acquisition facet as in_progress with jobId=workflowID. This
	// activates the existing per-facet live-progress polling (mirrors PII pattern
	// in dataSetRoutes.ts). FinalizeAcquisition will transition to ready/errored/failed.
	startedAtISO := workflow.Now(ctx).UTC().Format(time.RFC3339)
	_ = workflow.ExecuteActivity(localCtx, "UpdateAcquisitionFacetActivity",
		activities.UpdateAcquisitionFacetInput{
			ProjectID: input.ProjectID,
			DatasetID: input.DatasetID,
			State:     "in_progress",
			JobID:     workflowID,
			Summary:   map[string]interface{}{"startedAt": startedAtISO},
		}).Get(ctx, nil)

	// Step 2: Fetch dataset config
	var dataset map[string]interface{}
	err := workflow.ExecuteActivity(localCtx, activities.FetchDatasetConfigActivity,
		input.ProjectID, input.DatasetID).Get(ctx, &dataset)
	if err != nil {
		return failAcquisition(ctx, localCtx, input, result, fmt.Sprintf("failed to fetch dataset: %v", err))
	}

	log.Printf("[DataAcquisitionWorkflow] Dataset config: originConnector=%v kind=%v type=%v bucketName=%v filterSpec=%v acquisitionConfig=%v originVolume=%v",
		dataset["originConnector"], dataset["kind"], dataset["type"],
		dataset["bucketName"], dataset["filterSpec"], dataset["acquisitionConfig"],
		dataset["originVolume"])

	originVolume := extractOriginVolumeID(dataset)

	acqConfig, _ := dataset["acquisitionConfig"].(map[string]interface{})
	if acqConfig == nil {
		acqConfig, _ = dataset["acquisition_config"].(map[string]interface{})
	}
	if acqConfig == nil {
		acqConfig = make(map[string]interface{})
	}
	writeMode := resolveAcquisitionWriteMode(acqConfig)

	sqlQuery, _ := dataset["sqlQuery"].(string)
	if sqlQuery == "" {
		sqlQuery, _ = dataset["sql_query"].(string)
	}
	namespace, _ := dataset["namespace"].(string)
	datasetName, _ := dataset["name"].(string)
	datasetKind, _ := dataset["kind"].(string)

	bucketName, _ := dataset["bucketName"].(string)
	if bucketName == "" {
		bucketName, _ = dataset["bucket_name"].(string)
	}
	if bucketName == "" {
		return failAcquisition(ctx, localCtx, input, result, "dataset has no bucketName")
	}
	outputPath := fmt.Sprintf("/projects/%s/datasets/%s/data_files",
		input.ProjectID, input.DatasetID)

	// Connector activity options (longer timeout, on connector-operations queue)
	connAO := workflow.ActivityOptions{
		TaskQueue:           connectorOperationsQueue,
		StartToCloseTimeout: 30 * time.Minute,
		HeartbeatTimeout:    5 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    5 * time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    2,
		},
	}
	connCtx := workflow.WithActivityOptions(ctx, connAO)

	// Volume-backed datasets use POSIX mounts only — no originConnector or credentials.
	if originVolume != "" {
		return runVolumeDataAcquisition(
			ctx, localCtx, connCtx, input, result, dataset, originVolume,
			workflowID, runID, startedAtISO,
			bucketName, outputPath, writeMode, acqConfig,
			namespace, datasetName, datasetKind,
		)
	}

	originConnector, _ := dataset["originConnector"].(string)
	if originConnector == "" {
		originConnector, _ = dataset["origin_connector"].(string)
	}
	if originConnector == "" {
		return failAcquisition(ctx, localCtx, input, result, "dataset has no originConnector")
	}

	// Step 3: Fetch connector (data source) config
	var connector map[string]interface{}
	err = workflow.ExecuteActivity(localCtx, activities.FetchDataSourceConfigActivity,
		input.ProjectID, originConnector).Get(ctx, &connector)
	if err != nil {
		return failAcquisition(ctx, localCtx, input, result, fmt.Sprintf("failed to fetch connector: %v", err))
	}

	// Config-service returns snake_case (connector_config, credential_id); accept both
	connectorConfig, _ := connector["connectorConfig"].(map[string]interface{})
	if connectorConfig == nil {
		connectorConfig, _ = connector["connector_config"].(map[string]interface{})
	}
	credentialID, _ := connector["credentialId"].(string)
	if credentialID == "" {
		credentialID, _ = connector["credential_id"].(string)
	}
	if connectorConfig == nil {
		return failAcquisition(ctx, localCtx, input, result, "connector has no connectorConfig")
	}
	if credentialID == "" {
		return failAcquisition(ctx, localCtx, input, result, "connector has no credentialId")
	}

	// Apply dataset selection over connector bucket/prefix so UI selection is honoured.
	// Phase 2 unifies objectstore selection on `resourceSelector` (each entry is
	// `{ "bucket": "<b>", "prefix": "<p>" }`), so try that first. Fall back to the
	// legacy `filterSpec.sourcePath` string for datasets created before phase 2.
	objectstoreApplied := false
	if rs, _ := firstObjectStoreSelector(dataset); rs != nil {
		bucket, _ := rs["bucket"].(string)
		prefix, _ := rs["prefix"].(string)
		if bucket != "" {
			applyBucketPrefix(connectorConfig, bucket, prefix)
			log.Printf("[DataAcquisitionWorkflow] Applied dataset resourceSelector: bucket=%q prefix=%q", bucket, prefix)
			objectstoreApplied = true
		}
	}
	if !objectstoreApplied {
		// Legacy path. When dataset has bucketName, use it as the source bucket for objectstore so a typo
		// in sourcePath (e.g. "defaut-nemo/...") does not cause NoSuchBucket; prefix is taken from the path after the first "/".
		if filterSpec, _ := dataset["filterSpec"].(map[string]interface{}); filterSpec != nil {
			sp, _ := filterSpec["sourcePath"].(string)
			if sp == "" {
				sp, _ = filterSpec["source_path"].(string)
			}
			if sp != "" {
				applySourcePath(connectorConfig, sp, bucketName)
				log.Printf("[DataAcquisitionWorkflow] Applied dataset source path: %q -> connectorConfig bucket=%v prefix=%v",
					sp, connectorConfig["bucket"], connectorConfig["prefix"])
			}
		}
		if filterSpec, _ := dataset["filter_spec"].(map[string]interface{}); filterSpec != nil {
			sp, _ := filterSpec["sourcePath"].(string)
			if sp == "" {
				sp, _ = filterSpec["source_path"].(string)
			}
			if sp != "" {
				applySourcePath(connectorConfig, sp, bucketName)
				log.Printf("[DataAcquisitionWorkflow] Applied dataset source path (filter_spec): %q -> connectorConfig bucket=%v prefix=%v",
					sp, connectorConfig["bucket"], connectorConfig["prefix"])
			}
		}
	}

	// For DB connectors: overlay dataset sourceDatabase/sourceSchema when set (e.g. from explorer pick)
	// so acquisition connects to the right database when the connector has no database configured.
	applyDatabaseSourceOverlay(connectorConfig, dataset)

	resourceSelector, _ := dataset["resourceSelector"]
	if resourceSelector == nil {
		resourceSelector, _ = dataset["resource_selector"]
	}

	connectorType, _ := connectorConfig["connector_type"].(string)
	if connectorType == "" {
		connectorType, _ = connectorConfig["connectorType"].(string)
	}

	// For database connector, we need a database to connect to (connector config or dataset overlay).
	if connectorType == "database" {
		if db, _ := connectorConfig["database"].(string); db == "" {
			return failAcquisition(ctx, localCtx, input, result,
				"database connector requires a database: set it on the connector or pick a table from Browse so the dataset stores it")
		}
	}

	// Metrics-as-resource routing. When the dataset's resourceSelector points at
	// metric categories under a primary connector (ONTAP or GCP), we dispatch to
	// AcquireMetrics regardless of the connector_type label. This is done by
	// short-circuiting the connector_type switch below: we set
	// `metricsRouting=true` and an effective connectorType that the switch maps
	// to the metrics arm. This MUST happen BEFORE the writeMode==overwrite
	// ClearDatasetPath step (metrics datasets do not own a POSIX directory in
	// the same way) and BEFORE the cloud/objectstore arms which would otherwise
	// mis-route a `cloud`-typed GCP connector that has a metrics selector.
	metricsRouting := resourceSelectorLooksLikeMetrics(resourceSelector)
	if metricsRouting {
		provider, _ := connectorConfig["provider"].(string)
		if !metricsProviderAllowed(provider) {
			return failAcquisition(ctx, localCtx, input, result,
				fmt.Sprintf("metrics acquisition is only supported on ONTAP, GCP, and Azure cloud connectors; got provider=%q", provider))
		}
		// Overwrite for metrics is not currently safe: DatasetImportWorkflow
		// only appends to the Iceberg table, so an overwrite would clear the
		// raw parquet directory but leave duplicated rows accumulating in the
		// table. Until DatasetImportWorkflow learns true table replacement, we
		// reject overwrite for metrics in v1 with a clear error. The wizard
		// gates this in the GUI; this is the server-side belt.
		if writeMode == "overwrite" {
			return failAcquisition(ctx, localCtx, input, result,
				"metrics datasets do not support writeMode=overwrite in v1; use append (or incremental) so each run appends a new snapshot of metric samples")
		}
	}

	// Step 4: Overwrite mode — clear the dataset path first.
	// Skipped for metrics routing (we only support append/incremental there).
	if writeMode == "overwrite" && !metricsRouting {
		clearInput := map[string]interface{}{
			"outputPath": outputPath,
		}
		err = workflow.ExecuteActivity(connCtx, "ClearDatasetPath", clearInput).Get(ctx, nil)
		if err != nil {
			return failAcquisition(ctx, localCtx, input, result,
				fmt.Sprintf("failed to clear dataset path for overwrite: %v", err))
		}
		acqClearPath := fmt.Sprintf("/projects/%s/datasets/%s/_acquisition", input.ProjectID, input.DatasetID)
		err = workflow.ExecuteActivity(connCtx, "ClearDatasetPath", map[string]interface{}{
			"outputPath": acqClearPath,
		}).Get(ctx, nil)
		if err != nil {
			return failAcquisition(ctx, localCtx, input, result,
				fmt.Sprintf("failed to clear acquisition metadata path for overwrite: %v", err))
		}
	}

	// Step 5: Dispatch typed acquisition activity
	var acquireResult map[string]interface{}

	if metricsRouting {
		provider, _ := connectorConfig["provider"].(string)
		metricsWatermark, _ := acqConfig["lastWatermarkValue"].(string)
		if metricsWatermark == "" {
			metricsWatermark, _ = acqConfig["last_watermark_value"].(string)
		}
		metricsInput := map[string]interface{}{
			"projectID":        input.ProjectID,
			"datasetID":        input.DatasetID,
			"provider":         provider,
			"connectionInfo":   connectorConfig,
			"credentialId":     credentialID,
			"watermark":        metricsWatermark,
			"configServiceURL": input.ConfigServiceURL,
			"resourceSelector": resourceSelector,
		}

		metricsAO := workflow.ActivityOptions{
			TaskQueue:           connectorOperationsQueue,
			StartToCloseTimeout: 10 * time.Minute,
			HeartbeatTimeout:    60 * time.Second,
			RetryPolicy: &temporal.RetryPolicy{
				InitialInterval:    30 * time.Second,
				BackoffCoefficient: 2.0,
				MaximumAttempts:    3,
			},
		}
		metricsCtx := workflow.WithActivityOptions(ctx, metricsAO)
		err = workflow.ExecuteActivity(metricsCtx, "AcquireMetrics", metricsInput).Get(ctx, &acquireResult)
	} else {
		switch connectorType {
		case "database":
			timeoutSecs := 300
			if ts, ok := acqConfig["queryTimeoutSeconds"].(float64); ok {
				timeoutSecs = int(ts)
			}
			maxRows := 0
			if mr, ok := acqConfig["maxRows"].(float64); ok {
				maxRows = int(mr)
			}
			watermarkCol, _ := acqConfig["watermarkColumn"].(string)
			if watermarkCol == "" {
				watermarkCol, _ = acqConfig["watermark_column"].(string)
			}
			lastWatermark, _ := acqConfig["lastWatermarkValue"].(string)
			if lastWatermark == "" {
				lastWatermark, _ = acqConfig["last_watermark_value"].(string)
			}

			dbInput := map[string]interface{}{
				"projectID":        input.ProjectID,
				"datasetID":        input.DatasetID,
				"credentialID":     credentialID,
				"connectorConfig":  connectorConfig,
				"sqlQuery":         sqlQuery,
				"outputPath":       outputPath,
				"timeoutSecs":      timeoutSecs,
				"writeMode":        writeMode,
				"watermarkCol":     watermarkCol,
				"lastWatermark":    lastWatermark,
				"maxRows":          maxRows,
				"configServiceURL": input.ConfigServiceURL,
				"workflowID":       workflowID,
			}
			// Pass effective database/schema explicitly so activity always uses them (in case connectorConfig keys differ over the wire).
			if db, _ := connectorConfig["database"].(string); db != "" {
				dbInput["database"] = db
			}
			if schema, _ := connectorConfig["schema"].(string); schema != "" {
				dbInput["schema"] = schema
			}

			err = workflow.ExecuteActivity(connCtx, "AcquireFromDatabase", dbInput).Get(ctx, &acquireResult)

		case "objectstore":
			filters := extractObjectStoreFiltersFull(acqConfig, dataset)
			fileGlob := filters.FileIncludePattern
			if fileGlob == "" {
				fileGlob = filters.FileGlob
			}
			fileExcludePattern := filters.FileExcludePattern
			osProvider, _ := connectorConfig["provider"].(string)
			if strings.EqualFold(osProvider, "gcs") {
				acquireResult, err = executeAcquireFromGCS(
					ctx, connAO, input.ProjectID, input.DatasetID, credentialID,
					input.ConfigServiceURL, workflowID, connectorConfig, outputPath,
					filters,
				)
				break
			}
			pipelineInput := map[string]interface{}{
				"projectID":          input.ProjectID,
				"datasetID":          input.DatasetID,
				"credentialID":       credentialID,
				"connectorConfig":    connectorConfig,
				"outputPath":         outputPath,
				"outputBucket":       bucketName,
				"fileGlob":           fileGlob,
				"fileIncludePattern": filters.FileIncludePattern,
				"fileExcludePattern": fileExcludePattern,
				"maxFileSize":        filters.MaxFileSize,
				"modifiedAfter":      filters.ModifiedAfter,
				"configServiceURL":   input.ConfigServiceURL,
				// Note: workflowID/runID are NOT included; Python derives both from
				// activity.info() (finding #22). Tuning fields (batchSize, maxBatchesPerActivity)
				// are read from connector-worker env vars (finding #26).
			}

			if pipelineCfg.UsePipeline {
				log.Printf("[DataAcquisitionWorkflow] Streaming pipeline: bucket=%v prefix=%v fileGlob=%q fileExcludePattern=%q outputPath=%s",
					connectorConfig["bucket"], connectorConfig["prefix"], fileGlob, fileExcludePattern, outputPath)
				acquireResult, err = runStreamingObjectStoreAcquisition(
					ctx, connCtx, localCtx,
					input, workflowID,
					connectorConfig, pipelineInput,
					outputPath, startedAtISO,
					pipelineCfg,
				)
			} else {
				log.Printf("[DataAcquisitionWorkflow] Legacy AcquireFromObjectStore (ACQ_USE_PIPELINE=false): bucket=%v prefix=%v",
					connectorConfig["bucket"], connectorConfig["prefix"])
				legacyInput := make(map[string]interface{}, len(pipelineInput)+1)
				for k, v := range pipelineInput {
					legacyInput[k] = v
				}
				legacyInput["workflowID"] = workflowID
				objectStoreAO := connAO
				objectStoreAO.StartToCloseTimeout = 4 * time.Hour
				if objectStoreAO.RetryPolicy != nil {
					rp := *objectStoreAO.RetryPolicy
					rp.MaximumAttempts = 5
					objectStoreAO.RetryPolicy = &rp
				}
				objStoreCtx := workflow.WithActivityOptions(ctx, objectStoreAO)
				err = workflow.ExecuteActivity(objStoreCtx, "AcquireFromObjectStore", legacyInput).Get(ctx, &acquireResult)
			}

		case "api":
			provider, _ := connectorConfig["provider"].(string)
			apiInput := map[string]interface{}{
				"projectID":        input.ProjectID,
				"datasetID":        input.DatasetID,
				"provider":         provider,
				"connectionInfo":   connectorConfig,
				"credentialId":     credentialID,
				"configServiceURL": input.ConfigServiceURL,
				"resourceSelector": resourceSelector,
			}

			apiAO := workflow.ActivityOptions{
				TaskQueue:           connectorOperationsQueue,
				StartToCloseTimeout: 15 * time.Minute,
				HeartbeatTimeout:    60 * time.Second,
				RetryPolicy: &temporal.RetryPolicy{
					InitialInterval:    30 * time.Second,
					BackoffCoefficient: 2.0,
					MaximumAttempts:    3,
				},
			}
			apiCtx := workflow.WithActivityOptions(ctx, apiAO)
			err = workflow.ExecuteActivity(apiCtx, "AcquireFromAPI", apiInput).Get(ctx, &acquireResult)

		case "cloud":
			provider, _ := connectorConfig["provider"].(string)
			if provider != "gcp" {
				return failAcquisition(ctx, localCtx, input, result,
					fmt.Sprintf("cloud connector acquisition is only implemented for provider=gcp, got %q", provider))
			}
			gcsFilters := extractObjectStoreFiltersFull(acqConfig, dataset)
			acquireResult, err = executeAcquireFromGCS(
				ctx, connAO, input.ProjectID, input.DatasetID, credentialID,
				input.ConfigServiceURL, workflowID, connectorConfig, outputPath,
				gcsFilters,
			)

		default:
			return failAcquisition(ctx, localCtx, input, result,
				fmt.Sprintf("unsupported connector type: %s", connectorType))
		}
	}

	if err != nil {
		return failAcquisition(ctx, localCtx, input, result,
			fmt.Sprintf("acquisition activity failed: %v", err))
	}

	// Step 6: Chain DatasetImportWorkflow as child
	fileListKey, _ := acquireResult["fileListKey"].(string)
	childInput := types.DatasetImportWorkflowInput{
		ProjectId:   input.ProjectID,
		DataSetId:   input.DatasetID,
		DatasetName: datasetName,
		DatasetKind: datasetKind,
		BucketName:  bucketName,
		Namespace:   namespace,
		PathPrefix:  fmt.Sprintf("projects/%s", input.ProjectID),
		FileListKey: fileListKey,
	}

	childOpts := workflow.ChildWorkflowOptions{
		WorkflowID: fmt.Sprintf("import-%s-%s", input.ProjectID, input.DatasetID),
	}
	childCtx := workflow.WithChildOptions(ctx, childOpts)

	var importResult types.DatasetImportWorkflowResult
	err = workflow.ExecuteChildWorkflow(childCtx, DatasetImportWorkflow, childInput).Get(ctx, &importResult)
	if err != nil {
		return failAcquisition(ctx, localCtx, input, result,
			fmt.Sprintf("dataset import workflow failed: %v", err))
	}

	// Step 7: Update watermark if present
	if newWM, ok := acquireResult["newWatermarkValue"].(string); ok && newWM != "" {
		_ = workflow.ExecuteActivity(localCtx, activities.UpdateDatasetWatermarkActivity,
			input.ProjectID, input.DatasetID, newWM).Get(ctx, nil)
	}

	// Step 8: Update status to ready
	_ = workflow.ExecuteActivity(localCtx, "UpdateDatasetStatusActivity",
		input.ProjectID, input.DatasetID, "ready", "").Get(ctx, nil)

	if rc, ok := acquireResult["rowCount"].(float64); ok {
		result.RowCount = int(rc)
	}
	if fc, ok := acquireResult["filesCopied"].(float64); ok {
		result.FilesCopied = int(fc)
	}
	result.Status = "completed"

	// For database acquisitions (and as a defensive fallback for objectstore when
	// FinalizeAcquisition didn't run), mark the acquisition facet ready here. The
	// streaming-pipeline path also writes the facet from FinalizeAcquisition with
	// richer metrics; this call is a safe upsert that just clears jobId.
	if connectorType != "objectstore" || !pipelineCfg.UsePipeline {
		acqSummary := map[string]interface{}{
			"completedAt": workflow.Now(ctx).UTC().Format(time.RFC3339),
		}
		if result.RowCount > 0 {
			acqSummary["rowCount"] = result.RowCount
		}
		if result.FilesCopied > 0 {
			acqSummary["filesCopied"] = result.FilesCopied
		}
		_ = workflow.ExecuteActivity(localCtx, "UpdateAcquisitionFacetActivity",
			activities.UpdateAcquisitionFacetInput{
				ProjectID: input.ProjectID,
				DatasetID: input.DatasetID,
				State:     "ready",
				JobID:     "",
				Summary:   acqSummary,
			}).Get(ctx, nil)
	}

	log.Printf("[DataAcquisitionWorkflow] Completed: project=%s, dataset=%s", input.ProjectID, input.DatasetID)
	return result, nil
}

// runStreamingObjectStoreAcquisition wires Discover -> seed progress -> scatter
// AcquireBatch -> finalize. Returns the acquireResult map (parity with the legacy path).
func runStreamingObjectStoreAcquisition(
	ctx workflow.Context,
	connCtx workflow.Context,
	localCtx workflow.Context,
	input DataAcquisitionWorkflowInput,
	workflowID string,
	connectorConfig map[string]interface{},
	pipelineInput map[string]interface{},
	outputPath string,
	startedAtISO string,
	cfg types.AcquisitionPipelineConfig,
) (map[string]interface{}, error) {
	// Discover: long timeout because listing 100k+ keys can take a while.
	discoverAO := workflow.ActivityOptions{
		TaskQueue:           connectorOperationsQueue,
		StartToCloseTimeout: 1 * time.Hour,
		HeartbeatTimeout:    5 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    5 * time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    3,
		},
	}
	discoverCtx := workflow.WithActivityOptions(ctx, discoverAO)

	var discoverResult map[string]interface{}
	if err := workflow.ExecuteActivity(discoverCtx, "DiscoverSourceItems", pipelineInput).Get(ctx, &discoverResult); err != nil {
		// Discovery failure is terminal -- run finalize so the facet flips to failed and Redis gets cleaned up.
		_ = runFinalizeAcquisition(ctx, connCtx, input, outputPath, startedAtISO, connectorConfig, 0, 0, 0, true)
		return nil, fmt.Errorf("DiscoverSourceItems failed: %w", err)
	}

	totalDiscovered := readIntFromMap(discoverResult, "totalDiscovered", -1)
	filesFiltered := readIntFromMap(discoverResult, "filesFiltered", 0)
	filesListed := readIntFromMap(discoverResult, "filesListed", 0)

	consumers := decideConsumerCount(totalDiscovered, cfg)
	if consumers <= 0 {
		consumers = 1
	}

	log.Printf("[DataAcquisitionWorkflow] Discovery done: totalDiscovered=%d filesFiltered=%d filesListed=%d -> consumers=%d",
		totalDiscovered, filesFiltered, filesListed, consumers)

	// Post a "discovered" progress marker (jumps the bar to ~10%).
	pct := 10.0
	_ = workflow.ExecuteActivity(localCtx, "PostWorkflowProgressActivity", activities.PostWorkflowProgressInput{
		Phase:      "discovered",
		Percentage: pct,
		Message:    fmt.Sprintf("Discovered %d items", totalDiscovered),
		Extra: map[string]interface{}{
			"filesDiscovered": totalDiscovered,
			"filesFiltered":   filesFiltered,
			"filesListed":     filesListed,
		},
	}).Get(localCtx, nil)

	// Seed per-unit progress slots so OnUnitCompleteWithResult can update them.
	seedUnits := make([]activities.UnitProgressSeed, consumers)
	workUnits := make([]interface{}, consumers)
	for i := 0; i < consumers; i++ {
		setID := fmt.Sprintf("%s%d", objectStoreSetIDPrefix, i)
		seedUnits[i] = activities.UnitProgressSeed{UnitID: setID, Status: "pending"}
		unit := make(map[string]interface{}, len(pipelineInput)+1)
		for k, v := range pipelineInput {
			unit[k] = v
		}
		unit["setId"] = setID
		workUnits[i] = unit
	}
	_ = workflow.ExecuteActivity(localCtx, "PostWorkflowProgressActivity", activities.PostWorkflowProgressInput{
		Phase:      "copying",
		Percentage: pct,
		TotalUnits: consumers,
		Units:      seedUnits,
		Message:    fmt.Sprintf("Copying with %d consumers", consumers),
	}).Get(localCtx, nil)

	// Scatter: N parallel AcquireBatch activities. Per-unit completion drives progress;
	// AcquireBatch itself does NOT POST progress (avoids clobbering aggregated %).
	sgParams := ScatterGatherParams{
		ProcessActivityName:    "AcquireBatch",
		TaskQueue:              connectorOperationsQueue,
		ProcessTimeout:         30 * time.Minute,
		HeartbeatTimeout:       5 * time.Minute,
		ScheduleToStartTimeout: cfg.ScheduleToStartTimeout,
		WorkUnits:              workUnits,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    10 * time.Second,
			BackoffCoefficient: 2.0,
			MaximumInterval:    5 * time.Minute,
			MaximumAttempts:    3,
		},
		OnUnitComplete: func(completed, total int) {
			scaledPct := 10.0 + 80.0*float64(completed)/float64(total)
			_ = workflow.ExecuteActivity(localCtx, "PostWorkflowProgressActivity", activities.PostWorkflowProgressInput{
				Phase:      "copying",
				Percentage: scaledPct,
				Message:    fmt.Sprintf("Completed %d of %d units", completed, total),
			}).Get(localCtx, nil)
		},
		OnUnitCompleteWithResult: func(completed, total int, wuResult *types.WorkUnitResult) {
			if wuResult == nil {
				return
			}
			unitStatus := "completed"
			if wuResult.Status != "success" {
				unitStatus = "failed"
			}
			unitMetrics := map[string]interface{}{
				"fileCount": wuResult.FileCount,
			}
			if wuResult.Extra != nil {
				if v, ok := wuResult.Extra["bytesCopied"]; ok {
					unitMetrics["bytesCopied"] = v
				}
				if v, ok := wuResult.Extra["errorCount"]; ok {
					unitMetrics["errorCount"] = v
				}
				if v, ok := wuResult.Extra["durationMs"]; ok {
					unitMetrics["durationMs"] = v
				}
			}
			_ = workflow.ExecuteActivity(localCtx, "PostWorkflowProgressActivity", activities.PostWorkflowProgressInput{
				UnitID:      wuResult.SetID,
				UnitStatus:  unitStatus,
				UnitMetrics: unitMetrics,
			}).Get(localCtx, nil)
		},
	}

	sgResult, sgErr := RunScatterGather(ctx, sgParams)

	// Aggregate metrics from sg results to feed into Finalize.
	totalCopied := 0
	totalBytes := int64(0)
	for _, r := range sgResult.UnitResults {
		totalCopied += r.FileCount
		if r.Extra != nil {
			if b, ok := r.Extra["bytesCopied"]; ok {
				switch v := b.(type) {
				case float64:
					totalBytes += int64(v)
				case int:
					totalBytes += int64(v)
				case int64:
					totalBytes += v
				}
			}
		}
	}

	// Finalize always runs (happy path AND error path) so Redis is GC'd and the
	// facet reflects the final state.
	finalizeResult, finalizeErr := runFinalizeAcquisitionWithResult(
		ctx, connCtx, input, outputPath, startedAtISO, connectorConfig,
		totalDiscovered, filesFiltered, len(workUnits), sgErr != nil,
	)

	if sgErr != nil {
		return nil, fmt.Errorf("scatter-gather failed: %w", sgErr)
	}
	if finalizeErr != nil {
		return nil, fmt.Errorf("FinalizeAcquisition failed: %w", finalizeErr)
	}

	// Post a "finalizing" tick for the GUI.
	_ = workflow.ExecuteActivity(localCtx, "PostWorkflowProgressActivity", activities.PostWorkflowProgressInput{
		Phase:      "finalizing",
		Percentage: 95.0,
		Message:    "Finalizing acquisition",
	}).Get(localCtx, nil)

	// Build a legacy-shaped acquireResult map so downstream code (DatasetImport
	// chaining, watermark update) works unchanged.
	out := map[string]interface{}{
		"filesCopied": float64(totalCopied),
	}
	if v, ok := finalizeResult["totalBytes"]; ok {
		out["totalBytes"] = v
	}
	if v, ok := finalizeResult["throughputMBps"]; ok {
		out["throughputMBps"] = v
	}
	if v, ok := finalizeResult["fileListKey"].(string); ok && v != "" {
		out["fileListKey"] = v
	}
	return out, nil
}

// runFinalizeAcquisition is a fire-and-forget version used on the discover-failure path.
func runFinalizeAcquisition(
	ctx workflow.Context,
	connCtx workflow.Context,
	input DataAcquisitionWorkflowInput,
	outputPath string,
	startedAtISO string,
	connectorConfig map[string]interface{},
	totalDiscovered, filesFiltered, consumerCount int,
	scatterError bool,
) error {
	_, err := runFinalizeAcquisitionWithResult(
		ctx, connCtx, input, outputPath, startedAtISO, connectorConfig,
		totalDiscovered, filesFiltered, consumerCount, scatterError,
	)
	return err
}

func runFinalizeAcquisitionWithResult(
	ctx workflow.Context,
	connCtx workflow.Context,
	input DataAcquisitionWorkflowInput,
	outputPath string,
	startedAtISO string,
	connectorConfig map[string]interface{},
	totalDiscovered, filesFiltered, consumerCount int,
	scatterError bool,
) (map[string]interface{}, error) {
	finalizeAO := workflow.ActivityOptions{
		TaskQueue:           connectorOperationsQueue,
		StartToCloseTimeout: 10 * time.Minute,
		HeartbeatTimeout:    2 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    5 * time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    3,
		},
	}
	finalizeCtx := workflow.WithActivityOptions(ctx, finalizeAO)

	endpoint, _ := connectorConfig["endpoint"].(string)
	bucket, _ := connectorConfig["bucket"].(string)
	prefix, _ := connectorConfig["prefix"].(string)

	finalizeInput := map[string]interface{}{
		"projectID":        input.ProjectID,
		"datasetID":        input.DatasetID,
		"outputPath":       outputPath,
		"configServiceURL": input.ConfigServiceURL,
		"startedAt":        startedAtISO,
		"filesDiscovered":  totalDiscovered,
		"filesFiltered":    filesFiltered,
		"consumerCount":    consumerCount,
		"sourceEndpoint":   endpoint,
		"sourceBucket":     bucket,
		"sourcePrefix":     prefix,
		"scatterError":     scatterError,
	}
	var finalResult map[string]interface{}
	err := workflow.ExecuteActivity(finalizeCtx, "FinalizeAcquisition", finalizeInput).Get(ctx, &finalResult)
	return finalResult, err
}

// registerSetIDPrefix is used for volume RegisterBatch consumer identifiers.
const registerSetIDPrefix = "reg-s"

// runVolumeDataAcquisition runs the zero-copy streaming pipeline for
// volume-backed datasets: concurrent BFS discovery + Parquet registration.
//
// 1. Launch M DiscoverVolumeFiles + N RegisterBatch concurrently
// 2. workflow.Go goroutine: wait all discover futures -> MarkStreamEOF (always)
// 3. Wait all register futures
// 4. FinalizeRegistration (manifest.json + errors.json + GC Redis)
// 5. Update dataset status to ready (no DatasetImportWorkflow chained)
func runVolumeDataAcquisition(
	ctx workflow.Context,
	localCtx workflow.Context,
	connCtx workflow.Context,
	input DataAcquisitionWorkflowInput,
	result DataAcquisitionWorkflowResult,
	dataset map[string]interface{},
	originVolumeID string,
	workflowID string,
	runID string,
	startedAtISO string,
	bucketName string,
	outputPath string,
	writeMode string,
	acqConfig map[string]interface{},
	namespace string,
	datasetName string,
	datasetKind string,
) (DataAcquisitionWorkflowResult, error) {
	logger := workflow.GetLogger(ctx)
	pipelineCfg := activities.GetAcquisitionPipelineConfigFromEnv()

	if writeMode == "overwrite" {
		clearInput := map[string]interface{}{"outputPath": outputPath}
		if err := workflow.ExecuteActivity(connCtx, "ClearDatasetPath", clearInput).Get(ctx, nil); err != nil {
			return failAcquisition(ctx, localCtx, input, result,
				fmt.Sprintf("failed to clear dataset path for overwrite: %v", err))
		}
		acqClearPath := fmt.Sprintf("/projects/%s/datasets/%s/_acquisition", input.ProjectID, input.DatasetID)
		if err := workflow.ExecuteActivity(connCtx, "ClearDatasetPath", map[string]interface{}{
			"outputPath": acqClearPath,
		}).Get(ctx, nil); err != nil {
			return failAcquisition(ctx, localCtx, input, result,
				fmt.Sprintf("failed to clear acquisition metadata path for overwrite: %v", err))
		}
	}

	var volume map[string]interface{}
	if err := workflow.ExecuteActivity(localCtx, activities.FetchDataSourceConfigActivity,
		input.ProjectID, originVolumeID).Get(ctx, &volume); err != nil {
		return failAcquisition(ctx, localCtx, input, result, fmt.Sprintf("failed to fetch volume data source: %v", err))
	}

	volType, _ := volume["type"].(string)
	if volType != "" && volType != "volume" {
		return failAcquisition(ctx, localCtx, input, result, fmt.Sprintf("data source %s is not a volume (type=%s)", originVolumeID, volType))
	}

	volName, _ := volume["name"].(string)
	if volName == "" {
		volName = originVolumeID
	}

	mountPath := buildVolumeMountPath(volName, extractFilterSpecSourcePath(dataset))

	lastMtime, _ := acqConfig["lastWatermarkValue"].(string)
	if lastMtime == "" {
		lastMtime, _ = acqConfig["last_watermark_value"].(string)
	}
	if writeMode == "overwrite" {
		lastMtime = ""
	}

	fileGlob, fileExclude := extractObjectStoreFilters(acqConfig, dataset)

	// --- Activity options ---
	discoverAO := workflow.ActivityOptions{
		TaskQueue:           connectorOperationsQueue,
		StartToCloseTimeout: 1 * time.Hour,
		HeartbeatTimeout:    5 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    5 * time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    3,
		},
	}
	discoverCtx := workflow.WithActivityOptions(ctx, discoverAO)

	registerAO := workflow.ActivityOptions{
		TaskQueue:           connectorOperationsQueue,
		StartToCloseTimeout: 1 * time.Hour,
		HeartbeatTimeout:    5 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    5 * time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    3,
		},
	}
	registerCtx := workflow.WithActivityOptions(ctx, registerAO)

	M := pipelineCfg.MaxDiscoverWorkers
	if M <= 0 {
		M = 2
	}
	N := pipelineCfg.MaxRegisterConsumers
	if N <= 0 {
		N = 2
	}

	log.Printf("[DataAcquisitionWorkflow] Volume streaming pipeline: mount=%s M=%d N=%d fileGlob=%q fileExclude=%q",
		mountPath, M, N, fileGlob, fileExclude)

	// Launch M DiscoverVolumeFiles futures concurrently
	log.Printf("[DataAcquisitionWorkflow] Launching %d DiscoverVolumeFiles activities", M)
	discoverFutures := make([]workflow.Future, M)
	for i := 0; i < M; i++ {
		discoverInput := map[string]interface{}{
			"mountPath":          mountPath,
			"outputPath":         outputPath,
			"fileGlob":           fileGlob,
			"fileExclude":        fileExclude,
			"lastMtimeWatermark": lastMtime,
			"workerId":           fmt.Sprintf("%d", i),
		}
		discoverFutures[i] = workflow.ExecuteActivity(discoverCtx, "DiscoverVolumeFiles", discoverInput)
	}

	// Launch N RegisterBatch futures concurrently
	log.Printf("[DataAcquisitionWorkflow] Launching %d RegisterBatch activities", N)
	registerFutures := make([]workflow.Future, N)
	for i := 0; i < N; i++ {
		setID := fmt.Sprintf("%s%d", registerSetIDPrefix, i)
		registerInput := map[string]interface{}{
			"outputPath": outputPath,
			"setId":      setID,
		}
		registerFutures[i] = workflow.ExecuteActivity(registerCtx, "RegisterBatch", registerInput)
	}

	// Goroutine: wait for all discover futures, then ALWAYS mark EOF
	discoverDoneCh := workflow.NewChannel(ctx)
	workflow.Go(ctx, func(gCtx workflow.Context) {
		totalDiscovered := 0
		totalFiltered := 0
		totalDirsScanned := 0
		totalErrors := 0
		failedWorkers := 0

		for i := 0; i < M; i++ {
			log.Printf("[DataAcquisitionWorkflow] Waiting for DiscoverVolumeFiles worker %d/%d", i+1, M)
			var workerResult map[string]interface{}
			err := discoverFutures[i].Get(gCtx, &workerResult)
			if err != nil {
				failedWorkers++
				logger.Warn("DiscoverVolumeFiles worker failed",
					"worker", i, "error", err.Error())
				log.Printf("[DataAcquisitionWorkflow] DiscoverVolumeFiles worker %d FAILED: %v", i, err)
				continue
			}
			workerDiscovered := readIntFromMap(workerResult, "totalDiscovered", 0)
			workerDirs := readIntFromMap(workerResult, "dirsScanned", 0)
			totalDiscovered += workerDiscovered
			totalFiltered += readIntFromMap(workerResult, "filesFiltered", 0)
			totalDirsScanned += workerDirs
			totalErrors += readIntFromMap(workerResult, "errors", 0)
			log.Printf("[DataAcquisitionWorkflow] DiscoverVolumeFiles worker %d completed: discovered=%d dirs=%d",
				i, workerDiscovered, workerDirs)
		}

		log.Printf("[DataAcquisitionWorkflow] All %d discover workers resolved (failed=%d), marking EOF. total: discovered=%d filtered=%d dirs=%d errors=%d",
			M, failedWorkers, totalDiscovered, totalFiltered, totalDirsScanned, totalErrors)

		// ALWAYS mark EOF even if all workers failed
		eofAO := workflow.ActivityOptions{
			TaskQueue:           connectorOperationsQueue,
			StartToCloseTimeout: 2 * time.Minute,
			RetryPolicy: &temporal.RetryPolicy{
				InitialInterval:    2 * time.Second,
				BackoffCoefficient: 2.0,
				MaximumAttempts:    3,
			},
		}
		eofCtx := workflow.WithActivityOptions(gCtx, eofAO)
		if err := workflow.ExecuteActivity(eofCtx, "MarkStreamEOF", map[string]interface{}{}).Get(gCtx, nil); err != nil {
			logger.Error("MarkStreamEOF failed -- RegisterBatch consumers may hang until heartbeat timeout",
				"error", err.Error())
		}

		// Send aggregated counts to main goroutine
		discoverDoneCh.Send(gCtx, map[string]interface{}{
			"totalDiscovered": totalDiscovered,
			"filesFiltered":   totalFiltered,
			"dirsScanned":     totalDirsScanned,
			"errors":          totalErrors,
			"failedWorkers":   failedWorkers,
		})
	})

	// Wait for discovery completion signal
	var discoverAgg map[string]interface{}
	discoverDoneCh.Receive(ctx, &discoverAgg)

	totalDiscovered := readIntFromMap(discoverAgg, "totalDiscovered", 0)
	filesFiltered := readIntFromMap(discoverAgg, "filesFiltered", 0)
	totalErrors := readIntFromMap(discoverAgg, "errors", 0)
	failedWorkers := readIntFromMap(discoverAgg, "failedWorkers", 0)

	log.Printf("[DataAcquisitionWorkflow] Discovery complete: discovered=%d filtered=%d errors=%d failedWorkers=%d/%d",
		totalDiscovered, filesFiltered, totalErrors, failedWorkers, M)

	// Check if too many workers failed
	if failedWorkers >= M {
		return failAcquisition(ctx, localCtx, input, result,
			fmt.Sprintf("all %d DiscoverVolumeFiles workers failed", M))
	}

	// Wait for all RegisterBatch futures
	log.Printf("[DataAcquisitionWorkflow] Waiting for %d RegisterBatch futures", N)
	registerErrors := 0
	totalRegistered := 0
	maxMtime := ""
	for i := 0; i < N; i++ {
		log.Printf("[DataAcquisitionWorkflow] Waiting for RegisterBatch %d/%d", i+1, N)
		var regResult map[string]interface{}
		if err := registerFutures[i].Get(ctx, &regResult); err != nil {
			registerErrors++
			logger.Warn("RegisterBatch failed", "setId", i, "error", err.Error())
			log.Printf("[DataAcquisitionWorkflow] RegisterBatch %d FAILED: %v", i, err)
			continue
		}
		regFiles := readIntFromMap(regResult, "fileCount", 0)
		totalRegistered += regFiles
		if mt, ok := regResult["maxMtime"].(string); ok && mt != "" {
			if maxMtime == "" || mt > maxMtime {
				maxMtime = mt
			}
		}
		log.Printf("[DataAcquisitionWorkflow] RegisterBatch %d completed: files=%d", i, regFiles)
	}

	if registerErrors >= N {
		return failAcquisition(ctx, localCtx, input, result,
			fmt.Sprintf("all %d RegisterBatch consumers failed", N))
	}

	log.Printf("[DataAcquisitionWorkflow] Registration complete: registered=%d registerErrors=%d/%d maxMtime=%s",
		totalRegistered, registerErrors, N, maxMtime)

	// FinalizeRegistration
	finalizeAO := workflow.ActivityOptions{
		TaskQueue:           connectorOperationsQueue,
		StartToCloseTimeout: 10 * time.Minute,
		HeartbeatTimeout:    2 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    5 * time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    3,
		},
	}
	finalizeCtx := workflow.WithActivityOptions(ctx, finalizeAO)

	finalizeInput := map[string]interface{}{
		"outputPath":       outputPath,
		"projectID":        input.ProjectID,
		"datasetID":        input.DatasetID,
		"sourceType":       "volume",
		"configServiceURL": input.ConfigServiceURL,
		"filesDiscovered":  totalDiscovered,
		"filesFiltered":    filesFiltered,
		"consumerCount":    N,
		"startedAt":        startedAtISO,
		"source": map[string]interface{}{
			"mountPath": mountPath,
		},
	}
	var finalizeResult map[string]interface{}
	if err := workflow.ExecuteActivity(finalizeCtx, "FinalizeRegistration", finalizeInput).Get(ctx, &finalizeResult); err != nil {
		return failAcquisition(ctx, localCtx, input, result,
			fmt.Sprintf("FinalizeRegistration failed: %v", err))
	}

	// Update watermark
	if maxMtime != "" && writeMode != "overwrite" {
		_ = workflow.ExecuteActivity(localCtx, activities.UpdateDatasetWatermarkActivity,
			input.ProjectID, input.DatasetID, maxMtime).Get(ctx, nil)
	}

	// Chain DatasetImportWorkflow to register files with lakekeeper catalog
	// (same pattern as the S3 acquisition path at lines 396-419).
	manifestKey, _ := finalizeResult["manifestKey"].(string)
	log.Printf("[DataAcquisitionWorkflow] Chaining DatasetImportWorkflow: manifestKey=%s", manifestKey)

	childInput := types.DatasetImportWorkflowInput{
		ProjectId:   input.ProjectID,
		DataSetId:   input.DatasetID,
		DatasetName: datasetName,
		DatasetKind: datasetKind,
		BucketName:  bucketName,
		Namespace:   namespace,
		PathPrefix:  fmt.Sprintf("projects/%s", input.ProjectID),
		FileListKey: manifestKey,
	}
	childOpts := workflow.ChildWorkflowOptions{
		WorkflowID: fmt.Sprintf("import-%s-%s", input.ProjectID, input.DatasetID),
	}
	childCtx := workflow.WithChildOptions(ctx, childOpts)
	var importResult types.DatasetImportWorkflowResult
	if err := workflow.ExecuteChildWorkflow(childCtx, DatasetImportWorkflow, childInput).Get(ctx, &importResult); err != nil {
		return failAcquisition(ctx, localCtx, input, result,
			fmt.Sprintf("dataset import workflow failed: %v", err))
	}

	_ = workflow.ExecuteActivity(localCtx, "UpdateDatasetStatusActivity",
		input.ProjectID, input.DatasetID, "ready", "").Get(ctx, nil)

	fileCount := readIntFromMap(finalizeResult, "fileCount", totalRegistered)
	result.FilesCopied = fileCount
	result.Status = "completed"
	log.Printf("[DataAcquisitionWorkflow] Volume acquisition completed: project=%s dataset=%s files=%d",
		input.ProjectID, input.DatasetID, fileCount)
	return result, nil
}

// ObjectStoreFilters captures all per-listing filters extracted from the
// dataset's acquisitionConfig / filterSpec. New filters (maxFileSize,
// modifiedAfter) are optional and zero-valued when absent.
type ObjectStoreFilters struct {
	FileGlob           string
	FileIncludePattern string
	FileExcludePattern string
	MaxFileSize        int64  // bytes; 0 means no cap
	ModifiedAfter      string // ISO-8601; empty means no cutoff
}

// extractObjectStoreFilters honours both camelCase and snake_case from acquisitionConfig
// and the older filterSpec shape. Both `fileIncludePattern` (preferred) and the
// legacy `fileGlob` are returned; downstream activities should prefer
// fileIncludePattern when set.
func extractObjectStoreFilters(acqConfig map[string]interface{}, dataset map[string]interface{}) (string, string) {
	f := extractObjectStoreFiltersFull(acqConfig, dataset)
	include := f.FileIncludePattern
	if include == "" {
		include = f.FileGlob
	}
	return include, f.FileExcludePattern
}

// extractObjectStoreFiltersFull returns all filters (include/exclude/max-size/modified-after).
func extractObjectStoreFiltersFull(acqConfig map[string]interface{}, dataset map[string]interface{}) ObjectStoreFilters {
	out := ObjectStoreFilters{}

	// fileGlob (legacy / preferred-for-back-compat)
	out.FileGlob, _ = acqConfig["fileGlob"].(string)
	if out.FileGlob == "" {
		out.FileGlob, _ = acqConfig["file_glob"].(string)
	}
	if out.FileGlob == "" {
		if fs, _ := dataset["filterSpec"].(map[string]interface{}); fs != nil {
			out.FileGlob, _ = fs["fileGlob"].(string)
			if out.FileGlob == "" {
				out.FileGlob, _ = fs["file_glob"].(string)
			}
		}
	}

	// fileIncludePattern (new, preferred over fileGlob when set)
	out.FileIncludePattern, _ = acqConfig["fileIncludePattern"].(string)
	if out.FileIncludePattern == "" {
		out.FileIncludePattern, _ = acqConfig["file_include_pattern"].(string)
	}

	// fileExcludePattern
	out.FileExcludePattern, _ = acqConfig["fileExcludePattern"].(string)
	if out.FileExcludePattern == "" {
		out.FileExcludePattern, _ = acqConfig["file_exclude_pattern"].(string)
	}
	if out.FileExcludePattern == "" {
		if fs, _ := dataset["filterSpec"].(map[string]interface{}); fs != nil {
			out.FileExcludePattern, _ = fs["fileExcludePattern"].(string)
			if out.FileExcludePattern == "" {
				out.FileExcludePattern, _ = fs["file_exclude_pattern"].(string)
			}
		}
	}

	// maxFileSize (bytes)
	switch v := acqConfig["maxFileSize"].(type) {
	case float64:
		out.MaxFileSize = int64(v)
	case int:
		out.MaxFileSize = int64(v)
	case int64:
		out.MaxFileSize = v
	}
	if out.MaxFileSize == 0 {
		switch v := acqConfig["max_file_size"].(type) {
		case float64:
			out.MaxFileSize = int64(v)
		case int:
			out.MaxFileSize = int64(v)
		case int64:
			out.MaxFileSize = v
		}
	}

	// modifiedAfter (ISO-8601)
	out.ModifiedAfter, _ = acqConfig["modifiedAfter"].(string)
	if out.ModifiedAfter == "" {
		out.ModifiedAfter, _ = acqConfig["modified_after"].(string)
	}

	return out
}

// decideConsumerCount caps consumers by per-activity capacity. Avoids spawning more
// consumers than there is work; one less config knob (no separate ItemsPerConsumer).
//
//	consumers = min(MaxAcquireConsumers, max(1, ceil(totalDiscovered / (BatchSize*MaxBatchesPerActivity))))
//
// totalDiscovered == -1 means unbounded source (DB stream, future Kafka); use UnboundedConsumers.
func decideConsumerCount(totalDiscovered int, cfg types.AcquisitionPipelineConfig) int {
	if totalDiscovered <= 0 {
		if totalDiscovered < 0 {
			return cfg.UnboundedConsumers
		}
		// totalDiscovered == 0 -- nothing to do; still spin up 1 consumer so it
		// terminates cleanly on EOF and produces an empty manifest.
		return 1
	}
	capacityPerConsumer := cfg.BatchSize * cfg.MaxBatchesPerActivity
	if capacityPerConsumer <= 0 {
		capacityPerConsumer = 64 * 8
	}
	needed := int(math.Ceil(float64(totalDiscovered) / float64(capacityPerConsumer)))
	if needed < 1 {
		needed = 1
	}
	if needed > cfg.MaxAcquireConsumers {
		needed = cfg.MaxAcquireConsumers
	}
	return needed
}

func readIntFromMap(m map[string]interface{}, key string, defaultVal int) int {
	if v, ok := m[key]; ok {
		switch x := v.(type) {
		case float64:
			return int(x)
		case int:
			return x
		case int64:
			return int(x)
		}
	}
	return defaultVal
}

// extractOriginVolumeID returns originVolume from the dataset (camelCase or snake_case).
func extractOriginVolumeID(dataset map[string]interface{}) string {
	if dataset == nil {
		return ""
	}
	if v, _ := dataset["originVolume"].(string); v != "" {
		return v
	}
	v, _ := dataset["origin_volume"].(string)
	return v
}

// extractFilterSpecSourcePath reads filterSpec.sourcePath (camelCase or snake_case keys).
func extractFilterSpecSourcePath(dataset map[string]interface{}) string {
	if dataset == nil {
		return ""
	}
	for _, key := range []string{"filterSpec", "filter_spec"} {
		fs, ok := dataset[key].(map[string]interface{})
		if !ok || fs == nil {
			continue
		}
		if p, _ := fs["sourcePath"].(string); p != "" {
			return p
		}
		if p, _ := fs["source_path"].(string); p != "" {
			return p
		}
	}
	return ""
}

// buildVolumeMountPath joins /mnt/pvcs/<volumeName> with an optional trimmed source subpath.
func buildVolumeMountPath(volumeName, sourcePath string) string {
	sp := strings.Trim(strings.TrimPrefix(sourcePath, "/"), "/")
	mountBase := filepath.Join("/mnt/pvcs", volumeName)
	if sp == "" {
		return mountBase
	}
	return filepath.Join(mountBase, sp)
}

// resolveAcquisitionWriteMode returns writeMode from acquisition config, defaulting to append.
func resolveAcquisitionWriteMode(acqConfig map[string]interface{}) string {
	if acqConfig == nil {
		return "append"
	}
	if wm, _ := acqConfig["writeMode"].(string); wm != "" {
		return wm
	}
	if wm, _ := acqConfig["write_mode"].(string); wm != "" {
		return wm
	}
	return "append"
}

// applyDatabaseSourceOverlay copies sourceDatabase/sourceSchema from the dataset onto
// connectorConfig when present (camelCase or snake_case keys).
func applyDatabaseSourceOverlay(connectorConfig map[string]interface{}, dataset map[string]interface{}) {
	sourceDB, _ := dataset["sourceDatabase"].(string)
	if sourceDB == "" {
		sourceDB, _ = dataset["source_database"].(string)
	}
	if sourceDB != "" {
		connectorConfig["database"] = sourceDB
		log.Printf("[DataAcquisitionWorkflow] Applied dataset sourceDatabase: %q", sourceDB)
	}
	sourceSchema, _ := dataset["sourceSchema"].(string)
	if sourceSchema == "" {
		sourceSchema, _ = dataset["source_schema"].(string)
	}
	if sourceSchema != "" {
		connectorConfig["schema"] = sourceSchema
		log.Printf("[DataAcquisitionWorkflow] Applied dataset sourceSchema: %q", sourceSchema)
	}
}

// executeAcquireFromGCS runs AcquireFromGCS for cloud/gcp and objectstore/gcs connectors.
func executeAcquireFromGCS(
	ctx workflow.Context,
	connAO workflow.ActivityOptions,
	projectID, datasetID, credentialID, configServiceURL, workflowID string,
	connectorConfig map[string]interface{},
	outputPath string,
	filters ObjectStoreFilters,
) (map[string]interface{}, error) {
	bucket, _ := connectorConfig["bucket"].(string)
	if bucket == "" {
		return nil, fmt.Errorf(
			"GCS acquisition requires a Cloud Storage bucket from the dataset explorer (resource selector)",
		)
	}
	fileGlob := filters.FileIncludePattern
	if fileGlob == "" {
		fileGlob = filters.FileGlob
	}
	fileExcludePattern := filters.FileExcludePattern
	gcsInput := map[string]interface{}{
		"projectID":          projectID,
		"datasetID":          datasetID,
		"credentialID":       credentialID,
		"connectorConfig":    connectorConfig,
		"outputPath":         outputPath,
		"fileGlob":           fileGlob,
		"fileIncludePattern": filters.FileIncludePattern,
		"fileExcludePattern": fileExcludePattern,
		"maxFileSize":        filters.MaxFileSize,
		"modifiedAfter":      filters.ModifiedAfter,
		"configServiceURL":   configServiceURL,
		"workflowID":         workflowID,
	}
	gcsAO := connAO
	gcsAO.StartToCloseTimeout = 4 * time.Hour
	if gcsAO.RetryPolicy != nil {
		rp := *gcsAO.RetryPolicy
		rp.MaximumAttempts = 5
		gcsAO.RetryPolicy = &rp
	}
	gcsCtx := workflow.WithActivityOptions(ctx, gcsAO)
	log.Printf("[DataAcquisitionWorkflow] AcquireFromGCS: bucket=%v prefix=%v fileGlob=%q fileExcludePattern=%q",
		connectorConfig["bucket"], connectorConfig["prefix"], fileGlob, fileExcludePattern)
	var acquireResult map[string]interface{}
	err := workflow.ExecuteActivity(gcsCtx, "AcquireFromGCS", gcsInput).Get(ctx, &acquireResult)
	return acquireResult, err
}

// applyBucketPrefix sets connectorConfig bucket and prefix directly from the
// resourceSelector (phase 2 unified objectstore selection).
func applyBucketPrefix(connectorConfig map[string]interface{}, bucket string, prefix string) {
	if bucket != "" {
		connectorConfig["bucket"] = bucket
	}
	connectorConfig["prefix"] = strings.TrimSuffix(prefix, "/")
}

// firstObjectStoreSelector returns the first entry in dataset.resourceSelector
// that is shaped like an objectstore folder (has both `bucket` and `prefix`
// keys). Returns nil if no such entry exists.
func firstObjectStoreSelector(dataset map[string]interface{}) (map[string]interface{}, bool) {
	candidates := []interface{}{dataset["resourceSelector"], dataset["resource_selector"]}
	for _, c := range candidates {
		arr, ok := c.([]interface{})
		if !ok {
			continue
		}
		for _, item := range arr {
			m, ok := item.(map[string]interface{})
			if !ok {
				continue
			}
			if _, hasBucket := m["bucket"]; !hasBucket {
				continue
			}
			if _, hasPrefix := m["prefix"]; !hasPrefix {
				continue
			}
			return m, true
		}
	}
	return nil, false
}

// applySourcePath sets connectorConfig bucket and prefix from dataset source path.
// sourcePath is "bucket/prefix" (e.g. "default-nemo/kaggle/wiki") or just "prefix".
// When datasetBucketName is non-empty (e.g. dataset's bucketName), use it as the connector bucket
// and the path after the first "/" as prefix, so a typo in the first segment (e.g. "defaut-nemo")
// does not cause NoSuchBucket.
func applySourcePath(connectorConfig map[string]interface{}, sourcePath string, datasetBucketName string) {
	sourcePath = strings.TrimSpace(sourcePath)
	if sourcePath == "" {
		return
	}
	parts := strings.SplitN(sourcePath, "/", 2)
	if len(parts) == 1 {
		if datasetBucketName != "" {
			connectorConfig["bucket"] = datasetBucketName
		}
		connectorConfig["prefix"] = parts[0]
		return
	}
	if datasetBucketName != "" {
		connectorConfig["bucket"] = datasetBucketName
		connectorConfig["prefix"] = strings.TrimSuffix(parts[1], "/")
	} else {
		connectorConfig["bucket"] = parts[0]
		connectorConfig["prefix"] = strings.TrimSuffix(parts[1], "/")
	}
}

// resourceSelectorLooksLikeMetrics returns true when the dataset's
// resourceSelector contains at least one entry with a `category` key. Metrics
// connectors (ONTAP, GCP) emit synthetic `metric_category` leaves whose
// resource is `{category: "<name>"}`. Any selector item shaped like that is
// our signal to dispatch via AcquireMetrics rather than the connector_type
// routing arms.
//
// The check is closed (allowlist by key name): unrelated selectors with no
// `category` field are ignored, so a mixed selector — already rejected by the
// wizard validator — does not silently degrade to objectstore here.
func resourceSelectorLooksLikeMetrics(rs interface{}) bool {
	arr, ok := rs.([]interface{})
	if !ok {
		return false
	}
	for _, item := range arr {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		if cat, ok := m["category"].(string); ok && cat != "" {
			return true
		}
	}
	return false
}

// metricsProviderAllowed gates which primary connector providers may serve
// metrics acquisition. Kept as a tiny set so adding a new metrics-capable
// connector requires touching this list explicitly.
func metricsProviderAllowed(provider string) bool {
	switch provider {
	case "ontap", "gcp", "azure_cloud":
		return true
	default:
		return false
	}
}

func failAcquisition(
	ctx workflow.Context,
	localCtx workflow.Context,
	input DataAcquisitionWorkflowInput,
	result DataAcquisitionWorkflowResult,
	errMsg string,
) (DataAcquisitionWorkflowResult, error) {
	log.Printf("[DataAcquisitionWorkflow] ERROR: %s (project=%s, dataset=%s)", errMsg, input.ProjectID, input.DatasetID)
	result.Status = "failed"
	result.ErrorMessage = errMsg
	_ = workflow.ExecuteActivity(localCtx, "UpdateDatasetStatusActivity",
		input.ProjectID, input.DatasetID, "errored", errMsg).Get(ctx, nil)
	// Also flip the acquisition facet to failed so the GUI live-progress polling
	// stops and the dataset detail page surfaces the failure. Best-effort.
	_ = workflow.ExecuteActivity(localCtx, "UpdateAcquisitionFacetActivity",
		activities.UpdateAcquisitionFacetInput{
			ProjectID:    input.ProjectID,
			DatasetID:    input.DatasetID,
			State:        "failed",
			JobID:        "",
			ErrorMessage: errMsg,
		}).Get(ctx, nil)
	return result, fmt.Errorf("%s", errMsg)
}
