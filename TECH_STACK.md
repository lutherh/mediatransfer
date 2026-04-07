# MediaTransfer — Tech Stack

Local-first tool that migrates a Google Photos library to Scaleway Object Storage. All components run on the user's machine via Docker Compose — nothing is deployed to the cloud.

---

## Backend — Node.js (TypeScript)

| Component | Technology | Why |
|---|---|---|
| Runtime | **Node.js** (`^20.19 \|\| ^22.12 \|\| >=24.0`) | Streaming I/O for downloading/uploading large media between providers |
| Language | **TypeScript** (ESM) | Type safety across provider SDKs and Prisma models |
| Framework | **Fastify 5** | Lightweight HTTP framework with built-in streaming, CORS, rate-limiting, multipart uploads |
| Job Queue | **BullMQ** (backed by **Redis 7**) | Async transfer jobs with retries, progress tracking, rate limiting, concurrency control |
| Google Auth | **google-auth-library** | OAuth 2.0 for Google Photos Picker API and batch download |
| S3 Client | **@aws-sdk/client-s3**, **@aws-sdk/lib-storage** | S3-compatible uploads to Scaleway Object Storage (multipart) |
| Media Processing | **sharp**, **exifr**, **ffmpeg-static**, **heic-convert** | Thumbnail generation, EXIF extraction, video probing, HEIC→JPEG conversion |
| Archive Handling | **tar**, **extract-zip** | Google Takeout `.tgz` / `.zip` extraction |
| Validation | **Zod** | Runtime schema validation for API inputs and config |
| Logging | **Pino** | Structured JSON logging for transfer pipelines |

## Database — PostgreSQL 16

| Concern | Detail |
|---|---|
| ORM | **Prisma 7** — Type-safe queries, auto-generated client, schema-push migrations |
| What it stores | Transfer jobs, file manifests, Google tokens (encrypted), catalog metadata, takeout state |
| Why Postgres | JSONB for flexible per-provider metadata, strong transaction support for job state |

## Frontend — React 19 + Vite 8

| Component | Technology |
|---|---|
| Framework | **React 19** + **Vite 8** |
| Routing | **react-router-dom 7** |
| Styling | **Tailwind CSS 4** with **clsx** / **tailwind-merge** |
| Server State | **TanStack Query 5** |
| Virtualization | **TanStack Virtual 3** (catalog grid) |
| Testing | **Vitest** + **Testing Library** + **jsdom** |

## Infrastructure

| Component | Technology | Why |
|---|---|---|
| Queue Backend | **Redis 7** (Alpine) | Backs BullMQ job queues |
| Containerization | **Docker Compose** | Bundles Node app + Postgres 16 + Redis 7 for local development and production |
| Testing | **Vitest** | Fast, native TS/ESM support, coverage via `@vitest/coverage-v8` |

## Transfer Paths

| Path | Source | Destination | Method |
|---|---|---|---|
| **Picker → S3** | Google Photos Picker API | Scaleway Object Storage | OAuth-authorized download → S3 multipart upload |
| **Takeout → S3** | Google Takeout `.tgz` archives | Scaleway Object Storage | Local extraction → sidecar metadata merge → S3 upload |
| **S3 → Immich** | Scaleway Object Storage | Self-hosted Immich | PowerShell scripts via Immich API |

---

## Architecture

```
┌────────────┐     ┌──────────────────┐     ┌────────────┐
│  Frontend   │────▶│  Node.js API      │────▶│ PostgreSQL │
│  (React 19) │     │  (Fastify 5 + TS) │     │  16        │
└────────────┘     └──────┬───────────┘     └────────────┘
                          │
                    ┌─────▼─────┐
                    │   BullMQ   │◀──── Redis 7
                    │  Workers   │
                    └─────┬─────┘
                          │
                    ┌─────┴─────┐
                    ▼           ▼
              ┌──────────┐┌──────────┐
              │ Google   ││ Scaleway │
              │ Photos   ││ Object   │
              │ API      ││ Storage  │
              └──────────┘└──────────┘
```

---

## Summary

| Layer | Choice |
|---|---|
| **Language** | TypeScript (Node.js, ESM) |
| **API** | Fastify 5 |
| **Async jobs** | BullMQ + Redis 7 |
| **Database** | PostgreSQL 16 + Prisma 7 |
| **Frontend** | React 19 + Vite 8 + Tailwind 4 |
| **Providers** | Google Photos API → Scaleway Object Storage (S3) |
