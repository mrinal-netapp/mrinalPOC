package activities

import (
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
)

func TestGetString_DefaultsAndOverrides(t *testing.T) {
	cfg := map[string]interface{}{"name": "alice"}
	assert.Equal(t, "alice", getString(cfg, "name", "default"))
	assert.Equal(t, "default", getString(cfg, "missing", "default"))
	// Wrong type falls back to default.
	cfg["badType"] = 123
	assert.Equal(t, "fallback", getString(cfg, "badType", "fallback"))
}

func TestGetStringSlice_VariousInputs(t *testing.T) {
	cfg := map[string]interface{}{
		"args": []interface{}{"a", "b", "c"},
	}
	assert.Equal(t, []string{"a", "b", "c"}, getStringSlice(cfg, "args"))

	// Mixed types: non-string slots become "" but the slot is preserved.
	cfg["mixed"] = []interface{}{"a", 7, "c"}
	got := getStringSlice(cfg, "mixed")
	assert.Equal(t, []string{"a", "", "c"}, got)

	// Missing key returns nil.
	assert.Nil(t, getStringSlice(cfg, "absent"))

	// Wrong type returns nil.
	cfg["wrong"] = "string-not-slice"
	assert.Nil(t, getStringSlice(cfg, "wrong"))
}

func TestGetStringMap(t *testing.T) {
	cfg := map[string]interface{}{
		"env": map[string]interface{}{
			"FOO": "bar",
			"BAZ": 7, // non-string filtered out
		},
	}
	got := getStringMap(cfg, "env")
	assert.Equal(t, "bar", got["FOO"])
	_, ok := got["BAZ"]
	assert.False(t, ok)

	// Missing key returns nil.
	assert.Nil(t, getStringMap(cfg, "missing"))
}

func TestGetResources(t *testing.T) {
	got := getResources(map[string]interface{}{
		"resources": map[string]interface{}{
			"cpu":    "100m",
			"memory": "256Mi",
		},
	})
	assert.Equal(t, types.ResourceRequirements{CPU: "100m", Memory: "256Mi"}, got)

	// Empty config returns zero value.
	assert.Equal(t, types.ResourceRequirements{}, getResources(nil))
	assert.Equal(t, types.ResourceRequirements{}, getResources(map[string]interface{}{}))
}
