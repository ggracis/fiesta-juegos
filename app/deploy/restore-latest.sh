#!/usr/bin/env bash
# Plan B: copy the newest EC2 backup to app/data/fiesta.db on this notebook, then print how to start the server.
# Usage: ./restore-latest.sh ubuntu@3.12.34.56 ~/fiesta.pem     (or env EC2_HOST and KEY)
set -euo pipefail
HOST=${1:-${EC2_HOST:?usage: restore-latest.sh user@host key.pem}}
KEY=${2:-${KEY:?usage: restore-latest.sh user@host key.pem}}
APP="$(cd "$(dirname "$0")/.." && pwd)"
DB="$APP/data/fiesta.db"
# ponytail: backup names are timestamped, so lexical order == age
LATEST=$(ssh -i "$KEY" "$HOST" 'ls -1 /opt/fiesta/backups/fiesta-*.db | sort | tail -n 1')
mkdir -p "$APP/data"
if [ -e "$DB" ]; then
  STAMP=$(date +%Y%m%dT%H%M%S)
  mv "$DB" "$DB.$STAMP.bak"
  for x in -wal -shm; do [ -e "$DB$x" ] && mv "$DB$x" "$DB$x.$STAMP.bak"; done
fi
scp -i "$KEY" "$HOST:$LATEST" "$DB"
IP=$(hostname -I 2>/dev/null | cut -d' ' -f1 || true)
echo "Restored $LATEST -> $DB"
echo "Start:  PORT=3000 ADMIN_PASSWORD=... PANEL_TOKEN=... npm --prefix \"$APP\" start"
echo "Panels: http://${IP:-<notebook-ip>}:3000/play.html?api=http://${IP:-<notebook-ip>}:3000/&token=<PANEL_TOKEN>"
