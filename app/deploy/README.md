# Deploy on AWS EC2 (t4g.micro, Ubuntu 24.04 ARM64)

Single VM in region **sa-east-1 (Sao Paulo)**: Ubuntu 24.04 arm64 on a `t4g.micro`, Node 24, systemd service `fiesta`, Caddy (HTTPS, 80/443) -> Node server on `127.0.0.1:3000`, backup cron every 5 min. Free `sslip.io` hostname, no domain needed.

If the venue internet can drop, also read **[OFFLINE.md](OFFLINE.md)** (panel offline mode, notebook Plan B, switch-over checklist, `restore-latest.sh` / `.ps1`).

## 1. Launch

1. Switch the console to **sa-east-1**. EC2 > Launch instance: Ubuntu Server 24.04 LTS, **Arm64**, `t4g.micro`, 8-16 GB gp3, your key pair.
2. Security group (inbound only):
   - 22 from **your IP only**
   - 80 and 443 from anywhere
   - **Do not open 3000.** The service also binds to `127.0.0.1` (`HOST` in fiesta.service), so only Caddy can reach it.
3. Allocate an **Elastic IP** and associate it with the instance. Note it, e.g. `3.12.34.56`.
4. Your host is the IP with dashes: `3-12-34-56.sslip.io`.

## 2. Install (SSH in as `ubuntu`)

```sh
# Node 24 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git

# Caddy (official apt repo)
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

## 3. App

```sh
sudo useradd --system --create-home --shell /usr/sbin/nologin fiesta
sudo mkdir -p /opt/fiesta/backups && sudo chown -R fiesta:fiesta /opt/fiesta
sudo -u fiesta git clone https://github.com/ggracis/fiesta-juegos.git /opt/fiesta
cd /opt/fiesta/app
sudo -u fiesta npm ci
sudo -u fiesta npm run build
```

Put the roster (`data/guests.csv`) in `/opt/fiesta/app/data/` if it is not in the repo.

Admin password (never commit it). `PANEL_TOKEN` is **optional**: only needed if panels will call this server cross-origin (OFFLINE.md, Plan B); it also turns on CORS for `/api/*`, so leave it out otherwise.

```sh
echo 'ADMIN_PASSWORD=choose-a-long-password' | sudo -u fiesta tee /opt/fiesta/app/.env
# optional: echo 'PANEL_TOKEN=another-long-random-string' | sudo -u fiesta tee -a /opt/fiesta/app/.env
sudo chmod 600 /opt/fiesta/app/.env
```

## 4. Services

```sh
sudo cp /opt/fiesta/app/deploy/fiesta.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now fiesta

sudo cp /opt/fiesta/app/deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl edit caddy      # add:  [Service]
                               #       Environment=SITE_HOST=3-12-34-56.sslip.io
sudo systemctl restart caddy
```

Check: `https://3-12-34-56.sslip.io/` loads, `systemctl status fiesta` is active.

## 5. Backups (every 5 min, keeps newest 288)

```sh
sudo -u fiesta crontab -e
# */5 * * * * /opt/fiesta/app/deploy/backup.sh
```

Restore: stop `fiesta`, copy a file from `/opt/fiesta/backups/` over `app/data/fiesta.db`, start `fiesta`. Also copy a backup off the box before the event.

## 6. Update

```sh
cd /opt/fiesta && sudo -u fiesta git pull
cd app && sudo -u fiesta npm ci && sudo -u fiesta npm run build
sudo systemctl restart fiesta
```

## Costs

- New-account **Free plan** runs on credits. A public IPv4 (incl. the Elastic IP) and EBS storage both consume credits even when the instance is idle.
- Create a billing alarm / AWS Budget at **US$1** the same day you launch.
- Terminate the instance and release the Elastic IP after the event.

## Pre-event checklist

- [ ] Open the site from a phone on **mobile data** (not Wi-Fi): register, PIN, play.
- [ ] `sudo systemctl restart fiesta`, then confirm admin and panels stay logged in (sessions persist in the DB).
- [ ] Port 3000 is unreachable from outside: `curl http://<elastic-ip>:3000` times out.
- [ ] Cron backup is producing files in `/opt/fiesta/backups/`.
- [ ] Every panel: staff login + "Activar modo sin conexión" done, cached guest count looks right, airplane-mode test passed (OFFLINE.md).
- [ ] Notebook (Plan B) ready: repo + `npm ci`, `restore-latest` tested, `PANEL_TOKEN` chosen.
- [ ] Billing alarm exists.
