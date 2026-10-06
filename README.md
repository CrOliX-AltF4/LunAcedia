<div align="center">

# ◆ Lun'Acedia

[![Version](https://img.shields.io/github/v/release/CrOliX-AltF4/LunAcedia?style=flat-square&color=C8A415)](https://github.com/CrOliX-AltF4/LunAcedia/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/CrOliX-AltF4/LunAcedia/ci.yml?style=flat-square&label=CI)](https://github.com/CrOliX-AltF4/LunAcedia/actions)
[![Node](https://img.shields.io/badge/node-%3E%3D20-555555?style=flat-square)](.)
[![License](https://img.shields.io/badge/license-MIT-333333?style=flat-square)](LICENSE)

**sources → facts → actions → clients**

_A headless server for your inbox and your day. It gathers GitHub, Gmail, Calendar, Tasks, RSS and Home Assistant into one box, lets you act on each item at its source, and runs an agent that sorts, answers and proposes — never writing anything without your confirmation._

</div>

> [!NOTE]
> **Status: in development.** Fully standalone: a REST API, a WebSocket stream and a built-in web dashboard, nothing
> else required. Official clients: [Lun'Avaritia](https://github.com/CrOliX-AltF4/LunAvaritia) (Android) and the
> dashboard; it can also be wired to an optional hub. Part of the [Lun' ecosystem](https://github.com/CrOliX-AltF4).

---

## Quick start

```bash
# Docker (recommended) — the image keeps its data in /data: mount a volume there
docker run -d --name lunacedia -p 4000:4000 -p 4001:4001 \
  -v lunacedia-data:/data --env-file .env ghcr.io/crolix-altf4/lunacedia:latest

# From source
git clone https://github.com/CrOliX-AltF4/LunAcedia.git
cd LunAcedia && npm install
cp .env.example .env   # fill in credentials
npm run build && npm start
```

Open `http://localhost:4001`: the dashboard shows the box, lets you act on it, pair a phone and set the agent. The box,
the topics, the pending actions and the paired devices live in `STORAGE_DIR` — keep it on a volume.

> [`.env.example`](.env.example) is the full configuration reference.

---

## What it does

```
GitHub ──┐                                  ┌── Dashboard        built-in, :4001
Gmail  ──┤                                  ├── Lun'Avaritia     Android app
GCal   ──┼──► guards ──► the box ──► API ───┼── an optional hub  WebSocket + REST
Tasks  ──┤               + agent            └── any HTTP/WS client
RSS    ──┤
HA     ──┘          gestures and actions go back to the sources
```

**The box** — what is in your inbox at the source, read and unread: `GET /api/inbox`. Your gestures act **at the
source** and the box follows: open (the full text, marked read in Gmail), read / unread, archive, trash, spam, restore from
Gmail's trash, done (a GitHub notification, a Google task) — `POST /api/inbox/:key/:gesture`, `GET /api/inbox/trash`,
`POST /api/inbox/trash/:id/restore`. The box is reconciled with the sources every minute and clients are told what
changed. Gestures are your own hand: they run directly, and are journaled (`GET /api/inbox/journal`).

**Connectors** — GitHub notifications, Gmail (OAuth2), Google Calendar, Google Tasks, RSS/Atom, Home Assistant —
enabled one by one, classified by rules, never by a model.

**Actions** — 26 kinds through `POST /api/actions`: Gmail (reply, archive, trash, mark read/unread, spam / not spam,
star / unstar, add / remove a label by name, a **batch** on every mail of the box that matches, a **rule** for the mails
to come), Calendar
(create/update/delete an event), Tasks (create/complete/delete), GitHub (comment, label, create/close an issue, open a
PR, merge a PR, mark a notification read). Each kind has a tier (`GET/PATCH /api/config/tiers`):

- **auto** — runs at once;
- **confirm** — waits for you (the default for everything);
- **manual** — never runs through the API. `merge_pr` is manual for good.

**Pending actions** — what waits for your confirmation is kept on disk and survives a restart. Each kind has its own
delay: 2 hours for what goes stale or undoes something (a reply, a comment, a deletion, a closing, a PR), a day for what
plans (an event, a task, an issue). `GET /api/actions/pending` lists them with a summary in words, their deadline, who
proposed them and whether a third party's text came first; `POST /api/actions/:id/confirm|cancel` decides. At
confirmation the tier is read again, and a failure at the source says why. A new pending action is pushed to the phone.

**Agent** — `POST /api/agent` answers a request in natural language ("what urgent mail haven't I read?", "archive the
first one") with native tool calling: it searches the box, reads an item in full, finds free slots, and acts **only**
through the tier gate. Every tool argument is checked against the capability manifest (`source/capabilities/`);
`merge_pr` is never built from model output; once it has read a third party's text (a mail body…), every action it
proposes waits for your confirmation, whatever its tier. Bounded to 6 steps, 20 s and 3 actions per request.
**Two switches** (`GET|PUT /api/agent/settings`, also on the dashboard): the agent itself (off = no tool is ever
called) and its **writes** (off = it reads, sorts and may propose a reply; on = it may propose every write, always confirmed). A phone can
only turn the agent off. `GET /api/agent/journal` lists the last runs. Needs a model with tool calling (OpenAI, or
Ollama with a tool-capable model).

**Topics** — the pocket app's conversations, kept server side: one conversation is one topic to deal with.
`POST /api/conversations` opens one (optionally about a box item), `POST /api/conversations/:id/messages` follows up,
`GET` lists and pages, `PATCH` renames or archives, `DELETE` removes (journaled). Each turn is answered by the agent
with the earlier turns, so a follow-up makes sense; older turns are summarised, never silently dropped.

**Paired devices** — a phone never holds the server's secret. From the dashboard (**Appareils**), ask for a pairing
code (8 characters, one use, 10 minutes) and type it in the app; the phone gets its own token (only its SHA-256 is
kept), which opens the mobile routes only. Revoke a device and its token is refused at once; a device silent for 90
days is revoked automatically.

**Ingestion guards** — deterministic rules that drop, tag or re-prioritise the noise before it reaches the box, or act
on it in Gmail itself (see below).

**Batches** — `bulk_email` applies one sorting action to every mail of the box that matches structured criteria
(exact sender, sender containing, domain, subject containing — ANDed, never empty). LunAcedia computes and freezes the
selection when the batch is proposed — at most 200 mails, with how many matched — and a batch always waits for your
confirmation, whatever its tier. `POST /api/inbox/select` previews a selection without acting.

**Calendar conflicts** — overlapping events emit `calendar.conflict`; `GET /api/calendar/free-slots` computes open
gaps without a model; `GET /api/proposals` names a real free slot when proposing a fix.

**AI butler** — Lun'Acedia's own model (`openai` or `ollama`), set from the dashboard's onboarding screen. It powers
the agent, `GET /api/digest` and `GET /api/proposals`.

**LLM spend** — every call of its model is measured by day, caller, purpose and model, with an estimated cost
(`GET /api/usage`, dashboard **Dépense LLM**), alert thresholds per day and per caller, and an unusual-spend alert.
Nothing is ever cut for a cost.

**Push notifications** — FCM: a paired phone registers its token; new items within its priority filter, and pending
actions, are pushed to it.

---

## Configuration

### Minimal start (GitHub and RSS, no model)

```bash
GITHUB_ENABLED=true
GITHUB_TOKEN=ghp_...
GITHUB_WATCHED_REPOS=*

RSS_ENABLED=true
RSS_FEEDS='["https://hnrss.org/frontpage"]'

AI_PROVIDER=none
```

With `AI_PROVIDER=none` (the default), the box, the gestures, the actions, the API and the dashboard all work; only the
agent, the topics, the digest and the proposals answer `503 AI not configured`.

### Clients

| Client                                                      | How to connect                   | Best for                                     |
| ----------------------------------------------------------- | -------------------------------- | -------------------------------------------- |
| Built-in dashboard                                          | Open `http://host:4001`          | Everything, from a browser                   |
| [Lun'Avaritia](https://github.com/CrOliX-AltF4/LunAvaritia) | Server address + pairing code    | The box, topics and confirmations, on the go |
| An optional hub                                             | WebSocket `:4000` + REST, secret | A personal assistant on top of the box       |
| `curl` / any HTTP client                                    | `GET http://host:4001/api/inbox` | Scripts, automation                          |

All routes are bearer-protected (`ACEDIA_SECRET`); a paired device's token opens only the mobile routes.

### Google OAuth (Gmail · Calendar · Tasks)

Lun'Acedia uses **refresh tokens** — no browser interaction at runtime once connected.

**1. Create an OAuth 2.0 app** — [console.cloud.google.com](https://console.cloud.google.com) → your project →
**OAuth consent screen** (User type: **External**, add your account under **Audience**) → **Credentials → OAuth client
ID** (type **Web application**). Note the **Client ID** and **Client Secret**.

**2. Enable the APIs** — Gmail API, Google Calendar API, Google Tasks API.

**3a. Connect from the dashboard (recommended)**

- Add `http://<your-host>:<HTTP_PORT>/api/oauth/google/callback` as an authorized redirect URI.
- Fill in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
- Dashboard → **⚙ Réglages** → **Connecter** next to Gmail / Google Calendar / Google Tasks: each refresh token is
  stored automatically, no restart (`GET /api/oauth/google/status`).
- `GMAIL_ENABLED` / `GCAL_ENABLED` / `GTASKS_ENABLED` must still be `true` at start for the connector to exist.

**3b. Manual, via the OAuth Playground**

- Add `https://developers.google.com/oauthplayground` as a redirect URI, open the
  [OAuth Playground](https://developers.google.com/oauthplayground), ⚙️ → **Use your own OAuth credentials**.
- Scopes — the same as the dashboard asks for: `gmail.readonly`, `gmail.send`, `gmail.modify`, `calendar.readonly`,
  `calendar.events`, `tasks` (all under `https://www.googleapis.com/auth/`).
- **Authorize APIs** → **Exchange authorization code for tokens** → copy the `refresh_token`.
- The same Client ID, Client Secret and refresh token go into `GMAIL_*`, `GCAL_*` and `GTASKS_*`.

### Ingestion guards

A deterministic stage between a connector's poll and the box. You write **rules**; each has structured
**conditions** (ANDed) and **actions**. No free-form regex and no model here — mail content is untrusted data, so the
guard only compares text and reads metadata.

| Conditions                                                                                                                                                                                                                            | Actions                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `from` equals / contains / **domain** (subdomains included) · `subject` contains · `snippet` contains (Gmail's 200-character preview, not the body) · `label` equals (`CATEGORY_PROMOTIONS`…) · `header` present (`List-Unsubscribe`) | **drop** · **tag** · **set_priority** · **at the source**: archive, trash, spam, mark read, star, label |

- **Nothing is dropped by default.**
- **Never silent**: every dropped event is journaled (`guard_filtered.jsonl`, 30 days, `GUARD_JOURNAL_RETENTION_DAYS`)
  and can be **restored**; per-rule counters show dead or over-eager rules.
- **The VIP list always wins over a drop** — and a VIP is never archived, trashed or reported by a rule.
- **At the source**: a rule acts in Gmail on each new mail it matches, without asking again — a mail taken out of the
  inbox is neither stored nor announced. Every mail touched is journaled (`GET /api/guard/actions`); a refusal at the
  source leaves the mail in the box. One switch turns every rule's source actions off
  (`PUT /api/guard/source-actions`). The agent may propose a rule (`create_rule`): it always waits for your
  confirmation.
- **Preview before you commit**: `POST /api/guard/preview` runs candidate rules against recent events and changes
  nothing.

Routes: `GET/PUT /api/guard/rules` · `GET /api/guard/journal` · `POST /api/guard/journal/restore` ·
`POST /api/guard/preview` · `GET /api/guard/actions` · `PUT /api/guard/source-actions`.

---

## Architecture

- Connectors classify by **rules only** — no model inside the connector layer.
- Events carry **facts** — title, source, priority — never an interpretation; interpreting belongs to the client or
  the agent.
- **No privileged client**: the REST/WebSocket API is the only contract, and Lun'Acedia knows nothing of who consumes
  it.
- **A write is always confirmed by a human**; a gesture is the human's own hand.

---

## Development

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run format:check # prettier
npm test             # vitest
npm run build
```

Releases are tagged from the version in `package.json`; the Docker image is published to GHCR.

---

## Lun' ecosystem

| Project                                                     | Role                                             | Status         |
| ----------------------------------------------------------- | ------------------------------------------------ | -------------- |
| [Lun'Ira](https://github.com/CrOliX-AltF4/LunIra)           | AI dev pipeline — intent → code                  | Active         |
| **Lun'Acedia**                                              | Your box and your day — events · actions · agent | In development |
| [Lun'Avaritia](https://github.com/CrOliX-AltF4/LunAvaritia) | Lun'Acedia in your pocket — Android              | In development |
| [Lun'Gula](https://github.com/CrOliX-AltF4/LunGula)         | Imitation learning — replays → ONNX model        | Paused         |

---

<div align="center">

Built by **[CrOliX-AltF4](https://github.com/CrOliX-AltF4)** · MIT License · © 2026

</div>
