#!/usr/bin/env bash
set -euo pipefail

# Deploy billcom-mcp to Cloud Run
# Secrets are stored in Secret Manager (project mcp-servers-487419)
# Auth is handled at app level via OAuth 2.0 (Google as IdP)

SERVICE_URL="https://billcom-mcp-733083913968.us-central1.run.app"

gcloud config configurations activate mcp-billcom

gcloud run deploy billcom-mcp \
  --source . \
  --region us-central1 \
  --port 8080 \
  --allow-unauthenticated \
  --set-env-vars="MCP_TRANSPORT=http,SERVER_URL=${SERVICE_URL},ALLOWED_EMAILS=tseller@gmail.com" \
  --set-secrets="BILLCOM_API_BASE_URL=BILLCOM_API_BASE_URL:latest,BILLCOM_USERNAME=BILLCOM_USERNAME:latest,BILLCOM_PASSWORD=BILLCOM_PASSWORD:latest,BILLCOM_ORGANIZATION_ID=BILLCOM_ORGANIZATION_ID:latest,BILLCOM_DEV_KEY=BILLCOM_DEV_KEY:latest,GOOGLE_CLIENT_ID=GOOGLE_CLIENT_ID:latest,GOOGLE_CLIENT_SECRET=GOOGLE_CLIENT_SECRET:latest"
