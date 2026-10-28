# Shift · VPS Transfer — Plan

*(working name)*

Move the projects running on an **old VPS** to a **new VPS** from a website: enter both servers' IP, username and password → press **Start** → your projects are copied, **stopped on the old VPS**, **started on the new VPS**, and checked.

---

## 1. The reliability promise

No tool can honestly promise that every possible server setup will move perfectly. So Shift guarantees something stronger: **the worst case is "nothing changed."**

- The old VPS is **never wiped**. Projects are only stopped, and every file Shift changes there is backed up first.
- **Nothing changes** until the pre-flight checks pass. A red check disables the Start button.
- Each step is **verified** before the next one starts.
- If anything fails, Shift **rolls back automatically** and restarts your projects on the old VPS.

---

## 2. How it works

For you it's just: **fill in both servers → Start → confirm the list of found projects → done.**

```
Browser ──► Shift (runs on your PC: http://localhost:7300)
               │ SSH                 │ SSH
               ▼                     ▼
            OLD VPS ══ rsync ══► NEW VPS        direct (fastest)
               ╚═══ through Shift ═══╝          automatic fallback
```

Nothing has to be pre-installed on either server except SSH. Shift uploads small POSIX `sh` scripts (they run on bash, dash and busybox), runs them, and deletes them afterwards.

| # | Step | Old VPS | Downtime |
|---|---|---|---|
| 1 | Connect, confirm server fingerprints | read-only | – |
| 2 | Scan projects, runtimes, databases, configs | read-only | – |
| 3 | Pre-flight checks | read-only | – |
| 4 | Prepare new VPS (users, runtimes, packages) | untouched | – |
| 5 | Live sync: bulk copy while the old VPS keeps running | read-only | – |
| 6 | Cutover: stop old → final quick sync → databases | **stopped** | starts |
| 7 | Start on new VPS | – | ends |
| 8 | Verify | – | – |
| 9 | Pass → clean up · Fail → automatic rollback | restarted on rollback | – |

Downtime covers only steps 6–7, typically a few seconds to a few minutes. Step 5 repeats until almost nothing is left to copy.

---

## 3. What gets found and moved

The scan merges all these sources into one list of projects, grouped by folder. Each project has a switch to include or exclude it, and everything is pre-selected.

| Kind | Found via | Stopped on old (stays off after reboot) | Started on new |
|---|---|---|---|
| PM2 apps | `pm2 jlist` for every user (nvm installs too) | `pm2 stop`, PM2 boot service disabled | same Node + PM2 versions → `pm2 resurrect`, `startup`, `save` |
| systemd services | custom units (system + user) | `systemctl disable --now` | unit copied → `enable --now` |
| Docker Compose | container labels, `docker compose ls` | `compose stop`, restart policy → `no` | folder + volumes copied, images pulled/built → `up -d` |
| Single Docker containers | `docker inspect` | stop, restart policy → `no` | recreated from a generated compose file |
| Supervisor | supervisor config dirs | stop, `autostart=false` | config copied → `reread` / `update` |
| screen / tmux / nohup scripts | process scan in `/proc` (folder, command, env) | command recorded, then stopped | started the same way, or upgraded to a systemd service (recommended because it survives reboots) |
| Cron jobs | all users' crontabs, `/etc/cron.d` | lines commented out with a marker | installed after the timezone is matched |
| Websites | nginx / Apache / Caddy configs → linked to app ports | web server stopped if moved | configs + SSL certificates copied → config test → reload |
| Databases | MySQL/MariaDB, PostgreSQL, MongoDB, Redis, SQLite | stopped after the apps | dump → restore, **including DB users & passwords** |
| Not running | git repos & project files (`package.json`, `requirements.txt`, `composer.json`, `go.mod`, …) in `/home /root /var/www /opt /srv` | – | copied only |

