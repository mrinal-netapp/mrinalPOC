package activities

import (
	"context"
	"fmt"

	"go.temporal.io/sdk/activity"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ScaleDeploymentActivity scales a deployment
func ScaleDeploymentActivity(ctx context.Context, namespace, name string, replicas int32) error {
	logger := activity.GetLogger(ctx)
	logger.Info("Scaling deployment", "name", name, "namespace", namespace, "replicas", replicas)

	config, err := inClusterConfig()
	if err != nil {
		return fmt.Errorf("failed to get in-cluster config: %w", err)
	}

	clientset, err := newK8sClientset(config)
	if err != nil {
		return fmt.Errorf("failed to create Kubernetes client: %w", err)
	}

	scale, err := clientset.AppsV1().Deployments(namespace).GetScale(ctx, name, metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("failed to get deployment scale: %w", err)
	}

	scale.Spec.Replicas = replicas
	_, err = clientset.AppsV1().Deployments(namespace).UpdateScale(ctx, name, scale, metav1.UpdateOptions{})
	if err != nil {
		return fmt.Errorf("failed to update deployment scale: %w", err)
	}

	logger.Info("Deployment scaled", "name", name, "replicas", replicas)
	return nil
}

// ScaleStatefulSetActivity scales a stateful set
func ScaleStatefulSetActivity(ctx context.Context, namespace, name string, replicas int32) error {
	logger := activity.GetLogger(ctx)
	logger.Info("Scaling statefulset", "name", name, "namespace", namespace, "replicas", replicas)

	config, err := inClusterConfig()
	if err != nil {
		return fmt.Errorf("failed to get in-cluster config: %w", err)
	}

	clientset, err := newK8sClientset(config)
	if err != nil {
		return fmt.Errorf("failed to create Kubernetes client: %w", err)
	}

	scale, err := clientset.AppsV1().StatefulSets(namespace).GetScale(ctx, name, metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("failed to get statefulset scale: %w", err)
	}

	scale.Spec.Replicas = replicas
	_, err = clientset.AppsV1().StatefulSets(namespace).UpdateScale(ctx, name, scale, metav1.UpdateOptions{})
	if err != nil {
		return fmt.Errorf("failed to update statefulset scale: %w", err)
	}

	logger.Info("StatefulSet scaled", "name", name, "replicas", replicas)
	return nil
}

// UpdateReplicasActivity updates replica count (generic)
func UpdateReplicasActivity(ctx context.Context, namespace, name, kind string, replicas int32) error {
	switch kind {
	case "Deployment":
		return ScaleDeploymentActivity(ctx, namespace, name, replicas)
	case "StatefulSet":
		return ScaleStatefulSetActivity(ctx, namespace, name, replicas)
	default:
		return fmt.Errorf("unsupported kind: %s", kind)
	}
}
