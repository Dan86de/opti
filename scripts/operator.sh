#!/usr/bin/env bash
#
# The operator command: the only way host approval and credential saving
# happen in Slice 2, on purpose. Not an MCP tool and never relayed by the
# agent, because that would route the value through model context, chat logs
# and host history - the exact places the placeholder exists to keep it out
# of.
#
# Usage:
#   OPTI_ORIGIN=https://opti.example OPTI_OPERATOR_TOKEN=... \
#     ./scripts/operator.sh approve-host github:12345 todoist api.todoist.com
#
#   OPTI_ORIGIN=https://opti.example OPTI_OPERATOR_TOKEN=... \
#     ./scripts/operator.sh save-credential github:12345 todoist
#
# save-credential reads the value from $OPTI_CREDENTIAL_VALUE or, absent
# that, prompts on stdin with echo off. Never from argv: argv is visible to
# every process listing and lands in shell history.
set -euo pipefail

usage() {
  echo "usage: $0 approve-host <identity> <credential> <host>" >&2
  echo "       $0 save-credential <identity> <name>" >&2
  exit 64
}

: "${OPTI_ORIGIN:?set OPTI_ORIGIN to the worker's origin, e.g. https://opti.example}"
: "${OPTI_OPERATOR_TOKEN:?set OPTI_OPERATOR_TOKEN to the operator token}"

command="${1:-}"

json_escape() {
  # Enough for tokens and hostnames; jq would be nicer but this script must
  # run anywhere a terminal does.
  printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

post() {
  local path="$1" body="$2"
  curl --fail-with-body --silent --show-error \
    --request POST "${OPTI_ORIGIN}${path}" \
    --header "authorization: Bearer ${OPTI_OPERATOR_TOKEN}" \
    --header "content-type: application/json" \
    --data "$body"
  echo
}

case "$command" in
  approve-host)
    [ $# -eq 4 ] || usage
    post /admin/approve-host \
      "{\"identity\":$(json_escape "$2"),\"credential\":$(json_escape "$3"),\"host\":$(json_escape "$4")}"
    ;;
  save-credential)
    [ $# -eq 3 ] || usage
    if [ -n "${OPTI_CREDENTIAL_VALUE:-}" ]; then
      value="$OPTI_CREDENTIAL_VALUE"
    else
      read -r -s -p "value for ${3}: " value
      echo >&2
    fi
    [ -n "$value" ] || { echo "refusing to save an empty value" >&2; exit 65; }
    post /admin/save-credential \
      "{\"identity\":$(json_escape "$2"),\"name\":$(json_escape "$3"),\"value\":$(json_escape "$value")}"
    ;;
  *)
    usage
    ;;
esac
