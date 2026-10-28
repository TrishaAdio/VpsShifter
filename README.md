# Shift · VPS Transfer

A website that moves your projects (Telegram bots and userbots, websites, APIs, databases) from an **old VPS** to a **new VPS**. It copies them, stops them on the old VPS, starts them on the new one, and checks that they work. If something fails, it restarts everything on the old VPS automatically.

## Run it

You need **Node.js 18 or newer** on your own computer (Windows, macOS or Linux).

```bash
cd vps-transfer
npm install
npm start          # builds the website the first time, then opens on http://localhost:7300
```

Open **http://localhost:7300** and follow the steps:

1. **Get Started**
2. Enter **IP, port, username, password** for both servers, then click **Find my projects**
3. Check that the server fingerprints are yours, then click **Trust & continue**
4. Review the projects Shift found. Everything is selected; untick anything you want to leave behind.
5. Click **Start transfer**
6. When it's done, change your domains' **DNS A record** to the new IP. The summary page lists them.

Options:
- `PORT=8080 npm start` changes the port.
- `HOST=0.0.0.0 SHIFT_PASSWORD=secret npm start` lets other machines reach Shift. Only do this with a password set.

## What it moves

| Type | How it is found | On the new VPS |
|---|---|---|
| PM2 apps (Node, also via nvm) | `pm2 jlist` for each user | same Node + PM2 versions, `pm2 resurrect`, start on boot |
| Scripts in **screen / tmux / nohup** (typical for userbots) | process scan | same command and environment; runs as a systemd service (or keeps running after reboot via cron) |
| systemd services | custom unit files | same unit, enabled and started |
| Docker Compose and single containers | `docker inspect` | volumes copied, images pulled, built or copied, `up -d` |
| Supervisor programs | config files | config installed, programs started |
| nginx / Apache / Caddy sites + SSL certificates | enabled site configs | installed and config-tested, then started |
| MySQL/MariaDB, PostgreSQL, Redis, MongoDB | running servers | dump → restore (including DB users), **row counts compared** |
| Cron jobs | crontabs, `/etc/cron.d` | installed; paused on the old VPS so they never run twice |
| Python venvs / pip packages | each interpreter's package list | same Python version (via `uv`), same package versions |

## Safety

- Nothing is deleted on the old VPS. Projects are only stopped, and every config Shift changes there is backed up first, so rollback restores the exact original state.
- Telegram bots and userbots are fully stopped and checked **before** the new copy starts, so a session is never used from two servers at once.
- Files are compared by checksum after the final copy, and database row counts must match.
- After starting, Shift watches each app for crashes, checks its ports and web pages, and scans its logs.
- Passwords are kept in memory only. They are never saved to disk or written to logs.
- The temporary transfer key and any temporary sudo rule are removed at the end.

## Files

```
server/            Node.js engine (SSH, scan, plan, transfer, cutover, verify, rollback)
server/remote/     POSIX shell scripts that run on the servers (no install needed there)
web/               React website (macOS/iOS style)
data/jobs/         migration history + logs (no passwords)
```
