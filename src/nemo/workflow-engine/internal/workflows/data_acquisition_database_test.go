package workflows

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestApplyDatabaseSourceOverlay_CamelCase(t *testing.T) {
	connectorConfig := map[string]interface{}{
		"host": "mysql.example.com",
		"port": float64(3306),
	}
	dataset := map[string]interface{}{
		"sourceDatabase": "sakila",
		"sourceSchema":   "sakila",
	}
	applyDatabaseSourceOverlay(connectorConfig, dataset)
	assert.Equal(t, "sakila", connectorConfig["database"])
	assert.Equal(t, "sakila", connectorConfig["schema"])
}

func TestApplyDatabaseSourceOverlay_PostgreSQLTypical(t *testing.T) {
	connectorConfig := map[string]interface{}{
		"host":   "postgres.example.com",
		"port":   float64(5432),
		"schema": "public",
	}
	dataset := map[string]interface{}{
		"sourceDatabase": "appdb",
		"sourceSchema":   "app",
	}
	applyDatabaseSourceOverlay(connectorConfig, dataset)
	assert.Equal(t, "appdb", connectorConfig["database"])
	assert.Equal(t, "app", connectorConfig["schema"])
}

func TestApplyDatabaseSourceOverlay_SnakeCase(t *testing.T) {
	connectorConfig := map[string]interface{}{}
	dataset := map[string]interface{}{
		"source_database": "app_db",
		"source_schema":   "app_db",
	}
	applyDatabaseSourceOverlay(connectorConfig, dataset)
	assert.Equal(t, "app_db", connectorConfig["database"])
	assert.Equal(t, "app_db", connectorConfig["schema"])
}

func TestApplyDatabaseSourceOverlay_NoOpWhenUnset(t *testing.T) {
	connectorConfig := map[string]interface{}{
		"database": "connector_default",
	}
	dataset := map[string]interface{}{}
	applyDatabaseSourceOverlay(connectorConfig, dataset)
	assert.Equal(t, "connector_default", connectorConfig["database"])
	_, hasSchema := connectorConfig["schema"]
	assert.False(t, hasSchema)
}

func TestApplyDatabaseSourceOverlay_DatasetOverridesConnectorDatabase(t *testing.T) {
	connectorConfig := map[string]interface{}{
		"database": "old",
		"schema":   "old_schema",
	}
	dataset := map[string]interface{}{
		"sourceDatabase": "sakila",
		"sourceSchema":   "sakila",
	}
	applyDatabaseSourceOverlay(connectorConfig, dataset)
	assert.Equal(t, "sakila", connectorConfig["database"])
	assert.Equal(t, "sakila", connectorConfig["schema"])
}
