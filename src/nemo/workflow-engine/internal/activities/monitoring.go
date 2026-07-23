package activities

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"go.temporal.io/sdk/activity"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// CheckPodStatusActivity checks the current status of a pod (single check, returns immediately)
// Use with workflow.Sleep() for polling pattern
func CheckPodStatusActivity(ctx context.Context, namespace, podName string) (types.PodStatusResult, error) {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[CheckPodStatusActivity] Checking pod: %s/%s", namespace, podName)
	log.Printf("[CheckPodStatusActivity] WorkflowID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.ActivityID)

	config, err := inClusterConfig()
	if err != nil {
		return types.PodStatusResult{}, fmt.Errorf("failed to get in-cluster config: %w", err)
	}

	clientset, err := newK8sClientset(config)
	if err != nil {
		return types.PodStatusResult{}, fmt.Errorf("failed to create Kubernetes client: %w", err)
	}

	pod, err := clientset.CoreV1().Pods(namespace).Get(ctx, podName, metav1.GetOptions{})
	if err != nil {
		return types.PodStatusResult{}, fmt.Errorf("failed to get pod: %w", err)
	}

	result := types.PodStatusResult{
		Phase: string(pod.Status.Phase),
	}

	if pod.Status.Phase == corev1.PodSucceeded {
		result.Ready = true
		result.IsCompleted = true
		result.Message = "Pod succeeded"
		return result, nil
	}

	if pod.Status.Phase == corev1.PodFailed {
		result.Ready = false
		result.IsCompleted = true
		result.Message = "Pod failed"
		return result, nil
	}

	// Check if pod is ready
	ready := true
	for _, condition := range pod.Status.Conditions {
		if condition.Type == corev1.PodReady && condition.Status != corev1.ConditionTrue {
			ready = false
			break
		}
	}

	if ready && pod.Status.Phase == corev1.PodRunning {
		result.Ready = true
		result.IsCompleted = false
		result.Message = "Pod is ready and running"
		return result, nil
	}

	result.Ready = false
	result.IsCompleted = false
	result.Message = fmt.Sprintf("Pod phase: %s", pod.Status.Phase)
	return result, nil
}

// CheckServiceStatusActivity checks if a service has endpoints (single check, returns immediately)
// Use with workflow.Sleep() for polling pattern
func CheckServiceStatusActivity(ctx context.Context, namespace, serviceName string) (types.ServiceStatusResult, error) {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[CheckServiceStatusActivity] Checking service: %s/%s", namespace, serviceName)
	log.Printf("[CheckServiceStatusActivity] WorkflowID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.ActivityID)

	config, err := inClusterConfig()
	if err != nil {
		return types.ServiceStatusResult{}, fmt.Errorf("failed to get in-cluster config: %w", err)
	}

	clientset, err := newK8sClientset(config)
	if err != nil {
		return types.ServiceStatusResult{}, fmt.Errorf("failed to create Kubernetes client: %w", err)
	}

	endpoints, err := clientset.CoreV1().Endpoints(namespace).Get(ctx, serviceName, metav1.GetOptions{})
	if err != nil {
		return types.ServiceStatusResult{
			Ready:         false,
			EndpointCount: 0,
		}, nil
	}

	endpointCount := 0
	for _, subset := range endpoints.Subsets {
		endpointCount += len(subset.Addresses)
	}

	return types.ServiceStatusResult{
		Ready:         endpointCount > 0,
		EndpointCount: endpointCount,
	}, nil
}

// WaitForPodReadyActivity is deprecated - use CheckPodStatusActivity with workflow polling instead
// Kept for backward compatibility
func WaitForPodReadyActivity(ctx context.Context, namespace, podName string, timeout time.Duration) error {
	logger := activity.GetLogger(ctx)
	logger.Info("WARNING: This activity uses busy-wait polling. Consider using CheckPodStatusActivity with workflow.Sleep() instead.")
	logger.Info("Waiting for pod to be ready", "podName", podName, "namespace", namespace)

	deadline := time.Now().Add(timeout)
	pollInterval := 5 * time.Second

	for time.Now().Before(deadline) {
		result, err := CheckPodStatusActivity(ctx, namespace, podName)
		if err != nil {
			return err
		}

		if result.Ready {
			logger.Info("Pod is ready", "podName", podName)
			return nil
		}

		if result.IsCompleted && result.Phase == string(corev1.PodFailed) {
			return fmt.Errorf("pod failed: %s", podName)
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(pollInterval):
			continue
		}
	}

	return fmt.Errorf("timeout waiting for pod to be ready: %s", podName)
}

// WaitForServiceReadyActivity is deprecated - use CheckServiceStatusActivity with workflow polling instead
// Kept for backward compatibility
func WaitForServiceReadyActivity(ctx context.Context, namespace, serviceName string, timeout time.Duration) error {
	logger := activity.GetLogger(ctx)
	logger.Info("WARNING: This activity uses busy-wait polling. Consider using CheckServiceStatusActivity with workflow.Sleep() instead.")
	logger.Info("Waiting for service to be ready", "serviceName", serviceName, "namespace", namespace)

	deadline := time.Now().Add(timeout)
	pollInterval := 2 * time.Second

	for time.Now().Before(deadline) {
		result, err := CheckServiceStatusActivity(ctx, namespace, serviceName)
		if err != nil {
			return err
		}

		if result.Ready {
			logger.Info("Service is ready", "serviceName", serviceName)
			return nil
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(pollInterval):
			continue
		}
	}

	return fmt.Errorf("timeout waiting for service to be ready: %s", serviceName)
}

// CollectLogsActivity collects logs from a pod
func CollectLogsActivity(ctx context.Context, namespace, podName, containerName string) (string, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("Collecting logs", "podName", podName, "namespace", namespace)

	config, err := inClusterConfig()
	if err != nil {
		return "", fmt.Errorf("failed to get in-cluster config: %w", err)
	}

	clientset, err := newK8sClientset(config)
	if err != nil {
		return "", fmt.Errorf("failed to create Kubernetes client: %w", err)
	}

	req := clientset.CoreV1().Pods(namespace).GetLogs(podName, &corev1.PodLogOptions{
		Container: containerName,
	})

	logs, err := req.Stream(ctx)
	if err != nil {
		return "", fmt.Errorf("failed to stream logs: %w", err)
	}
	defer logs.Close()

	logBytes := make([]byte, 0)
	buffer := make([]byte, 1024)
	for {
		n, err := logs.Read(buffer)
		if n > 0 {
			logBytes = append(logBytes, buffer[:n]...)
		}
		if err != nil {
			break
		}
	}

	return string(logBytes), nil
}

// CollectMetricsActivity collects metrics (placeholder)
func CollectMetricsActivity(ctx context.Context, namespace, resourceType, resourceName string) (map[string]interface{}, error) {
	// Placeholder implementation
	// In production, this would query Prometheus or metrics API
	return map[string]interface{}{
		"message": "Metrics collection not implemented",
	}, nil
}
