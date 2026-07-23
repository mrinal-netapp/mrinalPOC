# syntax=docker/dockerfile:1
#
# Build context: repo root (so paths align with scripts/docker-build.sh which runs
# `docker build ... -f src/nemo/agent-studio-ui/Dockerfile .` from the workspace root).
# Mirrors src/nemo/gui/Dockerfile so the two UIs are built and shipped the same way.

FROM docker.repo.eng.netapp.com/node:22-alpine AS builder

WORKDIR /build

ENV NODE_OPTIONS="--max-old-space-size=4096"

# ── Build-time VITE_* args (baked into the JS bundle) ───────────────────────────
# Base path for client-side routing / asset URLs. Defaults to / for standalone mode.
# When deployed behind apigateway at /studio, set --build-arg VITE_BASE_PATH=/studio.
ARG VITE_BASE_PATH=/
ENV VITE_BASE_PATH=${VITE_BASE_PATH}

# API base URLs the UI talks to (baked into the JS bundle). Defaults target the
# same-origin Istio Gateway API routes on the console host (see
# deployments/helm/edge/templates/httproute-app-istio.yaml):
#   /api/v1        -> config-service    (no rewrite)
#   /agents-maf    -> agent-service-maf (gateway rewrites /agents-maf -> /api/v1,
#                     which is where the MAF backend mounts its routers)
# A leading-slash path resolves against window.origin, independent of the
# /studio base path. Override per environment as needed.
ARG VITE_API_BASE_URL=/api/v1
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

ARG VITE_UTILITIES_API_BASE_URL=
ENV VITE_UTILITIES_API_BASE_URL=${VITE_UTILITIES_API_BASE_URL}

# Legacy RFC-demo agent base; also seeds the runtime fallback below when
# VITE_AGENT_RUNTIME_API_BASE_URL is unset. The gateway maps /agents-maf ->
# /api/v1, so the UI base omits /api/v1.
ARG VITE_AGENT_API_BASE_URL=/agents-maf
ENV VITE_AGENT_API_BASE_URL=${VITE_AGENT_API_BASE_URL}

# Agent-service-maf runtime (invoke / sessions / traces / SSE). Endpoints append
# /projects/{id}/... ; the gateway rewrites /agents-maf -> /api/v1, so this base
# omits /api/v1.
ARG VITE_AGENT_RUNTIME_API_BASE_URL=/agents-maf
ENV VITE_AGENT_RUNTIME_API_BASE_URL=${VITE_AGENT_RUNTIME_API_BASE_URL}

# Agent/agent-team CRUD (config-service) base. The agents-config RTK Query slice
# builds full /api/v1/... URLs and injects them into the shared apiSlice (whose
# fetchBaseQuery baseUrl is VITE_API_BASE_URL). Default to "/" so this resolves
# to an absolute same-origin URL (<origin>/) -- the slice then emits absolute
# <origin>/api/v1/... requests that fetchBaseQuery leaves untouched. Leaving it
# empty would derive "" from VITE_API_BASE_URL, producing relative /api/v1/...
# URLs that get re-prefixed to /api/v1/api/v1/... (double prefix).
ARG VITE_AGENTS_CONFIG_API_BASE_URL=/
ENV VITE_AGENTS_CONFIG_API_BASE_URL=${VITE_AGENTS_CONFIG_API_BASE_URL}

ARG VITE_MODEL_SERVICE_BASE_URL=
ENV VITE_MODEL_SERVICE_BASE_URL=${VITE_MODEL_SERVICE_BASE_URL}

ARG VITE_PROJECT_ID=
ENV VITE_PROJECT_ID=${VITE_PROJECT_ID}

ARG VITE_USER_ID=
ENV VITE_USER_ID=${VITE_USER_ID}

ARG VITE_ORG_ID=
ENV VITE_ORG_ID=${VITE_ORG_ID}

ARG VITE_AUTH_ENABLED=false
ENV VITE_AUTH_ENABLED=${VITE_AUTH_ENABLED}

ARG VITE_KEYCLOAK_ISSUER=https://auth.agentstudio.local/realms/nemo
ENV VITE_KEYCLOAK_ISSUER=${VITE_KEYCLOAK_ISSUER}

ARG VITE_KEYCLOAK_CLIENT_ID=agentstudio-ui
ENV VITE_KEYCLOAK_CLIENT_ID=${VITE_KEYCLOAK_CLIENT_ID}

