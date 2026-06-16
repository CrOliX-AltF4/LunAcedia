<div align="center">

# ◆ LunAcedia

[![Version](https://img.shields.io/github/v/release/CrOliX-AltF4/LunAcedia?style=flat-square&color=C8A415)](https://github.com/CrOliX-AltF4/LunAcedia/releases)
[![License](https://img.shields.io/badge/license-MIT-333333?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/CrOliX-AltF4/LunAcedia/ci.yml?style=flat-square&label=CI)](https://github.com/CrOliX-AltF4/LunAcedia/actions)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-555555?style=flat-square)](https://github.com/CrOliX-AltF4/LunAcedia/pkgs/container/lunacedia)

**sources → facts → actions → clients**

_A standalone information infrastructure server. Aggregates events from GitHub, Email, Calendar, Tasks, RSS and Home Assistant — pushes them to connected clients over WebSocket and REST, executes actions back on the sources, and optionally synthesizes summaries via a configurable AI provider._

</div>

---

## What it does

LunAcedia polls your information sources on a schedule, deduplicates events with a 7-day TTL, and broadcasts structured `AcediaEvent` objects to all connected clients.

```
GitHub ──┐
Gmail  ──┤                          ┌── Natsume (AI companion) — WS + AI bridge
GCal   ──┼──► IngestionHub ──WS──► ├── LunAvaritia (mobile app) — REST API
Tasks  ──┤    + EventStore          └── Any WebSocket or HTTP client
RSS    ──┤
HA     ──┘

                     Actions back: reply email · complete task · update event
                     AI layer: butler (openai/ollama) or delegate to Natsume
```

**Design rules:**

- Connectors classify by **rules only** — no LLM inside the connector layer
- `AcediaEvent` carries **facts**: title, source, priority, dedupeKey — no interpretation
- Interpretation belongs to the consumer (Natsume) or the optional AI butler layer
- **Asymmetry**: Natsume knows LunAcedia; LunAcedia does not know Natsume

> "Acedia" — the sin of sloth, of letting information pile up unread. LunAcedia makes sure nothing slips through. Part of the [Lun ecosystem](https://github.com/CrOliX-AltF4).

---

## Quick start

### Docker (recommended)

```bash
docker run -d \
  --name lunacedia \
  -p 4000:4000 \
  -p 4001:4001 \
  --env-file .env \
  ghcr.io/crolix-altf4/lunacedia:latest
```

### From source

```bash
git clone https://github.com/CrOliX-AltF4/LunAcedia.git
cd LunAcedia
npm install
cp .env.example .env   # fill in your credentials
npm run build
npm start
```

---

## Connectors

| Connector      | Env flag         | What it polls                                |
| -------------- | ---------------- | -------------------------------------------- |
| GitHub         | `GITHUB_ENABLED` | Notifications API + failed CI check-runs     |
| Gmail          | `GMAIL_ENABLED`  | Unread INBOX via Gmail REST API (OAuth2)     |
| GCal           | `GCAL_ENABLED`   | Upcoming events via Google Calendar (OAuth2) |
| Google Tasks   | `GTASKS_ENABLED` | Due tasks via Google Tasks API (OAuth2)      |
| RSS            | `RSS_ENABLED`    | RSS 2.0 + Atom feeds, zero dependencies      |
| Home Assistant | `HA_ENABLED`     | State changes via HA REST API                |

### Actions

Connectors that support it can execute actions back on the source:

| Connector       | Action `kind` | Effect                                              |
| --------------- | ------------- | --------------------------------------------------- |
| Gmail           | `reply`       | Sends a reply in the same thread                    |
| Google Tasks    | `complete`    | Marks a task as completed                           |
| Google Calendar | `update`      | Patches event fields (title, description, location) |

```http
POST /api/actions
Authorization: Bearer <ACEDIA_SECRET>
{ "connector": "Gmail", "action": { "kind": "reply", "sourceId": "<threadId>", "body": "On it!" } }
```

---

## WebSocket protocol

Connect to `ws://localhost:4000` (add `Authorization: Bearer <ACEDIA_SECRET>` header if auth is enabled).

Every event is a JSON-serialized `AcediaEvent`:

```typescript
{
  type:      "github.push" | "email.received" | "calendar.upcoming" | "tasks.due" | "rss.item" | ...
  ts:        number          // Unix ms
  source:    "github" | "email" | "calendar" | "tasks" | "rss" | "ha" | "system"
  title:     string
  body?:     string
  url?:      string
  priority:  "urgent" | "normal" | "info"
  dedupeKey: string          // stable across polls — use for client-side dedup
  meta?:     Record<string, unknown>
}
```

The server sends `{"type":"ping"}` every 30 seconds as a heartbeat.

---

## REST API

`HTTP_PORT` (default `4001`) — all routes require `Authorization: Bearer <ACEDIA_SECRET>` except `/api/health`.

### Events

| Method | Route                    | Description                                                                   |
| ------ | ------------------------ | ----------------------------------------------------------------------------- |
| `GET`  | `/api/health`            | Server status, uptime, connector list, AI mode (no auth)                      |
| `GET`  | `/api/events`            | Paginated event list (`?source=` `?priority=` `?since=` `?limit=` `?offset=`) |
| `GET`  | `/api/events/:dedupeKey` | Single event by deduplication key                                             |
| `GET`  | `/api/stats`             | Event counts by source                                                        |

### Actions

| Method | Route          | Body                                             |
| ------ | -------------- | ------------------------------------------------ |
| `POST` | `/api/actions` | `{ connector: string, action: ConnectorAction }` |

### AI butler

Available when `AI_PROVIDER` is not `none`.

| Method | Route         | Description                                                                    |
| ------ | ------------- | ------------------------------------------------------------------------------ |
| `POST` | `/api/chat`   | `{ text: string }` → `{ response: string }` — free chat with the butler        |
| `GET`  | `/api/digest` | `?limit=20` → `{ response: string, count: number }` — synthesize recent events |

### Push notifications (FCM)

| Method   | Route                     | Body                                             |
| -------- | ------------------------- | ------------------------------------------------ |
| `POST`   | `/api/devices/push-token` | `{ token: string }` — register Android FCM token |
| `DELETE` | `/api/devices/push-token` | Unregister current token                         |

---

## AI butler

LunAcedia can optionally synthesize events and answer questions via a configurable AI provider.

| `AI_PROVIDER`    | Behaviour                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `none` (default) | No AI — `/api/chat` and `/api/digest` return 503                                            |
| `openai`         | GPT-4o-mini (configurable via `AI_MODEL`)                                                   |
| `ollama`         | Local Ollama instance (configurable via `OLLAMA_URL` and `AI_MODEL`)                        |
| `natsume`        | Delegates to Natsume Core `/api/core/synthesize` — uses Natsume's LLM, LTM, and personality |

The butler system prompt is loaded from `characters/butler.json` (configurable). Default: formal, concise, fact-focused.

---

## Configuration

All configuration is via environment variables. See [`.env.example`](.env.example) for the full reference.

### Core

| Variable        | Default   | Description                              |
| --------------- | --------- | ---------------------------------------- |
| `PORT`          | `4000`    | WebSocket server port                    |
| `HTTP_PORT`     | `4001`    | HTTP REST API port                       |
| `ACEDIA_SECRET` | _(empty)_ | Bearer token for auth (empty = disabled) |

### Connectors

| Variable         | Default | Description             |
| ---------------- | ------- | ----------------------- |
| `GITHUB_ENABLED` | `false` | Enable GitHub connector |
| `GMAIL_ENABLED`  | `false` | Enable Gmail connector  |
| `GCAL_ENABLED`   | `false` | Enable GCal connector   |
| `GTASKS_ENABLED` | `false` | Enable Tasks connector  |
| `RSS_ENABLED`    | `false` | Enable RSS connector    |
| `HA_ENABLED`     | `false` | Enable Home Assistant   |

### AI butler

| Variable              | Default                    | Description                                 |
| --------------------- | -------------------------- | ------------------------------------------- |
| `AI_PROVIDER`         | `none`                     | `none` \| `openai` \| `ollama` \| `natsume` |
| `AI_MODEL`            | `gpt-4o-mini` / `llama3.2` | Model name (openai/ollama only)             |
| `OPENAI_API_KEY`      | _(required if openai)_     | OpenAI API key                              |
| `OLLAMA_URL`          | `http://localhost:11434`   | Ollama base URL                             |
| `NATSUME_CORE_URL`    | _(required if natsume)_    | Natsume Core URL (e.g. `http://nas:3333`)   |
| `NATSUME_CORE_SECRET` | _(required if natsume)_    | Natsume Core bearer token (`ADMIN_SECRET`)  |

### Push (FCM)

| Variable                       | Default         | Description                         |
| ------------------------------ | --------------- | ----------------------------------- |
| `FIREBASE_PROJECT_ID`          | _(empty)_       | Firebase project ID                 |
| `FIREBASE_SERVICE_ACCOUNT_KEY` | _(empty)_       | Base64-encoded service account JSON |
| `ACEDIA_FCM_FILTER`            | `urgent,normal` | Priority levels that trigger push   |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add a connector or fix a bug.

---

## License

[MIT](LICENSE) — CrOliX-AltF4
