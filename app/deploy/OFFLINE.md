# Offline runbook (internet drops at the venue)

Two layers. Layer 1 is automatic; Layer 2 (notebook on the venue Wi-Fi) is manual and only for a long outage.

## Layer 1: panels survive a drop by themselves

What the panels do when the server stops answering (a small "Sin conexión" badge shows up top-right):

- The page and its assets come from a service worker cache (works after the panel has loaded `play.html` once online).
- Guests log in with their PIN checked **locally** against a roster the panel downloaded earlier (5 wrong PINs lock that screen for 30 s, same as online).
- El Distinto can be played; **Quiz / Pixel cannot** (their answer key lives on the server) and are hidden while offline.
- Every attempt/result goes into a queue in the panel's `localStorage` (`fiesta.queue`) and is resent in order, forever (retry every 1 s growing to 30 s, plus when the connection returns). Nothing is lost on reload.
- Prizes are **never decided on the panel**. A guest who reaches the prize score sees "¡Superaste el puntaje! Acércate a la acreditación…"; the server assigns the prize when the queue syncs (stock and one-per-guest rules apply). Staff see it in Check-in as usual.
- Over the attempt limit? Offline attempts beyond `maxAttempts` are still recorded (and ranked) but are flagged and **never win a prize**. The first `maxAttempts` attempts to reach the server count.

### Pre-event checklist (do it on EVERY panel, with internet)

1. Open `https://<host>/play.html?setup=1` on the panel's browser (the same browser/profile used for the event, in kiosk mode).
2. Tap **Activar modo sin conexión**, log in with the admin password, you come back to the panel.
3. The strip shows **"N invitados guardados (hh:mm)"**. N must be the number of registered guests so far. The panel refreshes it every 5 min while online, so do this step again after most guests have registered, and once more right before doors open.
4. Remove `?setup=1` (reload `https://<host>/play.html`). Play one round online to confirm.
5. Airplane-mode test: with the page open, turn Wi-Fi off, reload (the page must still load), log in with a real PIN, play, check the result screen. Turn Wi-Fi on; within ~30 s the badge disappears and the attempt shows in Admin > Guests.
6. Staff login cookie lasts 24 h. If the event starts > 24 h after step 2, repeat it, otherwise queued offline items wait (they are not lost) until staff log in again.

## Layer 2: Plan B, a notebook on the venue LAN

Use when the outage is long. The notebook runs the same server with a copy of the DB; panels talk to it over the venue Wi-Fi/router (no internet needed).

### Prepare before the event (with internet)

- Notebook: Node 24, `git clone` of the repo, `npm --prefix app ci`. Same Wi-Fi/router as the panels; note its LAN IP (give it a fixed one or a DHCP reservation).
- Pick a `PANEL_TOKEN` (random string) and write it down. Set the same value in EC2 `/opt/fiesta/app/.env` if you also want panels to reach EC2 cross-origin (optional).
- Test the restore once: `app/deploy/restore-latest.sh ubuntu@<ec2-ip> ~/fiesta.pem` (Windows: `restore-latest.ps1 -Ec2 ubuntu@<ec2-ip> -Key C:\keys\fiesta.pem`).

### Switch to the notebook (EC2 or internet is down)

1. On the notebook: run `restore-latest.sh` / `.ps1` (copies the newest EC2 backup to `app/data/fiesta.db`, keeps the old file aside). It only works while EC2 is reachable; if it is not, restore from the last backup you copied off the box (README step 5) to `app/data/fiesta.db`.
2. Start it: `PORT=3000 ADMIN_PASSWORD=... PANEL_TOKEN=... npm --prefix app start` (do **not** set `NODE_ENV=production`: the staff cookie is `Secure` there and the LAN is plain http).
3. On each panel open `http://<notebook-ip>:3000/play.html?setup=1&token=<PANEL_TOKEN>` (the token is stored and removed from the URL; the roster downloads by itself, the strip shows the guest count). Then open `http://<notebook-ip>:3000/play.html`.
   - Plain http means no service worker there; the page loads from the notebook, which is on the LAN, so that is fine.
   - Alternative that keeps the EC2 page: `https://<host>/play.html?api=http://<notebook-ip>:3000/&token=<PANEL_TOKEN>`. Chrome blocks http calls from an https page, so you must allow "Insecure content" for the EC2 site in the browser's site settings first. `?api=` (empty value) clears it.
4. Staff devices: open `http://<notebook-ip>:3000/admin.html` for admin and check-in while the notebook is the server.
5. From now on **the notebook is the only source of truth**. Do not use EC2 for anything.

### Switch back (internet returns)

Rule: one source of truth at a time.

| What happened | Do this |
|---|---|
| Panels only ran in Layer 1 (never used the notebook) | Nothing. Queues flush to EC2 by themselves (`/api/panel/sync`). Check the badge is gone on every panel. |
| The notebook served any play (Plan B) | **Copy the notebook DB to EC2**, then point panels back to EC2 (below). |

Checklist (the notebook was the server):

1. Stop new play: Admin > Pausar juegos on the notebook. Wait 30 s for panels to flush (badge gone, no "por enviar").
2. Stop the notebook server (Ctrl+C). Copy `app/data/fiesta.db` (the `-wal`/`-shm` files are empty after a clean stop; if not, copy them too).
3. On EC2: `sudo systemctl stop fiesta`, keep the old DB: `sudo -u fiesta mv /opt/fiesta/app/data/fiesta.db{,.pre-notebook}`, put the notebook DB there (`scp`), `sudo chown fiesta:fiesta` it, `sudo systemctl start fiesta`.
4. Open `https://<host>/admin.html`, log in, check counts (guests, attempts, prizes) look like the notebook's. Unpause.
5. On each panel open `https://<host>/play.html` (if you used `?api=`, load `play.html?api=` once to clear it). Panels that still hold queued items from before the switch flush them to EC2 now (idempotent, safe to repeat).
6. Keep `fiesta.db.pre-notebook` and the notebook copy until the event is over.

Known limit: the notebook starts from the newest backup (<= 5 min old). Plays that happened on EC2 in the minutes between that backup and the outage are not in the notebook DB, so if they were never synced they are lost when you copy the notebook DB over EC2. Their guests can simply play again on the notebook (the attempt is not counted there).

## Troubleshooting

- Badge stays on after internet is back: reload `play.html`; queued items are kept in the browser and resent in a few seconds.
- "Sin datos guardados" in `?setup=1`: staff login did not complete (or the token is wrong). Repeat the checklist step 2.
- A panel says "No hay conexión" on PIN entry: it has no roster cached. Needs internet once and the setup step.
- Queue keeps growing while online: staff cookie expired (401). Run the setup step again; nothing is lost.
