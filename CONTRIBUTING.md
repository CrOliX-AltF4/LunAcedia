# Contributing to LunAcedia

Thank you for contributing! This guide will help you get started quickly and ensure your contribution fits smoothly into the project.

## Table of contents

- [Code of conduct](#code-of-conduct)
- [Quick start](#quick-start)
- [Project structure](#project-structure)
- [Contribution workflow](#contribution-workflow)
- [Adding a connector](#adding-a-connector)
- [Commit conventions](#commit-conventions)
- [Code standards](#code-standards)
- [Tests](#tests)
- [Submitting a PR](#submitting-a-pr)

---

## Code of conduct

This project adheres to the [Contributor Covenant](https://www.contributor-covenant.org/). By contributing, you agree to abide by its terms. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

---

## Quick start

### Prerequisites

- **Node.js** >= 20
- **npm** >= 10
- Git

### Setup

```bash
git clone https://github.com/CrOliX-AltF4/LunAcedia.git
cd LunAcedia
npm install
cp .env.example .env   # fill in your credentials
npm run dev            # starts the server in dev mode
```

Git hooks (pre-commit, commit-msg) are installed automatically via Husky on `npm install`.

### Available commands

| Command                 | Description                       |
| ----------------------- | --------------------------------- |
| `npm run dev`           | Start in development mode (tsx)   |
| `npm run build`         | Compile TypeScript → `dist/`      |
| `npm run start`         | Start compiled server             |
| `npm run typecheck`     | Type-check without emitting files |
| `npm run lint`          | Run ESLint across the project     |
| `npm run lint:fix`      | Lint + autofix                    |
| `npm run format`        | Run Prettier across the project   |
| `npm run format:check`  | Check formatting without writing  |
| `npm test`              | Run tests once                    |
| `npm run test:watch`    | Run tests in watch mode           |
| `npm run test:coverage` | Run tests with coverage report    |

---

## Project structure

```
source/
├── auth/              # Shared OAuth2 token managers (Google)
├── connectors/        # One folder per integration (github/, email/, rss/, calendar/)
│   └── <name>/
│       ├── <name>_connector.ts   # IConnector implementation
│       └── ...                   # helpers (formatter, parser, auth)
├── hub/               # IngestionHub — orchestrates polling + deduplication
├── types/             # AcediaEvent and shared types
├── ws/                # AcediaWsServer — WebSocket broadcast to clients
└── index.ts           # Entry point — wires connectors, hub, server
tests/                 # Mirrors source/ structure
```

---

## Contribution workflow

1. **Fork** the repo and create a branch from `master`:

    ```bash
    git checkout -b feat/my-connector master
    ```

2. **Develop** your feature with atomic commits.

3. **Make sure** all checks pass locally:

    ```bash
    npm run typecheck && npm run lint && npm test && npm run build
    ```

4. **Open a Pull Request** targeting `master`.

---

## Adding a connector

A connector is the standard way to integrate a new data source. Follow this pattern:

1. **Create** `source/connectors/<name>/<name>_connector.ts` implementing `IConnector`
2. **Add** env vars to `.env.example` with `<NAME>_ENABLED=false` guard
3. **Register** in `source/index.ts`: `if (process.env["<NAME>_ENABLED"] === "true") connectors.push(new MyConnector())`
4. **Write tests** in `tests/connectors/<name>/` (mock `fetch` via `vi.stubGlobal`)

**Connector rules (from Jarvis doctrine):**

- Classification by rules only — never call an LLM inside a connector
- `AcediaEvent` carries facts: title, body, url, priority, dedupeKey — no interpretation
- `dedupeKey` must be stable across polls (deterministic from source ID)
- Credentials read from `process.env` — never hardcoded

---

## Commit conventions

This project uses [Conventional Commits](https://www.conventionalcommits.org/).

### Format

```
<type>(<scope>): <short description in lowercase>
```

### Accepted types

| Type       | Usage                           |
| ---------- | ------------------------------- |
| `feat`     | New feature or connector        |
| `fix`      | Bug fix                         |
| `docs`     | Documentation only              |
| `style`    | Formatting, no logic change     |
| `refactor` | Refactoring without fix or feat |
| `test`     | Adding or updating tests        |
| `ci`       | CI/CD                           |
| `chore`    | Maintenance, background tasks   |

The `commit-msg` hook validates the format automatically.

---

## Code standards

- **Strict TypeScript**: `strict: true`, zero `any` without explicit comment
- **ESLint + Prettier**: enforced via pre-commit hook
- **No `console.log`** in production paths — use `console.warn` / `console.error`
- **Imports**: always use `import type` for type-only imports
- **Modules**: native ESM (`"type": "module"`)

---

## Tests

- Framework: **Vitest**
- Tests live in `tests/` mirroring `source/`
- Mock `fetch` at the boundary — never mock connector internals
- New connector = new test file (no exceptions)

```bash
npm run test:coverage   # full coverage report
npm run test:watch      # watch mode during development
```

---

## Submitting a PR

1. Target branch: `master`
2. Fill in the PR template
3. Verify all CI checks pass (typecheck → lint → format → test → build)
4. Request a review from a maintainer

---

Questions? Open a [GitHub Discussion](../../discussions) or an issue with the `question` label.
