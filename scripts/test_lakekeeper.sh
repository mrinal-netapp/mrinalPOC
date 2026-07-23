#!/bin/bash

set -x
# Configuration
BUCKET_NAME="nemo"
DATASET_NAME="test-dataset"
PROJECT_ID="p-abc123xy"  # Replace with your actual project ID
DATASET_ID="ds-u09ctbc3"  # From your data file path
DEPLOYMENT_ENDPOINT="http://s3.us-west-2.agentstudio.local:8080"  # Replace with your actual endpoint
LAKEKEEPER_URL="http://localhost:8181"
WORKSPACE_ID="546525ec-ef0c-11f0-b17c-97a417f24b34"
NAMESPACE_ID="019badf2-cf39-70f0-b681-663bacb0e3ae"

# Derive S3 endpoint
S3_ENDPOINT=$(echo "$DEPLOYMENT_ENDPOINT" | sed 's|https\?://|https://s3.|')

echo "=== Step 1: Creating Warehouse ==="
# warehouse creation is done once per agentstudio app / nemo initialization.
# each agentstudio app / nemo initialization will have a unique id , which will be used to create a warehouse
curl -X POST ${LAKEKEEPER_URL}/management/v1/warehouse \
  -H "Content-Type: application/json" \
  -d "{
    \"warehouse-name\": \"${BUCKET_NAME}\",
    \"storage-profile\": {
      \"type\": \"s3\",
      \"bucket\": \"${BUCKET_NAME}\",
      \"region\": \"us-west-2\",
      \"sts-enabled\": false,
      \"path-style-access\": true,
      \"endpoint\": \"${S3_ENDPOINT}\"
    }
  }" | jq '.'
# Response :
# {
#   "warehouse-id": "546525ec-ef0c-11f0-b17c-97a417f24b34"
# }

echo -e "\n=== Step 2: Creating Namespace ==="
# each AgentStudio project is a namespace in lakekeeper
curl -X POST ${LAKEKEEPER_URL}/catalog/v1/${WORKSPACE_ID}/namespaces \
  -H "Content-Type: application/json" \
  -d "{
    \"namespace\": [\"${PROJECT_ID}\"]
  }" | jq '.' || echo "Namespace may already exist (this is OK)"
# Response :
# {
#   "namespace": [
#     "p-abc123xy"
#   ],
#   "properties": {
#     "namespace_id": "019badf2-cf39-70f0-b681-663bacb0e3ae",
#     "location": "s3://nemo/019badf2-cf39-70f0-b681-663bacb0e3ae"
#   }
# }

# echo -e "\n=== Step 3: Creating Iceberg Table ==="
# each AgentStudio dataset is a table in lakekeeper
curl -X POST ${LAKEKEEPER_URL}/catalog/v1/${WORKSPACE_ID}/namespaces/${PROJECT_ID}/tables \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"${DATASET_NAME}\",
    \"schema\": {
      \"type\": \"struct\",
      \"fields\": [
        {
          \"id\": 1,
          \"name\": \"file_path\",
          \"type\": \"string\",
          \"required\": false,
          \"doc\": \"s3://nemo/datasets/ds-u09ctbc3/data_files/INvideos.csv\"
        },
        {
          \"id\": 2,
          \"name\": \"file_size\",
          \"type\": \"long\",
          \"required\": false,
          \"doc\": \"60000000\"
        }
      ]
    },
    \"properties\": {
      \"agentstudio.dataset.id\": \"${DATASET_ID}\",
      \"agentstudio.dataset.name\": \"${DATASET_NAME}\",
      \"agentstudio.dataset.type\": \"acquired\",
      \"agentstudio.dataset.kind\": \"structured\"
    },
    \"location\": \"s3://${BUCKET_NAME}/datasets/${DATASET_ID}\"
  }" | jq '.'

# Response :
# {
#   "metadata-location": "s3://nemo/datasets/ds-u09ctbc3/metadata/00000-019badfb-344c-7132-b4f7-dc1314601772.gz.metadata.json",
#   "metadata": {
#     "format-version": 2,
#     "table-uuid": "019badfb-3434-73e3-b71c-8cf4f48aadb9",
#     "location": "s3://nemo/datasets/ds-u09ctbc3",
#     "last-sequence-number": 0,
#     "last-updated-ms": 1768150479948,
#     "last-column-id": 2,
#     "schemas": [
#       {
#         "schema-id": 0,
#         "type": "struct",
#         "fields": [
#           {
#             "id": 1,
#             "name": "file_path",
#             "required": false,
#             "type": "string",
#             "doc": "s3://nemo/datasets/ds-u09ctbc3/data_files/INvideos.csv"
#           },
#           {
#             "id": 2,
#             "name": "file_size",
#             "required": false,
#             "type": "long",
#             "doc": "60000000"
#           }
#         ]
#       }
#     ],
#     "current-schema-id": 0,
#     "partition-specs": [
#       {
#         "spec-id": 0,
#         "fields": []
#       }
#     ],
#     "default-spec-id": 0,
#     "last-partition-id": 999,
#     "properties": {
#       "agentstudio.dataset.name": "test-dataset",
#       "agentstudio.dataset.id": "ds-u09ctbc3",
#       "agentstudio.dataset.kind": "structured",
#       "agentstudio.dataset.type": "acquired"
#     },
#     "sort-orders": [
#       {
#         "order-id": 0,
#         "fields": []
#       }
#     ],
#     "default-sort-order-id": 0,
#     "refs": {}
#   },
#   "config": {
#     "s3.signer.uri": "http://localhost:8181/catalog/",
#     "region": "us-west-2",
#     "s3.path-style-access": "true",
#     "s3.endpoint": "http://s3.us-west-2.agentstudio.local:8080/",
#     "s3.region": "us-west-2",
#     "s3.signer.endpoint": "v1/signer/546525ec-ef0c-11f0-b17c-97a417f24b34/tabular-id/019badfb-3434-73e3-b71c-8cf4f48aadb9/v1/aws/s3/sign",
#     "client.region": "us-west-2",
#     "s3.remote-signing-enabled": "true"
#   }
# }
# echo -e "\n=== Done ==="
