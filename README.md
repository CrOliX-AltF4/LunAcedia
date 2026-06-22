<div align="center">

# ◆ LunAcedia

[![Version](https://img.shields.io/github/v/release/CrOliX-AltF4/LunAcedia?style=flat-square&color=C8A415)](https://github.com/CrOliX-AltF4/LunAcedia/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/CrOliX-AltF4/LunAcedia/ci.yml?style=flat-square&label=CI)](https://github.com/CrOliX-AltF4/LunAcedia/actions)
[![Node](https://img.shields.io/badge/node-%3E%3D20-555555?style=flat-square)](.)
[![License](https://img.shields.io/badge/license-MIT-333333?style=flat-square)](LICENSE)

**sources → facts → actions → clients**

_A headless information infrastructure server. Polls GitHub, Gmail, Calendar, Tasks, RSS and Home Assistant — deduplicates events, broadcasts them over WebSocket and REST, executes actions back on the sources._

</div>

> [!NOTE]
> **Fully standalone** — no Natsume or LunAvaritia required. LunAcedia is a headless backend; any HTTP or WebSocket client can consume it. Official clients: [LunAvaritia](https://github.com/CrOliX-AltF4/LunAvaritia) (Android) and the Natsume admin panel (desktop). Part of the [Lun' ecosystem](https://github.com/CrOliX-AltF4).

---

## Quick start

```bash
# Docker (recommended)
docker run -d --name lunacedia -p 4000:4000 -p 4001:4001 \
  --env-file .env ghcr.io/crolix-altf4/lunacedia:latest

# From source
git clone https://github.com/CrOliX-AltF4/LunAcedia.git
cd LunAcedia && npm install
cp .env.example .env   # fill in credentials
npm run build && npm start
```

Once running, open `http://localhost:4001` in your browser — the built-in dashboard lists live events, unread count, and lets you trigger actions without any additional client.

> See [`.env.example`](.env.example) for the full configuration reference.

---

## What it does

```
GitHub ──┐
Gmail  ──┤                            ┌── Browser          built-in dashboard  :4001
GCal   ──┼──► IngestionHub ──────►   ├── LunAvaritia       Android client (official)
Tasks  ──┤    + EventStore            ├── Natsume           AI companion — WS + butler bridge
RSS    ──┤    + Web dashboard         └── Any WS/HTTP client
HA     ──┘

              Actions back: reply email · complete task · update event
              AI butler: openai / ollama (standalone) or delegate to Natsume
```

**Headless by design** — LunAcedia exposes a REST API and a WebSocket stream. Clients are independent: the Android app, the Natsume bridge, and the built-in dashboard all talk to the same API. No client is required for LunAcedia to run.

**Connectors** — GitHub notifications, Gmail (OAuth2), Google Calendar, Google Tasks, RSS/Atom, Home Assistant — enabled individually via env flags, classified by rules, never by LLM

**Events** — Structured `AcediaEvent` objects: type, source, priority, dedupeKey, body — 7-day dedup TTL

**Actions** — Reply to emails, complete tasks, update calendar events — via `POST /api/actions`

**AI butler** — Optional synthesis layer: `openai` or `ollama` for standalone use, `natsume` to delegate to Natsume Core with shared LTM and personality

**Push notifications** — FCM: register Android tokens, filter by priority, deliver via Firebase

**Clients** — WebSocket `:4000` (live event stream), HTTP REST `:4001` (query + actions), all routes bearer-protected (disable with empty `ACEDIA_SECRET` for LAN-only)

> "Acedia" — the sin of sloth, of letting information pile up unread. Part of the [Lun ecosystem](https://github.com/CrOliX-AltF4).

---

## Standalone usage (no Natsume, no mobile app)

A minimal `.env` to get started with GitHub and RSS only:

```bash
GITHUB_ENABLED=true
GITHUB_TOKEN=ghp_...
GITHUB_WATCHED_REPOS=*

RSS_ENABLED=true
RSS_FEEDS='["https://hnrss.org/frontpage"]'

AI_PROVIDER=none   # events and actions work — /api/chat and /api/digest return 503
```

```bash
npm start
# → WebSocket on :4000  — connect any WS client for live events
# → REST on     :4001   — GET /api/events, /api/stats, /api/health
# → Dashboard   :4001   — open in browser for visual event feed
```

`AI_PROVIDER=none` (default) means all connectors, REST, WebSocket, actions, and the dashboard work normally — only the `/api/chat` and `/api/digest` endpoints return `503 AI not configured`. Set `AI_PROVIDER=openai` or `AI_PROVIDER=ollama` to enable those without Natsume.

### Clients

| Client                                                     | How to connect                        | Best for                                      |
| ---------------------------------------------------------- | ------------------------------------- | --------------------------------------------- |
| Built-in dashboard                                         | Open `http://host:4001`               | Quick visual check, standalone users          |
| [LunAvaritia](https://github.com/CrOliX-AltF4/LunAvaritia) | Set server URL in Settings            | Mobile — notifications, read/action on the go |
| Natsume admin panel                                        | Set `ACEDIA_WS_URL` in Natsume `.env` | Desktop — TTS alerts + manual triage panel    |
| `curl` / any HTTP client                                   | `GET http://host:4001/api/events`     | Dev, scripts, automation                      |

---

## Google OAuth setup (Gmail · Calendar · Tasks)

LunAcedia uses **refresh tokens** — no browser interaction at runtime. You generate the token once and put it in `.env`.

**1. Create an OAuth 2.0 app**

- Go to [console.cloud.google.com](https://console.cloud.google.com) → select your project
- **APIs & Services → OAuth consent screen** — set User type: **External**
- Under **Audience** (or "Test users" in older UI) → **+ Add users** → add your Google account
- **APIs & Services → Credentials → + Create credentials → OAuth client ID** → Application type: **Web application**
- Add `https://developers.google.com/oauthplayground` as an authorized redirect URI
- Note your **Client ID** and **Client Secret**

**2. Enable the required APIs**

In **APIs & Services → Library**, enable:

- Gmail API
- Google Calendar API
- Google Tasks API

**3. Get the refresh token (once)**

- Go to [developers.google.com/oauthplayground](https://developers.google.com/oauthplayground)
- Click ⚙️ → check **"Use your own OAuth credentials"** → enter your Client ID + Secret
- Select these scopes:
    - `https://www.googleapis.com/auth/gmail.readonly`
    - `https://www.googleapis.com/auth/calendar.readonly`
    - `https://www.googleapis.com/auth/tasks.readonly`
- **Authorize APIs** → sign in → accept (you will see "This app isn't verified" — click **Continue**, you are a test user)
- **Step 2 → Exchange authorization code for tokens** → copy the `refresh_token`

**4. Fill in `.env`**

The same Client ID, Client Secret, and refresh token work for all three Google connectors:

```bash
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REFRESH_TOKEN=<token from Step 3>

GCAL_CLIENT_ID=...        # same values
GCAL_CLIENT_SECRET=...
GCAL_REFRESH_TOKEN=<same token>

GTASKS_CLIENT_ID=...
GTASKS_CLIENT_SECRET=...
GTASKS_REFRESH_TOKEN=<same token>
```

---

## Design rules

- Connectors classify by **rules only** — no LLM inside the connector layer
- `AcediaEvent` carries **facts**: title, source, priority — no interpretation
- Interpretation belongs to the consumer (Natsume) or the optional AI butler
- **Asymmetry**: Natsume knows LunAcedia; LunAcedia does not know Natsume
- **Client independence**: no client is privileged — the REST/WS API is the only contract

---

## Lun ecosystem

| Project                                                    | Role                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| [LunIra](https://github.com/CrOliX-AltF4/LunIra)           | AI dev pipeline — intent → code                           |
| **LunAcedia**                                              | Information infrastructure — events · actions · AI butler |
| [LunAvaritia](https://github.com/CrOliX-AltF4/LunAvaritia) | Mobile companion — Android                                |
| [LunGula](https://github.com/CrOliX-AltF4/LunGula)         | Imitation learning — gameplay → ONNX policy               |
| LunAnima                                                   | AI companion core — private                               |

---

<div align="center">

Built by **[CrOliX-AltF4](https://github.com/CrOliX-AltF4)** · MIT License · © 2026

_Part of the [Lun' ecosystem](https://github.com/CrOliX-AltF4)._

</div>
