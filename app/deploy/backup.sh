#!/bin/sh
# Consistent SQLite snapshot (VACUUM INTO), keeps the newest 288 (24 h at 5 min).
# Crontab (as user fiesta):
# */5 * * * * /opt/fiesta/app/deploy/backup.sh
set -eu
DIR=/opt/fiesta/backups
DB=/opt/fiesta/app/data/fiesta.db
mkdir -p "$DIR"
OUT="$DIR/fiesta-$(date -u +%Y%m%dT%H%M%SZ).db"
DB="$DB" OUT="$OUT" node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.DB);
db.prepare("VACUUM INTO ?").run(process.env.OUT);
db.close();
'
# ponytail: filenames are timestamped, so lexical order == age
ls -1 "$DIR"/fiesta-*.db | sort -r | tail -n +289 | while read -r f; do rm -f "$f"; done
