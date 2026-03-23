/**
 * One-time OAuth2 authorization flow for QuickBooks Online.
 *
 * Usage:
 *   INTUIT_CLIENT_ID=... INTUIT_CLIENT_SECRET=... npx tsx scripts/qbo-auth.ts
 *
 * Opens a browser for you to sign in to QuickBooks. After authorization,
 * prints the refresh token and realm ID to store in your secrets.
 */

import { createServer } from "node:http";
import { URL } from "node:url";
import { randomBytes } from "node:crypto";
import { exec } from "node:child_process";

const clientId = process.env.INTUIT_CLIENT_ID;
const clientSecret = process.env.INTUIT_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("Set INTUIT_CLIENT_ID and INTUIT_CLIENT_SECRET env vars");
  process.exit(1);
}

const PORT = 8765;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const state = randomBytes(16).toString("hex");

const authUrl = new URL("https://appcenter.intuit.com/connect/oauth2");
authUrl.searchParams.set("client_id", clientId);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", "com.intuit.quickbooks.accounting");
authUrl.searchParams.set("state", state);

console.log("\n=== QuickBooks OAuth2 Authorization ===\n");
console.log("Opening browser...\n");

// Open browser
const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
exec(`${openCmd} "${authUrl.toString()}"`);

// Wait for callback
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost:${PORT}`);

  if (url.pathname !== "/callback") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const code = url.searchParams.get("code");
  const realmId = url.searchParams.get("realmId");
  const returnedState = url.searchParams.get("state");

  if (returnedState !== state) {
    res.writeHead(400);
    res.end("State mismatch");
    return;
  }

  if (!code || !realmId) {
    res.writeHead(400);
    res.end("Missing code or realmId");
    return;
  }

  // Exchange code for tokens
  try {
    const tokenRes = await fetch(
      "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI,
        }),
      },
    );

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      res.writeHead(500);
      res.end(`Token exchange failed: ${text}`);
      console.error(`\nToken exchange failed: ${tokenRes.status} ${text}`);
      server.close();
      return;
    }

    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1>Authorization successful!</h1><p>You can close this tab.</p>");

    console.log("=== SUCCESS ===\n");
    console.log(`QBO_REALM_ID=${realmId}`);
    console.log(`QBO_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log(`\nAccess token (expires in ${tokens.expires_in}s):`);
    console.log(tokens.access_token);
    console.log("\nStore QBO_REALM_ID and QBO_REFRESH_TOKEN in GCP Secret Manager.");
    console.log("The refresh token has rolling 101-day expiration — it renews on each use.\n");
  } catch (err) {
    res.writeHead(500);
    res.end("Error exchanging tokens");
    console.error("\nError:", err);
  }

  server.close();
});

server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}/callback for OAuth callback...\n`);
});
