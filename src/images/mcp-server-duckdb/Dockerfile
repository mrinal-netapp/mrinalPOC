# syntax=docker/dockerfile:1
FROM docker.repo.eng.netapp.com/python:3.12-slim

# mcp-server-motherduck pulls in the exact duckdb + fastmcp versions that
# match the pre-installed extensions.  We no longer run its CLI — we use
# our own server.py which adds automatic OAuth2 token refresh.
COPY obs-client /tmp/obs-client
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install mcp-server-motherduck==1.0.1 /tmp/obs-client

# Pre-install DuckDB extensions to a fixed path that won't be
# overwritten by the emptyDir /tmp mount at runtime.
ENV DUCKDB_EXTENSION_DIR=/opt/duckdb/extensions
RUN mkdir -p ${DUCKDB_EXTENSION_DIR} && \
    python -c "import duckdb; c=duckdb.connect(); c.execute(\"SET extension_directory='${DUCKDB_EXTENSION_DIR}'\"); c.execute('INSTALL iceberg; INSTALL httpfs; INSTALL avro')" && \
    chmod -R a+rX ${DUCKDB_EXTENSION_DIR}

COPY server.py /app/server.py
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER 1000
EXPOSE 8000

ENTRYPOINT ["/entrypoint.sh"]
