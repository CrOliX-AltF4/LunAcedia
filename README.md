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
>
> **Doctrine** — the ecosystem's constitution and standards (UX, security/auth, satellite readiness bar) live in LunAnima's `docs/constitution.md` and `docs/standards/` (private repo). Rewritten 2026-09-15 — see LunAnima's `docs/adr/ADR-003-refonte-doctrine-2026-09.md` for what changed and why, in particular `04-securite-auth.md` which covers this repo's Google OAuth token storage.

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

              Actions back: 17 kinds across Gmail/Calendar/Tasks/GitHub, gated by autonomy tier
              AI butler: openai / ollama (standalone) or delegate to Natsume
              Agent: reads your events, acts through the tier gate (/api/agent)
```

**Headless by design** — LunAcedia exposes a REST API and a WebSocket stream. Clients are independent: the Android app, the Natsume bridge, and the built-in dashboard all talk to the same API. No client is required for LunAcedia to run.

**Connectors** — GitHub notifications, Gmail (OAuth2), Google Calendar, Google Tasks, RSS/Atom, Home Assistant — enabled individually via env flags, classified by rules, never by LLM

**Events** — Structured `AcediaEvent` objects: type, source, priority, dedupeKey, body — 7-day dedup TTL

**Actions** — 17 kinds via `POST /api/actions`: Gmail (reply, archive, delete, mark read/unread), Calendar (create/update/delete event), Tasks (create/complete/delete), GitHub (comment, label, create/close issue, open PR, merge PR). Each kind has an autonomy tier, `GET/PATCH /api/config/tiers`:

- **auto** — the butler acts with no human signal at all
- **confirm** — needs a human signal first, either an explicit request or a proposal it made and is waiting on a "yes" (`POST /api/actions` queues it, `POST /api/actions/:id/confirm` executes it)
- **manual** — never executable through the API no matter how explicitly it's requested (the butler may only suggest it as text)

`merge_pr` is hardcoded to `manual` and cannot be relaxed — merging is always a human action.

**Agent** — `POST /api/agent` answers a request in natural language ("quels mails urgents je n'ai pas lus ?", "archive le premier") with native tool calling: it searches the events LunAcedia holds (unread mail and everything received since it started), reads one in full, finds free slots, and acts **only** through the same tier gate as `POST /api/actions`. Every tool argument is re-validated against the capability manifest (`source/capabilities/`); `merge_pr` is never built from model output; once the agent has read third-party text (a mail body…), every action it proposes is held for confirmation even if its tier is `auto`. Bounded to 6 steps, 20 s and 3 actions per request. The switch is `GET|PUT /api/agent/settings` (off = no tool is ever called) and `GET /api/agent/journal` lists the last 50 runs. `POST /api/chat` (LunAvaritia) and `POST /api/intent` (one action) are answered by the same agent. Requires `AI_PROVIDER != none` and a model with tool calling (OpenAI; Ollama with a tool-capable model).

**Topics** — the pocket app's conversations, kept server side so they are the same from every client: one conversation is one topic to deal with. `POST /api/conversations` opens one (optionally `about` a box item — a notification's "Traiter"), `POST /api/conversations/:id/messages` follows up, `GET /api/conversations[/:id]` lists and pages, `PATCH` renames or archives, `DELETE` removes (journaled). Each turn is answered by the agent with the topic's earlier turns, so a follow-up ("et le deuxième ?") makes sense; older turns are folded into a summary, never silently dropped. Third-party text read in an earlier turn — or the item the topic is about — keeps every later action held for confirmation. With the agent off, answers are plain dialogue with no tool. Stored under `STORAGE_DIR/conversations/` (one append-only file per topic); 4000 characters per message, 500 messages per topic, no automatic purge. The dashboard lists them read-only (**Sujets**).

**Paired devices** — a phone never holds `ACEDIA_SECRET`: from the dashboard (**Appareils**), ask for a pairing code (8 characters, one use, 10 minutes) and type it in the app with the server's address; the phone receives its own token (only its SHA-256 is kept), which opens the mobile routes only (the box, topics, pending actions, digest, its notifications, turning the agent off). Revoke a device and its token is refused at once; a device silent for 90 days is revoked automatically. Five wrong codes invalidate every open code; pairing attempts are rate-limited.

**LLM spend** — every call of LunAcedia's own model is measured by day, caller (the Core, the phone's topics, a direct API client, a background pass), purpose and model, with an estimated cost in dollars (`LLM_PRICES` overrides the price table; a local model is free). `GET /api/usage` reports it; the dashboard shows it (**Dépense LLM**) with **alert paliers** per day and per caller and an unusual-spend alert (`GET|PUT /api/config/usage-alerts`; defaults from `LLM_ALERT_DAILY_USD`, `LLM_ALERT_CALLER_USD`, `LLM_ALERT_SPIKE_FACTOR`, `LLM_ALERT_SPIKE_MIN_USD`). Alerts are pushed to the phone within its priority filter, and relayed by the Core when wired. **Nothing is ever cut for a cost** — spend is managed at the provider.

**Calendar conflict detection & rescheduling** — overlapping timed events emit a `calendar.conflict` entry automatically; `GET /api/calendar/free-slots` computes open gaps deterministically (no LLM); `GET /api/proposals` names an actual free slot when proposing a fix for a conflict.

**AI butler** — LunAcedia's own LLM (`openai` or `ollama`), configured from the dashboard's onboarding screen. It powers the agent above, `GET /api/digest` and `GET /api/proposals` (suggests next actions for urgent/conflict items). Natsume's Core never acts as LunAcedia's LLM: it delegates requests to the agent instead (ADR-008 D2).

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

AI_PROVIDER=none   # events and actions work — /api/agent, /api/chat, /api/conversations and /api/digest return 503
```

