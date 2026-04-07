@echo off
cd /d "%~dp0.."

(
  echo [%date% %time%] Pulling latest images...
  docker compose -f docker-compose.immich.yml pull
  echo [%date% %time%] Restarting changed containers...
  docker compose -f docker-compose.immich.yml up -d
  echo [%date% %time%] Done.
) >> scripts\immich-update-log.txt 2>&1
