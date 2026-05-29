# Recovery: re-authorizing QBO after access loss

## When you need this

The morning brief reports `Token expired` for QBO. Cloud Run logs (`gcloud logging read … service_name=billcom-mcp …`) show repeated `invalid_grant` on QBO refreshes. The token has been invalidated by Intuit — usually because someone with admin access to the AYSO Region 2B145 QBO company uninstalled the "MCP Server" app from their Intuit app list. This has happened before (2026-05-08); AYSO national periodically sweeps the app list of regional companies as part of their security policy.

## Why the realm looks weird

QBO issues **different realm IDs for the same company** depending on the OAuth context:

- **Direct-user OAuth** (Master Admin / Company Admin / Standard User logged in directly to Region 2B145) → realm `9130356619937076`. The original working setup used this. **No longer accessible** to `tseller@gmail.com` after AYSO national rolled back regional treasurer admin access nation-wide.
- **QBOA accountant OAuth** (`tseller@gmail.com` is now an accountant on "AYSO - Section 2" firm, which has access to Region 2B145 as a client) → realm `9341457051065220`. **This is the working path going forward.**

If a request to `/v3/company/9130356619937076/...` returns "Wrong Cluster" (HTTP 401, errorCode 11017), the wrong realm is configured — the two realms are in different physical Intuit clusters and are not interchangeable. Always use `9341457051065220` going forward.

## Recovery steps

Total time when smooth: ~5 minutes.

### 1. Confirm symptom

Browse `qbo.intuit.com` → AYSO - Region 2B145 → settings → "Apps already connected". If **MCP Server is absent**, this is the right playbook. (If MCP Server is present but you're still getting `invalid_grant`, it's a different problem — check Cloud Run logs and the warmup-race notes in `git log`.)

### 2. Re-auth in the browser

Open this URL while signed in to Intuit as `tseller@gmail.com`:

```
https://billcom-mcp-733083913968.us-central1.run.app/qbo/auth
```

On Intuit's company picker:

1. Under **"Search for a company or firm"**, pick **AYSO - Section 2** (the only option visible to a QBOA accountant).
2. **Leave "Install for your firm" UNCHECKED.** Checking it puts the install at firm scope, which yields a different realm in a different cluster.
3. Under **"Search for a client"**, pick **AYSO - Region 2B145**.
4. The consent screen says "Connecting MCP Server to AYSO - Region 2B145" — click **Connect**.

### 3. Capture the credentials

The callback page shows:

- `Realm ID:` — expected to be `9341457051065220`. **If you see anything else, STOP** and investigate; the rest of this playbook assumes the accountant-context realm.
- `Refresh Token:` — a fresh `RT1-…` string. Treat as a secret. Do **not** paste into chat / Slack / email.

The page tells you to "Store these as GCP secrets." That's correct — the `/qbo/auth` endpoint does **not** auto-persist the initial RT (only rolling rotations auto-persist via `SecretManagerTokenStore`).

### 4. Persist the new refresh token

In a terminal:

```bash
# Save RT to Secret Manager via stdin (never appears in argv / history)
printf '%s' '<paste the new RT here>' | gcloud secrets versions add QBO_REFRESH_TOKEN \
  --data-file=- \
  --project=mcp-servers-487419 \
  --account=tseller@gmail.com
```

`QBO_REALM_ID` should already be `9341457051065220` from prior recovery. Only update it if step 3 returned a different realm (don't expect that to happen).

### 5. Bump Cloud Run

The running revision still holds the old token in its env. Force a new revision so it re-reads from Secret Manager:

```bash
gcloud run services update billcom-mcp \
  --account=tseller@gmail.com \
  --project=mcp-servers-487419 \
  --region us-central1 \
  --update-secrets="QBO_REFRESH_TOKEN=QBO_REFRESH_TOKEN:latest"
```

### 6. Smoke test

Pull the MCP bearer token into an env var (without echoing it), open a session, and call a QBO tool:

```bash
MCP_TOKEN=$(gcloud secrets versions access latest --secret=MCP_API_TOKEN \
  --project=mcp-servers-487419 --account=tseller@gmail.com)
URL="https://billcom-mcp-733083913968.us-central1.run.app/mcp"
INIT=$(curl -s -i -X POST "$URL" \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}')
SID=$(echo "$INIT" | grep -i "^mcp-session-id:" | awk '{print $2}' | tr -d '\r')
curl -s -X POST "$URL" \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"qbo_account_balances","arguments":{}}}'
unset MCP_TOKEN
```

Expect to see Chase Checking and Divvy Credit Card Payable balances. If you see "Wrong Cluster" — the realm got out of sync. Check `gcloud secrets versions access latest --secret=QBO_REALM_ID …`; it should be `9341457051065220`.

## Related background

- The original break (2026-05-08) was caused by an admin uninstalling the MCP Server app, not by a token-refresh race. The eager `[qbo] Warmup` refresh has since been removed (`src/http-server.ts` / `src/qbo-client.ts`) to reduce cold-start race surface, but that change wasn't the actual fix for the May 8 incident.
- Intuit's `/qbo/auth` flow is `src/qbo-auth-callback.ts`. The file header still calls it "temporary" from when it was first set up. We keep it because re-auth is needed periodically.
- If MCP Server gets removed *again* after this recovery, the same playbook works. Each recovery takes ~5 minutes and leaves the system running until the next sweep.
