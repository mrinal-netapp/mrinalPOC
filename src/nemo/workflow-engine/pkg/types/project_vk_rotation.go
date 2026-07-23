package types

import "time"

// ScheduledProjectVKRotationInput is passed from the Temporal schedule into
// the fan-out workflow that starts per-project rotation child workflows.
type ScheduledProjectVKRotationInput struct {
	ConfigServiceURL string        `json:"configServiceUrl,omitempty"`
	GracePeriod      time.Duration `json:"gracePeriod,omitempty"`
}

// ProjectVKRotationInput is the per-project rotation workflow input.
type ProjectVKRotationInput struct {
	ProjectId        string        `json:"projectId"`
	ConfigServiceURL string        `json:"configServiceUrl,omitempty"`
	GracePeriod      time.Duration `json:"gracePeriod,omitempty"`
}

// RotateProjectVirtualKeyResult mirrors config-service gateway-rotate response.
type RotateProjectVirtualKeyResult struct {
	ProjectId         string `json:"projectId"`
	Skipped           bool   `json:"skipped"`
	SkipReason        string `json:"skipReason,omitempty"`
	OldVirtualKeyId   string `json:"oldVirtualKeyId,omitempty"`
	NewVirtualKeyId   string `json:"newVirtualKeyId,omitempty"`
	NewVirtualKeyName string `json:"newVirtualKeyName,omitempty"`
}

// DeleteRetiredProjectVirtualKeyResult mirrors gateway-rotate-complete response.
type DeleteRetiredProjectVirtualKeyResult struct {
	ProjectId           string `json:"projectId"`
	Deleted             bool   `json:"deleted"`
	RetiredVirtualKeyId string `json:"retiredVirtualKeyId,omitempty"`
}

// ListProjectsForVKRotationResult mirrors gateway-rotation-targets response.
type ListProjectsForVKRotationResult struct {
	ProjectIds []string `json:"projectIds"`
}

// ScheduledProjectVKRotationResult summarizes a fan-out tick.
type ScheduledProjectVKRotationResult struct {
	ProjectsFound    int `json:"projectsFound"`
	RotationsStarted int `json:"rotationsStarted"`
}
