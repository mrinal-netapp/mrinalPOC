#!/bin/bash
# Script to consolidate OpenAPI specs from AgentStudio services

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GATEWAY_DIR="$PROJECT_ROOT/src/nemo/apigateway-service"

CONFIG_SERVICE_SPEC="$PROJECT_ROOT/src/nemo/config-service/openapi.yaml"
ANALYTICS_SERVICE_SPEC="$PROJECT_ROOT/src/nemo/analytics-service/openapi.yaml"
CONSOLIDATED_SPEC="$GATEWAY_DIR/openapi-consolidated.yaml"

echo "Consolidating OpenAPI specs..."
echo "  - Config Service: $CONFIG_SERVICE_SPEC"
echo "  - Analytics Service: $ANALYTICS_SERVICE_SPEC"
echo "  - Output: $CONSOLIDATED_SPEC"

# Check if Python is available for YAML merging
if command -v python3 &> /dev/null; then
    python3 << 'PYTHON_SCRIPT'
import yaml
import sys
import os

# Read config-service spec
config_spec_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'src/nemo/config-service/openapi.yaml')
analytics_spec_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'src/nemo/analytics-service/openapi.yaml')
output_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'src/nemo/apigateway-service/openapi-consolidated.yaml')

with open(config_spec_path, 'r') as f:
    config_spec = yaml.safe_load(f)

with open(analytics_spec_path, 'r') as f:
    analytics_spec = yaml.safe_load(f)

# Create consolidated spec
consolidated = {
    'openapi': '3.0.3',
    'info': {
        'title': 'AgentStudio Services API',
        'version': '1.0.0',
        'description': 'Consolidated API documentation for all AgentStudio services (Config Service, Analytics Service)'
    },
    'servers': [
        {'url': 'http://localhost:8080', 'description': 'AgentStudio Gateway (local)'},
        {'url': 'http://gateway:8080', 'description': 'AgentStudio Gateway (Kubernetes)'}
    ],
    'paths': {},
    'components': {
        'schemas': {}
    }
}

# Merge paths - prefix config-service paths with /config
if 'paths' in config_spec:
    for path, methods in config_spec['paths'].items():
        consolidated['paths'][f'/config{path}'] = methods

# Merge analytics-service paths - prefix with /analytics
if 'paths' in analytics_spec:
    for path, methods in analytics_spec['paths'].items():
        consolidated['paths'][f'/analytics{path}'] = methods

# Merge components/schemas
if 'components' in config_spec and 'schemas' in config_spec['components']:
    consolidated['components']['schemas'].update(config_spec['components']['schemas'])

if 'components' in analytics_spec and 'schemas' in analytics_spec['components']:
    consolidated['components']['schemas'].update(analytics_spec['components']['schemas'])

# Write consolidated spec
with open(output_path, 'w') as f:
    yaml.dump(consolidated, f, default_flow_style=False, sort_keys=False, allow_unicode=True)

print(f"Consolidated OpenAPI spec written to {output_path}")
PYTHON_SCRIPT
else
    echo "Error: python3 is required to consolidate OpenAPI specs"
    exit 1
fi

