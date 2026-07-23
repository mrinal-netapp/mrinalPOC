package activities

import (
	"context"
	"fmt"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"go.temporal.io/sdk/activity"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// CreatePodActivity creates a pod in the local Kubernetes cluster
func CreatePodActivity(ctx context.Context, input types.PodCreationInput) (types.PodCreationResult, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("Creating pod", "name", input.Name, "namespace", input.Namespace)

	// Get in-cluster Kubernetes config
	config, err := inClusterConfig()
	if err != nil {
		return types.PodCreationResult{}, fmt.Errorf("failed to get in-cluster config: %w", err)
	}

	clientset, err := newK8sClientset(config)
	if err != nil {
		return types.PodCreationResult{}, fmt.Errorf("failed to create Kubernetes client: %w", err)
	}

	// Build pod spec
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      input.Name,
			Namespace: input.Namespace,
			Labels: map[string]string{
				"agentstudio.pipeline": "true",
				"app":                  input.Name,
			},
		},
		Spec: corev1.PodSpec{
			RestartPolicy: corev1.RestartPolicyNever,
			Containers: []corev1.Container{
				{
					Name:    "main",
					Image:   input.Image,
					Command: input.Command,
					Args:    input.Args,
					Env:     buildEnvVars(input.Env),
					Resources: corev1.ResourceRequirements{
						Requests: buildResourceList(input.Resources),
						Limits:   buildResourceList(input.Resources),
					},
				},
			},
		},
	}

	// Create pod
	createdPod, err := clientset.CoreV1().Pods(input.Namespace).Create(ctx, pod, metav1.CreateOptions{})
	if err != nil {
		return types.PodCreationResult{}, fmt.Errorf("failed to create pod: %w", err)
	}

	logger.Info("Pod created", "podName", createdPod.Name)

	return types.PodCreationResult{
		PodName: createdPod.Name,
		Status:  "created",
	}, nil
}

// DeletePodActivity deletes a pod
func DeletePodActivity(ctx context.Context, namespace, podName string) error {
	logger := activity.GetLogger(ctx)
	logger.Info("Deleting pod", "name", podName, "namespace", namespace)

	config, err := inClusterConfig()
	if err != nil {
		return fmt.Errorf("failed to get in-cluster config: %w", err)
	}

	clientset, err := newK8sClientset(config)
	if err != nil {
		return fmt.Errorf("failed to create Kubernetes client: %w", err)
	}

	err = clientset.CoreV1().Pods(namespace).Delete(ctx, podName, metav1.DeleteOptions{})
	if err != nil {
		return fmt.Errorf("failed to delete pod: %w", err)
	}

	logger.Info("Pod deleted", "podName", podName)
	return nil
}

// GetPodStatusActivity gets the status of a pod
func GetPodStatusActivity(ctx context.Context, namespace, podName string) (string, error) {
	config, err := inClusterConfig()
	if err != nil {
		return "", fmt.Errorf("failed to get in-cluster config: %w", err)
	}

	clientset, err := newK8sClientset(config)
	if err != nil {
		return "", fmt.Errorf("failed to create Kubernetes client: %w", err)
	}

	pod, err := clientset.CoreV1().Pods(namespace).Get(ctx, podName, metav1.GetOptions{})
	if err != nil {
		return "", fmt.Errorf("failed to get pod: %w", err)
	}

	return string(pod.Status.Phase), nil
}

// CreateServiceActivity creates a service
func CreateServiceActivity(ctx context.Context, namespace, name string, spec map[string]interface{}) (string, error) {
	// Placeholder implementation
	return "created", nil
}

// DeleteServiceActivity deletes a service
func DeleteServiceActivity(ctx context.Context, namespace, name string) error {
	// Placeholder implementation
	return nil
}

// UpdateServiceActivity updates a service
func UpdateServiceActivity(ctx context.Context, namespace, name string, spec map[string]interface{}) error {
	// Placeholder implementation
	return nil
}

// Helper functions
func buildEnvVars(env map[string]string) []corev1.EnvVar {
	var envVars []corev1.EnvVar
	for key, value := range env {
		envVars = append(envVars, corev1.EnvVar{
			Name:  key,
			Value: value,
		})
	}
	return envVars
}

func buildResourceList(resources types.ResourceRequirements) corev1.ResourceList {
	resourceList := corev1.ResourceList{}
	if resources.CPU != "" {
		resourceList[corev1.ResourceCPU] = resource.MustParse(resources.CPU)
	}
	if resources.Memory != "" {
		resourceList[corev1.ResourceMemory] = resource.MustParse(resources.Memory)
	}
	return resourceList
}
