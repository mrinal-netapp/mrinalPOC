FROM docker.repo.eng.netapp.com/python:3.12-slim

WORKDIR /app

# System deps -- none beyond the python wheels below.
RUN pip install --no-cache-dir \
    "fastapi>=0.115" \
    "uvicorn[standard]>=0.30" \
    "pyyaml>=6.0"

COPY app.py /app/app.py
COPY fixtures.yaml /app/fixtures.yaml

ENV MOCK_LLM_FIXTURES=/app/fixtures.yaml \
    MOCK_LLM_HOT_RELOAD=0

EXPOSE 4000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "4000"]
