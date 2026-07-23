#!/usr/bin/env python3
"""Consolidate OpenAPI specs from AgentStudio services into a single spec."""

import yaml
import os
import sys

# Get project root
script_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(script_dir)

# Allow paths to be overridden for Docker build context
if len(sys.argv) > 1:
    config_spec_path = sys.argv[1] if len(sys.argv) > 1 else None
    analytics_spec_path = sys.argv[2] if len(sys.argv) > 2 else None
    output_path = sys.argv[3] if len(sys.argv) > 3 else None
else:
    config_spec_path = None
    analytics_spec_path = None
    output_path = None

# Default paths
if not config_spec_path:
    config_spec_path = os.path.join(project_root, 'src/nemo/config-service/openapi.yaml')
if not analytics_spec_path or analytics_spec_path == "":
    # Try to find analytics-service spec, but it's optional
    potential_path = os.path.join(project_root, 'src/nemo/analytics-service/openapi.yaml')
    if os.path.exists(potential_path):
        analytics_spec_path = potential_path
    else:
        analytics_spec_path = None  # Mark as not available
if not output_path:
    output_path = os.path.join(project_root, 'src/nemo/apigateway-service/openapi-consolidated.yaml')

print("Consolidating OpenAPI specs...")
print(f"  - Config Service: {config_spec_path}")
if analytics_spec_path and os.path.exists(analytics_spec_path):
    print(f"  - Analytics Service: {analytics_spec_path}")
else:
    print(f"  - Analytics Service: (not found, skipping)")
print(f"  - Output: {output_path}")

# Read config-service spec
with open(config_spec_path, 'r') as f:
    config_spec = yaml.safe_load(f)

# Read analytics-service spec (optional - may not exist if service is removed)
analytics_spec = {}
if analytics_spec_path and os.path.exists(analytics_spec_path):
    with open(analytics_spec_path, 'r') as f:
        analytics_spec = yaml.safe_load(f)

# Get domain from environment or use default
prism_endpoint = os.environ.get('ENDPOINT', 'agentstudio.local')

# Create consolidated spec
consolidated = {
    'openapi': '3.0.3',
    'info': {
        'title': 'AgentStudio Services API',
        'version': '1.0.0',
        'description': 'Consolidated API documentation for all AgentStudio services (Config Service)'
    },
    'servers': [
        {'url': 'http://localhost:8080', 'description': 'AgentStudio Gateway (local)'},
        {'url': f'https://{prism_endpoint}:8443', 'description': 'AgentStudio Gateway (local development)'}
    ],
    # Global security requirement - all endpoints require authentication
    'security': [
        {'bearerAuth': []},
        {'oauth2': ['openid', 'profile', 'email']}
    ],
    'paths': {},
    'components': {
        'schemas': {},
        # Security schemes for Swagger UI authentication
        'securitySchemes': {
            'bearerAuth': {
                'type': 'http',
                'scheme': 'bearer',
                'bearerFormat': 'JWT',
                'description': 'Enter your JWT token obtained from Keycloak. You can get a token by logging into the GUI and copying the token from browser developer tools, or by using the OAuth2 flow below.'
            },
            'oauth2': {
                'type': 'oauth2',
                'description': 'OAuth2 authentication via Keycloak. Click Authorize and login with your credentials.',
                'flows': {
                    'authorizationCode': {
                        'authorizationUrl': f'https://auth.{prism_endpoint}:8443/realms/nemo/protocol/openid-connect/auth',
                        'tokenUrl': f'https://auth.{prism_endpoint}:8443/realms/nemo/protocol/openid-connect/token',
                        'scopes': {
                            'openid': 'OpenID Connect scope',
                            'profile': 'User profile information',
                            'email': 'User email address'
                        }
                    }
                }
            }
        }
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
output_dir = os.path.dirname(output_path)
if output_dir:  # Only create directory if path has a directory component
    os.makedirs(output_dir, exist_ok=True)
with open(output_path, 'w') as f:
    yaml.dump(consolidated, f, default_flow_style=False, sort_keys=False, allow_unicode=True)

print(f"✓ Consolidated OpenAPI spec written to {output_path}")

