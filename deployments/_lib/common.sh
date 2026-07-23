#!/usr/bin/env bash
# deployments/_lib/common.sh -- shared helpers for cloud infra runners.
#
# Sourced by deployments/<cloud>/scripts/infra.sh. Cloud-agnostic: logging,
# command checks, and the destroy confirmation guard. No Azure/AWS/GCP
# specifics live here.

# Colours (fall back to empty when not a TTY so logs stay clean in CI).
if [[ -t 1 ]]; then
  _C_CYAN=$'\033[1;36m'; _C_GREEN=$'\033[1;32m'; _C_YELLOW=$'\033[1;33m'
  _C_RED=$'\033[1;31m'; _C_RESET=$'\033[0m'
else
  _C_CYAN=''; _C_GREEN=''; _C_YELLOW=''; _C_RED=''; _C_RESET=''
fi

log_info()  { printf '%s[infra]%s %s\n'  "$_C_CYAN"   "$_C_RESET" "$*"; }
log_ok()    { printf '%s[infra]%s %s\n'  "$_C_GREEN"  "$_C_RESET" "$*"; }
log_warn()  { printf '%s[infra]%s %s\n'  "$_C_YELLOW" "$_C_RESET" "$*" >&2; }
log_error() { printf '%s[infra]%s %s\n'  "$_C_RED"    "$_C_RESET" "$*" >&2; }

# Storage-layer logging (same colours; distinct prefix for grep).
log_storage_info()  { printf '%s[storage]%s %s\n'  "$_C_CYAN"   "$_C_RESET" "$*"; }
log_storage_ok()    { printf '%s[storage]%s %s\n'  "$_C_GREEN"  "$_C_RESET" "$*"; }
log_storage_warn()  { printf '%s[storage]%s %s\n'  "$_C_YELLOW" "$_C_RESET" "$*" >&2; }
log_storage_error() { printf '%s[storage]%s %s\n'  "$_C_RED"    "$_C_RESET" "$*" >&2; }

# die <message...> -- log an error and exit non-zero.
die() { log_error "$*"; exit 1; }

# normalize_infra_action -- map deprecated ACTION=create to apply (Terraform-style upsert).
normalize_infra_action() {
  if [[ "${ACTION:-}" == "create" ]]; then
    log_warn "ACTION=create is deprecated; use ACTION=apply"
    ACTION=apply
  fi
}

# require_cmd <cmd> [install-hint] -- ensure a command exists on PATH.
require_cmd() {
  local cmd="$1" hint="${2:-}"
  command -v "$cmd" >/dev/null 2>&1 && return 0
  if [[ -n "$hint" ]]; then
    die "required command '$cmd' not found. $hint"
  fi
  die "required command '$cmd' not found on PATH."
}

# confirm_destroy <expected> -- guard a destructive action. Honours the
# CONFIRM environment variable (used by CI) and otherwise prompts on the TTY.
# The supplied confirmation must equal <expected> (the environment name).
confirm_destroy() {
  local expected="$1" answer
  if [[ -n "${CONFIRM:-}" ]]; then
    [[ "${CONFIRM}" == "${expected}" ]] || \
      die "destroy aborted: CONFIRM='${CONFIRM}' does not match ENV='${expected}'."
    log_warn "destroy confirmed for '${expected}' via CONFIRM."
    return 0
  fi
  if [[ ! -t 0 ]]; then
    die "destroy requires confirmation but no TTY is available; set CONFIRM='${expected}'."
  fi
  read -r -p "Type '${expected}' to confirm DESTROY of this environment: " answer
  [[ "${answer}" == "${expected}" ]] || die "destroy aborted: confirmation did not match."
}
