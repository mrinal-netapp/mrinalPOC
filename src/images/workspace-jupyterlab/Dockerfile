# syntax=docker/dockerfile:1
# Custom JupyterLab image based on jupyter/minimal-notebook
# Pre-installs common data science libraries like polars, lancedb, etc.

FROM docker.repo.eng.netapp.com/jupyter/minimal-notebook:latest

USER root

# Install system dependencies that may be needed for some Python packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Switch back to user
USER $NB_UID

# Pip cache as jovyan (NB_USER) speeds rebuilds on BuildKit K8s driver
RUN --mount=type=cache,target=/home/jovyan/.cache/pip \
    pip install --upgrade pip setuptools wheel && \
    pip install \
    "polars>=0.20.0" "pandas>=2.0.0" "pyarrow>=14.0.0" \
    "lancedb>=0.4.0" "numpy>=1.24.0" "scipy>=1.11.0" \
    "jupyterlab-git>=0.45.0" "jupyterlab-widgets>=3.0.0" "ipywidgets>=8.0.0" \
    "requests>=2.31.0" "python-dotenv>=1.0.0"

# Install JupyterLab extensions
RUN jupyter labextension install @jupyter-widgets/jupyterlab-manager --no-build && \
    jupyter lab build --minimize=False && \
    jupyter lab clean && \
    npm cache clean --force && \
    rm -rf /home/$NB_USER/.cache/yarn

# Set working directory
WORKDIR /home/$NB_USER/work

# Switch back to jovyan user for runtime
# Jupyter images expect to run as the jovyan user
USER $NB_UID

# Keep the default JupyterLab startup command
# This can be overridden by the workspace orchestrator if needed
CMD ["start-notebook.sh", "--allow-root", "--NotebookApp.allow_origin='*'"]
