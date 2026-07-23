# syntax=docker/dockerfile:1
# Keycloak Setup Image
# Pre-installs dependencies for Keycloak realm and OIDC client setup
# Used by the nemo-keycloak-setup Kubernetes job

FROM docker.repo.eng.netapp.com/python:3.11-alpine

# Install system dependencies
RUN apk add --no-cache curl

# Install kubectl
# Download the latest stable version of kubectl
RUN KUBECTL_VERSION=$(curl -L -s https://dl.k8s.io/release/stable.txt) && \
    curl -LO "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" && \
    chmod +x kubectl && \
    mv kubectl /usr/local/bin/kubectl && \
    kubectl version --client

RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --upgrade pip setuptools wheel && \
    pip install \
    python-keycloak \
    requests \
    urllib3 \
    kubernetes

# Set working directory
WORKDIR /app

# Default command (will be overridden by the job)
CMD ["python3", "--version"]
