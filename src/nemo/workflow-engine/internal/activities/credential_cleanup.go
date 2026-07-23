package activities

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"

	"go.temporal.io/sdk/activity"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// DeleteProjectCredentialSecretsActivity deletes all K8s credential secrets
// belonging to a project. Secrets are identified by the label
// agentstudio/project-id={projectId} in the shared namespace.
func DeleteProjectCredentialSecretsActivity(ctx context.Context, projectId string) error {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[DeleteProjectCredentialSecretsActivity] Starting for project: %s", projectId)
	log.Printf("[DeleteProjectCredentialSecretsActivity] WorkflowID: %s, ActivityID: %s",
		activityInfo.WorkflowExecution.ID, activityInfo.ActivityID)

	config, err := inClusterConfig()
	if err != nil {
		return fmt.Errorf("failed to get in-cluster config: %w", err)
	}

	clientset, err := newK8sClientset(config)
	if err != nil {
		return fmt.Errorf("failed to create Kubernetes client: %w", err)
	}

	namespace := strings.TrimSpace(os.Getenv("KUBERNETES_NAMESPACE"))
	if namespace == "" {
		namespace = strings.TrimSpace(os.Getenv("NAMESPACE"))
	}
	if namespace == "" {
		namespace = strings.TrimSpace(os.Getenv("POD_NAMESPACE"))
	}
	if namespace == "" {
		return fmt.Errorf(
			"kubernetes namespace is not set (expected NAMESPACE, KUBERNETES_NAMESPACE, or POD_NAMESPACE, e.g. from downward API fieldRef metadata.namespace)",
		)
	}

	labelSelector := fmt.Sprintf("agentstudio/project-id=%s,agentstudio/credential=true", projectId)
	secrets, err := clientset.CoreV1().Secrets(namespace).List(ctx, metav1.ListOptions{
		LabelSelector: labelSelector,
	})
	if err != nil {
		return fmt.Errorf("failed to list credential secrets for project %s: %w", projectId, err)
	}

	if len(secrets.Items) == 0 {
		log.Printf("[DeleteProjectCredentialSecretsActivity] No credential secrets found for project %s", projectId)
		return nil
	}

	log.Printf("[DeleteProjectCredentialSecretsActivity] Found %d credential secrets for project %s", len(secrets.Items), projectId)

	deleted := 0
	for _, secret := range secrets.Items {
		err := clientset.CoreV1().Secrets(namespace).Delete(ctx, secret.Name, metav1.DeleteOptions{})
		if err != nil {
			log.Printf("[DeleteProjectCredentialSecretsActivity] WARN: Failed to delete secret %s: %v (continuing)", secret.Name, err)
			continue
		}
		deleted++
		log.Printf("[DeleteProjectCredentialSecretsActivity] Deleted secret: %s", secret.Name)
	}

	log.Printf("[DeleteProjectCredentialSecretsActivity] Completed: %d/%d secrets deleted for project %s",
		deleted, len(secrets.Items), projectId)
	return nil
}
