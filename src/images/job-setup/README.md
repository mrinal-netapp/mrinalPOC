# Keycloak Setup Image

This Docker image contains pre-installed dependencies for the Keycloak setup job, which automatically creates Keycloak realms and OIDC clients.

## What's Included

- **Python 3.11** (Alpine-based)
- **python-keycloak** - Python SDK for Keycloak administration
- **requests** - HTTP library for Python
- **urllib3** - HTTP client library
- **kubectl** - Kubernetes command-line tool (latest stable version)
- **curl** - Command-line tool for transferring data

## Purpose

This image is used by the `nemo-keycloak-setup` Kubernetes job to:
- Wait for Keycloak to be ready
- Create the Keycloak realm
- Create OIDC clients (GUI, Gateway, Lakekeeper, and service accounts)
- Update Kubernetes secrets with client credentials

By pre-installing all dependencies, the job startup time is significantly reduced compared to installing dependencies on every run.

## Building the Image

### Using Make

```bash
# Build the image
make docker-build-keycloak-setup

# Build and push to registry
make docker-build-push-keycloak-setup
```

### Manual Build

```bash
docker build -t <your-registry>/job-setup:latest \
  -f src/images/job-setup/Dockerfile \
  src/images/job-setup
```

## Configuration

The image is configured in the platform chart values under `keycloak.setup.image`:

```yaml
keycloak:
  setup:
    image:
      repository: ""  # Defaults to {global.imageRepository}/job-setup
      tag: "latest"
      pullPolicy: "IfNotPresent"
```

## Usage

The image is automatically used by the Keycloak setup job when `keycloak.setup.enabled` is `true` in the Helm values. The job runs as a Helm post-install/post-upgrade hook.

The job script (`keycloak-setup.py`) is mounted into the container at runtime and executed with:

```bash
python3 /tmp/keycloak_setup.py
```

## Environment Variables

The job container expects the following environment variables:

- `KEYCLOAK_URL` - Keycloak service URL (default: `http://keycloak.agentstudio-identity.svc.cluster.local:8080`)
- `KEYCLOAK_ADMIN_USER` - Keycloak admin username (default: `admin`)
- `KEYCLOAK_ADMIN_PASSWORD` - Keycloak admin password
- `KEYCLOAK_REALM` - Realm name to create (default: `nemo`)
- `DOMAIN` - Domain for redirect URIs
- `PROTOCOL` - Protocol for redirect URIs (`http` or `https`)
- `NAMESPACE` - Kubernetes namespace (automatically set from pod metadata)
- `SECRET_NAME` - Kubernetes secret name for OIDC credentials (default: `keycloak-oidc-secrets`)

## Updating Dependencies

To update Python dependencies, modify the `pip install` command in the Dockerfile and rebuild the image.

To update kubectl, the Dockerfile automatically downloads the latest stable version. If you need a specific version, modify the `KUBECTL_VERSION` variable in the Dockerfile.
