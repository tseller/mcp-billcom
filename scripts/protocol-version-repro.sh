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
set -euo pipefail

BASE="${1:?usage: protocol-version-repro.sh <base-url> [bearer-token]}"
TOKEN="${2:-}"
VERSION="${VERSION:-2026-07-28}"

auth=()
[[ -n "$TOKEN" ]] && auth=(-H "Authorization: Bearer $TOKEN")

hdrs=$(mktemp)
curl -sS -D "$hdrs" -o /dev/null -X POST "$BASE/mcp" \
  ${auth[@]+"${auth[@]}"} \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "MCP-Protocol-Version: $VERSION" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"$VERSION\",\"capabilities\":{},\"clientInfo\":{\"name\":\"protocol-version-repro\",\"version\":\"1.0\"}}}"

SESSION=$(tr -d '\r' < "$hdrs" | awk -F': ' 'tolower($1)=="mcp-session-id"{print $2}')
rm -f "$hdrs"
if [[ -z "$SESSION" ]]; then
  echo "FAIL: handshake did not return a session id" >&2
  exit 1
fi
echo "session: $SESSION"

curl -sS -o /dev/null -X POST "$BASE/mcp" \
  ${auth[@]+"${auth[@]}"} \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SESSION" \
  -H "MCP-Protocol-Version: $VERSION" \
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