Shift also moves `.env` files, environment variables of running processes, Linux users/groups (same names, and the same IDs when they're free), deploy keys, `~/.gitconfig` / `~/.npmrc`, the timezone, firewall rules for app ports, and Let's Encrypt certificates. Your SSH login keys are added to the new VPS's existing keys and never replace them.

### Runtime matching (the #1 reason moves break)
- **Exact versions** are read from the old VPS (Node per user/nvm, Python per venv, PHP + extensions, Java, Docker, database versions). The same versions are installed on the new VPS:
  - Node from official builds or nvm
  - Python with `uv`, which can install any version on any distro. Packages are pinned from the old venv.
  - PHP from distro, ondrej or remi repos
  - Databases from their official repos
- **Smart copy:**
  - Same CPU and a compatible system: an exact copy of everything, including dependencies (fastest).
  - Different CPU or system type (e.g. Intel → ARM, Ubuntu → Alpine): the code is copied and dependencies are rebuilt from lockfiles (`npm ci` / `npm rebuild`, `pip`, `docker build` for the new CPU).
- **Databases:**
  - Default: dump/restore, which works across versions and CPUs.
  - Optional fast mode for big databases: data files are pre-copied, then a final quick sync runs while the DB is stopped. This is only allowed when version and CPU match exactly.

---

## 4. Reliability engine

### Hard safety rules
1. Never delete anything on the old VPS.
2. Never touch SSH access on either server. No `sshd_config` edits, the SSH port is never closed, and keys are only ever added to `authorized_keys`, never replaced.
3. Stop old **before** starting new (default). Bots, cron jobs and workers never run twice.
4. Every change on the old VPS is first backed up to `/var/backups/shift/<job>/`, so rollback restores the exact original state.

### Pre-flight gate
✓ green = OK · ⚠ yellow = warning, the plan adjusts · ✗ red = blocks Start
- Free disk on the new VPS ≥ 1.2 × the data to copy. Enough RAM (a temporary swap file is added for heavy installs on small VPSes).
- CPU, OS and runtime differences → rebuild instead of copy where needed
- The ports the apps need are free on the new VPS
- Root or sudo works. Without sudo, Shift runs in "own files only" mode.
- Whether the old VPS can reach the new one directly → decides the transfer mode
- Required tools are present or installable (rsync, ssh, tar, curl)

### Transfer (automatic fallback chain)
1. **Direct:** old VPS → new VPS with rsync over SSH, using a temporary key made only for this job and removed afterwards.
2. **Tunnel:** used if the servers can't reach each other (provider firewall, IPv4/IPv6 mismatch). Same rsync, routed through Shift.
3. **Stream:** a `tar` stream through Shift, if tunnels are disabled on the server.
4. **SFTP:** the last resort. It needs nothing but SSH.

rsync keeps permissions, owners, symlinks and hard links (plus ACLs/xattrs where supported). It resumes after interruptions, and a speed limit keeps the old apps fast during live sync.

### Crash-proof & resumable
- Every step is **idempotent** (safe to run twice) and **checkpointed** in a local job file. The job file never contains passwords.
- Long tasks (copying, dumps, installs) run **detached on the server**, each with its own log and exit-code file. If your PC sleeps or Wi-Fi drops, they keep going. Shift reconnects and continues from the last checkpoint. If Shift itself was restarted, you re-enter the passwords first.
- Lock files stop two migrations from running on the same servers. Every step has SSH keepalives, timeouts and retries.

### Verification
| Check | Must be true |
|---|---|
| Files | checksum comparison (`rsync --checksum --dry-run`) shows 0 differences |
| Databases | same databases & tables, same row counts, restore had no errors |
| Services | systemd active · PM2 online · containers running/healthy |
| Stability | no crash/restart loop for 60 s |
| Ports | same ports listening as on the old VPS |
| Websites | each app and domain returns the same HTTP status as on the old VPS. Domains are tested via the `Host` header, before any DNS change. |
| Logs | no new fatal errors (`EADDRINUSE`, `MODULE_NOT_FOUND`, `ImportError`, permission denied, …) |
| From outside | public ports are reachable from the internet (catches firewalls set in the provider's control panel) |

### Rollback
- Runs automatically when any critical check fails (on by default), or with one button at any time later.
- Order: stop what was started on the new VPS → restore the backed-up configs on the old VPS → re-enable and restart in reverse order → verify the old VPS is healthy.
- Late rollback (the new VPS has already received new data): an optional reverse sync copies that data back first.

### Real-world pitfalls handled
| Pitfall | Handling |
|---|---|
| Fresh Ubuntu: `apt` locked by auto-updates / cloud-init | wait for the lock, then retry |
| Interactive prompts (`needrestart`, config questions) | fully non-interactive installs |
| `pm2` / `node` "not found" over SSH (nvm, volta, pyenv, asdf, bun) | per-user install paths detected |
| Login shell is zsh/fish | everything runs through `/bin/sh` scripts |
| Docker `restart: always` comes back after the old VPS reboots | restart policy set to `no` (restored on rollback) |
| Bots/cron running on both servers | stop-before-start + cron lines disabled on old |
| Python venv breaks after the move | venv recreated when the path or version differs |
| Native modules (bcrypt, sharp, sqlite3) on another CPU | rebuilt from the lockfile |
| SQLite DBs or other files changing during the copy | final copy only after the app is stopped |
| SELinux (Rocky/Alma/CentOS) blocks nginx or files | labels restored, required permissions enabled |
| Cloud firewalls (Oracle, AWS, GCP, …) | outside check + exact "open port X in your panel" message |
| App binds port 80/443 without root (`setcap`) | capabilities re-applied |
| Small VPS runs out of RAM during `npm ci` | temporary swap during the install |
| Old IP hardcoded in `.env` / configs | listed, optional replace |
| `sudo` password / `requiretty` | password sent via stdin (never on the command line), PTY when required |
| Old end-of-life OS on the old VPS (CentOS 7, Ubuntu 16.04, …) | old SSH algorithms allowed; nothing has to be installed there (tar/SFTP fallback) |
| Minimal images without rsync | auto-install, else tar/SFTP fallback |

---

## 5. Compatibility
- **OS:** Ubuntu, Debian, RHEL/CentOS/Rocky/AlmaLinux, Fedora, Amazon Linux. Also Alpine (OpenRC), Arch and openSUSE. Moves between different distros work because packages are mapped per distro.
- **CPU:** x86_64 and ARM64, including moves between them.
- **Login:** password, SSH key or 2FA prompt · any SSH port · IPv4/IPv6 · root or sudo user.
- **Your PC:** Windows, macOS or Linux. No `ssh` program is needed because SSH is built in.
- **Not supported:** Windows servers, cPanel/Plesk (use their own migration tools), Kubernetes.

---

## 6. Security
- By default, Shift runs **on your own PC** and listens on `localhost` only, so passwords never go through a third-party site. Hosting it elsewhere requires a login + HTTPS.
- Passwords stay **in memory only**. They are never saved and never logged (logs are auto-redacted).
- In direct mode, your data goes straight from the old VPS to the new VPS.
- Server fingerprints are shown on first connect. This protects against fake servers and man-in-the-middle attacks.
- The temporary transfer key and any temporary sudo rule are removed and **checked to be gone**, even after a failure. Leftovers from an interrupted job are cleaned up on the next run.

---

## 7. Website & animations (macOS / iOS style)

### Look
- Apple's current **Liquid Glass** style: translucent frosted panels with soft light edges, squircle corners and floating controls. Browsers that can't render the full effect get plain frosted glass.
- A macOS window with traffic-light buttons, on a slowly moving gradient wallpaper.
- Light/dark mode follows your system, with a smooth crossfade.
- System font (SF Pro on Apple devices, Inter elsewhere) + Lucide icons. SF Symbols can't be used because their license doesn't allow use on websites.
- On phones the layout switches to iOS style: large titles, bottom sheets and full-width buttons.

### Screens
1. **Welcome:** the icon bounces in like an app launching from the Dock.
2. **Connect:** two glass server cards (Old → New) joined by an animated line. Each has a password eye toggle and a *Test* button: spinner → drawn green check. A wrong password triggers the macOS login **shake**.
3. **Fingerprint confirm:** a macOS sheet slides down from the title bar.
4. **Scan:** an AirDrop-style radar pulse. Found projects drop in one by one (icon, folder, size, runtime, ports, domain), each with an iOS switch. Tap a card to expand it.
5. **Pre-flight:** the checklist ticks itself row by row, like iOS Setup.
6. **Transfer:**
   - Apple Watch-style **activity rings** (Files · Databases · Services)
   - data particles flowing between the servers
   - a **Dynamic Island** pill showing step, speed and time left (tap to expand)
   - a live step timeline
   - a collapsible macOS **Terminal** window with live logs
7. **Done:** the rings close with a spring and a check. Shows a summary, DNS instructions with copy buttons, *Download report* and *Rollback*.
8. **Problem:** a calm explanation, then "Your old VPS is running again" once the rollback is verified.

### Motion rules
- Spring physics everywhere (iOS-like), never linear easing.
- iOS push navigation between screens. Cards morph from one screen to the next (shared-element transitions).
- Controls:
  - buttons shrink slightly on press and lift on hover
  - macOS blue focus glow
  - macOS notification banners
  - iOS switches and segmented controls with a sliding pill
- Only `transform` and `opacity` are animated, for smooth 60–120 fps. The "Reduce motion" setting is respected.

### Wireframes
```
 ● ● ●                     Shift · VPS Transfer
 ╭──────── OLD VPS ────────╮         ╭──────── NEW VPS ────────╮
 │ IP       203.0.113.10   │         │ IP       198.51.100.20  │
 │ Port     22             │  ────►  │ Port     22             │
 │ User     root           │         │ User     root           │
 │ Password ••••••••••     │         │ Password ••••••••••     │
 │      [ Test  ✓ ]        │         │      [ Test  ✓ ]        │
 ╰─────────────────────────╯         ╰─────────────────────────╯
                       [  Start  → ]
                        Advanced ▾
```
```
          ╭─ ◐ Syncing files · 48 MB/s · 2 min left ─╮     ← Dynamic Island
   OLD VPS ●━━━━━━━━  •  •  •  •  •  ━━━━━━━━● NEW VPS
             ◎ Files     ◎ Databases     ◎ Services        ← activity rings
   ✓ Connect  ✓ Scan  ✓ Pre-flight  ◐ Live sync  ○ Cutover  ○ Start  ○ Verify
   ▸ Terminal (live logs)
```

### Advanced options (collapsed, safe defaults)
- **Rehearsal mode:** does everything except stopping the old VPS and starting the new one. It's a risk-free test run and makes the real move faster.
- Cutover order: stop-then-start (default) or start-then-stop (only for apps without their own data).
- Keep websites online during the DNS change: the old VPS forwards visitors to the new one until DNS updates (optional).
- Copy mode: Smart (default), exact copy, or rebuild dependencies.
- screen/nohup scripts: keep as they are, or convert to systemd (recommended).
- Speed limit · Auto-rollback (on) · Replace old IP in configs (ask).

---

## 8. Tech stack
| Part | Choice | Why |
|---|---|---|
| UI | React + TypeScript + Vite + Tailwind CSS + Motion (Framer Motion) | best spring & layout animations |
| Engine | Node.js + TypeScript + Fastify + `ssh2` | SSH written in JavaScript: passwords, keys, 2FA, SFTP, tunnels |
| Live updates | WebSocket | real-time progress, logs and step status |
| Job state | JSON files written atomically (no secrets) | resume after a crash |
| Server side | POSIX `sh` scripts | run on any Linux, nothing to install |
| Run it | `npm install && npm start`, or one `docker run` | opens at `http://localhost:7300` |

```
vps-transfer/
├─ web/                 React UI
│  ├─ screens/          Welcome, Connect, Scan, Preflight, Transfer, Done
│  └─ components/       Window, GlassCard, IOSSwitch, ActivityRings,
│                       DynamicIsland, Sheet, Toast, Terminal
├─ server/              Migration engine
│  ├─ ssh/              connections, exec, sudo, SFTP, tunnels, fingerprints
│  ├─ detect/           os, runtimes, pm2, systemd, docker, supervisor,
│  │                    screen, cron, web, db
│  ├─ steps/            preflight, prepare, sync, cutover, start, verify,
│  │                    rollback, cleanup
│  ├─ engine/           state machine, checkpoints, retries, events
│  ├─ scripts/          sh scripts run on the servers
│  └─ api/              REST + WebSocket
├─ shared/              shared types
└─ Dockerfile
```

---

## 9. How we prove it works
- **Test matrix:**
  - Systems: real VMs (with systemd) running Ubuntu 20.04/22.04/24.04, Debian 11/12, Rocky 9, AlmaLinux 9, Amazon Linux 2023, Alpine and Arch, on x86 and ARM.
  - Sample projects: a PM2 Discord bot, a Python API on systemd, Docker Compose + Postgres, PHP + MySQL + nginx + SSL, a screen script and a cron job.
  - Every sample project is moved between mixed pairs and must come up healthy.
- **Failure tests:** network cut mid-copy, Shift killed mid-cutover, a full disk, a wrong password, a port already taken, an app crashing on the new VPS. Each case must end in **success or a clean, verified rollback. Never data loss.**

---

## 10. Build order
1. SSH core + Connect screen (test, fingerprints, OS detection)
2. Scanner + Scan screen
3. Pre-flight + transfer engine (all 4 modes, resumable)
4. Stop / start / rollback for every project type
5. Verification + report
6. Full macOS/iOS design & animations
7. Test matrix + failure tests, fix everything found
8. Packaging (npm / Docker) + README

---

## 11. What stays manual
- Point your **domain's DNS** to the new IP. Shift shows exactly what to change, and automatic Cloudflare updates can be added.
- Update **IP allow-lists** at outside services (remote DBs, payment/API whitelists). Shift lists the ones it finds.
- Open ports in your **provider's firewall panel** if Shift reports them blocked from outside.
- Delete the old VPS when you're happy. Shift never does.
