# Build stage
FROM docker.repo.eng.netapp.com/node:20-alpine AS builder

WORKDIR /build

# Set environment variables for better cross-platform builds
ENV NODE_OPTIONS="--max-old-space-size=4096"

# Accept base path as build argument (defaults to / for standalone mode)
# When deployed behind gateway at /console, set --build-arg VITE_BASE_PATH=/console
ARG VITE_BASE_PATH=/
ENV VITE_BASE_PATH=${VITE_BASE_PATH}

# Accept config service base path as build argument
# When behind gateway, config-service is at /config
# Defaults to /config if VITE_BASE_PATH is not /, otherwise empty (standalone mode)
ARG VITE_CONFIG_SERVICE_BASE_PATH=
ENV VITE_CONFIG_SERVICE_BASE_PATH=${VITE_CONFIG_SERVICE_BASE_PATH}

# Workspace public hostname configuration (build-time variables)
# Public format: ${VITE_WORKSPACE_LABEL_PREFIX}{workspaceId}.${VITE_WORKSPACE_SUBDOMAIN_BASE}
# (single label so a *.{endpoint} wildcard DNS record covers it).
#
# Base domain — the bare endpoint (NOT a "ws." subdomain). Defaults to agentstudio.local.
ARG VITE_WORKSPACE_SUBDOMAIN_BASE=agentstudio.local
ENV VITE_WORKSPACE_SUBDOMAIN_BASE=${VITE_WORKSPACE_SUBDOMAIN_BASE}

# Protocol for workspace subdomains (https for production, http for local dev)
ARG VITE_WORKSPACE_SUBDOMAIN_PROTOCOL=https
ENV VITE_WORKSPACE_SUBDOMAIN_PROTOCOL=${VITE_WORKSPACE_SUBDOMAIN_PROTOCOL}

# Prefix applied to workspaceId when building the public hostname. Hyphen
# (not underscore) so the label is RFC-1035 / CA-baseline compliant. Default "ws-".
ARG VITE_WORKSPACE_LABEL_PREFIX=ws-
ENV VITE_WORKSPACE_LABEL_PREFIX=${VITE_WORKSPACE_LABEL_PREFIX}

# Keycloak OIDC issuer URL (build-time variable)
# Defaults to local dev URL, should be overridden for production
ARG VITE_KEYCLOAK_ISSUER=https://auth.agentstudio.local/realms/agentstudio
ENV VITE_KEYCLOAK_ISSUER=${VITE_KEYCLOAK_ISSUER}

# Keycloak OIDC client ID (build-time variable)
ARG VITE_KEYCLOAK_CLIENT_ID=agentstudio-gui
ENV VITE_KEYCLOAK_CLIENT_ID=${VITE_KEYCLOAK_CLIENT_ID}

# Copy package files and config files (for better layer caching)
COPY src/nemo/gui/package*.json ./
COPY src/nemo/gui/tsconfig*.json ./
COPY src/nemo/gui/vite.config.ts ./

# Install dependencies (npm ci does clean install, no need to clear cache)
RUN npm ci --no-audit

# Copy source code (excluding node_modules via .dockerignore)
COPY src/nemo/gui/ ./

# Build the application (VITE_BASE_PATH will be used by vite.config.ts)
# The base path is set at build time and cannot be changed at runtime
RUN npm run build

# Verify base path was used correctly (debug)
RUN if [ -f dist/index.html ]; then \
      echo "Built with base path: ${VITE_BASE_PATH}"; \
      grep -q "base.*${VITE_BASE_PATH}" dist/index.html || echo "Warning: base path may not be set correctly in index.html"; \
    fi

# Production stage - using nginx to serve static files
FROM docker.repo.eng.netapp.com/nginx:alpine

# Copy built files to nginx html directory
COPY --from=builder /build/dist /usr/share/nginx/html

# Create startup script to generate nginx config from environment variables
RUN cat > /docker-entrypoint.sh << 'SCRIPT' && chmod +x /docker-entrypoint.sh
#!/bin/sh
set -e

API_SERVICE_NAME=${API_SERVICE_NAME:-namespace-service}
API_SERVICE_PORT=${API_SERVICE_PORT:-8080}
WORKFLOW_SERVICE_NAME=${WORKFLOW_SERVICE_NAME:-workflow-engine}
WORKFLOW_SERVICE_PORT=${WORKFLOW_SERVICE_PORT:-8080}
DEBUG_ENABLED=${DEBUG:-false}

