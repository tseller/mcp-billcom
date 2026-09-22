#!/usr/bin/env bash
# Reproduce #15: a client that announces an MCP protocol version the server
# doesn't speak gets its tool calls rejected 400 before anything runs.
#
#   scripts/protocol-version-repro.sh <base-url> [bearer-token]
#
# Drives a full handshake and then one post-initialize request carrying
# MCP-Protocol-Version: 2026-07-28 — the version Tim's Claude connector
# announces, captured from Cloud Run logs on 2026-09-17.
#
# Exit 0 = the request was answered. Exit 1 = it was refused (the bug).
#
# Two versions are in play and they are NOT the same fact, so they are not the
# same variable:
#
#   HANDSHAKE_VERSION — what the session negotiates at initialize. Must be one
#                       the legacy era actually speaks; this is the "negotiated
#                       version" the fix treats as authoritative.
#   VERSION           — the version under test, carried on the header of the
#                       requests made AFTER initialize. This is the one the
#                       connector announces and the server does not speak.
#
# They were one variable until 2026-09-22, which sent the unsupported version
# as the handshake's own protocolVersion too. That asks a different question
# (can you negotiate 2026-07-28?) than the one this script exists to ask (does
# an established session survive a header naming a version we don't speak?),
# and once prod grew a modern era it started failing the handshake outright —
# the script reported "FAIL" while the fix it tests was working perfectly.
#
# Note the handshake deliberately sends NO MCP-Protocol-Version header: a real
# client has nothing to echo before a version is negotiated.
set -euo pipefail

BASE="${1:?usage: protocol-version-repro.sh <base-url> [bearer-token]}"
TOKEN="${2:-}"
VERSION="${VERSION:-2026-07-28}"
HANDSHAKE_VERSION="${HANDSHAKE_VERSION:-2025-06-18}"

auth=()
[[ -n "$TOKEN" ]] && auth=(-H "Authorization: Bearer $TOKEN")

hdrs=$(mktemp)
init=$(mktemp)
init_status=$(curl -sS -D "$hdrs" -o "$init" -w '%{http_code}' -X POST "$BASE/mcp" \
  ${auth[@]+"${auth[@]}"} \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"$HANDSHAKE_VERSION\",\"capabilities\":{},\"clientInfo\":{\"name\":\"protocol-version-repro\",\"version\":\"1.0\"}}}")

SESSION=$(tr -d '\r' < "$hdrs" | awk -F': ' 'tolower($1)=="mcp-session-id"{print $2}')
rm -f "$hdrs"
if [[ -z "$SESSION" ]]; then
  # Say what the server actually answered. A bare "no session id" hid a
  # perfectly explicit JSON-RPC error and read as though the fix had broken.
  echo "FAIL: handshake ($HANDSHAKE_VERSION) returned no session id — HTTP $init_status" >&2
  head -c 500 "$init" >&2; echo >&2
  rm -f "$init"
  exit 1
fi
rm -f "$init"
echo "session: $SESSION  (negotiated $HANDSHAKE_VERSION)"

curl -sS -o /dev/null -X POST "$BASE/mcp" \
  ${auth[@]+"${auth[@]}"} \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SESSION" \
  -H "MCP-Protocol-Version: $HANDSHAKE_VERSION" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

# The request the connector's tool calls take. tools/list needs no credentials,
# so it isolates the transport's protocol-version gate from anything downstream.
body=$(mktemp)
status=$(curl -sS -o "$body" -w '%{http_code}' -X POST "$BASE/mcp" \
  ${auth[@]+"${auth[@]}"} \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SESSION" \
  -H "MCP-Protocol-Version: $VERSION" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')

echo "MCP-Protocol-Version: $VERSION  ->  HTTP $status ($(wc -c < "$body" | tr -d ' ') bytes)"
head -c 400 "$body"; echo
rm -f "$body"

[[ "$status" == "200" ]]
