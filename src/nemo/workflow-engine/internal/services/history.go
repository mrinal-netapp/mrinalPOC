package services

import (
	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
)

type HistoryService struct {
	configClient *clients.ConfigClient
}

func NewHistoryService(configServiceURL string) *HistoryService {
	return &HistoryService{
		configClient: clients.NewConfigClient(configServiceURL),
	}
}

// NewHistoryServiceWithClient returns a HistoryService wired to a caller-supplied
// ConfigClient. Used by tests that point ConfigClient at an httptest.Server.
func NewHistoryServiceWithClient(configClient *clients.ConfigClient) *HistoryService {
	return &HistoryService{configClient: configClient}
}

func (s *HistoryService) CreateExecution(execution *types.PipelineExecution) error {
	return s.configClient.CreateExecution(execution)
}

func (s *HistoryService) GetExecution(projectId, pipelineId, executionId string) (*types.PipelineExecution, error) {
	return s.configClient.GetExecution(projectId, pipelineId, executionId)
}

func (s *HistoryService) ListExecutions(projectId, pipelineId string) ([]*types.PipelineExecution, error) {
	return s.configClient.ListExecutions(projectId, pipelineId)
}

func (s *HistoryService) UpdateExecution(execution *types.PipelineExecution) error {
	return s.configClient.UpdateExecution(execution)
}
