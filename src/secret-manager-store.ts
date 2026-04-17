/**
 * TokenStore backed by GCP Secret Manager, for use on Cloud Run.
 * Reads via the `latest` alias and writes via addVersion so concurrent
 * instances converge on the most recent refresh token.
 */

import type { TokenStore } from "./qbo-client.js";

async function getMetadataAccessToken(): Promise<string> {
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!res.ok) throw new Error(`Metadata token fetch failed: ${res.status}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

export class SecretManagerTokenStore implements TokenStore {
  constructor(
    private projectId: string,
    private secretId: string,
  ) {}

  async getRefreshToken(): Promise<string> {
    const token = await getMetadataAccessToken();
    const res = await fetch(
      `https://secretmanager.googleapis.com/v1/projects/${this.projectId}/secrets/${this.secretId}/versions/latest:access`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      throw new Error(`Secret Manager read failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { payload: { data: string } };
    return Buffer.from(data.payload.data, "base64").toString("utf8");
  }

  async saveRefreshToken(newToken: string): Promise<void> {
    const token = await getMetadataAccessToken();
    const res = await fetch(
      `https://secretmanager.googleapis.com/v1/projects/${this.projectId}/secrets/${this.secretId}:addVersion`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          payload: { data: Buffer.from(newToken).toString("base64") },
        }),
      },
    );
    if (!res.ok) {
      throw new Error(`Secret Manager write failed: ${res.status} ${await res.text()}`);
    }
    console.error("[qbo] Refresh token persisted to Secret Manager");
  }
}
