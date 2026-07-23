package activities

import (
	"context"
	"fmt"

	"go.temporal.io/sdk/activity"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
)

// CreateCrdActivity creates a custom resource
func CreateCrdActivity(ctx context.Context, gvr schema.GroupVersionResource, namespace string, obj *unstructured.Unstructured) error {
	logger := activity.GetLogger(ctx)
	logger.Info("Creating CRD", "kind", obj.GetKind(), "name", obj.GetName())

	config, err := inClusterConfig()
	if err != nil {
		return fmt.Errorf("failed to get in-cluster config: %w", err)
	}

	client, err := newDynamicClient(config)
	if err != nil {
		return fmt.Errorf("failed to create dynamic client: %w", err)
	}

	var resourceInterface dynamic.ResourceInterface
	if namespace != "" {
		resourceInterface = client.Resource(gvr).Namespace(namespace)
	} else {
		resourceInterface = client.Resource(gvr)
	}

	_, err = resourceInterface.Create(ctx, obj, metav1.CreateOptions{})
	if err != nil {
		return fmt.Errorf("failed to create CRD: %w", err)
	}

	logger.Info("CRD created", "kind", obj.GetKind(), "name", obj.GetName())
	return nil
}

// UpdateCrdActivity updates a custom resource
func UpdateCrdActivity(ctx context.Context, gvr schema.GroupVersionResource, namespace string, obj *unstructured.Unstructured) error {
	logger := activity.GetLogger(ctx)
	logger.Info("Updating CRD", "kind", obj.GetKind(), "name", obj.GetName())

	config, err := inClusterConfig()
	if err != nil {
		return fmt.Errorf("failed to get in-cluster config: %w", err)
	}

	client, err := newDynamicClient(config)
	if err != nil {
		return fmt.Errorf("failed to create dynamic client: %w", err)
	}

	var resourceInterface dynamic.ResourceInterface
	if namespace != "" {
		resourceInterface = client.Resource(gvr).Namespace(namespace)
	} else {
		resourceInterface = client.Resource(gvr)
	}

	_, err = resourceInterface.Update(ctx, obj, metav1.UpdateOptions{})
	if err != nil {
		return fmt.Errorf("failed to update CRD: %w", err)
	}

	logger.Info("CRD updated", "kind", obj.GetKind(), "name", obj.GetName())
	return nil
}

// DeleteCrdActivity deletes a custom resource
func DeleteCrdActivity(ctx context.Context, gvr schema.GroupVersionResource, namespace, name string) error {
	logger := activity.GetLogger(ctx)
	logger.Info("Deleting CRD", "name", name)

	config, err := inClusterConfig()
	if err != nil {
		return fmt.Errorf("failed to get in-cluster config: %w", err)
	}

	client, err := newDynamicClient(config)
	if err != nil {
		return fmt.Errorf("failed to create dynamic client: %w", err)
	}

	var resourceInterface dynamic.ResourceInterface
	if namespace != "" {
		resourceInterface = client.Resource(gvr).Namespace(namespace)
	} else {
		resourceInterface = client.Resource(gvr)
	}

	err = resourceInterface.Delete(ctx, name, metav1.DeleteOptions{})
	if err != nil {
		return fmt.Errorf("failed to delete CRD: %w", err)
	}

	logger.Info("CRD deleted", "name", name)
	return nil
}

// GetCrdStatusActivity gets the status of a custom resource
func GetCrdStatusActivity(ctx context.Context, gvr schema.GroupVersionResource, namespace, name string) (map[string]interface{}, error) {
	config, err := inClusterConfig()
	if err != nil {
		return nil, fmt.Errorf("failed to get in-cluster config: %w", err)
	}

	client, err := newDynamicClient(config)
	if err != nil {
		return nil, fmt.Errorf("failed to create dynamic client: %w", err)
	}

	var resourceInterface dynamic.ResourceInterface
	if namespace != "" {
		resourceInterface = client.Resource(gvr).Namespace(namespace)
	} else {
		resourceInterface = client.Resource(gvr)
	}

	obj, err := resourceInterface.Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to get CRD: %w", err)
	}

	return obj.Object, nil
}
