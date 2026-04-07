@echo off
cd /d "%~dp0.."

REM Ensure Immich mount-check marker files exist (prevents crash loop after updates)
for %%d in (encoded-video thumbs upload library profile backups) do (
  if not exist "data\immich\%%d" mkdir "data\immich\%%d"
  if not exist "data\immich\%%d\.immich" type nul > "data\immich\%%d\.immich"
)

(
  echo [%date% %time%] Pulling latest images...
  docker compose -f docker-compose.immich.yml pull
  echo [%date% %time%] Restarting changed containers...
  docker compose -f docker-compose.immich.yml up -d
  echo [%date% %time%] Done.
) >> scripts\immich-update-log.txt 2>&1