# Determine if DEBUG is enabled
if [ "$DEBUG_ENABLED" = "true" ] || [ "$DEBUG_ENABLED" = "1" ]; then
    # DEBUG enabled - log everything including health checks
    ACCESS_LOG_CONFIG="access_log /var/log/nginx/access.log;"
    HEALTH_LOG_CONFIG="access_log /var/log/nginx/access.log;"
else
    # DEBUG disabled - skip logging for health check endpoints
    ACCESS_LOG_CONFIG="access_log /var/log/nginx/access.log;"
    HEALTH_LOG_CONFIG="access_log off;"
fi

cat > /etc/nginx/conf.d/default.conf <<EOF
server {
    listen 9000;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # HTTP response compression (browser uses Accept-Encoding: gzip, deflate, br).
    # LZO is not a standard Content-Encoding; gzip is supported everywhere. Brotli would
    # require an nginx build with ngx_brotli (stock nginx:alpine has gzip only).
    gzip on;
    gzip_vary on;
    gzip_min_length 256;
    gzip_comp_level 5;
    gzip_proxied any;
    gzip_types
        text/plain
        text/css
        text/xml
        text/javascript
        application/javascript
        application/json
        application/xml
        application/xhtml+xml
        application/xml+rss
        image/svg+xml;
    
    # Main access log (for all requests)
    ${ACCESS_LOG_CONFIG}
    error_log /var/log/nginx/error.log;
    
    # Health check endpoints - skip logging unless DEBUG is enabled
    location ~ ^/(health|ready)$ {
        ${HEALTH_LOG_CONFIG}
        try_files \$uri /index.html;
    }
    
    # All other routes
    location / {
        try_files \$uri \$uri/ /index.html;
    }
    
    # API proxy (config-service)
    location /api {
        proxy_pass http://${API_SERVICE_NAME}:${API_SERVICE_PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
    
    # Workflow proxy (workflow-engine) - strip /workflow prefix
    location /workflow/ {
        proxy_pass http://${WORKFLOW_SERVICE_NAME}:${WORKFLOW_SERVICE_PORT}/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }
}
EOF

# Runtime config for the GUI (observability tool URLs injected at deploy time).
# Inline the config directly into index.html to avoid path-resolution issues
# with external script files on deep-link navigation (SPA routes).
GRAFANA_URL=${GRAFANA_URL:-}
JAEGER_URL=${JAEGER_URL:-}
# Same as k8s down.namespace on the GUI deployment (SERVICES_NAMESPACE / chart namespace).
K8S_METRICS_NS=${NAMESPACE:-agentstudio}
# Keycloak issuer is build-time-baked into the JS bundle via VITE_KEYCLOAK_ISSUER, but the
# deploy-time KEYCLOAK_ISSUER env var lets the same image work against any ENDPOINT.
# AuthContext.tsx prefers window.__RUNTIME_CONFIG__.keycloakIssuer over the build-time default.
KEYCLOAK_ISSUER_RUNTIME=${KEYCLOAK_ISSUER:-}
WORKSPACE_SUBDOMAIN_BASE_RUNTIME=${WORKSPACE_SUBDOMAIN_BASE:-}
WORKSPACE_SUBDOMAIN_PROTOCOL_RUNTIME=${WORKSPACE_SUBDOMAIN_PROTOCOL:-}
WORKSPACE_LABEL_PREFIX_RUNTIME=${WORKSPACE_LABEL_PREFIX:-}
WORKSPACE_PUBLIC_PORT_RUNTIME=${WORKSPACE_PUBLIC_PORT:-}

sed -i "s|</head>|<script>window.__RUNTIME_CONFIG__={grafanaUrl:\"${GRAFANA_URL}\",jaegerUrl:\"${JAEGER_URL}\",k8sMetricsNamespace:\"${K8S_METRICS_NS}\",keycloakIssuer:\"${KEYCLOAK_ISSUER_RUNTIME}\",workspaceSubdomainBase:\"${WORKSPACE_SUBDOMAIN_BASE_RUNTIME}\",workspaceSubdomainProtocol:\"${WORKSPACE_SUBDOMAIN_PROTOCOL_RUNTIME}\",workspaceLabelPrefix:\"${WORKSPACE_LABEL_PREFIX_RUNTIME}\",workspacePublicPort:\"${WORKSPACE_PUBLIC_PORT_RUNTIME}\"};</script></head>|" /usr/share/nginx/html/index.html

exec nginx -g "daemon off;"
SCRIPT

EXPOSE 9000

ENTRYPOINT ["/docker-entrypoint.sh"]
