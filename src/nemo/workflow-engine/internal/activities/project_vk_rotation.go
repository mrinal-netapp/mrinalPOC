package activities

import (
	"context"
	"log"
	"os"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
)

func resolveConfigServiceURL(override string) string {
	if override != "" {
		return override
	}
	if v := os.Getenv("CONFIG_SERVICE_URL"); v != "" {
		return v
	}
	return "http://config-service:3000"
}

func resolveProjectVKRotationGrace(input time.Duration) time.Duration {
	if input > 0 {
		return input
	}
	if raw := os.Getenv("PROJECT_VK_ROTATION_GRACE_PERIOD"); raw != "" {
		if d, err := time.ParseDuration(raw); err == nil && d > 0 {
			return d
		}
	}
	return 30 * time.Minute
}

// ListProjectsForVKRotationActivity returns project ids with active gateway VKs.
func ListProjectsForVKRotationActivity(
	ctx context.Context,
	input types.ScheduledProjectVKRotationInput,
) (types.ListProjectsForVKRotationResult, error) {
	_ = ctx
	configURL := resolveConfigServiceURL(input.ConfigServiceURL)
	client := clients.NewConfigClient(configURL)
	return client.ListProjectsForVKRotation()
}

// RotateProjectVirtualKeyActivity calls Bifrost POST .../rotate and updates K8s + metadata.
func RotateProjectVirtualKeyActivity(
	ctx context.Context,
	input types.ProjectVKRotationInput,
) (types.RotateProjectVirtualKeyResult, error) {
	_ = ctx
	configURL := resolveConfigServiceURL(input.ConfigServiceURL)
	client := clients.NewConfigClient(configURL)
	result, err := client.RotateProjectVirtualKey(input.ProjectId)
	if err != nil {
		log.Printf("[RotateProjectVirtualKeyActivity] project=%s error: %v", input.ProjectId, err)
		return types.RotateProjectVirtualKeyResult{}, err
	}
	log.Printf(
		"[RotateProjectVirtualKeyActivity] project=%s skipped=%v old=%s new=%s",
		input.ProjectId, result.Skipped, result.OldVirtualKeyId, result.NewVirtualKeyId,
	)
	return result, nil
}

// DeleteRetiredProjectVirtualKeyActivity calls promote-secondary after the grace period.
func DeleteRetiredProjectVirtualKeyActivity(
	ctx context.Context,
	input types.ProjectVKRotationInput,
) (types.DeleteRetiredProjectVirtualKeyResult, error) {
	_ = ctx
	configURL := resolveConfigServiceURL(input.ConfigServiceURL)
	client := clients.NewConfigClient(configURL)
	result, err := client.CompleteProjectVirtualKeyRotation(input.ProjectId)
	if err != nil {
		log.Printf("[DeleteRetiredProjectVirtualKeyActivity] project=%s error: %v", input.ProjectId, err)
		return types.DeleteRetiredProjectVirtualKeyResult{}, err
	}
	log.Printf(
		"[DeleteRetiredProjectVirtualKeyActivity] project=%s deleted=%v retired=%s",
		input.ProjectId, result.Deleted, result.RetiredVirtualKeyId,
	)
	return result, nil
}

// ResolveProjectVKRotationGrace exposes grace duration for tests and callers.
func ResolveProjectVKRotationGrace(input time.Duration) time.Duration {
	return resolveProjectVKRotationGrace(input)
}
