import { records, fieldsOf, dec, shq, SCRIPTS } from './ssh.js';
import path from 'node:path';

const posix = path.posix;
const SYSTEM_DIRS = ['/usr/lib/python3/dist-packages', '/usr/lib/python3/site-packages', '/usr/lib64/python', '/usr/lib/python'];

export function parseProbe(text) {
  const r = { hostKeys: [], df: {}, lock: null };
  for (const { type, raw } of records(text)) {
    if (type === 'PROBE') {
      const f = fieldsOf(raw);
      Object.assign(r, {
        id: f[0], like: f[1], ver: f[2], name: f[3] || f[0], arch: f[4], libc: f[5], init: f[6], pm: f[7], hostname: f[8],
        family: f[9], memKB: +f[10] || 0, swapKB: +f[11] || 0, diskKB: +f[12] || 0, cpus: +f[13] || 1,
        tools: (f[14] || '').trim().split(/\s+/).filter(Boolean), uid: +f[15], user: f[16], codename: f[17], rsync: f[18], uptime: f[19],
      });
    } else if (type === 'HOSTKEY') r.hostKeys.push(fieldsOf(raw)[0].trim());
    else if (type === 'DF') { const [d, v] = fieldsOf(raw); const [kb, mnt] = (v || '').split(' '); r.df[d] = { kb: +kb || 0, mount: mnt }; }
    else if (type === 'LOCK') r.lock = fieldsOf(raw)[0].trim();
    else if (type === 'BOOT') r.bootId = fieldsOf(raw)[0].trim();
  }
  return r;
}

function parseKV(content) {
  const out = {};
  let sec = '';
  for (let line of content.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const m = line.match(/^\[(.+)\]$/);
    if (m) { sec = m[1]; continue; }
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    (out[sec] ||= {});
    (out[sec][k] ||= []).push(v);
  }
  return out;
}

/** Split a command line like systemd/sh would (quotes respected). */
export function splitArgs(s) {
  const out = [];
  let cur = '', q = null, any = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") { q = c; any = true; }
    else if (/\s/.test(c)) { if (cur || any) out.push(cur); cur = ''; any = false; }
    else if (c === '\\' && i + 1 < s.length) cur += s[++i];
    else cur += c;
  }
  if (cur || any) out.push(cur);
  return out;
}

function parseEnvAssignments(v) {
  const env = {};
  for (const a of splitArgs(v)) { const i = a.indexOf('='); if (i > 0) env[a.slice(0, i)] = a.slice(i + 1); }
  return env;
}

export function parseUnit(content) {
  const kv = parseKV(content);
  const s = kv.Service || {};
  const first = (k) => (s[k] ? s[k][s[k].length - 1] : '');
  let exec = (s.ExecStart || []).filter(Boolean).pop() || '';
  exec = exec.replace(/^[-@+!:]+/, '');
  const env = {};
  for (const e of s.Environment || []) Object.assign(env, parseEnvAssignments(e));
  return {
    execStart: exec,
    argv: splitArgs(exec),
    workdir: first('WorkingDirectory').replace(/^-/, ''),
    user: first('User') || 'root',
    group: first('Group'),
    env,
    envFiles: (s.EnvironmentFile || []).map((x) => x.replace(/^-/, '').trim()).filter(Boolean),
    restart: first('Restart'),
    type: first('Type') || 'simple',
    description: (kv.Unit?.Description || [''])[0],
  };
}

export function parseSupervisor(content) {
  const kv = parseKV(content);
  const programs = [];
  for (const [sec, v] of Object.entries(kv)) {
    const m = sec.match(/^program:(.+)$/);
    if (!m) continue;
    programs.push({ name: m[1], command: (v.command || [''])[0], directory: (v.directory || [''])[0], user: (v.user || ['root'])[0], autostart: (v.autostart || ['true'])[0] });
  }
  return programs;
}

