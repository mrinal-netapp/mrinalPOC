package activities

import (
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// inClusterConfig is rest.InClusterConfig by default; tests may override it.
var inClusterConfig = rest.InClusterConfig

// newK8sClientset wraps kubernetes.NewForConfig for test injection.
var newK8sClientset = func(config *rest.Config) (kubernetes.Interface, error) {
	return kubernetes.NewForConfig(config)
}

// newDynamicClient wraps dynamic.NewForConfig for test injection.
var newDynamicClient = func(config *rest.Config) (dynamic.Interface, error) {
	return dynamic.NewForConfig(config)
}
