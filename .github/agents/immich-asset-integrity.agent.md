---
name: 'Immich Asset Integrity'
description: 'Use when: Immich photos/videos fail to load (ENOENT, I/O error, broken thumbnails), suspecting silent data loss after an rclone mount/restart, or auditing whether DB asset rows have matching originals on S3. Distinguishes between transient mount failures, DNS outages, unflushed vfs-cache writes, and genuinely-missing objects.'
tools: [read, execute, search]
---

See [.claude/agents/immich-asset-integrity.md](../../.claude/agents/immich-asset-integrity.md) for the canonical instructions. The two files are kept in sync.
