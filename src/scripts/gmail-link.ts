/**
 * One-time bootstrap: mint a Gmail refresh token (scope gmail.readonly) for
 * an account, to be stored in GMAIL_REFRESH_TOKENS (env or Secret Manager).
 *
 * Prereq: add the redirect URI below to the Google OAuth client's authorized
 * redirect URIs in the GCP console (APIs & Services → Credentials).
 *
 * Usage: npm run gmail:link
 *   Uses GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET, falling back to
 *   GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET. Override the redirect with
 *   GMAIL_REDIRECT_URI (default http://localhost:8766/callback).
 */

import { createServer } from "node:http";

const clientId = process.env.GMAIL_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
const redirectUri = process.env.GMAIL_REDIRECT_URI || "http://localhost:8766/callback";

if (!clientId || !clientSecret) {
  console.error("Set GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET (or GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET)");
  process.exit(1);
}

const port = parseInt(new URL(redirectUri).port || "80", 10);

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", clientId);
authUrl.searchParams.set("redirect_uri", redirectUri);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/gmail.readonly email");
authUrl.searchParams.set("access_type", "offline");
// Force the consent screen so Google issues a refresh token even if the
// account previously authorized this client.
authUrl.searchParams.set("prompt", "consent");

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", redirectUri);
  if (url.pathname !== new URL(redirectUri).pathname) {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end(`Missing code: ${url.searchParams.get("error") ?? "unknown error"}`);
    return;
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId!,
      client_secret: clientSecret!,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    res.writeHead(500).end(`Token exchange failed: ${text}`);
    console.error(`Token exchange failed: ${tokenRes.status} ${text}`);
    process.exit(1);
  }
  const tokens = (await tokenRes.json()) as {
    refresh_token?: string;
    access_token: string;
    id_token?: string;
  };
  if (!tokens.refresh_token) {
    res.writeHead(500).end("No refresh_token in response (revoke prior grant and retry)");
    console.error("No refresh_token returned. Revoke the app at myaccount.google.com/permissions and retry.");
    process.exit(1);
  }

  // Identify the account from the id_token payload (email claim).
  let email = "unknown";
  if (tokens.id_token) {
    try {
      const payload = JSON.parse(
        Buffer.from(tokens.id_token.split(".")[1], "base64url").toString(),
      ) as { email?: string };
      email = payload.email ?? email;
    } catch {
      // fall through with "unknown"
    }
  }

  res.writeHead(200, { "Content-Type": "text/plain" }).end("Done — return to the terminal.");
  console.log(`\nAuthorized account: ${email}`);
  console.log(`\nAdd this entry to GMAIL_REFRESH_TOKENS (JSON object, merge with existing):`);
  console.log(JSON.stringify({ [email]: tokens.refresh_token }, null, 2));
  console.log(`\nFor Cloud Run: update the GMAIL_REFRESH_TOKENS secret and redeploy.`);
  server.close();
});

server.listen(port, () => {
  console.log(`Listening on ${redirectUri}`);
  console.log(`\nOpen this URL and sign in as the Gmail account to link:\n\n${authUrl.toString()}\n`);
});
