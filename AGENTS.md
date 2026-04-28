# AGENTS.md — MediaTransfer

Cross-tool guidance for AI coding agents (Claude Code, GitHub Copilot, Codex, Cursor, etc.) working in this repository. This file is the **single entry point**; deeper rules live in the linked docs.

> MediaTransfer is a **locally-run** Google Photos → Scaleway Object Storage → (optional) Immich migration tool. Everything runs on the developer's machine via Docker Compose — nothing is deployed to the cloud.

---

## Authoritative docs (read these first)

| Doc | Purpose |
|-----|---------|
| [LLM_INSTRUCTIONS.md](LLM_INSTRUCTIONS.md) | Coding standards, test rules, workflow constraints |
| [PLAN.md](PLAN.md) | Ordered implementation phases and step status |
| [TECH_STACK.md](TECH_STACK.md) | Approved technologies and versions |
| [README.md](README.md) | Project overview and local setup |

---

## Hard rules (do not violate)

1. **One step at a time.** Complete a single `PLAN.md` step fully — including tests — before starting the next.
2. **Never run `git commit`, `git push`, or any version-control mutation.** The developer handles VCS manually.
3. **Every change ships with tests** (Vitest). `foo.ts` → `foo.test.ts`. Run `npm run lint` and `npx vitest run` before declaring a step done.
4. **No secrets in source.** All credentials live in `.env` (gitignored) and are read via environment variables.
5. **No Python.** Anywhere. For any reason.
6. **No `console.log` in production code.** Use Pino.
7. **Update `PLAN.md`** as steps progress. Add a manual user-verification gate after passing tests.

---

## Tech stack at a glance

- **Runtime:** Node.js `^20.19 || ^22.12 || >=24.0` (ESM, `"type": "module"`)
- **Language:** TypeScript only (`.ts`, no `.js` source). Sole exception: [scripts/local-dev.mjs](scripts/local-dev.mjs) — bootstrap launcher that has to run before `tsx` is available.
- **API:** Fastify 5
- **DB:** PostgreSQL 16 + Prisma 7
- **Queue:** BullMQ + Redis 7
- **Frontend:** React 19 + Vite 8 + Tailwind 4 + TanStack Query/Virtual
- **Validation:** Zod
- **Logging:** Pino
- **Tests:** Vitest + Testing Library

See [TECH_STACK.md](TECH_STACK.md) for the full matrix.

---

## Project layout

```
src/        # Backend (Fastify, BullMQ workers, providers, takeout pipeline)
frontend/   # React 19 + Vite SPA
prisma/     # Prisma schema
scripts/    # Operational TypeScript scripts (takeout, S3↔Immich migration)
plans/      # Numbered tactical plans
data/       # Runtime data (gitignored: takeout, immich volumes)
```

---

## Common commands

```bash
npm run lint            # ESLint — must pass
npx vitest run          # Full test suite
npm run dev             # Local dev (see scripts/local-dev.mjs)
docker compose up -d    # Bring up Postgres + Redis + API
```

---

## Specialized agents

This repo defines specialized subagents in two locations (kept in sync):

- [.github/agents/](.github/agents/) — VS Code Copilot Chat custom agents
- [.claude/agents/](.claude/agents/) — Claude Code subagents

Available agents: `architect`, `debug`, `devops-expert`, `expert-react-frontend-engineer`, `security-reviewer`, `s3-immich-path-verifier`, `orchestrator`.

When in doubt, delegate to the agent whose description matches the task.

---

## Things that bite

- **S3 path namespaces:** MediaTransfer owns `transfers/**` and `_thumbs/**`. Immich owns its own prefix. See `s3-immich-path-verifier` agent before touching either.
- **Takeout state files** in `data/takeout/state*.json` are append-only from the agent's perspective — never rewrite them without an explicit plan and a `.bak` snapshot.
- **HEIC conversion** uses `heic-convert` (pure JS) rather than libvips/sharp HEIC, because Sharp's HEIC support is licensing-restricted.
- **Immich containers** are managed by `docker-compose.immich.yml` (separate from the main `docker-compose.yml`).
