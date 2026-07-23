package workflows

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestExtractOriginVolumeID_CamelCase(t *testing.T) {
	ds := map[string]interface{}{"originVolume": "vol-abc12345"}
	assert.Equal(t, "vol-abc12345", extractOriginVolumeID(ds))
}

func TestExtractOriginVolumeID_SnakeCase(t *testing.T) {
	ds := map[string]interface{}{"origin_volume": "vol-snake01"}
	assert.Equal(t, "vol-snake01", extractOriginVolumeID(ds))
}

func TestExtractOriginVolumeID_PrefersCamelCase(t *testing.T) {
	ds := map[string]interface{}{
		"originVolume":  "vol-camel",
		"origin_volume": "vol-snake",
	}
	assert.Equal(t, "vol-camel", extractOriginVolumeID(ds))
}

func TestExtractFilterSpecSourcePath_CamelCase(t *testing.T) {
	ds := map[string]interface{}{
		"filterSpec": map[string]interface{}{"sourcePath": "/incoming/events"},
	}
	assert.Equal(t, "/incoming/events", extractFilterSpecSourcePath(ds))
}

func TestExtractFilterSpecSourcePath_SnakeCase(t *testing.T) {
	ds := map[string]interface{}{
		"filter_spec": map[string]interface{}{"source_path": "archive/2026"},
	}
	assert.Equal(t, "archive/2026", extractFilterSpecSourcePath(ds))
}

func TestExtractFilterSpecSourcePath_PrefersFilterSpecOverFilterSpecSnake(t *testing.T) {
	ds := map[string]interface{}{
		"filterSpec": map[string]interface{}{"sourcePath": "/primary"},
		"filter_spec": map[string]interface{}{
			"source_path": "/secondary",
		},
	}
	assert.Equal(t, "/primary", extractFilterSpecSourcePath(ds))
}

func TestBuildVolumeMountPath_WithSubpath(t *testing.T) {
	got := buildVolumeMountPath("my-vol", "/incoming/events/")
	// filepath.Join uses OS separators; normalize for assertion.
	assert.Contains(t, got, "/mnt/pvcs/my-vol")
	assert.Contains(t, got, "incoming")
	assert.Contains(t, got, "events")
}

func TestBuildVolumeMountPath_EmptySubpath(t *testing.T) {
	got := buildVolumeMountPath("my-vol", "")
	assert.Equal(t, buildVolumeMountPath("my-vol", "/"), got)
}

func TestResolveAcquisitionWriteMode_DefaultsToAppend(t *testing.T) {
	assert.Equal(t, "append", resolveAcquisitionWriteMode(nil))
	assert.Equal(t, "append", resolveAcquisitionWriteMode(map[string]interface{}{}))
}

func TestResolveAcquisitionWriteMode_CamelAndSnake(t *testing.T) {
	assert.Equal(t, "overwrite", resolveAcquisitionWriteMode(map[string]interface{}{
		"writeMode": "overwrite",
	}))
	assert.Equal(t, "incremental", resolveAcquisitionWriteMode(map[string]interface{}{
		"write_mode": "incremental",
	}))
}

func TestResolveAcquisitionWriteMode_CamelWinsOverSnake(t *testing.T) {
	assert.Equal(t, "overwrite", resolveAcquisitionWriteMode(map[string]interface{}{
		"writeMode":  "overwrite",
		"write_mode": "append",
	}))
}
