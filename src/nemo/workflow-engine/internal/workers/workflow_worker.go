package workers

import (
	"fmt"
	"log"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/internal/activities"
	"github.com/agentstudio/nemo/workflow-engine/internal/services"
	"github.com/agentstudio/nemo/workflow-engine/internal/util"
	"github.com/agentstudio/nemo/workflow-engine/internal/workflows"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"
)

type WorkflowWorker struct {
	worker worker.Worker
	client client.Client
}

func NewWorkflowWorker(temporalAddress, taskQueue string, executorService *services.ExecutorService) *WorkflowWorker {
	// Retry connection to Temporal server (it may not be ready immediately)
	var c client.Client
	var err error
	maxRetries, retryDelay := util.TemporalConnectOptions()
	for i := 0; i < maxRetries; i++ {
		c, err = client.Dial(client.Options{
			HostPort: temporalAddress,
		})
		if err == nil {
			break
		}
		if i < maxRetries-1 {
			time.Sleep(retryDelay)
		}
	}
	if err != nil {
		panic(fmt.Sprintf("Failed to create Temporal client for worker after %d retries: %v", maxRetries, err))
	}

	return NewWorkflowWorkerWithClient(c, taskQueue, executorService)
}

// NewWorkflowWorkerWithClient wires a workflow worker to an existing Temporal client.
// Production code uses NewWorkflowWorker, which dials Temporal then delegates here.
func NewWorkflowWorkerWithClient(c client.Client, taskQueue string, _ *services.ExecutorService) *WorkflowWorker {
	w := worker.New(c, taskQueue, worker.Options{})

	// Register workflows
	w.RegisterWorkflow(workflows.PipelineWorkflow)
	w.RegisterWorkflow(workflows.ProjectInitWorkflow)
	w.RegisterWorkflow(workflows.ProjectDeleteWorkflow)
	w.RegisterWorkflow(workflows.TableProcessingWorkflow)
	w.RegisterWorkflow(workflows.DatasetDeleteWorkflow)
	w.RegisterWorkflow(workflows.DatasetImportWorkflow)
	w.RegisterWorkflow(workflows.KnowledgeBaseCreationWorkflow)
	w.RegisterWorkflow(workflows.KnowledgeBaseDeleteWorkflow)
	w.RegisterWorkflow(workflows.ScheduledKBSyncWorkflow)
	w.RegisterWorkflow(workflows.DataAcquisitionWorkflow)
	w.RegisterWorkflow(workflows.ConnectorInteractiveWorkflow)
	w.RegisterWorkflow(workflows.ExplorerSessionWorkflow)
	w.RegisterWorkflow(workflows.ExplorerListWorkflow)
	w.RegisterWorkflow(workflows.MCPHealthCheckWorkflow)
	w.RegisterWorkflow(workflows.ProjectVirtualKeyRotationWorkflow)
	w.RegisterWorkflow(workflows.ScheduledProjectVirtualKeyRotationWorkflow)
	w.RegisterWorkflow(workflows.ArtifactGCWorkflow)
	w.RegisterWorkflow(workflows.DependencyLineageSyncWorkflow)
	w.RegisterWorkflow(workflows.VolumeBrowseWorkflow)
	w.RegisterWorkflow(workflows.VolumeScanWorkflow)
	w.RegisterWorkflow(workflows.ProjectAddUserWorkflow)
	w.RegisterWorkflow(workflows.ProjectRemoveUserWorkflow)
	w.RegisterWorkflow(workflows.ProjectChangeRoleWorkflow)

	// Register activities (merged from pipeline-worker)
	activities.RegisterActivities(w)

	return &WorkflowWorker{
		worker: w,
		client: c,
	}
}

func (w *WorkflowWorker) Start() error {
	log.Println("Starting workflow worker...")
	return w.worker.Run(worker.InterruptCh())
}

func (w *WorkflowWorker) Stop() {
	log.Println("Stopping workflow worker...")
	w.worker.Stop()
	w.client.Close()
}
