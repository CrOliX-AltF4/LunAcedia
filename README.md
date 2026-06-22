<div align="center">

# ◆ LunAcedia

[![Version](https://img.shields.io/github/v/release/CrOliX-AltF4/LunAcedia?style=flat-square&color=C8A415)](https://github.com/CrOliX-AltF4/LunAcedia/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/CrOliX-AltF4/LunAcedia/ci.yml?style=flat-square&label=CI)](https://github.com/CrOliX-AltF4/LunAcedia/actions)
[![Node](https://img.shields.io/badge/node-%3E%3D20-555555?style=flat-square)](.)
[![License](https://img.shields.io/badge/license-MIT-333333?style=flat-square)](LICENSE)

**sources → facts → actions → clients**

_A standalone information infrastructure server. Polls GitHub, Gmail, Calendar, Tasks, RSS and Home Assistant — deduplicates events, broadcasts them over WebSocket and REST, executes actions back on the sources._

</div>

> [!NOTE]
> Fully standalone — no Natsume dependency required. Natsume can optionally connect as a consumer via the AI butler bridge. Part of the [Lun' ecosystem](https://github.com/CrOliX-AltF4).

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

> See [`.env.example`](.env.example) for the full configuration reference.

---

## What it does

```
GitHub ──┐
Gmail  ──┤                           ┌── Natsume (AI companion)  WebSocket + AI bridge
GCal   ──┼──► IngestionHub ──WS──►  ├── LunAvaritia (mobile)    REST API + push
Tasks  ──┤    + EventStore           └── Any WebSocket / HTTP client
RSS    ──┤
HA     ──┘

             Actions back: reply email · complete task · update event
             AI layer: butler (openai / ollama) or delegate to Natsume
```

**Connectors** — GitHub notifications, Gmail (OAuth2), Google Calendar, Google Tasks, RSS/Atom, Home Assistant — enabled individually via env flags, each classified by rules, never by LLM

**Events** — Structured `AcediaEvent` objects: type, source, priority, dedupeKey, body — 7-day TTL, stable dedup key across polls

**Actions** — Reply to emails, complete tasks, update calendar events — triggered via `POST /api/actions`

**AI butler** — Optional synthesis layer: `openai`, `ollama`, or `natsume` (delegates to Natsume Core with shared LTM and personality)

**Push notifications** — FCM integration: register Android tokens, filter by priority, deliver via Firebase

**Clients** — WebSocket on `:4000`, HTTP REST on `:4001`, all routes bearer-protected

> "Acedia" — the sin of sloth, of letting information pile up unread. Part of the [Lun ecosystem](https://github.com/CrOliX-AltF4).

---

## Design rules

- Connectors classify by **rules only** — no LLM inside the connector layer
- `AcediaEvent` carries **facts**: title, source, priority — no interpretation
- Interpretation belongs to the consumer (Natsume) or the optional AI butler
- **Asymmetry**: Natsume knows LunAcedia; LunAcedia does not know Natsume

---

## Lun ecosystem

| Project                                                    | Role                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| [LunIra](https://github.com/CrOliX-AltF4/LunIre)           | AI dev pipeline — intent → code                           |
| **LunAcedia**                                              | Information infrastructure — events · actions · AI butler |
| [LunAvaritia](https://github.com/CrOliX-AltF4/LunAvaritia) | Mobile companion — Android                                |
| [LunGula](https://github.com/CrOliX-AltF4/LunGula  )       | Imitation learning — gameplay → ONNX policy               |
| LunAnima                                                   | AI companion core — private                               |

---

<div align="center">

Built by **[CrOliX-AltF4](https://github.com/CrOliX-AltF4)** · MIT License · © 2026

_Part of the [Lun' ecosystem](https://github.com/CrOliX-AltF4)._

</div>
