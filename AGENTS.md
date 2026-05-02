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
5. **No `console.log` in production code.** Use Pino.
6. **Update `PLAN.md`** as steps progress. Add a manual user-verification gate after passing tests.
7. **Default to parallel subagents for non-trivial work.** When a task spans multiple independent areas (backend + frontend, multiple files, research + implementation, multi-area review), dispatch specialized subagents (`Explore`, `architect`, `debug`, `expert-react-frontend-engineer`, `security-reviewer`, etc.) in a single tool batch instead of working serially. The user does not need to ask. Skip only for single-file edits, trivial questions, or strictly sequential dependencies.

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

- **S3 path namespaces:** MediaTransfer historically wrote to `transfers/**` (bucket root) while Immich expects everything under `immich/**`. As of 2026-04 the canonical layout is `photosync/immich/{library,upload,s3transfers}/...` — see [.github/agents/s3-immich-path-verifier.agent.md](.github/agents/s3-immich-path-verifier.agent.md) and the repo memory note `s3-immich-layout.md`.
- **macOS S3 mount:** Use the Mac-native NFS mount (`scripts/mount-s3.sh` → `data/immich-s3`) as the single source of truth. The in-container FUSE sidecar (`immich_rclone_s3` → `data/s3-mount`) cannot propagate back through OrbStack on macOS — never bind `data/s3-mount` over an Immich subpath, it will silently shadow real files with an empty directory.
- **rclone writeback cache:** The macOS NFS mount uses rclone writeback caching. Never kill rclone or unmount `data/immich-s3` without giving rclone time to drain its writeback queue (set a generous launchd `ExitTimeOut`); otherwise dirty cache entries can be silently lost before reaching Scaleway. **There is no `vfs/sync` rc method on rclone 1.x** — only `vfs/forget|list|queue|queue-set-expiry|refresh|stats`. `vfs/queue` only inspects the writeback queue, it doesn't block on it. Earlier docs/scripts referencing `vfs/sync` were wrong; rely on graceful shutdown instead. Startup guards must not `cd` into a suspect mount before a bounded liveness probe — stale NFS/FUSE endpoints can hang on `cd`.
- **macOS compose profiles:** `docker-compose.immich.yml` keeps the Linux-only `immich_rclone_s3` / `rclone-cleanup` services behind the `linux` compose profile. `scripts/start-all.sh` unsets `COMPOSE_PROFILES` on macOS; do not reintroduce an unconditional `immich-server depends_on: rclone-s3` edge, or `compose up` will block Immich in `Created` on macOS.
- **Takeout state files** in `data/takeout/state*.json` are append-only from the agent's perspective — never rewrite them without an explicit plan and a `.bak` snapshot.
- **HEIC conversion** uses `heic-convert` (pure JS) rather than libvips/sharp HEIC, because Sharp's HEIC support is licensing-restricted.
- **Immich containers** are managed by `docker-compose.immich.yml` (separate from the main `docker-compose.yml`). Image tags are now pinned by digest in `docker-compose.immich.yml` (2026-04-29). To upgrade Immich, pull the new tag, then re-run digest resolution (`docker inspect <image> --format '{{index .RepoDigests 0}}'`) and update the pin; do not switch back to floating tags.
- **Unknown-date assets** flood the "recent" timeline because their `fileCreatedAt` defaults to upload time. Run [scripts/immich-sink-unknown-date.sh](scripts/immich-sink-unknown-date.sh) after every MediaTransfer import to backdate them to epoch.
- **Immich BullMQ workers can silently half-register.** On 2026-05-02 the microservices process bootstrapped and logged "Immich Microservices is running", but a queue (e.g. `thumbnailGeneration`) was left with `wait>0, active=0` because its BullMQ consumer wasn't pulling jobs. The container stayed `(healthy)` because the existing healthcheck only probes `/api/server/ping`. **A plain `docker restart immich_server` is NOT sufficient** — workers come back half-registered. Use `docker stop` + `docker start`. (Don't use the Redis `CLIENT LIST` worker count as a fault signal on its own — BullMQ consumers connect lazily and disconnect when idle, so `workers=0` for an idle queue is normal.) [scripts/immich-queue-watchdog.sh](scripts/immich-queue-watchdog.sh) detects the actual stall (`wait>1000 && active==0 && !paused`, two consecutive samples) every 5 min via the `uk.4to.mediatransfer.queuewatchdog` LaunchAgent and auto-recovers when `--auto-restart` is enabled (30-min cooldown). Requires `IMMICH_WATCHDOG_API_KEY` in `.env.immich` (Immich Account Settings → API Keys). See `/memories/repo/immich-queue-watchdog.md`.