```bash
npm start
# → WebSocket on :4000  — connect any WS client for live events
# → REST on     :4001   — GET /api/events, /api/stats, /api/health
# → Dashboard   :4001   — open in browser for visual event feed
```

`AI_PROVIDER=none` (default) means all connectors, REST, WebSocket, actions, and the dashboard work normally — only the `/api/agent`, `/api/chat`, `/api/intent` and `/api/digest` endpoints return `503 AI not configured`. Set `AI_PROVIDER=openai` or `AI_PROVIDER=ollama` to enable those without Natsume.

### Clients

| Client                                                     | How to connect                        | Best for                                      |
| ---------------------------------------------------------- | ------------------------------------- | --------------------------------------------- |
| Built-in dashboard                                         | Open `http://host:4001`               | Quick visual check, standalone users          |
| [LunAvaritia](https://github.com/CrOliX-AltF4/LunAvaritia) | Set server URL in Settings            | Mobile — notifications, read/action on the go |
| Natsume admin panel                                        | Set `ACEDIA_WS_URL` in Natsume `.env` | Desktop — TTS alerts + manual triage panel    |
| `curl` / any HTTP client                                   | `GET http://host:4001/api/events`     | Dev, scripts, automation                      |

---

## Google OAuth setup (Gmail · Calendar · Tasks)

LunAcedia uses **refresh tokens** — no browser interaction at runtime once connected. Steps 1-2 (create the app, enable the APIs) are shared by both connection methods below; pick one for step 3.

**1. Create an OAuth 2.0 app**

- Go to [console.cloud.google.com](https://console.cloud.google.com) → select your project
- **APIs & Services → OAuth consent screen** — set User type: **External**
- Under **Audience** (or "Test users" in older UI) → **+ Add users** → add your Google account
- **APIs & Services → Credentials → + Create credentials → OAuth client ID** → Application type: **Web application**
- Note your **Client ID** and **Client Secret**

**2. Enable the required APIs**

In **APIs & Services → Library**, enable:

- Gmail API
- Google Calendar API
- Google Tasks API

**3a. Connect in-app (recommended)** — one click per connector from the dashboard, no manual token copying:

- Add `http://<your-host>:<HTTP_PORT>/api/oauth/google/callback` as an authorized redirect URI on the OAuth client (e.g. `http://localhost:4001/api/oauth/google/callback`) — this is a _different_ redirect URI from the OAuth Playground one in 3b, register both if you might use either method
- Fill in `.env`:
    ```bash
    GOOGLE_CLIENT_ID=...
    GOOGLE_CLIENT_SECRET=...
    ```
- Start LunAcedia, open the dashboard → **⚙ Réglages** → click **Connecter** next to Gmail / Google Calendar / Google Tasks — each opens Google's consent screen and stores the refresh token automatically (`GoogleTokenStore`, no restart needed, `GET /api/oauth/google/status` reports connection state)
- `GMAIL_ENABLED` / `GCAL_ENABLED` / `GTASKS_ENABLED` still need to be `true` at process start for the connector to exist at all — this flow fixes "enabled but missing/expired token", not "never enabled"

**3b. Manual, via OAuth Playground (alternative)** — no dashboard access, or you'd rather not expose a callback endpoint:

- Add `https://developers.google.com/oauthplayground` as an authorized redirect URI on the OAuth client
- Go to [developers.google.com/oauthplayground](https://developers.google.com/oauthplayground)
- Click ⚙️ → check **"Use your own OAuth credentials"** → enter your Client ID + Secret
- Select these scopes:
    - `https://www.googleapis.com/auth/gmail.readonly`
    - `https://www.googleapis.com/auth/calendar.readonly`
    - `https://www.googleapis.com/auth/tasks.readonly`
- **Authorize APIs** → sign in → accept (you will see "This app isn't verified" — click **Continue**, you are a test user)
- **Step 2 → Exchange authorization code for tokens** → copy the `refresh_token`
- Fill in `.env` — the same Client ID, Client Secret, and refresh token work for all three Google connectors:
    ```bash
    GMAIL_CLIENT_ID=...
    GMAIL_CLIENT_SECRET=...
    GMAIL_REFRESH_TOKEN=<token from OAuth Playground>

    GCAL_CLIENT_ID=...        # same values
    GCAL_CLIENT_SECRET=...
    GCAL_REFRESH_TOKEN=<same token>

    GTASKS_CLIENT_ID=...
    GTASKS_CLIENT_SECRET=...
    GTASKS_REFRESH_TOKEN=<same token>
    ```

---

## Ingestion guards (drop the noise before it reaches you)

A deterministic stage between a connector's poll and dispatch. You write **rules**; each rule has structured
**conditions** (ANDed) and **actions**. There is no free-form regex and no LLM in this layer — mail content is
untrusted data, so the guard only compares text and reads metadata.

| Conditions                                                                                                                                                                                                                                   | Actions                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `from` equals / contains / **domain** (subdomains included) · `subject` contains · `snippet` contains (Gmail's 200-character preview, _not_ the full body) · `label` equals (`CATEGORY_PROMOTIONS`…) · `header` present (`List-Unsubscribe`) | **drop** · **tag** (adds a label to `AcediaEvent.tags`) · **set_priority** |

- **Nothing is dropped by default**: with no rule configured, behaviour is unchanged.
- **Never silent**: every dropped event is written to a journal (`guard_filtered.jsonl`, 30 days by default,
  `GUARD_JOURNAL_RETENTION_DAYS`) and can be **restored**. Per-rule hit counters show dead or over-eager rules.
- **The VIP list always wins over a drop** (the existing `vipSenders`).
- **Preview before you commit**: `POST /api/guard/preview` runs candidate rules against recent events and the
  journal and changes nothing.
- **No repeated fetching**: an unread mail stays in the inbox, so LunAcedia remembers what it already decided
  (dispatched, or dropped under the current rules) and does not re-fetch its metadata on every poll.
- Events that pass carry `tags` and `ruleId` (both optional) so you can see which rule touched them; filter with
  `GET /api/events?tag=…`.

Routes: `GET/PUT /api/guard/rules` · `GET /api/guard/journal` · `POST /api/guard/journal/restore` ·
`POST /api/guard/preview`. Design: `docs/adr/ADR-010` in the Lun'Anima repository.

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
