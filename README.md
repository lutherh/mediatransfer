# mediatransfer
Local tool that transfers assets from one cloud to another. Runs entirely on your machine.

## Run with Docker Compose

Start full stack (API + Postgres + Redis):

```bash
docker compose up --build -d
```

Check API health:

```bash
curl http://localhost:3000/health
```

Stop services:

```bash
docker compose down
```
