#!/usr/bin/env bash
set -euo pipefail

# Smoke-test S3 path-style endpoint compatibility with AWS CLI.
# Validates put/get/head/delete/list for keys with spaces and special chars.
#
# Required env vars:
#   S3_ENDPOINT   e.g. https://s3.agentstudio.local
#   S3_BUCKET     target bucket name
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (standard AWS CLI auth)
#
# Optional env vars:
#   AWS_REGION=us-east-1
#   AWS_PROFILE=<profile>
#   AWS_CLI_INSECURE=1   (adds --no-verify-ssl for local/self-signed setups)

if ! command -v aws >/dev/null 2>&1; then
  echo "ERROR: aws CLI not found in PATH"
  exit 1
fi

: "${S3_ENDPOINT:?S3_ENDPOINT is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"

AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_CLI_OPTS=(--endpoint-url "${S3_ENDPOINT}" --region "${AWS_REGION}")
if [[ "${AWS_CLI_INSECURE:-0}" == "1" ]]; then
  AWS_CLI_OPTS+=(--no-verify-ssl)
fi
if [[ -n "${AWS_PROFILE:-}" ]]; then
  AWS_CLI_OPTS+=(--profile "${AWS_PROFILE}")
fi

# Force path-style addressing for this validation.
export AWS_S3_ADDRESSING_STYLE=path

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

base_prefix="cli-smoke-$(date +%s)"
src_file="${tmp_dir}/payload.txt"
dst_file="${tmp_dir}/downloaded.txt"
echo "s3 cli smoke test $(date -u +%FT%TZ)" > "${src_file}"

keys=(
  "${base_prefix}/a b.txt"
  "${base_prefix}/a+b.txt"
  "${base_prefix}/a%20b.txt"
  "${base_prefix}/dir with space/file #1.txt"
  "${base_prefix}/资料.txt"
)

echo "Using endpoint: ${S3_ENDPOINT}"
echo "Using bucket:   ${S3_BUCKET}"
echo "Using prefix:   ${base_prefix}"

echo "Checking bucket access..."
aws s3api head-bucket --bucket "${S3_BUCKET}" "${AWS_CLI_OPTS[@]}"

for key in "${keys[@]}"; do
  echo "PUT ${key}"
  aws s3api put-object \
    --bucket "${S3_BUCKET}" \
    --key "${key}" \
    --body "${src_file}" \
    "${AWS_CLI_OPTS[@]}"

  echo "HEAD ${key}"
  aws s3api head-object \
    --bucket "${S3_BUCKET}" \
    --key "${key}" \
    "${AWS_CLI_OPTS[@]}" >/dev/null

  echo "GET ${key}"
  aws s3api get-object \
    --bucket "${S3_BUCKET}" \
    --key "${key}" \
    "${dst_file}" \
    "${AWS_CLI_OPTS[@]}" >/dev/null
done

echo "LIST prefix ${base_prefix}/"
aws s3api list-objects-v2 \
  --bucket "${S3_BUCKET}" \
  --prefix "${base_prefix}/" \
  "${AWS_CLI_OPTS[@]}" >/dev/null

# Validate aws s3 high-level command path too.
echo "aws s3 cp sanity check"
aws s3 cp "${src_file}" "s3://${S3_BUCKET}/${base_prefix}/cp with space.txt" "${AWS_CLI_OPTS[@]}"
aws s3 cp "s3://${S3_BUCKET}/${base_prefix}/cp with space.txt" "${dst_file}" "${AWS_CLI_OPTS[@]}"

for key in "${keys[@]}" "${base_prefix}/cp with space.txt"; do
  echo "DELETE ${key}"
  aws s3api delete-object \
    --bucket "${S3_BUCKET}" \
    --key "${key}" \
    "${AWS_CLI_OPTS[@]}" >/dev/null
done

echo "SUCCESS: S3 endpoint CLI smoke test passed."
