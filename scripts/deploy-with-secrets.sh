#!/usr/bin/env bash
# Deploys the Worker and sets its secrets in the same version. Required for the
# first deploy (cf cannot set secrets on a Worker that doesn't exist yet), and
# handy for rotating secrets later.
#
# Each value is read with hidden input and handed to `cf deploy` through a pipe,
# so it never touches disk, shell history, or the process list. Extra arguments
# are passed to `cf deploy` (for example --dry-run).
set -euo pipefail
cd "$(dirname "$0")/.."

prompt() {
  local name=$1 description=$2 value
  read -rsp "$name ($description): " value
  echo >&2
  if [[ -z $value ]]; then
    echo "$name is required" >&2
    exit 1
  fi
  printf -v "$name" '%s' "$value"
}

# JSON-escape a value for the secrets file
json_string() {
  local s=${1//\\/\\\\}
  s=${s//\"/\\\"}
  printf '"%s"' "$s"
}

prompt PRIVATE_KEY "0x-prefixed private key of the bot wallet"
prompt RPC_URL "Ethereum mainnet JSON-RPC URL"
prompt RUN_TOKEN "long random string for POST /run"

# Run the project's cf directly: npx would not pass the pipe's file descriptor
# through to it
./node_modules/.bin/cf deploy "$@" --secrets-file <(
  printf '{"PRIVATE_KEY":%s,"RPC_URL":%s,"RUN_TOKEN":%s}' \
    "$(json_string "$PRIVATE_KEY")" \
    "$(json_string "$RPC_URL")" \
    "$(json_string "$RUN_TOKEN")"
)
