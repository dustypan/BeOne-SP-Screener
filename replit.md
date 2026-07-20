# BeOne Superhighway Manufacturing Partnership Screener

A web app that screens pharmaceutical manufacturing partners against configurable criteria using Claude AI, the Brave search API, and Citeline data.

## How to run

The workflow **Start application** runs `node server.js` on port 5000.

## Stack

- **Backend**: Node.js + Express (`server.js`)
- **Frontend**: Vanilla HTML/CSS/JS (`index.html`, `login.html`, `js/`, `css/`)
- **Database**: Replit PostgreSQL (schema bootstrapped automatically on startup)
- **AI**: Anthropic Claude (via `@anthropic-ai/sdk`)
- **Search**: Brave Search API
- **Data**: Citeline MSSQL database + local `citeline-data/Citeline_Screener_Data.xlsx` fallback

## Environment variables / secrets

| Key | Where | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | Replit Secret or in-app UI | Required for AI screening |
| `BRAVE_API_KEY` | Replit Secret or `.env` | Required for web search during screening |
| `PHARMCUBE_API_KEY` | `.env` / Replit Secret | PharmCube pipeline data |
| `ONEBD_API_KEY` | `.env` / Replit Secret | OneBD data |
| `CITELINE_USER` | `.env` / Replit Secret | Citeline SQL Server username |
| `CITELINE_PASS` | `.env` / Replit Secret | Citeline SQL Server password |
| `SITE_PASSKEY` | Replit Secret (optional) | If set, gates the app behind a passkey login |
| `PORT` | Env var (shared) | Set to 5000 for Replit webview |

> **Note**: `.env` provides values for local/dev use. For production deployment, all secrets must be in Replit Secrets.

## Deploying

Click **Publish** in the Replit UI. Before publishing, add `ANTHROPIC_API_KEY`, `BRAVE_API_KEY`, and any other secrets under Replit Secrets so they're available in production.

## User preferences

- Keep existing project structure — do not restructure or migrate the stack.
