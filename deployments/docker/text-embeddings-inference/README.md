# Custom TEI image for AgentStudio

The default TEI Helm chart uses the upstream
`ghcr.io/huggingface/text-embeddings-inference:cpu-1.5` image, which is
published **amd64-only**. On Apple Silicon dev clusters the image lands via
QEMU/Rosetta emulation — it works but is slow on first cold start.

For local clusters where QEMU emulation is too slow, build the multi-arch
image once and reference it from `values-resource-constrained.yaml`:

```sh
make helm-tei-prepull           # Pull upstream amd64 image to local cache
                                # (QEMU/Rosetta does the rest on arm64 hosts)

# OR — build a native multi-arch image (slower setup, faster runtime):
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t agentstudio-tei-models:cpu-1.7 \
  -f deployments/docker/text-embeddings-inference/Dockerfile \
  --load \
  deployments/docker/text-embeddings-inference
```

Then in `values-resource-constrained.yaml`:

```yaml
text-embeddings-inference:
  image:
    repository: agentstudio-tei-models
    tag: "cpu-1.7"
    pullPolicy: IfNotPresent
```

## Why not just use the upstream image?

The upstream `cpu-1.5` image is built with Intel MKL, which has no arm64
binaries. On arm64 the upstream image runs under QEMU/Rosetta with a
significant cold-start penalty (~30s longer model load). The Dockerfile in
this directory builds TEI without MKL using the platform-native ORT runtime,
producing a single image that runs natively on amd64 and arm64.

## When to update

- Bump the base image tag in the Dockerfile when the upstream TEI release
  changes.
- Update `image.tag` in `values.yaml` after publishing the new image.
- No code changes anywhere else — the model catalog
  (`src/nemo/config-service/services/BuiltinModels.ts`) is independent of
  the TEI image version.
