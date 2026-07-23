# Custom JupyterLab Workspace Image

This directory contains the Dockerfile for building a custom JupyterLab image with pre-installed data science libraries.

## Overview

The image is based on `jupyter/minimal-notebook` and includes:
- **Polars**: Fast DataFrame library
- **LanceDB**: Vector database for embeddings
- **PyArrow**: Columnar data format
- **Pandas**: Data manipulation
- **NumPy/SciPy**: Scientific computing
- **JupyterLab extensions**: Git integration, widgets, etc.

## Building the Image

### Using Makefile (Recommended)

```bash
# Build the workspace image
make docker-build-workspace-image

# Build and push to registry
make docker-build-push-workspace-image
```

### Manual Build

```bash
cd src/images/workspace-jupyterlab

# Build with default tag
docker build -t docker.repo.eng.netapp.com/user/$(USER)/nemo/workspace-jupyterlab:latest .

# Build with specific version
docker build -t docker.repo.eng.netapp.com/user/$(USER)/nemo/workspace-jupyterlab:v1.0.0 .

# Push to registry
docker push docker.repo.eng.netapp.com/user/$(USER)/nemo/workspace-jupyterlab:latest
```

## Using the Image

### In Workspace Templates

When creating a workspace template, specify this image as the `baseImage`:

```json
{
  "name": "Data Science Workspace",
  "type": "jupyterlab",
  "environment": {
    "baseImage": "docker.repo.eng.netapp.com/user/$(USER)/nemo/workspace-jupyterlab:latest",
    "libraries": [
      // Additional libraries can still be installed at runtime
      {"name": "scikit-learn", "version": "latest", "packageManager": "pip"}
    ]
  }
}
```

### Default Behavior

If no `baseImage` is specified in a workspace template, the system defaults to `jupyter/scipy-notebook:latest`. To use this custom image as the default, update the default in `WorkspaceOrchestratorService.ts`:

```typescript
const baseImage = template.environment?.baseImage || 'docker.repo.eng.netapp.com/user/$(USER)/nemo/workspace-jupyterlab:latest';
```

## Customization

### Adding More Libraries

Edit the `Dockerfile` and add libraries to the pip install command:

```dockerfile
RUN pip install --no-cache-dir \
    # ... existing libraries ...
    your-new-library>=1.0.0
```

### Version Pinning

For production, pin specific versions:

```dockerfile
RUN pip install --no-cache-dir \
    polars==0.20.0 \
    lancedb==0.4.0
```

### Python Version

To use a specific Python version, change the base image:

```dockerfile
FROM jupyter/minimal-notebook:python-3.11
```

## Image Registry

The image should be pushed to your container registry:
- **GHCR**: `docker.repo.eng.netapp.com/user/$(USER)/nemo/workspace-jupyterlab`
- **Docker Hub**: `ramsek/workspace-jupyterlab`
- **Private Registry**: `your-registry.com/nemo/workspace-jupyterlab`

## Versioning Strategy

- **latest**: Latest stable build
- **v1.0.0**: Semantic versioning for releases
- **dev**: Development builds

## Benefits

1. **Faster Startup**: Pre-installed libraries mean workspaces start faster
2. **Consistency**: All workspaces use the same base libraries
3. **Reduced Network**: No need to download libraries on every launch
4. **Customization**: Can include company-specific tools and configurations

## Maintenance

- Update library versions periodically
- Rebuild and push new versions when dependencies change
- Test the image before deploying to production

