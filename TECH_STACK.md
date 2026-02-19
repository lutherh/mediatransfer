# MediaTransfer — Tech Stack Overview

Locally-run tool that transfers assets from one cloud to another. All components (API, database, job queue) run on the user's local machine via Docker Compose — nothing is deployed to the cloud.

---

## Backend — Node.js (TypeScript)

| Component | Technology | Why |
|---|---|---|
| Runtime | **Node.js 20+ (LTS)** | Excellent for streaming I/O — perfect for downloading/uploading large media files between clouds |
| Language | **TypeScript** | Type safety across cloud provider SDKs, better refactoring as provider integrations grow |
| Framework | **Fastify** | Lightweight, high-performance HTTP framework; built-in streaming support for large file transfers |
| Job Queue | **BullMQ** (backed by **Redis**) | Handles long-running transfer jobs asynchronously with retries, progress tracking, rate limiting, and concurrency control |
| Cloud SDKs | **@google-cloud/storage**, **@aws-sdk/client-s3**, **@azure/storage-blob**, **scw-sdk** etc. | Native Node.js SDKs with streaming support for each cloud provider |
| Validation | **Zod** | Runtime schema validation for API inputs and config |
| Logging | **Pino** | Fast, structured JSON logging — important for debugging transfer pipelines |

## Database — PostgreSQL 16

| Concern | Detail |
|---|---|
| ORM | **Prisma** — Type-safe queries, auto-generated migrations, great TS integration |
| What to store | Transfer jobs, history/audit log, cloud credentials (encrypted), user settings, file manifests |
| Why Postgres | JSONB for flexible per-provider metadata, strong transaction support for job state management |

## Frontend (optional, if needed)

| Component | Technology |
|---|---|
| Framework | **React + Vite** |
| UI Library | **shadcn/ui** (Tailwind-based) |
| State/Data | **TanStack Query** for async server state |

## Infrastructure / Supporting Services

| Component | Technology | Why |
|---|---|---|
| Cache / Queue Backend | **Redis** | Backs BullMQ; also useful for caching auth tokens and rate-limit counters |
| Containerization | **Docker + Docker Compose** | Bundles Node app + Postgres + Redis — the primary way to run the entire tool locally |
| Testing | **Vitest** | Fast, native TS/ESM support, compatible with Node.js streams |
| CI/CD | **GitHub Actions** | Standard pipeline for lint → test → build (no cloud deployment — tool runs locally) |

## Where Java Fits — Optional Companion Service

If any cloud provider only offers a mature Java SDK (e.g., some enterprise storage or on-prem systems), or if you need a high-throughput parallel processing layer:

| Component | Technology |
|---|---|
| Runtime | **Java 21 (LTS)** with Virtual Threads |
| Framework | **Spring Boot 3** |
| Use case | Dedicated microservice for providers that need Java SDKs, or a batch-processing worker for massive bulk transfers |
| Communication | REST or **gRPC** between Node and Java services |

---

## Architecture at a Glance

```
┌────────────┐     ┌──────────────────┐     ┌────────────┐
│  Frontend   │────▶│  Node.js API      │────▶│ PostgreSQL │
│  (React)    │     │  (Fastify + TS)   │     │  (state)   │
└────────────┘     └──────┬───────────┘     └────────────┘
                          │
                    ┌─────▼─────┐
                    │   BullMQ   │◀──── Redis
                    │  Workers   │
                    └─────┬─────┘
                          │
              ┌───────┬───┼───────┬───────────┐
              ▼       ▼   ▼       ▼           ▼
        ┌────────┐┌────────┐┌────────┐┌──────────┐
        │ Google ││ AWS S3 ││ Azure  ││ Scaleway │
        │ Cloud  ││        ││ Blob   ││ Object   │
        └────────┘└────────┘└────────┘└──────────┘
```

---

## Summary

| Layer | Choice |
|---|---|
| **Primary language** | TypeScript (Node.js) |
| **API** | Fastify |
| **Async jobs** | BullMQ + Redis |
| **Database** | PostgreSQL + Prisma |
| **Frontend** | React + Vite (if needed) |
| **Java** | Spring Boot microservice for providers requiring Java SDKs or bulk batch work |
| **No Python** | ✅ |
