# Docker build: "No space left on device"

When a Docker (or Podman) build fails with **`OSError: [Errno 28] No space left on device`** during `pip install` or other steps, the message refers to the **filesystem used by the container runtime**, not necessarily the disk you see as "free" on the host.

## Where the space is used

- **Docker**: Data (images, layers, build cache) lives under **Docker’s data root**, usually `/var/lib/docker`. That is often on the same partition as `/` or `/var`.
- **Podman**: Often uses `~/.local/share/containers/storage` or `/var/lib/containers`.
- Builds run inside a container; temporary files and new layers are written to that storage location. So even if `/home` has lots of free space, the build can still run out of space if the **Docker/Podman storage** partition is full.

## Check which disk is full

1. See Docker’s disk usage:
   ```bash
   docker system df
   ```
   (For Podman: `podman system df`.)

2. See which filesystem holds Docker’s data:
   ```bash
   docker info 2>/dev/null | grep -i "Docker Root Dir"
   ```
   Then check that path’s partition, e.g.:
   ```bash
   df -h /var/lib/docker
   ```

3. If your `df -h` shows a small root or `/var` (e.g. only a few GB free), that is likely where the build is failing.

## Free space

- Prune build cache and unused images/containers:
  ```bash
  docker system prune -a
  docker builder prune -a
  ```
  (Podman: `podman system prune -a`; builder prune if available.)

- Then retry the build. For heavy images (e.g. kb-retrieval-service with large pip installs), ensure the partition that holds Docker/Podman storage has several GB free (e.g. 5–10 GB for a single build).

## If the partition is too small

- **Move Docker’s data root** to a larger filesystem (e.g. `/home`) by configuring the daemon (e.g. `"data-root": "/home/docker"` in `/etc/docker/daemon.json`) and restarting the daemon. Back up or migrate existing data as needed.
- Or **run the build on a host** where the partition that holds the container storage has enough free space.

## kb-retrieval-service

This service’s image has a large Python stage (optimum, transformers, ONNX). The Dockerfile installs **CPU-only** `onnxruntime` first to avoid pulling NVIDIA CUDA wheels and reduce build size. If you still hit "no space", free or move Docker/Podman storage as above.
