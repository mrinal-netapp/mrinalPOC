# syntax=docker/dockerfile:1
# init-tools: Lightweight init container toolbox (~12 MB)
# Provides psql, pg_isready, curl, nc, and standard shell utilities
# for init containers that wait on services, create databases, or do HTTP checks.

FROM docker.repo.eng.netapp.com/alpine:3.20

RUN apk add --no-cache postgresql16-client curl

USER 65534:65534

ENTRYPOINT ["/bin/sh"]