export function parseNginx(content) {
  const clean = content.replace(/#[^\n]*/g, '');
  const grab = (re) => [...clean.matchAll(re)].map((m) => m[1].trim());
  const words = (arr) => arr.flatMap((x) => x.split(/\s+/)).filter(Boolean);
  const serverNames = words(grab(/\bserver_name\s+([^;]+);/g)).filter((n) => n !== '_' && n !== 'localhost' && !n.startsWith('~'));
  const listens = grab(/\blisten\s+([^;]+);/g);
  const proxies = grab(/\b(?:proxy_pass|uwsgi_pass|grpc_pass)\s+([^;]+);/g);
  const upstreamServers = grab(/\bserver\s+([0-9a-zA-Z.\-\[\]:]+:\d+)[^;]*;/g);
  const ports = new Set();
  for (const p of [...proxies, ...upstreamServers]) {
    const m = p.match(/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|::1):(\d+)/);
    if (m) ports.add(+m[1]);
  }
  const files = new Set();
  for (const k of ['ssl_certificate', 'ssl_certificate_key', 'ssl_trusted_certificate', 'ssl_dhparam', 'auth_basic_user_file', 'include', 'ssl_client_certificate']) {
    for (const v of grab(new RegExp(`\\b${k}\\s+([^;]+);`, 'g'))) {
      const p = v.replace(/^["']|["']$/g, '');
      if (p.startsWith('/') && !p.startsWith('/etc/nginx/') && !p.includes('$')) files.add(p);
      if (p.startsWith('/etc/nginx/snippets/') || p.startsWith('/etc/nginx/conf.d/') || p.startsWith('/etc/nginx/ssl') || p.startsWith('/etc/nginx/certs')) files.add(p);
    }
  }
  const roots = words(grab(/\b(?:root|alias)\s+([^;]+);/g)).filter((p) => p.startsWith('/') && !p.includes('$')).map((p) => p.replace(/\/+$/, '') || '/');
  const fastcgi = grab(/\bfastcgi_pass\s+([^;]+);/g);
  return { serverNames: [...new Set(serverNames)], listens, ports: [...ports], files: [...files], roots: [...new Set(roots)], fastcgi, ssl: listens.some((l) => /443|ssl/.test(l)) };
}

export function parseScan(text) {
  const s = {
    os: {}, passwd: [], groups: [], tz: 'UTC', listens: [], procs: new Map(), tmux: [], pm2: [], pm2Off: [], pm2Boot: {}, pm2Dumps: {},
    units: [], docker: null, supervisor: { confs: [], status: '' }, crons: [], crond: [], nginx: null, apache: { sites: [], mods: [] },
    caddy: null, letsencrypt: [], php: null, phpfpm: [], dbs: [], folders: [], errors: [],
  };
  for (const { type, raw } of records(text)) {
    try {
      switch (type) {
        case 'OS': {
          const f = fieldsOf(raw);
          s.os = { id: f[0], like: f[1], ver: f[2], name: f[3], arch: f[4], libc: f[5], init: f[6], pm: f[7], hostname: f[8], family: f[9], codename: f[10] };
          break;
        }
        case 'PASSWD': {
          const content = dec(raw.split(' ')[1]);
          s.passwd = content.split('\n').filter(Boolean).map((l) => { const p = l.split(':'); return { name: p[0], uid: +p[2], gid: +p[3], home: p[5], shell: p[6] }; });
          break;
        }
        case 'GROUP': {
          const content = dec(raw.split(' ')[1]);
          s.groups = content.split('\n').filter(Boolean).map((l) => { const p = l.split(':'); return { name: p[0], gid: +p[2], members: (p[3] || '').split(',').filter(Boolean) }; });
          break;
        }
        case 'TZ': s.tz = fieldsOf(raw)[0].trim() || 'UTC'; break;
        case 'L': {
          const [addr, port, pids] = raw.split(' ');
          s.listens.push({ addr, port: +port, pids: pids && pids !== '-' ? pids.split(',').map(Number) : [] });
          break;
        }
        case 'P': {
          const f = fieldsOf(raw);
          s.procs.set(+f[0], { pid: +f[0], ppid: +f[1], uid: +f[2], comm: f[3], exe: f[4], cand: !!f[5] });
          break;
        }
        case 'PX': {
          const f = fieldsOf(raw);
          const p = s.procs.get(+f[0]);
          if (p) Object.assign(p, { cwd: f[1], cgroup: f[2], resolved: f[3] });
          break;
        }
        case 'PC': {
          const [pid, b] = raw.split(' ');
          const p = s.procs.get(+pid);
          if (p) p.argv = dec(b).split('\0').filter((x, i, a) => !(i === a.length - 1 && x === ''));
          break;
        }
        case 'PE': {
          const [pid, b] = raw.split(' ');
          const p = s.procs.get(+pid);
          if (p) {
            p.env = {};
            for (const kv of dec(b).split('\0')) { const i = kv.indexOf('='); if (i > 0) p.env[kv.slice(0, i)] = kv.slice(i + 1); }
          }
          break;
        }
        case 'TMUX': { const f = fieldsOf(raw); s.tmux.push({ user: f[0], panePid: +f[1], session: f[2] }); break; }
        case 'PM2': {
          const f = fieldsOf(raw);
          let apps = [];
          const j = f[5] || '';
          const i = j.indexOf('[');
          if (i >= 0) { try { apps = JSON.parse(j.slice(i, j.lastIndexOf(']') + 1)); } catch (e) { s.errors.push('Could not read PM2 list for ' + f[0]); } }
          s.pm2.push({ user: f[0], home: f[1], pm2bin: f[2], nodebin: f[3], version: (f[4] || '').trim(), apps });
          break;
        }
        case 'PM2DUMP': { const [h, b] = raw.split(' '); try { s.pm2Dumps[dec(h)] = JSON.parse(dec(b)); } catch {} break; }
        case 'PM2OFF': s.pm2Off.push(fieldsOf(raw)[0]); break;
        case 'PM2ERR': { const f = fieldsOf(raw); s.errors.push(`PM2 for ${f[0]}: ${f[2]}`); break; }
        case 'PM2BOOT': { const f = fieldsOf(raw); s.pm2Boot[f[0]] = { service: f[1], enabled: !!f[2] }; break; }
        case 'UNIT': {
          const f = fieldsOf(raw);
          s.units.push({ name: f[0], path: f[1], active: f[2], enabled: f[3], mainPid: +f[4] || 0, dropins: f[5], content: f[6], ...parseUnit(f[6] || '') });
          break;
        }
        case 'DOCKERINFO': { const [root, arch, ver] = fieldsOf(raw)[0].split('|'); (s.docker ||= {}).info = { root, arch, version: ver }; break; }
        case 'DOCKER': (s.docker ||= {}).containers = JSON.parse(fieldsOf(raw)[0] || '[]'); break;
        case 'DVOL': (s.docker ||= {}).volumes = JSON.parse(fieldsOf(raw)[0] || '[]'); break;
        case 'DIMG': (s.docker ||= {}).images = JSON.parse(fieldsOf(raw)[0] || '[]'); break;
        case 'SUPCONF': { const [p, b] = raw.split(' '); const c = dec(b); s.supervisor.confs.push({ path: dec(p), content: c, programs: parseSupervisor(c) }); break; }
        case 'SUPSTATUS': s.supervisor.status = fieldsOf(raw)[0]; break;
        case 'CRON': { const [u, b] = raw.split(' '); s.crons.push({ user: dec(u), content: dec(b) }); break; }
        case 'CROND': { const [p, b] = raw.split(' '); s.crond.push({ path: dec(p), content: dec(b) }); break; }
        case 'NGXVER': { const f = fieldsOf(raw); s.nginx = { version: f[0], running: !!f[1], sites: s.nginx?.sites || [] }; break; }
        case 'NGX': {
          const [e, r, b] = raw.split(' ');
          (s.nginx ||= { sites: [] }).sites.push({ enabledPath: dec(e), realPath: dec(r), content: dec(b) });
          break;
        }
        case 'APACHE': { const [e, r, b] = raw.split(' '); s.apache.sites.push({ enabledPath: dec(e), realPath: dec(r), content: dec(b) }); break; }
        case 'APACHEMODS': s.apache.mods = fieldsOf(raw)[0].trim().split(/\s+/).filter(Boolean); break;
        case 'CADDY': { const [, b] = raw.split(' '); s.caddy = { content: dec(b) }; break; }
        case 'LE': s.letsencrypt = fieldsOf(raw)[0].trim().split(/\s+/).filter(Boolean); break;
        case 'PHP': { const f = fieldsOf(raw); s.php = { version: f[0].trim(), modules: f[1].trim().split(/\s+/).filter(Boolean) }; break; }
        case 'PHPFPM': s.phpfpm.push(fieldsOf(raw)[0]); break;
        case 'DB': {
          const f = fieldsOf(raw);
          const db = { engine: f[0], flavor: f[1], version: (f[2] || '').trim(), ok: f[3] === '0', raw: f[4] || '', conf: f[5] || '', databases: [] };
          if (db.ok) {
            for (const line of db.raw.split('\n')) {
              const m = line.trim().match(/^(\S+)\s+(\d+)/);
              if (db.engine === 'redis') { const r = line.match(/^(db\d+):keys=(\d+)/); if (r) db.databases.push({ name: r[1], size: 0, keys: +r[2] }); }
              else if (m && !['admin', 'local', 'config'].includes(m[1])) db.databases.push({ name: m[1], size: +m[2] });
            }
          }
          s.dbs.push(db);
          break;
        }
        case 'FOLDER': s.folders.push(fieldsOf(raw)[0]); break;
      }
    } catch (e) {
      s.errors.push(`Could not read ${type}: ${e.message}`);
    }
  }
  return s;
}

export function parseInspect(text) {
  const r = { dirs: {}, manifests: {}, py: {}, node: {}, authKeys: {}, userSites: [], localSites: [], nvm: {} };
  for (const { type, raw } of records(text)) {
    if (type === 'DIR') {
      const f = fieldsOf(raw);
      r.dirs[f[0]] = { size: +f[1] || 0, owner: f[2], sessions: (f[3] || '').split('|').filter(Boolean), venvs: (f[4] || '').split('|').filter(Boolean),
        locks: (f[5] || '').trim().split(/\s+/).filter(Boolean), env: !!f[6], nodeModulesKB: +f[7] || 0 };
    } else if (type === 'MF') {
      const [d, n, b] = raw.split(' ');
      ((r.manifests[dec(d)] ||= {}))[dec(n)] = dec(b);
    } else if (type === 'PYINFO') {
      const f = fieldsOf(raw);
      const info = { interp: f[0], user: f[1], cwd: f[2], pkgs: [], sites: [] };
      for (const line of (f[3] || '').split('\n')) {
        if (line.startsWith('V=')) info.version = line.slice(2);
        else if (line.startsWith('PREFIX=')) info.prefix = line.slice(7);
        else if (line.startsWith('BASE=')) info.base = line.slice(5);
        else if (line.startsWith('EXE=')) info.exe = line.slice(4);
        else if (line.startsWith('SITE=')) info.sites.push(line.slice(5));
        else if (line.startsWith('PKG=')) {
          const [spec, loc] = line.slice(4).split('|');
          info.pkgs.push({ spec, name: spec.split('==')[0], loc: loc || '' });
        }
      }
      info.venv = info.prefix && info.base && info.prefix !== info.base ? info.prefix : null;
      r.py[`${info.interp}|${info.user}`] = info;
    } else if (type === 'NODEINFO') {
      const f = fieldsOf(raw);
      r.node[f[0]] = { path: f[0], version: (f[1] || '').trim(), prefix: f[2], globals: (f[3] || '').trim().split(/\s+/).filter((x) => x && x !== '@') };
    } else if (type === 'AUTHKEYS') { const [u, b] = raw.split(' '); r.authKeys[dec(u)] = dec(b); }
    else if (type === 'USERSITE') { const f = fieldsOf(raw); r.userSites.push({ user: f[0], path: f[1] }); }
    else if (type === 'LOCALSITE') r.localSites.push(fieldsOf(raw)[0]);
    else if (type === 'NVM') { const f = fieldsOf(raw); r.nvm[f[0]] = f[1]; }
  }
  return r;
}

// ---------------------------------------------------------------- classification

const NODE_TAGS = [
  [/^(telegraf|grammy|node-telegram-bot-api|puregram|@grammyjs\/.*)$/, 'Telegram bot'],
  [/^(telegram|@mtcute\/.*|tdl|airgram)$/, 'Telegram userbot'],
  [/^(discord\.js|eris|oceanic\.js|@discordjs\/.*)$/, 'Discord bot'],
  [/^(whatsapp-web\.js|@whiskeysockets\/baileys|baileys|@adiwajshing\/baileys|venom-bot|@wppconnect-team\/wppconnect)$/, 'WhatsApp bot'],
  [/^(next|nuxt|astro|@remix-run\/.*|gatsby|@sveltejs\/kit|vite|react-scripts)$/, 'Website'],
  [/^(express|fastify|koa|@nestjs\/core|hono|@hapi\/hapi|restify|socket\.io|apollo-server|@apollo\/server|elysia)$/, 'API'],
];
const PY_TAGS = [
  [/^(telethon|pyrogram|pyrofork|hydrogram|kurigram|pyrotgfork|telethon-tgcrypto)$/i, 'Telegram userbot'],
  [/^(aiogram|python-telegram-bot|pytelegrambotapi|telebot|pytgbot)$/i, 'Telegram bot'],
  [/^(discord\.py|discord|nextcord|py-cord|disnake|hikari)$/i, 'Discord bot'],
  [/^(django|flask|fastapi|aiohttp|starlette|sanic|quart|tornado|litestar|uvicorn|gunicorn)$/i, 'API'],
  [/^(streamlit|gradio|dash)$/i, 'Website'],
];

function tagsFor(dir, ins, pyInfo) {
  const tags = new Set();
  const mf = ins.manifests[dir] || {};
  if (mf['package.json']) {
    try {
      const pj = JSON.parse(mf['package.json']);
      const deps = Object.keys({ ...(pj.dependencies || {}), ...(pj.devDependencies || {}) });
      for (const d of deps) for (const [re, t] of NODE_TAGS) if (re.test(d)) tags.add(t);
    } catch {}
  }
  const pyNames = [];
  for (const f of ['requirements.txt', 'pyproject.toml', 'Pipfile']) {
    if (!mf[f]) continue;
    for (const m of mf[f].matchAll(/^[\s"']*([A-Za-z0-9_.\-]+)/gm)) pyNames.push(m[1]);
  }
  if (pyInfo) for (const p of pyInfo.pkgs) if (!SYSTEM_DIRS.some((d) => p.loc.startsWith(d))) pyNames.push(p.name);
  for (const n of pyNames) for (const [re, t] of PY_TAGS) if (re.test(n)) tags.add(t);
  if (mf['composer.json']) tags.add(/laravel|symfony|slim|wordpress/i.test(mf['composer.json']) ? 'Website' : 'PHP app');
  if (ins.dirs[dir]?.sessions?.length) tags.add('Telegram session');
  if (tags.has('Telegram userbot') && tags.has('Telegram bot')) tags.delete('Telegram bot');
  if (tags.has('Website') && tags.has('API') && tags.size > 2) tags.delete('API');
  return [...tags];
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
}

function under(p, dir) {
  if (!p || !dir) return false;
  return p === dir || p.startsWith(dir.endsWith('/') ? dir : dir + '/');
}

function isHome(dir, scan) {
  return dir === '/root' || scan.passwd.some((u) => u.home === dir && u.uid >= 1000);
}

/** Pick the "top" app process for each process tree that is not managed by a service manager. */
function managerOf(proc, scan, unitNames) {
  const cg = proc.cgroup || '';
  // walk ancestors
  const chain = [];
  let p = proc, guard = 0;
  while (p && guard++ < 64) { chain.push(p); p = scan.procs.get(p.ppid); }
  const comms = chain.map((x) => x.comm || '');
  if (comms.some((c) => c.startsWith('PM2'))) return { type: 'pm2' };
  if (comms.some((c) => /^containerd-shim/.test(c)) || /docker|containerd|libpod/.test(cg)) return { type: 'docker' };
  if (comms.includes('supervisord')) return { type: 'supervisor' };
  const unit = (cg.match(/\/([^/\s]+\.service)/g) || []).map((x) => x.slice(1)).pop();
  const launcherUnit = unit && /^(cron|crond|cronie|rc-local|ssh|sshd|getty@.*|serial-getty@.*|user@\d+|session-.*|init)\.service$/.test(unit);
  const screenFirst = comms.some((c) => c === 'SCREEN' || c === 'screen' || c.startsWith('tmux'));
  if (unit && unitNames.has(unit)) return { type: 'systemd', unit, custom: true };
  if (unit && !launcherUnit && !screenFirst && !/^(pm2-)/.test(unit) && !/user\.slice\/user-\d+\.slice\/user@/.test(cg)) {
    return { type: 'systemd', unit, custom: unitNames.has(unit) };
  }
  const screenIdx = comms.findIndex((c) => c === 'SCREEN' || c === 'screen');
  if (screenIdx >= 0) {
    const sp = chain[screenIdx];
    const argv = sp.argv || [];
    let name = null;
    const si = argv.findIndex((a) => a === '-S' || a.startsWith('-S') || /^-[a-zA-Z]*S$/.test(a));
    if (si >= 0) name = argv[si] === '-S' || /^-[a-zA-Z]*S$/.test(argv[si]) ? argv[si + 1] : argv[si].slice(2);
    return { type: 'screen', session: name || null, screenPid: sp.pid };
  }
  const tmuxIdx = comms.findIndex((c) => c.startsWith('tmux'));
  if (tmuxIdx >= 0) {
    const pane = chain[tmuxIdx - 1];
    const t = pane && scan.tmux.find((x) => x.panePid === pane.pid);
    return { type: 'tmux', session: t?.session || null };
  }
  return { type: 'nohup' };
}

const NOISE_ENV = /^(SSH_|TERM|TERMCAP|STY|WINDOW|TMUX|PWD$|OLDPWD$|SHLVL$|_$|LS_COLORS$|MAIL$|XDG_|DBUS_|MOTD_SHOWN$|LESSOPEN$|LESSCLOSE$|HISTSIZE$|HISTFILESIZE$|HISTCONTROL$|COLUMNS$|LINES$|SUDO_|LOGNAME$|PS1$|PROMPT_COMMAND$|INVOCATION_ID$|JOURNAL_STREAM$|SYSTEMD_EXEC_PID$|MANAGERPID$|NOTIFY_SOCKET$|PM2_|pm_|NODE_APP_INSTANCE$|unique_id$|COLORTERM$|DISPLAY$|SCREENDIR$)/;
export function cleanEnv(env = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!NOISE_ENV.test(k)) out[k] = v;
  return out;
}

function runtimeOf(exe, argv = []) {
  const b = posix.basename(exe || '');
  if (/^(node|nodejs)$/.test(b)) return 'node';
  if (/^(python|python\d.*|pypy.*)$/.test(b)) return 'python';
  if (/^php/.test(b)) return 'php';
  if (b === 'java') return 'java';
  if (b === 'bun') return 'bun';
  if (b === 'deno') return 'deno';
  if (/^ruby/.test(b)) return 'ruby';
  if (b === 'dotnet') return 'dotnet';
  if (/^(gunicorn|uvicorn|celery|hypercorn|daphne|flask)$/.test(posix.basename(argv[0] || ''))) return 'python';
  return 'binary';
}

/**
 * Build the list of projects shown to the user.
 */
export function buildProjects(scan, ins) {
  const projects = [];
  const unitNames = new Set(scan.units.map((u) => u.name));
  const userByUid = new Map(scan.passwd.map((u) => [u.uid, u.name]));
  const byPid = new Map();
  const portsOfPids = (pids) => {
    const set = new Set(pids);
    // include children
    let grew = true;
    while (grew) { grew = false; for (const p of scan.procs.values()) if (set.has(p.ppid) && !set.has(p.pid)) { set.add(p.pid); grew = true; } }
    return scan.listens.filter((l) => l.pids.some((x) => set.has(x)));
  };
  const add = (p) => {
    p.id = p.id || `${p.kind}-${slug(p.name)}-${projects.length}`;
    p.tags ||= [];
    p.warnings ||= [];
    p.ports ||= [];
    p.domains ||= [];
    p.size = ins.dirs[p.dir]?.size || 0;
    projects.push(p);
    for (const pid of p.pids || []) byPid.set(pid, p);
    return p;
  };
  const pyFor = (interp, user) => ins.py[`${interp}|${user}`];
  const nodeFor = (bin) => ins.node[bin];

  // ---- PM2
  for (const pm of scan.pm2) {
    for (const app of pm.apps) {
      const env = app.pm2_env || {};
      const pid = app.pid || 0;
      const proc = scan.procs.get(pid);
      const interp = env.exec_interpreter || 'node';
      const isPy = /python/.test(interp);
      const dir = env.pm_cwd || posix.dirname(env.pm_exec_path || '/');
      const existing = projects.find((x) => x.kind === 'pm2' && x.details.user === pm.user && x.name === app.name);
      if (existing) { if (pid) existing.pids.push(pid); continue; } // cluster instances
      const p = add({
        kind: 'pm2', name: app.name, title: app.name, dir, user: pm.user, running: env.status === 'online', status: env.status,
        pids: pid ? [pid] : [],
        runtime: isPy
          ? { type: 'python', interp: proc?.resolved || (interp.startsWith('/') ? interp : null), user: pm.user, cwd: dir }
          : { type: 'node', bin: pm.nodebin, version: env.node_version ? `v${String(env.node_version).replace(/^v/, '')}` : nodeFor(pm.nodebin)?.version },
        details: { user: pm.user, home: pm.home, pm2bin: pm.pm2bin, nodebin: pm.nodebin, pm2version: pm.version, script: env.pm_exec_path, interpreter: interp,
          errLog: env.pm_err_log_path, outLog: env.pm_out_log_path, restarts: env.restart_time, mode: env.exec_mode, instances: env.instances },
        manager: 'PM2',
      });
      p.cmd = `${interp} ${env.pm_exec_path || ''} ${(env.args || []).join?.(' ') || ''}`.trim();
    }
  }

  // ---- systemd custom units
  for (const u of scan.units) {
    const pids = u.mainPid ? [u.mainPid] : [];
    for (const proc of scan.procs.values()) if ((proc.cgroup || '').includes(`/${u.name}`)) pids.push(proc.pid);
    const exe = u.argv[0] || '';
    const rt = runtimeOf(exe, u.argv);
    const dir = u.workdir && u.workdir !== '~' ? u.workdir : (u.argv.slice(1).find((a) => a.startsWith('/')) ? posix.dirname(u.argv.slice(1).find((a) => a.startsWith('/'))) : '/');
    const mainProc = scan.procs.get(u.mainPid);
    add({
      kind: 'systemd', name: u.name.replace(/\.service$/, ''), title: u.description || u.name, dir, user: u.user,
      running: u.active === 'active', status: u.active, pids: [...new Set(pids)],
      runtime: rt === 'python' ? { type: 'python', interp: exe.startsWith('/') ? exe : mainProc?.resolved, user: u.user, cwd: dir }
        : rt === 'node' ? { type: 'node', bin: mainProc?.exe || exe, version: nodeFor(mainProc?.exe || exe)?.version } : { type: rt, bin: exe },
      details: { unit: u.name, path: u.path, dropins: u.dropins, enabled: u.enabled === 'enabled', active: u.active === 'active', envFiles: u.envFiles, unitParsed: { ...u, content: undefined }, content: u.content },
      manager: 'systemd', cmd: u.execStart,
    });
  }

  // ---- Docker
  if (scan.docker?.containers?.length) {
    const groups = new Map();
    for (const c of scan.docker.containers) {
      const L = c.Config?.Labels || {};
      const proj = L['com.docker.compose.project'];
      const key = proj ? `compose:${proj}` : `container:${c.Name}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    const images = new Map((scan.docker.images || []).map((i) => [i.Id, i]));
    for (const [key, cs] of groups) {
      const L = cs[0].Config?.Labels || {};
      const isCompose = key.startsWith('compose:');
      const name = isCompose ? L['com.docker.compose.project'] : cs[0].Name.replace(/^\//, '');
      const binds = [], vols = [];
      for (const c of cs) for (const m of c.Mounts || []) {
        if (m.Type === 'bind') binds.push(m.Source);
        else if (m.Type === 'volume' && m.Name) vols.push({ name: m.Name, source: m.Source, driver: m.Driver });
      }
      const running = cs.some((c) => c.State?.Running);
      const ports = new Set();
      for (const c of cs) for (const [, arr] of Object.entries(c.NetworkSettings?.Ports || {})) for (const b of arr || []) ports.add(+b.HostPort);
      const imgs = cs.map((c) => { const i = images.get(c.Image) || {}; return { ref: c.Config?.Image, id: c.Image, digests: i.RepoDigests || [], arch: i.Architecture, tags: i.RepoTags || [] }; });
      const workdir = L['com.docker.compose.project.working_dir'];
      const p = add({
        kind: isCompose ? 'compose' : 'container', name, title: name, dir: workdir || (binds[0] ? binds[0] : '/'), user: 'root', running,
        status: running ? 'running' : 'stopped', pids: cs.map((c) => c.State?.Pid).filter(Boolean),
        runtime: { type: 'docker' },
        details: {
          project: name, workdir, configFiles: (L['com.docker.compose.project.config_files'] || '').split(',').filter(Boolean),
          envFiles: (L['com.docker.compose.project.environment_file'] || '').split(',').filter(Boolean),
          containers: cs.map((c) => ({ id: c.Id, name: c.Name.replace(/^\//, ''), running: !!c.State?.Running, restart: c.HostConfig?.RestartPolicy?.Name || 'no', service: c.Config?.Labels?.['com.docker.compose.service'], health: c.State?.Health?.Status })),
          binds: [...new Set(binds)], volumes: vols.filter((v, i, a) => a.findIndex((x) => x.name === v.name) === i), images: imgs,
          inspect: isCompose ? undefined : cs[0],
        },
        manager: isCompose ? 'Docker Compose' : 'Docker', cmd: isCompose ? `docker compose -p ${name} up -d` : `docker run ${cs[0].Config?.Image}`,
      });
      p.ports = [...ports].filter(Boolean);
      if (!isCompose) p.selected = running || ['always', 'unless-stopped'].includes(cs[0].HostConfig?.RestartPolicy?.Name);
    }
  }

  // ---- Supervisor
  for (const conf of scan.supervisor.confs) {
    if (!conf.programs.length) continue;
    const pr = conf.programs[0];
    const statusLines = scan.supervisor.status.split('\n');
    const pids = [];
    let running = false;
    for (const prog of conf.programs) {
      const line = statusLines.find((l) => l.startsWith(prog.name + ' ') || l.startsWith(prog.name + ':'));
      if (line && /RUNNING/.test(line)) { running = true; const m = line.match(/pid (\d+)/); if (m) pids.push(+m[1]); }
    }
    const argv = splitArgs(pr.command);
    const rt = runtimeOf(argv[0], argv);
    add({
      kind: 'supervisor', name: posix.basename(conf.path).replace(/\.(conf|ini)$/, ''), title: conf.programs.map((x) => x.name).join(', '),
      dir: pr.directory || '/', user: pr.user || 'root', running, status: running ? 'running' : 'stopped', pids,
      runtime: rt === 'python' ? { type: 'python', interp: argv[0].startsWith('/') ? argv[0] : scan.procs.get(pids[0])?.resolved, user: pr.user || 'root', cwd: pr.directory || '/' }
        : rt === 'node' ? { type: 'node', bin: scan.procs.get(pids[0])?.exe || argv[0], version: nodeFor(scan.procs.get(pids[0])?.exe || argv[0])?.version } : { type: rt },
      details: { conf: conf.path, programs: conf.programs.map((x) => x.name), content: conf.content },
      manager: 'Supervisor', cmd: pr.command,
    });
  }

  // ---- Unmanaged processes (screen / tmux / nohup)
  const cands = [...scan.procs.values()].filter((p) => p.cand && p.argv?.length);
  for (const proc of cands) {
    const parent = scan.procs.get(proc.ppid);
    if (parent && parent.cand) continue; // only the top of each app tree
    if (byPid.has(proc.pid)) continue;
    const mgr = managerOf(proc, scan, unitNames);
    if (['pm2', 'docker', 'supervisor', 'systemd'].includes(mgr.type)) continue;
    const user = userByUid.get(proc.uid) || 'root';
    const argv = proc.argv;
    const rt = runtimeOf(proc.exe, argv);
    if (rt === 'binary' && !/^\/(home|root|opt|srv|var\/www|app|usr\/local\/bin)\//.test(proc.exe)) continue;
    // skip obvious tools
    if (/\/(rsync|ssh|sftp-server|bash|sh|vim?|nano|less|top|htop|tail|cat)$/.test(proc.exe)) continue;
    const scriptArg = argv.slice(1).find((a) => !a.startsWith('-'));
    const label = scriptArg ? posix.basename(scriptArg).replace(/\.(py|js|mjs|cjs|ts|php)$/, '') : posix.basename(proc.exe);
    const cwd = proc.cwd || '/';
    const name = mgr.session || `${posix.basename(cwd) || 'app'}-${label}`;
    add({
      kind: 'process', name, title: `${posix.basename(cwd)} · ${label}`, dir: cwd, user, running: true, status: 'running', pids: [proc.pid],
      runtime: rt === 'python' ? { type: 'python', interp: proc.resolved || proc.exe, user, cwd }
        : rt === 'node' ? { type: 'node', bin: proc.exe, version: nodeFor(proc.exe)?.version } : { type: rt, bin: proc.exe },
      details: { launcher: mgr.type, session: mgr.session, argv: argv.map((a, i) => (i === 0 && proc.resolved ? proc.resolved : a)), argvRaw: argv, env: cleanEnv(proc.env), exe: proc.exe },
      manager: mgr.type === 'nohup' ? 'Background process' : mgr.type === 'screen' ? 'screen session' : 'tmux session',
      cmd: argv.join(' '),
    });
  }

  // ---- ports for process-based projects
  for (const p of projects) {
    if (p.kind === 'compose' || p.kind === 'container') continue;
    p.ports = [...new Set(portsOfPids(p.pids).map((l) => l.port))];
    p.listen = portsOfPids(p.pids).map((l) => ({ addr: l.addr, port: l.port }));
  }

  // ---- Cron
  for (const c of scan.crons) {
    const lines = c.content.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#') && !/shift-(pm2|launch)/.test(l));
    if (!lines.length) continue;
    add({ kind: 'cron', name: `cron-${c.user}`, title: `Scheduled jobs (${c.user})`, dir: scan.passwd.find((u) => u.name === c.user)?.home || '/', user: c.user,
      running: true, status: `${lines.length} job${lines.length > 1 ? 's' : ''}`, pids: [], runtime: { type: 'cron' },
      details: { content: c.content, lines }, manager: 'cron', cmd: lines.slice(0, 3).join('\n') });
  }
  for (const c of scan.crond) {
    add({ kind: 'crond', name: posix.basename(c.path), title: `Scheduled jobs (${posix.basename(c.path)})`, dir: '/etc/cron.d', user: 'root', running: true, status: 'cron.d file',
      pids: [], runtime: { type: 'cron' }, details: { path: c.path, content: c.content }, manager: 'cron', cmd: c.content.split('\n').filter((l) => l.trim() && !l.startsWith('#')).slice(0, 3).join('\n') });
  }

  // ---- Websites
  if (scan.nginx) {
    for (const site of scan.nginx.sites) {
      const ng = parseNginx(site.content);
      const name = posix.basename(site.realPath).replace(/\.conf$/, '');
      const p = add({
        kind: 'site', name, title: ng.serverNames[0] || name, dir: ng.roots[0] || '/etc/nginx', user: 'root', running: scan.nginx.running, status: scan.nginx.running ? 'online' : 'nginx stopped',
        pids: [], runtime: { type: 'nginx' }, domains: ng.serverNames,
        details: { server: 'nginx', enabledPath: site.enabledPath, realPath: site.realPath, content: site.content, ...ng },
        manager: 'nginx', cmd: ng.serverNames.join(' '),
      });
      p.ports = ng.listens.map((l) => +(l.match(/(\d+)/) || [])[1]).filter(Boolean);
      p.ports = [...new Set(p.ports)];
      if (ng.fastcgi.some((f) => /php/.test(f))) p.tags.push('PHP');
      // link to apps
      for (const port of ng.ports) for (const app of projects) if (app !== p && app.ports.includes(port)) { app.domains.push(...ng.serverNames); app.linkedSites = [...(app.linkedSites || []), p.id]; }
    }
  }
  for (const site of scan.apache.sites) {
    const name = posix.basename(site.realPath).replace(/\.conf$/, '');
    const sn = [...site.content.matchAll(/^\s*Server(?:Name|Alias)\s+(.+)$/gim)].flatMap((m) => m[1].split(/\s+/));
    const root = (site.content.match(/^\s*DocumentRoot\s+"?([^"\n]+)"?/im) || [])[1];
    add({ kind: 'site', name, title: sn[0] || name, dir: root || '/var/www', user: 'root', running: true, status: 'online', pids: [], runtime: { type: 'apache' }, domains: [...new Set(sn)],
      details: { server: 'apache', enabledPath: site.enabledPath, realPath: site.realPath, content: site.content, roots: root ? [root] : [], files: [] }, manager: 'Apache', cmd: sn.join(' ') });
  }
  if (scan.caddy) {
    const doms = [...scan.caddy.content.matchAll(/^([a-z0-9.\-*]+\.[a-z]{2,}[^{]*)\{/gim)].flatMap((m) => m[1].trim().split(/[\s,]+/));
    add({ kind: 'site', name: 'caddy', title: doms[0] || 'Caddy', dir: '/etc/caddy', user: 'root', running: true, status: 'online', pids: [], runtime: { type: 'caddy' }, domains: doms,
      details: { server: 'caddy', content: scan.caddy.content, roots: [], files: [] }, manager: 'Caddy', cmd: doms.join(' ') });
  }

  // ---- Databases
  for (const db of scan.dbs) {
    const label = { mysql: db.flavor === 'mariadb' ? 'MariaDB' : 'MySQL', postgres: 'PostgreSQL', redis: 'Redis', mongodb: 'MongoDB' }[db.engine];
    const p = add({
      kind: 'db', name: db.engine, title: label, dir: '/var/lib', user: 'root', running: true, status: db.ok ? `${db.databases.length} database${db.databases.length === 1 ? '' : 's'}` : 'needs password',
      pids: [], runtime: { type: 'db', engine: db.engine }, details: { ...db },
      manager: label, cmd: db.databases.map((d) => d.name).join(', '),
    });
    p.size = Math.round(db.databases.reduce((a, d) => a + (d.size || 0), 0) / 1024);
    p.ports = [...new Set(scan.listens.filter((l) => ({ mysql: 3306, postgres: 5432, redis: 6379, mongodb: 27017 })[db.engine] === l.port).map((l) => l.port))];
    if (!db.ok) p.warnings.push(`Shift could not log in to ${label}. Enter its admin password below, or untick it.`);
    p.needsAuth = !db.ok && db.engine !== 'redis';
  }

  // ---- Folders (not running)
  const used = projects.filter((p) => !['cron', 'crond', 'db'].includes(p.kind)).map((p) => p.dir);
  const folders = [...new Set(scan.folders)].sort();
  for (const f of folders) {
    if (used.some((d) => under(f, d) && !isHome(d, scan) && d !== '/')) continue;
    if (folders.some((o) => o !== f && under(f, o) && !isHome(o, scan))) continue;
    if (/\/(node_modules|\.git|venv|\.venv|site-packages|dist|build|public|static|src|lib|test|tests|docs)(\/|$)/.test(f.replace(/^\/(root|home\/[^/]+)/, ''))) {
      // keep only if it's a standalone project root
      if (!(ins.manifests[f] && (ins.manifests[f]['package.json'] || ins.manifests[f]['requirements.txt']))) continue;
    }
    if (used.includes(f)) continue;
    const owner = (ins.dirs[f]?.owner || 'root:root').split(':')[0];
    add({ kind: 'folder', name: posix.basename(f), title: posix.basename(f), dir: f, user: owner, running: false, status: 'not running', pids: [], runtime: { type: 'files' },
      details: {}, manager: 'Files only', cmd: f, selected: true });
  }

  // ---- tags & warnings
  for (const p of projects) {
    const py = p.runtime?.type === 'python' && p.runtime.interp ? pyFor(p.runtime.interp, p.runtime.user || p.user) : null;
    if (py) { p.runtime.version = py.version; p.runtime.venv = py.venv; }
    if (!['db', 'cron', 'crond'].includes(p.kind)) p.tags = [...new Set([...(p.tags || []), ...tagsFor(p.dir, ins, py)])];
    if (p.kind === 'site' && !p.tags.includes('Website')) p.tags.unshift('Website');
    if (p.kind === 'db') p.tags = ['Database'];
    if (p.kind === 'cron' || p.kind === 'crond') p.tags = ['Scheduled'];
    if (p.tags.includes('Telegram session') || p.tags.includes('Telegram userbot'))
      p.warnings.push('Telegram session: the old copy is fully stopped and checked before the new one starts, so your session is never used from two servers at once.');
    if (p.kind === 'process' && p.details.launcher !== 'nohup') p.notes = [`Runs in a ${p.details.launcher} session — it will be set up to also survive reboots on the new VPS.`];
    if (p.selected === undefined) p.selected = p.kind !== 'folder' || true;
    if (p.kind === 'container' && !p.running) p.selected = p.selected ?? false;
    p.icon = iconFor(p);
  }
  // dedupe domains
  for (const p of projects) p.domains = [...new Set(p.domains)];
  return projects;
}

function iconFor(p) {
  if (p.tags.includes('Telegram userbot') || p.tags.includes('Telegram bot')) return 'telegram';
  if (p.tags.includes('Discord bot')) return 'discord';
  if (p.tags.includes('WhatsApp bot')) return 'whatsapp';
  if (p.kind === 'db') return 'database';
  if (p.kind === 'cron' || p.kind === 'crond') return 'clock';
  if (p.kind === 'site') return 'globe';
  if (p.kind === 'compose' || p.kind === 'container') return 'docker';
  if (p.tags.includes('Website')) return 'globe';
  if (p.tags.includes('API')) return 'api';
  if (p.runtime?.type === 'python') return 'python';
  if (p.runtime?.type === 'node') return 'node';
  if (p.runtime?.type === 'php') return 'php';
  return 'folder';
}

/** Collect inputs for the inspect script. */
export function inspectInputs(scan) {
  const dirs = new Set();
  const pys = new Set();
  const nodes = new Set();
  const users = new Set(['root']);
  for (const pm of scan.pm2) {
    nodes.add(pm.nodebin);
    users.add(pm.user);
    for (const a of pm.apps) {
      const e = a.pm2_env || {};
      if (e.pm_cwd) dirs.add(e.pm_cwd);
      if (/python/.test(e.exec_interpreter || '')) {
        const pr = scan.procs.get(a.pid);
        const interp = pr?.resolved || (e.exec_interpreter.startsWith('/') ? e.exec_interpreter : null);
        if (interp) pys.add(`${interp}|${pm.user}|${e.pm_cwd || '/'}`);
      }
    }
  }
  for (const u of scan.units) {
    if (u.workdir) dirs.add(u.workdir);
    users.add(u.user);
    const exe = u.argv[0] || '';
    const mp = scan.procs.get(u.mainPid);
    if (runtimeOf(exe, u.argv) === 'python') { const i = exe.startsWith('/') ? exe : mp?.resolved; if (i) pys.add(`${i}|${u.user}|${u.workdir || '/'}`); }
    if (runtimeOf(exe, u.argv) === 'node') nodes.add(mp?.exe || exe);
  }
  for (const c of scan.supervisor.confs) for (const pr of c.programs) if (pr.directory) dirs.add(pr.directory);
  const userByUid = new Map(scan.passwd.map((u) => [u.uid, u.name]));
  for (const p of scan.procs.values()) {
    if (!p.cand || !p.cwd) continue;
    const u = userByUid.get(p.uid) || 'root';
    dirs.add(p.cwd);
    users.add(u);
    const rt = runtimeOf(p.exe, p.argv);
    if (rt === 'python') pys.add(`${p.resolved || p.exe}|${u}|${p.cwd}`);
    if (rt === 'node') nodes.add(p.exe);
  }
  for (const f of scan.folders) dirs.add(f);
  for (const c of scan.docker?.containers || []) { const wd = c.Config?.Labels?.['com.docker.compose.project.working_dir']; if (wd) dirs.add(wd); }
  for (const v of scan.docker?.volumes || []) if (v.Mountpoint) dirs.add(v.Mountpoint);
  for (const u of scan.passwd) if (u.uid === 0 || (u.uid >= 1000 && u.uid < 65534)) { dirs.add(u.home); users.add(u.name); }
  for (const s of scan.nginx?.sites || []) for (const r of parseNginx(s.content).roots) dirs.add(r);
  for (const f of scan.folders) { const o = scan.passwd.find((u) => under(f, u.home)); if (o) users.add(o.name); }
  return {
    dirs: [...dirs].filter((d) => d && d !== '/'),
    pys: [...pys].filter(Boolean),
    nodes: [...nodes].filter(Boolean),
    users: [...users].filter(Boolean),
  };
}

export function inspectScript(inp) {
  return `SHIFT_DIRS=${shq(inp.dirs.join('\n'))}\nSHIFT_PYS=${shq(inp.pys.join('\n'))}\nSHIFT_NODES=${shq(inp.nodes.join('\n'))}\nSHIFT_USERS=${shq(inp.users.join('\n'))}\n${SCRIPTS.inspect}`;
}
