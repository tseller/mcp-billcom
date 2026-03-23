/**
 * Temporary QBO OAuth callback handler for Cloud Run.
 * Add to the Express app to capture the initial authorization.
 * Remove after obtaining the refresh token.
 */

import type { Router } from "express";
import type { Request, Response } from "express";
import { Router as createRouter } from "express";

interface QboAuthConfig {
  clientId: string;
  clientSecret: string;
  serverUrl: string;
}

export function createQboAuthRouter(config: QboAuthConfig): Router {
  const router = createRouter();

  // Step 1: Start the OAuth flow
  router.get("/qbo/auth", (_req: Request, res: Response) => {
    const url = new URL("https://appcenter.intuit.com/connect/oauth2");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", `${config.serverUrl}/qbo/callback`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "com.intuit.quickbooks.accounting");
    url.searchParams.set("state", "setup");
    res.redirect(url.toString());
  });

  // Step 2: Handle the callback
  router.get("/qbo/callback", async (req: Request, res: Response) => {
    const code = req.query.code as string;
    const realmId = req.query.realmId as string;

    if (!code || !realmId) {
      res.status(400).send("Missing code or realmId");
      return;
    }

    try {
      const tokenRes = await fetch(
        "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: `${config.serverUrl}/qbo/callback`,
          }),
        },
      );

      if (!tokenRes.ok) {
        const text = await tokenRes.text();
        res.status(500).send(`<pre>Token exchange failed: ${tokenRes.status}\n${text}</pre>`);
        return;
      }

      const tokens = (await tokenRes.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };

      res.send(`<html><body>
<h1>QBO Authorization Successful</h1>
<p><strong>Realm ID:</strong> <code>${realmId}</code></p>
<p><strong>Refresh Token:</strong></p>
<textarea rows="4" cols="80" onclick="this.select()">${tokens.refresh_token}</textarea>
<p><em>Store these as GCP secrets: QBO_REALM_ID and QBO_REFRESH_TOKEN</em></p>
<p>Access token expires in ${tokens.expires_in}s. The refresh token has rolling 101-day expiration.</p>
<p><strong>Remove the /qbo/* routes after saving these values.</strong></p>
</body></html>`);
    } catch (err) {
      res.status(500).send(`<pre>Error: ${err}</pre>`);
    }
  });

  return router;
}