COPY src/nemo/agent-studio-ui/package.json src/nemo/agent-studio-ui/package-lock.json* ./
COPY src/nemo/agent-studio-ui/tsconfig*.json ./
COPY src/nemo/agent-studio-ui/vite.config.ts ./

RUN npm ci --no-audit


COPY src/nemo/agent-studio-ui/ ./

RUN npm run build

RUN if [ -f dist/index.html ]; then \
      echo "Built with base path: ${VITE_BASE_PATH}"; \
      grep -q "base.*${VITE_BASE_PATH}" dist/index.html || echo "Warning: base path may not be set correctly in index.html"; \
    fi

# ── Runtime stage ──────────────────────────────────────────────────────────────
FROM docker.repo.eng.netapp.com/nginx:1.27-alpine AS runner

COPY --from=builder /build/dist /usr/share/nginx/html

RUN cat > /docker-entrypoint.sh << 'SCRIPT' && chmod +x /docker-entrypoint.sh
#!/bin/sh
set -e

API_SERVICE_NAME=${API_SERVICE_NAME:-apigateway-service}
API_SERVICE_PORT=${API_SERVICE_PORT:-8080}
WORKFLOW_SERVICE_NAME=${WORKFLOW_SERVICE_NAME:-workflow-engine}
WORKFLOW_SERVICE_PORT=${WORKFLOW_SERVICE_PORT:-8080}
DEBUG_ENABLED=${DEBUG:-false}

if [ "$DEBUG_ENABLED" = "true" ] || [ "$DEBUG_ENABLED" = "1" ]; then
    ACCESS_LOG_CONFIG="access_log /var/log/nginx/access.log;"
    HEALTH_LOG_CONFIG="access_log /var/log/nginx/access.log;"
else
    ACCESS_LOG_CONFIG="access_log /var/log/nginx/access.log;"
    HEALTH_LOG_CONFIG="access_log off;"
fi

cat > /etc/nginx/conf.d/default.conf <<EOF
server {
    listen 9000;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

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

    ${ACCESS_LOG_CONFIG}
    error_log /var/log/nginx/error.log;

    location ~ ^/(health|ready)$ {
        ${HEALTH_LOG_CONFIG}
        return 200 'ok';
        add_header Content-Type text/plain;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # API proxy. Forwards /api/* to ${API_SERVICE_NAME}:${API_SERVICE_PORT}
    # (defaults: apigateway-service:8080) — forward-compat for a future
    # apigateway /api/* mount. NOTE: apigateway-service does NOT currently
    # expose /api/* routes (its mounts are /config, /agents, /workflow, /kb,
    # /analytics, /console, /s3, /api-docs, /internal/*). Until those /api/*
    # routes are added (or the frontend uses existing prefixes like
    # /config/api/v1), bundle requests under /api/v1/config-service,
    # /api/v1/utilities, /api/agent etc. will 404. See README.md.
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

# Runtime auth config for agent-studio-ui. Auth code prefers these deploy-time
# values over the build-time VITE_* defaults baked into the JS bundle.
INDEX_HTML=/usr/share/nginx/html/index.html

js_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/</\\u003c/g'
}

AUTH_ENABLED_JS=$(js_escape "${AUTH_ENABLED:-}")
KEYCLOAK_ISSUER_JS=$(js_escape "${KEYCLOAK_ISSUER:-}")
KEYCLOAK_CLIENT_ID_JS=$(js_escape "${KEYCLOAK_CLIENT_ID:-}")

RUNTIME_SCRIPT="<script>window.__RUNTIME_CONFIG__={authEnabled:\"${AUTH_ENABLED_JS}\",keycloakIssuer:\"${KEYCLOAK_ISSUER_JS}\",keycloakClientId:\"${KEYCLOAK_CLIENT_ID_JS}\"};</script>"

# Idempotent: drop any prior injected runtime config block before re-inserting.
sed -i 's#<script>window.__RUNTIME_CONFIG__=.*</script>##g' "$INDEX_HTML"

RUNTIME_SCRIPT_SED=$(printf '%s' "$RUNTIME_SCRIPT" | sed -e 's/[&|\\]/\\&/g')
sed -i "s|</head>|${RUNTIME_SCRIPT_SED}</head>|" "$INDEX_HTML"

exec nginx -g "daemon off;"
SCRIPT

EXPOSE 9000

ENTRYPOINT ["/docker-entrypoint.sh"]
