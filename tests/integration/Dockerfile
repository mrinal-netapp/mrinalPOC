# syntax=docker/dockerfile:1
#
# Integration-test harness image.
#
# Packages the pytest + allure-pytest suite under tests/integration/ so CI can
# run it as `docker run <image> [pytest args]` instead of `make setup` + pytest
# on the runner. The image is execution-context agnostic: it targets a deployed
# AgentStudio over HTTP + Keycloak (no kubeconfig) and takes the entire
# configuration as runtime env vars (same contract as .env.example). See
# docs/testing/integration-cicd.md.
#
# Build context is this directory (tests/integration). The image is tagged by
# the git tree hash of this directory (see scripts/integration-image-tag.sh),
# so it is rebuilt only when the harness content changes.
#
# BASE_IMAGE defaults to the internal Artifactory mirror used in CI. Local
# builds off the NetApp network can override it with a public equivalent, e.g.
#   docker build --build-arg BASE_IMAGE=python:3.12-slim tests/integration
#   make integration-image-build BASE_IMAGE=python:3.12-slim
ARG BASE_IMAGE=docker.repo.eng.netapp.com/python:3.12-slim
FROM ${BASE_IMAGE}

# - PYTHONUNBUFFERED: stream pytest output live to the CI log.
# - NO_PROXY/no_proxy: mirror the harness Makefile so *.local / internal hosts
#   bypass any proxy inherited from the runner.
# - ALLURE_RESULTS_DIR: default results dir consumed by publish_allure.py; the
#   same path pytest.ini writes to (reports/allure-results under WORKDIR).
ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    NO_PROXY=* \
    no_proxy=* \
    ALLURE_RESULTS_DIR=/work/reports/allure-results

WORKDIR /work

# Install dependencies first for layer caching: requirements.txt changes far
# less often than test code, so unchanged deps reuse the cached layer.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Bake the harness in (tests + lib + scripts + pytest.ini + Makefile). The
# build context excludes .venv/, reports/, caches and .env* via .dockerignore
# so the image stays small and the tree-hash tag is deterministic.
COPY . /work

# No baked args: `docker run <image>` runs the full suite (pytest.ini
# testpaths=suites); `docker run <image> -m smoke` (or a suite path) appends
# straight through to pytest. Reports land under /work/reports (bind-mounted by
# CI so results can be collected + published from the runner).
ENTRYPOINT ["pytest"]
