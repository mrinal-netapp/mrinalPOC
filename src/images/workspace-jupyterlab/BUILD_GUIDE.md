# Building Custom JupyterLab Workspace Image

## Quick Start

```bash
# Build the image
make docker-build-workspace-image

# Build and push to registry
make docker-build-push-workspace-image
```

## Architecture Decision

### Why Build a Custom Image?

1. **Performance**: Pre-installed libraries mean faster workspace startup
2. **Consistency**: All workspaces use the same base libraries
3. **Reliability**: No network dependencies during workspace launch
4. **Customization**: Can include company-specific tools and configurations

### Current System

The workspace system supports two approaches:

1. **Dynamic Installation** (Current Default):
   - Uses base Jupyter image (`jupyter/scipy-notebook:latest`)
   - Installs libraries at runtime via init container
   - Slower startup but more flexible

2. **Pre-built Image** (Recommended):
   - Uses custom image with pre-installed libraries
   - Faster startup
   - More consistent environments

## Image Structure

```
src/images/workspace-jupyterlab/
├── Dockerfile          # Main image definition
├── README.md          # Usage documentation
├── BUILD_GUIDE.md     # This file
└── .dockerignore      # Build exclusions
```

## Customization Options

### Adding Libraries

Edit `Dockerfile` and add to the pip install command:

```dockerfile
RUN pip install --no-cache-dir \
    # ... existing libraries ...
    your-library>=1.0.0
```

### Changing Python Version

```dockerfile
FROM jupyter/minimal-notebook:python-3.11
```

### Adding System Dependencies

```dockerfile
USER root
RUN apt-get update && apt-get install -y \
    your-system-package \
    && rm -rf /var/lib/apt/lists/*
USER $NB_UID
```

### Custom JupyterLab Configuration

Add configuration files:

```dockerfile
COPY jupyter_lab_config.py /home/$NB_USER/.jupyter/
```

## Versioning Strategy

### Tags

- `latest`: Latest stable build
- `v1.0.0`: Semantic version for releases
- `dev`: Development builds
- `v1.0.0-polars-0.20`: Feature-specific versions

### When to Rebuild

- Library version updates
- Security patches
- New library additions
- Base image updates

## Integration with Workspace Templates

### Option 1: Set as Default

Update `WorkspaceOrchestratorService.ts`:

```typescript
const baseImage = template.environment?.baseImage || 
  'docker.repo.eng.netapp.com/user/$(USER)/nemo/workspace-jupyterlab:latest';
```

### Option 2: Per-Template Configuration

When creating workspace templates, specify the image:

```json
{
  "environment": {
    "baseImage": "docker.repo.eng.netapp.com/user/$(USER)/nemo/workspace-jupyterlab:latest"
  }
}
```

### Option 3: Hybrid Approach

- Use custom image for common libraries (polars, lancedb)
- Install additional libraries dynamically at runtime

## Build Process

### Local Build

```bash
cd src/images/workspace-jupyterlab
docker build -t workspace-jupyterlab:local .
```

### Production Build

```bash
# Set registry
export CONTAINER_IMAGE_REPO=docker.repo.eng.netapp.com/user/$(USER)/nemo

# Build with version
make docker-build-workspace-image VERSION=v1.0.0

# Push to registry
make docker-push-workspace-image VERSION=v1.0.0
```

### CI/CD Integration

Add to your CI pipeline:

```yaml
- name: Build workspace image
  run: make docker-build-workspace-image VERSION=${{ github.sha }}

- name: Push workspace image
  run: make docker-push-workspace-image VERSION=${{ github.sha }}
```

## Testing

### Test Locally

```bash
# Build image
docker build -t workspace-jupyterlab:test -f src/images/workspace-jupyterlab/Dockerfile .

# Run container
docker run -p 8888:8888 workspace-jupyterlab:test

# Verify libraries
docker run workspace-jupyterlab:test python -c "import polars; import lancedb; print('OK')"
```

### Test in Kubernetes

1. Push image to registry
2. Create workspace template with the image
3. Launch workspace
4. Verify libraries are available

## Troubleshooting

### Build Fails

- Check base image availability
- Verify network access for pip installs
- Check disk space

### Libraries Not Found

- Verify library names in Dockerfile
- Check Python version compatibility
- Rebuild image after changes

### Large Image Size

- Use multi-stage builds if needed
- Remove build dependencies
- Use `--no-cache-dir` for pip

## Best Practices

1. **Pin Versions**: Use specific versions for production
2. **Regular Updates**: Keep libraries up to date
3. **Security**: Scan images for vulnerabilities
4. **Documentation**: Document all customizations
5. **Testing**: Test image before deploying

## Registry Configuration

### GHCR (GitHub Container Registry)

```bash
export CONTAINER_IMAGE_REPO=docker.repo.eng.netapp.com/user/$(USER)/nemo
```

### Docker Hub

```bash
export CONTAINER_IMAGE_REPO=ramsek
```

### Private Registry

```bash
export CONTAINER_IMAGE_REPO=your-registry.com/nemo
```

## Next Steps

1. Build the image: `make docker-build-workspace-image`
2. Test locally
3. Push to registry: `make docker-push-workspace-image`
4. Update workspace templates to use the new image
5. Monitor workspace startup times

