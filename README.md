<div align="center">

# ◆ LunAcedia

[![Version](https://img.shields.io/github/v/release/CrOliX-AltF4/LunAcedia?style=flat-square&color=C8A415)](https://github.com/CrOliX-AltF4/LunAcedia/releases)
[![License](https://img.shields.io/badge/license-MIT-333333?style=flat-square)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/CrOliX-AltF4/LunAcedia/ci.yml?style=flat-square&label=CI)](https://github.com/CrOliX-AltF4/LunAcedia/actions)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-555555?style=flat-square)](https://github.com/CrOliX-AltF4/LunAcedia/pkgs/container/lunacedia)

**sources → facts → clients**

_A standalone information infrastructure server. Aggregates events from GitHub, Email, Calendar, RSS and pushes them to any connected client over WebSocket._

</div>

---

## What it does

LunAcedia polls your information sources on a schedule, deduplicates events with a 7-day TTL, and broadcasts structured `AcediaEvent` objects to all connected WebSocket clients.

```
GitHub ──┐
Gmail  ──┤                          ┌── Natsume (AI companion)
GCal   ──┼──► IngestionHub ──WS──► ├── Mobile app
RSS    ──┤    (dedup · dispatch)    └── Any WebSocket client
HA     ──┘
```

**Design rules:**

- Connectors classify by **rules only** — no LLM calls inside LunAcedia
- `AcediaEvent` carries **facts**: title, source, priority, dedupeKey — no interpretation
- Interpretation is the consumer's job (e.g. [Natsume](https://github.com/CrOliX-AltF4/Natsume-Tsurugi))

> "Acedia" — the sin of sloth, of letting information pile up unread. LunAcedia makes sure nothing slips through. Part of the [Lun ecosystem](https://github.com/CrOliX-AltF4).

---

## Quick start

### Docker (recommended)

```bash
docker run -d \
  --name lunacedia \
  -p 4000:4000 \
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

| Connector | Env flag         | What it polls                                |
| --------- | ---------------- | -------------------------------------------- |
| GitHub    | `GITHUB_ENABLED` | Notifications API + failed CI check-runs     |
| Gmail     | `GMAIL_ENABLED`  | Unread INBOX via Gmail REST API (OAuth2)     |
| GCal      | `GCAL_ENABLED`   | Upcoming events via Google Calendar (OAuth2) |
| RSS       | `RSS_ENABLED`    | RSS 2.0 + Atom feeds, zero dependencies      |

Copy `.env.example` to `.env` and enable the connectors you need. Each connector is independently gated.

---

## WebSocket protocol

Connect to `ws://localhost:4000` (or add `Authorization: Bearer <ACEDIA_SECRET>` if configured).

Every event is a JSON-serialized `AcediaEvent`:

```typescript
{
  type:      "github.push" | "email.received" | "calendar.upcoming" | "rss.item" | ...
  ts:        number          // Unix ms
  source:    "github" | "email" | "calendar" | "rss" | ...
  title:     string
  body?:     string
  url?:      string
  priority:  "urgent" | "normal" | "info"
  dedupeKey: string          // stable across polls — use for client-side dedup
  meta?:     Record<string, unknown>
}
```

The server also sends `{"type":"ping"}` every 30 seconds as a heartbeat.

---

## Configuration

All configuration is via environment variables. See [`.env.example`](.env.example) for the full reference.

| Variable         | Default   | Description                              |
| ---------------- | --------- | ---------------------------------------- |
| `PORT`           | `4000`    | WebSocket server port                    |
| `ACEDIA_SECRET`  | _(empty)_ | Bearer token for auth (empty = disabled) |
| `GITHUB_ENABLED` | `false`   | Enable GitHub connector                  |
| `GMAIL_ENABLED`  | `false`   | Enable Gmail connector                   |
| `GCAL_ENABLED`   | `false`   | Enable Google Calendar connector         |
| `RSS_ENABLED`    | `false`   | Enable RSS connector                     |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add a connector or fix a bug.

---

## License

[MIT](LICENSE) — CrOliX-AltF4
