import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Remote, SCRIPTS, shq, records, fieldsOf, dec, sleep } from './ssh.js';
import { parseProbe, parseScan, parseInspect, buildProjects, inspectInputs, inspectScript, splitArgs, parseNginx } from './scan.js';
import { computePlan, DEFAULT_OPTIONS, fmtKB } from './plan.js';
import { Transfer } from './transfer.js';

const posix = path.posix;
export const DATA_DIR = process.env.SHIFT_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
fs.mkdirSync(path.join(DATA_DIR, 'jobs'), { recursive: true, mode: 0o700 });

export const STEPS = [
  ['connect', 'Connect to both servers'],
  ['scan', 'Find your projects'],
  ['preflight', 'Pre-flight checks'],
  ['prepare', 'Prepare the new VPS'],
  ['sync', 'Copy files (projects keep running)'],
  ['cutover', 'Stop projects on the old VPS'],
  ['final', 'Final copy & databases'],
  ['start', 'Start projects on the new VPS'],
  ['verify', 'Check that everything works'],
  ['cleanup', 'Clean up'],
];

const PYCHECK = `import sys
def norm(n): return n.lower().replace("_", "-").replace(".", "-")
have = {}
try:
    from importlib import metadata as m
    for d in m.distributions():
        try: have[norm(d.metadata["Name"])] = d.version
        except Exception: pass
except Exception:
    import pkg_resources
    for d in pkg_resources.working_set: have[norm(d.project_name)] = d.version
missing = []
for line in open(sys.argv[1]):
    line = line.strip()
    if "==" not in line: continue
    n, v = line.split("==", 1)
    if have.get(norm(n)) != v: missing.append(line)
if missing:
    sys.stderr.write("Python packages missing or different: %s\\n" % ", ".join(missing[:12]))
    sys.exit(1)
`;

const FATAL_PATTERNS = [
  [/AUTH_KEY_DUPLICATED/, 'Telegram rejected the session because it was used from two places at once.'],
  [/EADDRINUSE|address already in use|Address already in use/, 'Its port is already used by something else.'],
  [/Cannot find module|MODULE_NOT_FOUND|ModuleNotFoundError|No module named|ImportError:/, 'A code library is missing.'],
  [/ERR_DLOPEN_FAILED|invalid ELF header|wrong ELF class|Exec format error|GLIBC_\d/, 'A compiled module does not fit the new server.'],
];
const WARN_PATTERNS = [
  [/Conflict: terminated by other getUpdates request/, 'Telegram says another copy of this bot is running somewhere else.'],
  [/EACCES|Permission denied/, 'Permission problem in the logs.'],
  [/Traceback \(most recent call last\)|UnhandledPromiseRejection|Uncaught/, 'Errors were printed in the logs.'],
  [/ECONNREFUSED/, 'Could not connect to a service (database?).'],
];

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
const b64 = (s) => Buffer.from(String(s)).toString('base64');

function launcherScript({ cwd, env, argv, pidfile, envFiles = [], home, user }) {
  const L = ['#!/bin/sh', '# Created by Shift (VPS transfer)'];
  if (pidfile) L.push(`echo $$ > ${shq(pidfile)}`);
  const e = { ...env };
  if (!e.HOME && home) e.HOME = home;
  if (!e.USER && user) e.USER = user;
  if (!e.PATH) e.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  if (!e.LANG) e.LANG = 'C.UTF-8';
  for (const [k, v] of Object.entries(e)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) L.push(`export ${k}=${shq(v)}`);
  for (const f of envFiles) L.push(`[ -f ${shq(f)} ] && { set -a; . ${shq(f)}; set +a; }`);
  L.push(`cd ${shq(cwd || home || '/')} || exit 1`);
  L.push(`exec ${argv.map(shq).join(' ')}`);
  return L.join('\n') + '\n';
}

function unitFile({ title, user, cwd, script }) {
  return `[Unit]
Description=${title.replace(/\n/g, ' ')} (moved by Shift)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${cwd}
ExecStart=/bin/sh ${script}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

function fixArgv(argv) {
  if (argv.length === 1 && /\s/.test(argv[0])) return argv[0].split(/\s+/).filter(Boolean);
  return argv;
}

/** docker inspect -> compose service (JSON is valid YAML) */
function containerCompose(c, images) {
  const H = c.HostConfig || {}, C = c.Config || {};
  const img = images.find((i) => i.Id === c.Image)?.Config || {};
  const name = c.Name.replace(/^\//, '');
  const svc = { image: C.Image, container_name: name };
  const rp = H.RestartPolicy?.Name;
  svc.restart = rp && rp !== 'no' ? (rp === 'on-failure' ? 'on-failure' : rp) : 'unless-stopped';
  const envImg = new Set(img.Env || []);
  const env = (C.Env || []).filter((e) => !envImg.has(e));
  if (env.length) svc.environment = env;
  const ports = [];
  for (const [cp, arr] of Object.entries(H.PortBindings || {})) for (const b of arr || []) ports.push(`${b.HostIp && b.HostIp !== '0.0.0.0' ? b.HostIp + ':' : ''}${b.HostPort || ''}${b.HostPort ? ':' : ''}${cp}`);
  if (ports.length) svc.ports = ports;
  const vols = [], top = {};
  for (const m of c.Mounts || []) {
    if (m.Type === 'bind') vols.push(`${m.Source}:${m.Destination}${m.RW === false ? ':ro' : ''}`);
    else if (m.Type === 'volume' && m.Name) { vols.push(`${m.Name}:${m.Destination}${m.RW === false ? ':ro' : ''}`); top[m.Name] = { external: true }; }
  }
  if (vols.length) svc.volumes = vols;
  if (C.Cmd && JSON.stringify(C.Cmd) !== JSON.stringify(img.Cmd)) svc.command = C.Cmd;
  if (C.Entrypoint && JSON.stringify(C.Entrypoint) !== JSON.stringify(img.Entrypoint)) svc.entrypoint = C.Entrypoint;
  if (C.WorkingDir && C.WorkingDir !== img.WorkingDir) svc.working_dir = C.WorkingDir;
  if (C.User && C.User !== img.User) svc.user = C.User;
  const nets = {};
  if (H.NetworkMode === 'host') svc.network_mode = 'host';
  else if (H.NetworkMode && !['default', 'bridge'].includes(H.NetworkMode) && !H.NetworkMode.startsWith('container:')) { svc.networks = [H.NetworkMode]; nets[H.NetworkMode] = { name: H.NetworkMode }; }
  if (H.Privileged) svc.privileged = true;
  if (H.CapAdd?.length) svc.cap_add = H.CapAdd;
  if (H.ExtraHosts?.length) svc.extra_hosts = H.ExtraHosts;
  if (H.Devices?.length) svc.devices = H.Devices.map((d) => `${d.PathOnHost}:${d.PathInContainer}`);
  const labels = Object.fromEntries(Object.entries(C.Labels || {}).filter(([k]) => !k.startsWith('com.docker.compose') && !(img.Labels || {})[k]));
  if (Object.keys(labels).length) svc.labels = labels;
  const doc = { services: { [slug(name)]: svc } };
  if (Object.keys(top).length) doc.volumes = top;
  if (Object.keys(nets).length) doc.networks = nets;
  return JSON.stringify(doc, null, 2) + '\n';
}

export class Job extends EventEmitter {
  constructor({ id, source, target, fingerprints = {} }) {
    super();
    this.id = id || crypto.randomBytes(5).toString('hex');
    this.creds = { source, target };
    this.secrets = new Set([source?.password, target?.password, source?.passphrase, target?.passphrase].filter((x) => x && x.length >= 3));
    this.state = {
      id: this.id,
      createdAt: new Date().toISOString(),
      status: 'connecting',
      error: null,
      servers: {
        source: { host: source.host, port: Number(source.port) || 22, username: source.username, fingerprint: fingerprints.source || null },
        target: { host: target.host, port: Number(target.port) || 22, username: target.username, fingerprint: fingerprints.target || null },
      },
      steps: STEPS.map(([id, title]) => ({ id, title, status: 'pending', detail: '' })),
      progress: { overall: 0, files: 0, databases: 0, services: 0, speed: '', eta: '', current: 'Connecting…' },
      projects: [],
      selection: [],
      options: { ...DEFAULT_OPTIONS },
      preflight: null,
      transfer: { mode: null },
      records: {},
      results: { verify: [], warnings: [], interp: {}, py: {}, volumes: {} },
      protect: [],
      attempts: {},
      cutoverStarted: false,
      dbAuth: {},
      finishedAt: null,
    };
    this.logs = [];
    this._saveTimer = null;
    this.cancelled = false;
  }

  // ---------------------------------------------------------------- infra
  redact(s) {
    let out = String(s);
    for (const sec of this.secrets) out = out.split(sec).join('••••••');
    return out;
  }
  log(msg, level = 'info', server = null) {
    const line = { t: Date.now(), level, server, msg: this.redact(msg) };
    this.logs.push(line);
    if (this.logs.length > 4000) this.logs.splice(0, this.logs.length - 4000);
    this.emit('log', line);
  }
  update(patch = {}) {
    Object.assign(this.state, patch);
    this.emit('state');
    this.save();
  }
  progress(p) {
    Object.assign(this.state.progress, p);
    this.emit('state');
  }
  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        const file = path.join(DATA_DIR, 'jobs', `${this.id}.json`);
        fs.writeFileSync(file + '.tmp', JSON.stringify({ state: this.state, plan: this.plan || null }, null, 1), { mode: 0o600 });
        fs.renameSync(file + '.tmp', file);
        fs.writeFileSync(path.join(DATA_DIR, 'jobs', `${this.id}.log`), this.logs.map((l) => `${new Date(l.t).toISOString()} [${l.level}]${l.server ? ' [' + l.server + ']' : ''} ${l.msg}`).join('\n'), { mode: 0o600 });
      } catch (e) { console.error('save failed', e.message); }
    }, 300);
  }
  attempt(key) { return this.state.attempts[key] || 1; }
  bumpAttempt(key) { this.state.attempts[key] = (this.state.attempts[key] || 1) + 1; }
  setStep(id, status, detail) {
    const s = this.state.steps.find((x) => x.id === id);
    if (!s) return;
    s.status = status;
    if (detail !== undefined) s.detail = detail;
    if (status === 'running') s.startedAt = Date.now();
    if (['done', 'failed', 'warn', 'skipped'].includes(status)) s.endedAt = Date.now();
    const idx = STEPS.findIndex(([x]) => x === id);
    const done = this.state.steps.filter((x) => ['done', 'warn', 'skipped'].includes(x.status)).length;
    this.state.progress.overall = Math.min(1, (done + (status === 'running' ? 0.3 : 0)) / STEPS.length);
    if (status === 'running') this.state.progress.current = s.title;
    void idx;
    this.emit('state');
    this.save();
  }
  async runStep(id, fn) {
    const s = this.state.steps.find((x) => x.id === id);
    if (s && ['done', 'warn', 'skipped'].includes(s.status)) return;
    if (this.cancelled) throw new Error('Cancelled');
    this.setStep(id, 'running');
    try {
      const r = await fn();
      this.setStep(id, r === 'warn' ? 'warn' : r === 'skipped' ? 'skipped' : 'done');
    } catch (e) {
      this.setStep(id, 'failed', e.message);
      this.bumpAttempt(id);
      throw e;
    }
  }

  /** Run a background task on a server, streaming its output into the log. */
  async runTask(remote, name, script, { onLine, raw = false, critical = true } = {}) {
    const tag = remote === this.src ? 'old' : 'new';
    const out = { warns: [], recs: [], failed: [] };
    let current = null;
    let buf = '';
    const handle = (line) => {
      if (!line.trim()) return;
      if (line.startsWith('@@')) {
        const [type, ...rest] = line.slice(2).split(' ');
        const raw1 = rest.join(' ');
        if (type === 'STEP') { current = dec(rest[0]); this.log(current, 'step', tag); this.progress({ current }); return; }
        if (type === 'OK') return;
        if (type === 'FAIL') { out.failed.push(current); this.log(`Failed: ${current}`, 'error', tag); return; }
        if (type === 'WARN') { const w = dec(rest[0]); out.warns.push(w); this.state.results.warnings.push(w); this.log(w, 'warn', tag); return; }
        out.recs.push({ type, raw: raw1, step: current });
        if (onLine && onLine(line, type)) return;
        return;
      }
      if (onLine && onLine(line)) return;
      this.log(line, 'out', tag);
    };
    await remote.startTask(name, script);
    const rc = await remote.waitTask(name, {
      isCancelled: () => this.cancelled && !this.state.cutoverStarted,
      onData: (chunk) => {
        buf += chunk;
        const parts = buf.split(/\r\n|\n|\r/);
        buf = parts.pop();
        for (const p of parts) handle(p);
      },
    });
    if (buf) handle(buf);
    this._lastTask = out;
    if (rc !== 0 && critical && !raw) {
      const what = out.failed.filter(Boolean).pop();
      throw new Error(what ? `${what} failed on the ${remote.label}` : `A step failed on the ${remote.label} (code ${rc})`);
    }
    return rc;
  }

  // ---------------------------------------------------------------- connect & scan
  async connect() {
    await this.runStep('connect', async () => {
      const mk = (cfg, label, fp) => new Remote(cfg, { label, fingerprint: fp, log: (m, l) => this.log(m, l || 'warn', label === 'old VPS' ? 'old' : 'new') });
      this.src = mk(this.creds.source, 'old VPS', this.state.servers.source.fingerprint);
      this.tgt = mk(this.creds.target, 'new VPS', this.state.servers.target.fingerprint);
      this.progress({ current: 'Connecting to both servers…' });
      await Promise.all([this.src.connect(), this.tgt.connect()]);
      this.state.servers.source.fingerprint = this.src.fingerprint;
      this.state.servers.target.fingerprint = this.tgt.fingerprint;
      this.log(`Connected to old VPS as ${this.src.user}`, 'ok', 'old');
      this.log(`Connected to new VPS as ${this.tgt.user}`, 'ok', 'new');
      for (const r of [this.src, this.tgt]) {
        if (!r.isRoot) {
          this.log(`Getting temporary root access through sudo on the ${r.label}…`, 'info', r === this.src ? 'old' : 'new');
          await r.bootstrapSudo(this.id);
        }
        await r.setupWorkdir(this.id);
      }
      const [sp, tp] = await Promise.all([this.src.sh(SCRIPTS.probe), this.tgt.sh(SCRIPTS.probe)]);
      this.srcInfo = parseProbe(sp.stdout);
      this.tgtInfo = parseProbe(tp.stdout);
      this.state.servers.source.info = this.publicInfo(this.srcInfo);
      this.state.servers.target.info = this.publicInfo(this.tgtInfo);
    });
  }
  publicInfo(i) {
    return { name: i.name, id: i.id, family: i.family, arch: i.arch, libc: i.libc, init: i.init, hostname: i.hostname, memKB: i.memKB, diskKB: i.diskKB, cpus: i.cpus, uptime: i.uptime };
  }

  async scan() {
    await this.runStep('scan', async () => {
      this.progress({ current: 'Looking for projects on the old VPS…' });
      const r = await this.src.sh(SCRIPTS.scan, { timeout: 15 * 60 * 1000 });
      if (!/@@DONE/.test(r.stdout)) throw new Error(`Scan did not finish: ${r.stderr.slice(0, 300)}`);
      this.scanData = parseScan(r.stdout);
      this.progress({ current: 'Reading project details…' });
      const inp = inspectInputs(this.scanData);
      const ir = await this.src.sh(inspectScript(inp), { timeout: 15 * 60 * 1000 });
      this.ins = parseInspect(ir.stdout);
      const projects = buildProjects(this.scanData, this.ins);
      this.state.projects = projects.map((p) => this.publicProject(p));
      this.projects = projects;
      this.state.selection = projects.filter((p) => p.selected).map((p) => p.id);
      for (const e of this.scanData.errors) this.log(e, 'warn', 'old');
      this.log(`Found ${projects.length} item${projects.length === 1 ? '' : 's'} to move`, 'ok', 'old');
    });
    this.update({ status: 'ready' });
  }

  publicProject(p) {
    const d = p.details || {};
    return {
      id: p.id, kind: p.kind, name: p.name, title: p.title, dir: p.dir, user: p.user, running: p.running, status: p.status, manager: p.manager,
      tags: p.tags, warnings: p.warnings, notes: p.notes || [], ports: p.ports, domains: p.domains, size: p.size, icon: p.icon,
      runtime: { type: p.runtime?.type, version: p.runtime?.version, venv: p.runtime?.venv || null },
      cmd: this.redact(String(p.cmd || '').slice(0, 300)), needsAuth: !!p.needsAuth,
      databases: p.kind === 'db' ? (d.databases || []).map((x) => x.name) : undefined,
    };
  }

  async setDbAuth(projectId, { user, password }) {
    const p = this.projects.find((x) => x.id === projectId);
    if (!p || p.kind !== 'db') throw new Error('Unknown database');
    if (password) this.secrets.add(password);
    const engine = p.details.engine;
    if (engine === 'mysql') {
      await this.src.writeFile(`${this.src.W}/mysql.cnf`, `[client]\nuser=${user || 'root'}\npassword="${String(password).replace(/(["\\])/g, '\\$1')}"\n`, { mode: '600' });
      const r = await this.src.sh(`mysql --defaults-extra-file="$SHIFT_W/mysql.cnf" -N -B -e "SELECT s.schema_name, COALESCE(SUM(t.data_length+t.index_length),0) FROM information_schema.schemata s LEFT JOIN information_schema.tables t ON t.table_schema=s.schema_name WHERE s.schema_name NOT IN ('information_schema','performance_schema','mysql','sys') GROUP BY s.schema_name"`);
      if (r.code !== 0) throw new Error('MySQL login failed: ' + r.stderr.trim().slice(0, 200));
      p.details.databases = r.stdout.trim().split('\n').filter(Boolean).map((l) => { const [n, s] = l.split('\t'); return { name: n, size: +s || 0 }; });
    } else if (engine === 'mongodb') {
      const uri = `mongodb://${encodeURIComponent(user || 'admin')}:${encodeURIComponent(password)}@127.0.0.1:27017/?authSource=admin`;
      this.secrets.add(uri);
      this.state.dbAuth.mongoUri = true;
      this.mongoUri = uri;
      const r = await this.src.sh(`MONGO_URI=${shq(uri)}; $(command -v mongosh || echo mongo) --quiet "$MONGO_URI" --eval 'db.adminCommand({listDatabases:1}).databases.forEach(function(d){print(d.name+" "+d.sizeOnDisk)})'`);
      if (r.code !== 0) throw new Error('MongoDB login failed');
      p.details.databases = r.stdout.trim().split('\n').filter(Boolean).map((l) => { const [n, s] = l.split(' '); return { name: n, size: +s || 0 }; }).filter((d) => !['admin', 'local', 'config'].includes(d.name));
    }
    p.needsAuth = false;
    p.warnings = p.warnings.filter((w) => !/could not log in/.test(w));
    p.status = `${p.details.databases.length} databases`;
    this.state.projects = this.projects.map((x) => this.publicProject(x));
    this.update();
  }

  // ---------------------------------------------------------------- preflight
  async preflight(selection, options = {}) {
    if (selection) this.state.selection = selection.filter((id) => this.projects.some((p) => p.id === id));
    this.state.options = { ...this.state.options, ...options, jobId: this.id };
    const { plan, checks } = computePlan({
      scan: this.scanData, ins: this.ins, projects: this.projects, selected: this.state.selection, options: this.state.options,
      src: this.srcInfo, tgt: this.tgtInfo, srcHost: this.src.cfg.host, tgtSshPort: this.tgt.cfg.port,
    });
    const sb = (this.srcInfo.bootId || '').split('|'), tb = (this.tgtInfo.bootId || '').split('|');
    if (sb[0] && sb[0] === tb[0] && sb[1] === tb[1] && sb[2] === tb[2]) checks.unshift({ id: 'same', level: 'error', title: 'Old and new VPS are the same server', detail: 'Enter the details of two different servers.' });
    // remote checks on target: ports in use, existing folders, internet
    const sel = this.projects.filter((p) => this.state.selection.includes(p.id));
    const portList = [...new Set(sel.filter((p) => p.kind !== 'site' && p.kind !== 'db').flatMap((p) => p.ports))];
    const webPorts = [...new Set(sel.filter((p) => p.kind === 'site').flatMap((p) => p.ports))];
    const tr = await this.tgt.sh(`listen_list
for p in ${shq(plan.proj.join('\n'))}; do :; done
printf '%s\\n' ${shq(plan.proj.join('\n'))} | while IFS= read -r d; do [ -n "$d" ] && [ -d "$d" ] && [ -n "$(ls -A "$d" 2>/dev/null)" ] && out EXISTS "$d" "$(du -sk "$d" 2>/dev/null | awk '{print $1}')"; done
for d in /proc/[0-9]*; do c=$(cat $d/comm 2>/dev/null); case $c in nginx|apache2|httpd|caddy|lighttpd|traefik|haproxy|node|python*|java|docker-proxy) echo "@@PROC \${d#/proc/} $c";; esac; done
if have curl; then curl -sI -m 10 https://nodejs.org >/dev/null 2>&1 && echo @@NET ok; elif have wget; then wget -q --spider -T 10 https://nodejs.org && echo @@NET ok; fi
true`);
    const listens = [];
    const procs = new Map();
    const exists = [];
    let net = false;
    for (const { type, raw } of records(tr.stdout)) {
      if (type === 'L') { const [addr, port, pids] = raw.split(' '); listens.push({ addr, port: +port, pids: pids === '-' ? [] : pids.split(',').map(Number) }); }
      if (type === 'EXISTS') { const f = fieldsOf(raw); exists.push({ dir: f[0], kb: +f[1] || 0 }); }
      if (type === 'PROC') { const [pid, comm] = raw.split(' '); procs.set(+pid, comm); }
      if (type === 'NET') net = true;
    }
    for (const port of portList) {
      const l = listens.find((x) => x.port === port);
      if (l) checks.push({ id: `port-${port}`, level: 'error', title: `Port ${port} is already used on the new VPS`, detail: `By ${l.pids.map((p) => procs.get(p) || p).join(', ') || 'another program'}. Stop it there first.` });
    }
    for (const port of webPorts) {
      const l = listens.find((x) => x.port === port);
      if (!l) continue;
      const who = l.pids.map((p) => procs.get(p)).filter(Boolean);
      const servers = new Set(sel.filter((p) => p.kind === 'site').map((p) => p.runtime?.type));
      if (who.length && !who.some((w) => servers.has(w) || (w === 'apache2' && servers.has('apache')) || (w === 'httpd' && servers.has('apache'))))
        checks.push({ id: `port-${port}`, level: 'error', title: `Port ${port} is used by ${who[0]} on the new VPS`, detail: 'Your websites need this port. Remove that web server from the new VPS first.' });
    }
    if (exists.length) {
      const big = exists.filter((e) => e.kb > 64);
      if (big.length) checks.push({ id: 'exists', level: 'warn', title: 'Some folders already exist on the new VPS', detail: `They will be replaced with the old VPS version: ${big.slice(0, 6).map((e) => `${e.dir} (${fmtKB(e.kb)})`).join(', ')}` });
    }
    const needsNet = plan.nodes.length || plan.pythons.length || Object.keys(plan.needs).length || plan.packages.length;
    if (needsNet && !net) checks.push({ id: 'net', level: 'warn', title: 'The new VPS may not have internet access', detail: 'Shift needs it to install software (Node.js, Python, Docker…).' });
    else if (needsNet) checks.push({ id: 'net', level: 'ok', title: 'New VPS can download software', detail: '' });
    // old IP hard-coded in configs
    if (/^\d+\.\d+\.\d+\.\d+$/.test(this.src.cfg.host) && plan.proj.length) {
      const g = await this.src.sh(`grep -rIlF --exclude='*.log' --exclude='*.session' --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=venv --exclude-dir=.venv --exclude-dir=__pycache__ ${shq(this.src.cfg.host)} ${plan.proj.map(shq).join(' ')} 2>/dev/null | head -n 8`, { timeout: 120000 }).catch(() => ({ stdout: '' }));
      const files = g.stdout.trim().split('\n').filter(Boolean);
      if (files.length) checks.push({ id: 'oldip', level: 'warn', title: 'The old IP address is written in some files', detail: `Update them after the move if needed: ${files.join(', ')}` });
    }
    if (plan.ports.length) checks.push({ id: 'fw', level: 'ok', title: 'Firewall', detail: `Ports ${plan.ports.join(', ')} will be opened on the new VPS if a firewall is active.` });
    const order = { error: 0, warn: 1, ok: 2 };
    checks.sort((a, b) => order[a.level] - order[b.level]);
    this.plan = plan;
    this.state.preflight = {
      checks, ok: !checks.some((c) => c.level === 'error'), totalKB: plan.totalKB, dbKB: plan.dbKB, mode: null,
      plan: { totalKB: plan.totalKB, paths: [...plan.base, ...plan.proj], ports: plan.ports, needs: plan.needs, nodes: plan.nodes.map((n) => n.version),
        pythons: plan.pythons.map((p) => p.version), users: plan.users.map((u) => u.name), crossArch: plan.crossArch },
    };
    this.update();
    return this.state.preflight;
  }

  // ---------------------------------------------------------------- run
  async start() {
    if (!this.plan || !this.state.preflight) throw new Error('Run the pre-flight checks first');
    if (!this.state.preflight.ok) throw new Error('Fix the red pre-flight items first');
    if (this.running) return;
    this.running = true;
    this.cancelled = false;
    this.update({ status: 'running', error: null });
    const st = (id) => this.state.steps.find((x) => x.id === id);
    if (st('preflight').status !== 'done') this.setStep('preflight', this.state.preflight.checks.some((c) => c.level === 'warn') ? 'warn' : 'done');
    try {
      await this.runStep('prepare', () => this.prepare());
      await this.runStep('sync', () => this.liveSync());
      if (this.state.options.rehearsal) {
        for (const id of ['cutover', 'final', 'start', 'verify']) this.setStep(id, 'skipped', 'Rehearsal mode');
        await this.runStep('cleanup', () => this.cleanup(false));
        this.update({ status: 'rehearsed', finishedAt: new Date().toISOString() });
        this.log('Rehearsal finished. Nothing was stopped on the old VPS. Start again without rehearsal mode to do the real move.', 'ok');
        return;
      }
      await this.runStep('cutover', () => this.cutover());
      await this.runStep('final', () => this.finalSync());
      await this.runStep('start', () => this.startTarget());
      const vr = await this.runStep('verify', () => this.verify());
      void vr;
      await this.runStep('cleanup', () => this.cleanup(true));
      this.progress({ overall: 1, current: 'Done', files: 1, databases: 1, services: 1 });
      this.update({ status: 'done', finishedAt: new Date().toISOString() });
      this.log('All projects now run on the new VPS 🎉', 'ok');
    } catch (e) {
      this.log(e.message, 'error');
      this.update({ error: e.message });
      if (this.state.cutoverStarted) {
        if (this.state.options.autoRollback) {
          this.log('Rolling back automatically — restarting your projects on the old VPS…', 'warn');
          await this.rollback(e.message).catch((er) => this.log(`Rollback problem: ${er.message}`, 'error'));
        } else this.update({ status: 'failed' });
      } else {
        this.log('Nothing was stopped on the old VPS — your projects there were never interrupted.', 'ok');
        await this.cleanup(false).catch(() => {});
        this.update({ status: 'failed' });
      }
    } finally {
      this.running = false;
      this.save();
    }
  }

  cancel() {
    if (this.state.cutoverStarted) throw new Error('Cannot cancel after projects were stopped. Use rollback instead.');
    this.cancelled = true;
  }

  sel() { return this.projects.filter((p) => this.plan.projects.includes(p.id)); }
  homeOf(user) { return this.scanData.passwd.find((u) => u.name === user)?.home || (user === 'root' ? '/root' : `/home/${user}`); }

  // ---------------------------------------------------------------- prepare
  async prepare() {
    const plan = this.plan, T = this.tgt, S = this.src;
    const stamp = `${this.id} ${new Date().toISOString()}`;
    await Promise.all([S.sh(`echo ${shq(stamp)} > /var/tmp/shift/lock`), T.sh(`echo ${shq(stamp)} > /var/tmp/shift/lock`)]);
    await T.writeFile(`${T.W}/pub/pycheck.py`, PYCHECK, { mode: '644' });
    const L = [];
    const crit = (title, cmd) => L.push(`step ${shq(title)} ${cmd} || exit 1`);
    const soft = (title, cmd) => L.push(`step ${shq(title)} ${cmd} || echo "@@WARN ${b64(title + ' did not fully succeed (continuing)')}"`);
    const essentials = ['rsync', 'curl', 'ca-certificates', 'tar', 'gzip'];
    crit('Install basic tools (rsync, curl…)', `act_pkgs ${essentials.map(shq).join(' ')}`);
    const extra = plan.packages.filter((p) => !essentials.includes(p));
    if (extra.length) soft('Install helper tools', `act_pkgs_try ${extra.map(shq).join(' ')}`);
    soft(`Set timezone to ${this.scanData.tz}`, `act_tz ${shq(this.scanData.tz)}`);
    const n = plan.needs;
    if (n.docker) crit('Install Docker', 'act_docker');
    if (n.supervisor) crit('Install Supervisor', 'act_supervisor');
    if (n.cron) crit('Install cron', 'act_cron_service');
    if (n.nginx) crit('Install nginx', 'act_nginx');
    if (n.apache) crit('Install Apache', 'act_apache');
    if (n.caddy) crit('Install Caddy', 'act_caddy');
    if (n.php) crit(`Install PHP ${n.php.version}`, `act_php ${shq(n.php.version)} ${n.php.mods.map(shq).join(' ')}`);
    if (n.certbot) soft('Install certbot (SSL renewals)', 'act_certbot');
    if (n.mysql) crit(`Install ${n.mysql === 'mariadb' ? 'MariaDB' : 'MySQL'}`, `act_mysql_server ${shq(n.mysql)}`);
    if (n.postgres) crit(`Install PostgreSQL ${n.postgres}`, `act_pg_server ${shq(n.postgres)}`);
    if (n.redis) crit('Install Redis', 'act_redis_server');
    if (n.mongodb) crit(`Install MongoDB ${n.mongodb}`, `act_mongo_server ${shq(n.mongodb)}`);
    for (const g of plan.groups) crit(`Create group ${g.name}`, `act_group ${shq(g.name)} ${shq(g.gid)}`);
    for (const u of plan.users) crit(`Create user ${u.name}`, `act_user ${shq(u.name)} ${shq(u.uid)} ${shq(u.group)} ${shq(u.home)} ${shq(u.shell)} ${shq(u.sup.join(','))}`);
    for (const nd of plan.nodes.filter((x) => x.kind === 'system')) {
      crit(`Install Node.js ${nd.version}`, `act_node ${shq(nd.version)} ${shq(nd.installPrefix)}`);
      for (const [a, b] of nd.links.filter(([x]) => !x.endsWith('/pm2'))) crit(`Link ${b}`, `act_link ${shq(a)} ${shq(b)}`);
      if (nd.globals.length) soft(`Install global npm tools (${nd.globals.map((g) => g.split('@')[0] || g).join(', ')})`, `act_npmg ${shq(nd.installPrefix + '/bin/node')} ${nd.globals.map(shq).join(' ')}`);
      for (const [a, b] of nd.links.filter(([x]) => x.endsWith('/pm2'))) crit(`Link ${b}`, `act_link ${shq(a)} ${shq(b)}`);
    }
    for (const v of plan.volumes) crit(`Create Docker volume ${v.name}`, `act_dvol ${shq(v.name)} ${Object.entries(v.labels).map(([k, val]) => shq(`${k}=${val}`)).join(' ')}`);
    const keyUsers = Object.keys(this.ins.authKeys).filter((u) => u === 'root' || plan.users.some((x) => x.name === u));
    for (const u of keyUsers) {
      await T.writeFile(`${T.W}/ak-${u}`, this.ins.authKeys[u], { mode: '600' });
      soft(`Add ${u}'s SSH login keys`, `act_authkeys ${shq(u)} ${shq(`${T.W}/ak-${u}`)}`);
    }
    for (const port of plan.ports) soft(`Open port ${port} in the firewall`, `act_fw_open ${shq(port)}`);
    this.progress({ current: 'Installing software on the new VPS…' });
    await this.runTask(T, `prepare-${this.attempt('prepare')}`, L.join('\n'));
    for (const r of this._lastTask.recs) if (r.type === 'VOL') { const f = fieldsOf(r.raw); this.state.results.volumes[f[0]] = f[1]; }
    this.save();
  }

  mappedVolumes() {
    return this.plan.volumes.map((v) => ({ src: v.src, dst: this.state.results.volumes[v.name] })).filter((m) => m.src && m.dst);
  }

  // ---------------------------------------------------------------- live sync
  async liveSync() {
    const plan = this.plan;
    this.transfer = new Transfer(this);
    this.progress({ current: 'Choosing the fastest way to copy…' });
    const mode = await this.transfer.setup();
    this.state.transfer.mode = mode;
    if (this.state.preflight) this.state.preflight.mode = mode;
    await this.transfer.filterExisting(plan);
    await this.transfer.writeLists(plan, this.state.protect);
    const total = Math.max(1, plan.totalKB * 1024);
    const onProgress = (p) => this.progress({ files: Math.min(0.98, p.percent / 100), speed: p.speed, eta: p.eta, current: `Copying files · ${p.percent}%` });
    this.log(`Copying ${fmtKB(plan.totalKB)} (${mode} mode)…`, 'info');
    const t0 = Date.now();
    await this.transfer.sync(plan, { phase: 'live', mapped: this.mappedVolumes(), name: `sync-1-${this.attempt('sync')}`, onProgress });
    this.log(`First copy finished in ${Math.round((Date.now() - t0) / 1000)}s`, 'ok');
    void total;
    await this.fixRuntimes();
    await this.prepareDocker();
    if (mode !== 'stream') {
      await this.transfer.writeLists(plan, this.state.protect);
      for (let pass = 2; pass <= 4; pass++) {
        const t = Date.now();
        this.progress({ current: `Catching up on changes (pass ${pass})…` });
        await this.transfer.sync(plan, { phase: 'live', mapped: this.mappedVolumes(), name: `sync-${pass}-${this.attempt('sync')}`, onProgress });
        const secs = (Date.now() - t) / 1000;
        this.log(`Pass ${pass} took ${Math.round(secs)}s`, 'info');
        if (secs < 20) break;
      }
    }
    this.progress({ files: 0.95 });
  }

  /** Make sure Node / Python environments work on the new VPS. */
  async fixRuntimes() {
    const plan = this.plan, T = this.tgt;
    const L = [];
    let any = false;
    for (const nd of plan.nodes.filter((x) => x.kind === 'home')) {
      L.push(`step ${shq(`Check Node.js ${nd.version}`)} act_node ${shq(nd.version)} ${shq(nd.prefix)} || exit 1`);
      L.push(`chown -R ${shq(this.ownerOf(nd.prefix))} ${shq(nd.prefix)} 2>/dev/null`);
      any = true;
    }
    for (const [i, py] of plan.pythons.entries()) {
      await T.writeFile(`${T.W}/pub/py-${i}.req`, py.req.join('\n') + '\n', { mode: '644' });
      await T.writeFile(`${T.W}/pub/py-${i}.opt`, py.opt.join('\n') + '\n', { mode: '644' });
      L.push(`echo "@@PYKEY ${i}"`);
      L.push(`step ${shq(`Prepare Python ${py.version} for ${posix.basename(py.cwd)}`)} act_pyfix ${shq(py.interp)} ${shq(py.version)} ${shq(py.venv || '-')} ${shq(py.owner)} ${shq(py.cwd)} "$SHIFT_W/pub/py-${i}.req" "$SHIFT_W/pub/py-${i}.opt" ${shq(py.newVenv || '-')} || exit 1`);
      any = true;
    }
    for (const r of plan.rebuild) {
      L.push(`step ${shq(`Rebuild native modules in ${r.dir}`)} act_node_rebuild ${shq(r.dir)} ${shq(r.owner)} ${shq(r.nodebin)} || echo "@@WARN ${b64(`Native modules in ${r.dir} could not be rebuilt`)}"`);
      any = true;
    }
    if (!any) return;
    this.progress({ current: 'Setting up Node.js / Python on the new VPS…' });
    let curKey = null;
    await this.runTask(T, `runtimes-${this.attempt('sync')}`, L.join('\n'), {
      onLine: (line, type) => {
        if (type === 'PYKEY') { curKey = Number(line.split(' ')[1]); return true; }
        if (type === 'PY' && curKey != null) {
          const [, how, p] = line.split(' ');
          const py = plan.pythons[curKey];
          this.state.results.py[py.key] = { how, path: p };
          if (how === 'rebuilt') {
            this.state.protect.push(p.replace(/\/?$/, '/'));
            if (!py.venv) for (const id of py.projects) this.state.results.interp[id] = { from: py.interp, to: `${p}/bin/python` };
            this.log(`Built a fresh Python ${py.version} environment at ${p}`, 'ok', 'new');
          }
          return true;
        }
        return false;
      },
    });
    this.save();
  }
  ownerOf(p) {
    const u = this.scanData.passwd.find((x) => x.home !== '/' && (p === x.home || p.startsWith(x.home + '/')));
    return u ? `${u.name}:${this.scanData.groups.find((g) => g.gid === u.gid)?.name || u.name}` : 'root:root';
  }

  async prepareDocker() {
    const sel = this.sel();
    const plan = this.plan;
    if (!plan.needs.docker) return;
    if (!plan.crossArch) {
      for (const im of plan.localImages) {
        this.log(`Copying local Docker image ${im.ref}…`, 'info');
        this.progress({ current: `Copying Docker image ${im.ref}…` });
        try {
          const t = this.transfer;
          await t.pipe(`docker save ${shq(im.ref)} | gzip -1`, `gunzip | docker load >/dev/null`, () => {});
        } catch (e) { this.log(`Could not copy image ${im.ref}: ${e.message}`, 'warn'); }
      }
    }
    const L = [];
    for (const p of sel.filter((x) => x.kind === 'compose')) {
      const c = this.composeCmd(p);
      L.push(`step ${shq(`Download images for ${p.name}`)} sh -c ${shq(`${c} pull --ignore-pull-failures -q 2>&1 | tail -n 5`)} || true`);
      L.push(`step ${shq(`Build images for ${p.name}`)} sh -c ${shq(`${c} build 2>&1 | tail -n 5`)} || true`);
    }
    for (const p of sel.filter((x) => x.kind === 'container')) {
      const im = p.details.images[0];
      if (im?.digests?.length) L.push(`step ${shq(`Download image ${im.ref}`)} docker pull -q ${shq(im.ref)} || true`);
    }
    if (L.length) await this.runTask(this.tgt, `docker-prep-${this.attempt('sync')}`, L.join('\n'), { critical: false });
  }

  composeCmd(p) {
    const d = p.details;
    let c = `cd ${shq(d.workdir || p.dir)} && docker compose -p ${shq(d.project)}`;
    for (const f of d.configFiles) c += ` -f ${shq(f)}`;
    for (const f of d.envFiles) c += ` --env-file ${shq(f)}`;
    return c;
  }

  // ---------------------------------------------------------------- cutover
  async cutover() {
    const S = this.src;
    const sel = this.sel();
    this.update({ cutoverStarted: true });
    const R = this.state.records;
    // 1. baselines
    this.progress({ current: 'Recording how your apps respond right now…' });
    const hl = this.httpChecks(sel);
    if (hl.length) {
      const r = await S.sh(hl.join('\n'));
      R.http ||= {};
      for (const { type, raw } of records(r.stdout)) if (type === 'HTTP') { const [k, code] = raw.split(' '); if (!(k in R.http)) R.http[k] = code; }
    }
    // 2. pm2: save fresh dumps, keep a filtered copy for the new VPS and for rollback
    for (const [user, apps] of this.groupPm2(sel)) {
      const d = apps[0].details;
      await S.sh(`backup_file ${shq(d.home + '/.pm2/dump.pm2')}; pm2_do ${shq(user)} ${shq(d.home)} ${shq(d.pm2bin)} ${shq(d.nodebin)} save --force >/dev/null 2>&1; true`, { actions: true });
      const raw = await S.readFile(`${d.home}/.pm2/dump.pm2`);
      let dump = [];
      try { dump = JSON.parse(raw || '[]'); } catch { dump = this.scanData.pm2Dumps[d.home] || []; }
      const names = new Set(apps.map((a) => a.name));
      const filtered = dump.filter((x) => names.has(x.name));
      if (!filtered.length) throw new Error(`Could not read the PM2 process list for ${user}`);
      R.pm2 ||= {};
      if (!R.pm2[user]) {
        R.pm2[user] = { user, home: d.home, pm2bin: d.pm2bin, nodebin: d.nodebin, names: [...names] };
        await S.writeFile(`${S.BK}/pm2-rollback-${user}.json`, JSON.stringify(filtered), { mode: '600' });
      }
      this.pm2Dumps ||= {};
      this.pm2Dumps[user] = filtered;
    }
    this.save();
    // 3. stop everything (records first, then actions)
    const L = [];
    const crit = (title, cmd) => L.push(`step ${shq(title)} ${cmd} || exit 1`);
    const checks = [];
    for (const [user, rec] of Object.entries(R.pm2 || {})) {
      crit(`Stop PM2 apps (${rec.names.join(', ')})`, `act_pm2_stop ${shq(user)} ${shq(rec.home)} ${shq(rec.pm2bin)} ${shq(rec.nodebin)} ${rec.names.map(shq).join(' ')}`);
    }
    for (const p of sel) {
      const d = p.details;
      const key = p.id;
      if (p.kind === 'systemd') {
        R[key] ||= { kind: 'systemd', unit: d.unit, enabled: d.enabled, active: d.active };
        crit(`Stop service ${d.unit}`, `act_unit_stop ${shq(d.unit)}`);
        checks.push(`unit:${d.unit}`);
      } else if (p.kind === 'supervisor') {
        R[key] ||= { kind: 'supervisor', conf: d.conf, programs: d.programs };
        crit(`Stop ${p.title} (supervisor)`, `act_sup_disable ${shq(d.conf)} ${d.programs.map(shq).join(' ')}`);
        for (const pr of d.programs) checks.push(`sup:${pr}`);
      } else if (p.kind === 'process') {
        const name = slug(p.name);
        const argv = fixArgv(d.argv);
        const script = `${S.BK}/launch/${name}.sh`;
        if (!R[key]) {
          await S.writeFile(script, launcherScript({ cwd: p.dir, env: d.env, argv, pidfile: `/var/lib/shift/pids/${name}.pid`, home: this.homeOf(p.user), user: p.user }), { mode: '755' });
          R[key] = { kind: 'process', user: p.user, launcher: d.launcher, name: d.session || name, slug: name, script, log: `/var/log/shift/${name}.log`,
            cmdline: (d.argvRaw || d.argv).join(' '), alt: argv.join(' ') };
        }
        crit(`Stop ${p.title}`, `act_proc_stop ${p.pids.map(shq).join(' ')}`);
        for (const pid of p.pids) checks.push(`pid:${pid}`);
      } else if (p.kind === 'compose' || p.kind === 'container') {
        R[key] ||= { kind: 'docker', containers: d.containers.map((c) => ({ id: c.id, restart: c.restart, running: c.running })) };
        for (const c of d.containers.filter((x) => x.running)) {
          crit(`Stop container ${c.name}`, `act_docker_stop ${shq(c.id)}`);
          checks.push(`docker:${c.id}`);
        }
      } else if (p.kind === 'cron') {
        R[key] ||= { kind: 'cron', user: p.user };
        crit(`Pause scheduled jobs of ${p.user}`, `act_cron_disable ${shq(p.user)}`);
      } else if (p.kind === 'crond') {
        R[key] ||= { kind: 'crond', path: d.path };
        crit(`Pause ${d.path}`, `act_file_park ${shq(d.path)}`);
      } else if (p.kind === 'site') {
        R[key] ||= { kind: 'site', server: d.server, enabledPath: d.enabledPath };
        if (d.server === 'nginx') crit(`Turn off website ${p.title}`, `act_ngx_disable ${shq(d.enabledPath)}`);
        else if (d.server === 'apache') crit(`Turn off website ${p.title}`, `act_apache_disable ${shq(d.enabledPath)}`);
        else if (d.server === 'caddy') crit('Stop Caddy', 'act_svc_park caddy');
      }
    }
    for (const rec of Object.values(R.pm2 || {})) void rec;
    // pm2 pids
    for (const p of sel.filter((x) => x.kind === 'pm2')) for (const pid of p.pids) checks.push(`pid:${pid}`);
    const dirs = [...new Set(sel.filter((p) => ['pm2', 'systemd', 'process', 'supervisor'].includes(p.kind)).map((p) => p.dir).filter((d) => d && d.length > 1 && !['/root', '/home'].includes(d)))];
    if (dirs.length) L.push(`step ${shq('Stop leftover processes')} act_kill_strays ${dirs.map(shq).join(' ')} || true`);
    crit('Make sure everything is stopped', `confirm_stopped ${checks.map(shq).join(' ')}`);
    this.save();
    this.progress({ current: 'Stopping projects on the old VPS…', services: 0.1 });
    await this.runTask(S, `cutover-${this.attempt('cutover')}`, L.join('\n'));
    this.log('All selected projects are stopped on the old VPS', 'ok', 'old');
    // 4. databases
    const dbs = sel.filter((p) => p.kind === 'db');
    if (dbs.length) {
      const D = [];
      if (this.mongoUri) D.push(`export MONGO_URI=${shq(this.mongoUri)}`);
      for (const p of dbs) {
        const e = p.details.engine;
        R[p.id] ||= { kind: 'db', engine: e };
        const names = p.details.databases.map((x) => x.name);
        if (e === 'mysql') D.push(`step ${shq('Back up MySQL/MariaDB')} act_mysql_dump ${shq(names.join(' '))} || exit 1`);
        if (e === 'postgres') D.push(`step ${shq('Back up PostgreSQL')} act_pg_dump || exit 1`);
        if (e === 'redis') D.push(`step ${shq('Back up Redis')} act_redis_dump || exit 1`);
        if (e === 'mongodb') D.push(`step ${shq('Back up MongoDB')} act_mongo_dump || exit 1`);
        D.push(`step ${shq(`Stop ${p.title} on the old VPS`)} act_db_park ${shq(e)} || exit 1`);
      }
      this.save();
      this.progress({ current: 'Backing up databases…', databases: 0.2 });
      await this.runTask(S, `dbdump-${this.attempt('cutover')}`, D.join('\n'));
      this.progress({ databases: 0.5 });
    }
  }

  groupPm2(sel) {
    const m = new Map();
    for (const p of sel.filter((x) => x.kind === 'pm2')) { if (!m.has(p.user)) m.set(p.user, []); m.get(p.user).push(p); }
    return m;
  }

  httpChecks(sel) {
    const L = [];
    for (const p of sel) {
      if (['db', 'cron', 'crond'].includes(p.kind)) continue;
      if (p.kind === 'site') {
        for (const d of p.domains.slice(0, 5)) {
          L.push(`printf '@@HTTP %s %s\\n' ${shq(`host:${d}`)} "$(http_code http://127.0.0.1/ ${shq(d)})"`);
          if (p.details.ssl) L.push(`printf '@@HTTP %s %s\\n' ${shq(`https:${d}`)} "$(https_code ${shq(d)})"`);
        }
      } else {
        for (const port of p.ports.slice(0, 5)) L.push(`printf '@@HTTP %s %s\\n' ${shq(`port:${port}`)} "$(http_code http://127.0.0.1:${port}/)"`);
      }
    }
    return L;
  }

  // ---------------------------------------------------------------- final sync
  async finalSync() {
    const plan = this.plan, S = this.src, T = this.tgt;
    const sel = this.sel();
    const dbs = sel.filter((p) => p.kind === 'db');
    if (!this.transfer) { this.transfer = new Transfer(this); this.transfer.mode = this.state.transfer.mode; await this.transfer.setup(); }
    await this.transfer.writeLists(plan, this.state.protect);
    const mapped = this.mappedVolumes();
    if (dbs.length) mapped.push({ src: `${S.W}/db`, dst: `${T.W}/db` });
    this.progress({ current: 'Final copy of recent changes…' });
    await this.transfer.sync(plan, { phase: 'final', mapped, name: `final-${this.attempt('final')}`, sinceStamp: true,
      onProgress: (p) => this.progress({ files: 0.95 + p.percent / 2000, speed: p.speed, eta: p.eta }) });
    this.progress({ files: 1 });
    // verify files
    const checksum = plan.opt.verify === 'checksum' || (plan.opt.verify === 'auto' && plan.totalKB < 5 * 1024 * 1024);
    this.progress({ current: checksum ? 'Comparing file checksums…' : 'Comparing files…' });
    const diffs = await this.transfer.verify(plan, { checksum });
    if (diffs.length) {
      for (const d of diffs.slice(0, 20)) this.log(`Different: ${d}`, 'error');
      throw new Error(`${diffs.length} file${diffs.length > 1 ? 's are' : ' is'} different on the new VPS after copying`);
    }
    this.log(`All files are identical on both servers${checksum ? ' (checksums match)' : ''}`, 'ok');
    // databases
    if (dbs.length) {
      const L = [];
      for (const p of dbs) {
        const e = p.details.engine;
        if (e === 'mysql') L.push(`step ${shq('Restore MySQL/MariaDB')} act_mysql_restore || exit 1`, `act_mysql_count ${shq(p.details.databases.map((x) => x.name).join(' '))} | sed 's/^/@@COUNT /'`);
        if (e === 'postgres') L.push(`step ${shq('Restore PostgreSQL')} act_pg_restore || exit 1`, `act_pg_count | sed 's/^/@@COUNT /'`);
        if (e === 'redis') L.push(`step ${shq('Restore Redis')} act_redis_restore || exit 1`, `act_redis_count | sed 's/^/@@COUNT /'`);
        if (e === 'mongodb') L.push(`step ${shq('Restore MongoDB')} act_mongo_restore || exit 1`, `act_mongo_count | sed 's/^/@@COUNT /'`);
      }
      this.progress({ current: 'Restoring databases…', databases: 0.6 });
      const got = new Map();
      await this.runTask(T, `dbrestore-${this.attempt('final')}`, L.join('\n'), {
        onLine: (line, type) => { if (type === 'COUNT') { const [eng, name, cnt] = line.slice(8).split('|'); got.set(`${eng}|${name}`, cnt); return true; } return false; },
      });
      const want = new Map();
      for (const e of ['mysql', 'pg', 'redis', 'mongo']) {
        const txt = await S.readFile(`${S.W}/db/${e}.counts`);
        for (const l of String(txt || '').split('\n').filter(Boolean)) { const [eng, name, cnt] = l.split('|'); want.set(`${eng}|${name}`, cnt); }
      }
      const bad = [];
      for (const [k, v] of want) {
        if (got.get(k) === v) continue;
        const msg = `${k.split('|')[1]}: ${v} rows on old, ${got.get(k) ?? 'missing'} on new`;
        if (k.startsWith('redis|') && got.has(k) && Number(got.get(k)) >= Number(v) * 0.9) { this.log(`Redis ${msg} (keys with expiry are normal)`, 'warn'); continue; }
        bad.push(msg);
      }
      if (bad.length) { for (const b of bad.slice(0, 15)) this.log(b, 'error'); throw new Error(`Database check failed (${bad.length} table${bad.length > 1 ? 's' : ''} differ)`); }
      this.log(`Databases restored — ${want.size} tables/collections checked, all row counts match`, 'ok', 'new');
      this.progress({ databases: 1 });
    } else this.progress({ databases: 1 });
  }

  // ---------------------------------------------------------------- start
  interpFor(p, cur) {
    const r = this.state.results.interp[p.id];
    if (r && (cur === r.from || !cur)) return r.to;
    return cur;
  }

  async startTarget() {
    const T = this.tgt, plan = this.plan;
    const sel = this.sel();
    const sysd = plan.tgtSystemd;
    const conv = this.state.options.convertToSystemd;
    const L = [];
    const crit = (title, cmd) => L.push(`step ${shq(title)} ${cmd} || exit 1`);
    const R = this.state.records;
    this.started = { units: [], pm2: {}, sup: [], launch: [], compose: [], sites: [], cron: [] };
    const cronUsers = new Set();
    for (const p of sel) if (p.kind === 'cron') cronUsers.add(p.user);
    if (!sysd) for (const p of sel) if (['process', 'systemd', 'pm2'].includes(p.kind)) cronUsers.add(p.user);
    for (const u of cronUsers) L.push(`act_cron_backup ${shq(u)}`);
    if (sysd) L.push('systemctl daemon-reload 2>/dev/null');
    L.push(`T0=$(date +%s); echo "@@T0 $T0"`);
    const fam = this.tgtInfo.family;
    // pm2
    for (const [user, apps] of this.groupPm2(sel)) {
      const d = apps[0].details;
      const dump = (this.pm2Dumps?.[user] || []).map((e) => {
        const app = apps.find((a) => a.name === e.name);
        const to = app && this.interpFor(app, e.exec_interpreter);
        return to && to !== e.exec_interpreter ? { ...e, exec_interpreter: to } : e;
      });
      if (!dump.length) {
        const txt = await this.src.readFile(`${this.src.BK}/pm2-rollback-${user}.json`);
        dump.push(...JSON.parse(txt || '[]'));
      }
      const f = `${T.W}/pm2-${user}.json`;
      await T.writeFile(f, JSON.stringify(dump), { mode: '600' });
      for (const a of apps) if (a.details.errLog) L.push(`printf '@@LOGOFF %s %s\\n' ${shq(a.id)} "$(wc -c < ${shq(a.details.errLog)} 2>/dev/null || echo 0)"`);
      crit(`Start PM2 apps (${apps.map((a) => a.name).join(', ')})`, `act_pm2_load ${shq(user)} ${shq(d.home)} ${shq(d.pm2bin)} ${shq(d.nodebin)} ${shq(f)}`);
      L.push(`step ${shq(`Start PM2 on boot for ${user}`)} act_pm2_boot ${shq(user)} ${shq(d.home)} ${shq(d.pm2bin)} ${shq(d.nodebin)} || true`);
      this.started.pm2[user] = { home: d.home, pm2bin: d.pm2bin, nodebin: d.nodebin, names: apps.map((a) => a.name) };
    }
    for (const p of sel) {
      const d = p.details;
      if (p.kind === 'systemd') {
        const up = d.unitParsed;
        const argv = [...up.argv];
        const ni = this.interpFor(p, argv[0]);
        if (ni && ni !== argv[0]) argv[0] = ni;
        if (sysd) {
          let content = d.content;
          if (ni && ni !== up.argv[0]) content = content.replace(up.argv[0], ni);
          await T.writeFile(d.path, content, { mode: '644' });
          if (d.active || d.enabled) crit(`Start service ${d.unit}`, d.active ? `act_unit_start ${shq(d.unit)} ${d.enabled ? 1 : 0}` : `svc enable ${shq(d.unit)}`);
          this.started.units.push(d.unit);
        } else {
          const name = slug(p.name);
          const script = `/etc/shift/launch/${name}.sh`;
          const env = { ...up.env };
          await T.writeFile(script, launcherScript({ cwd: up.workdir || this.homeOf(up.user), env, argv, envFiles: up.envFiles, pidfile: `/var/lib/shift/pids/${name}.pid`, home: this.homeOf(up.user), user: up.user }), { mode: '755' });
          crit(`Start ${p.title}`, `act_launch ${shq(up.user)} nohup ${shq(name)} ${shq(script)} ${shq(`/var/log/shift/${name}.log`)} ${shq(name)}`);
          L.push(`act_launch_boot ${shq(up.user)} nohup ${shq(name)} ${shq(script)} ${shq(`/var/log/shift/${name}.log`)} || true`);
          this.started.launch.push({ id: p.id, name, user: up.user, log: `/var/log/shift/${name}.log` });
        }
      } else if (p.kind === 'process') {
        const rec = R[p.id];
        const name = rec?.slug || slug(p.name);
        const argv = fixArgv([...d.argv]);
        const ni = this.interpFor(p, argv[0]);
        if (ni) argv[0] = ni;
        const script = `/etc/shift/launch/${name}.sh`;
        const useUnit = sysd && conv;
        await T.writeFile(script, launcherScript({ cwd: p.dir, env: d.env, argv, pidfile: useUnit ? null : `/var/lib/shift/pids/${name}.pid`, home: this.homeOf(p.user), user: p.user }), { mode: '755' });
        if (useUnit) {
          const unit = `shift-${name}.service`;
          await T.writeFile(`/etc/systemd/system/${unit}`, unitFile({ title: p.title, user: p.user, cwd: p.dir, script }), { mode: '644' });
          crit(`Start ${p.title} (as service ${unit})`, `act_unit_start ${shq(unit)} 1`);
          this.started.units.push(unit);
          p.targetUnit = unit;
        } else {
          const mode = d.launcher === 'screen' || d.launcher === 'tmux' ? d.launcher : 'nohup';
          crit(`Start ${p.title}`, `act_launch ${shq(p.user)} ${mode} ${shq(d.session || name)} ${shq(script)} ${shq(`/var/log/shift/${name}.log`)} ${shq(name)}`);
          L.push(`act_launch_boot ${shq(p.user)} ${mode === 'tmux' ? 'nohup' : mode} ${shq(d.session || name)} ${shq(script)} ${shq(`/var/log/shift/${name}.log`)} || true`);
          this.started.launch.push({ id: p.id, name, session: d.session || name, user: p.user, log: `/var/log/shift/${name}.log` });
        }
      } else if (p.kind === 'supervisor') {
        const base = posix.basename(d.conf).replace(/\.(conf|ini)$/, '');
        const dst = fam === 'debian' ? `/etc/supervisor/conf.d/${base}.conf` : fam === 'alpine' ? `/etc/supervisor.d/${base}.ini` : fam === 'rhel' ? `/etc/supervisord.d/${base}.ini` : d.conf;
        let content = d.content;
        const ri = this.state.results.interp[p.id];
        if (ri) content = content.split(ri.from).join(ri.to);
        await T.writeFile(dst, content, { mode: '644' });
        crit(`Start ${p.title} (supervisor)`, 'act_supervisor && act_sup_apply');
        this.started.sup.push({ conf: dst, programs: d.programs });
      } else if (p.kind === 'compose') {
        crit(`Start Docker app ${p.name}`, `sh -c ${shq(`${this.composeCmd(p)} up -d`)}`);
        this.started.compose.push({ id: p.id, cmd: this.composeCmd(p) });
      } else if (p.kind === 'container') {
        const name = slug(p.name);
        const dir = `/etc/shift/compose/${name}`;
        await T.writeFile(`${dir}/docker-compose.yml`, containerCompose(d.inspect, this.scanData.docker.images || []), { mode: '644' });
        crit(`Start container ${p.name}`, `sh -c ${shq(`cd ${dir} && docker compose -p ${name} up -d`)}`);
        this.started.compose.push({ id: p.id, cmd: `cd ${dir} && docker compose -p ${name}` });
      } else if (p.kind === 'cron') {
        await T.writeFile(`${T.W}/cron-${p.user}`, d.content, { mode: '600' });
        crit(`Install scheduled jobs for ${p.user}`, `act_cron_install ${shq(p.user)} ${shq(`${T.W}/cron-${p.user}`)}`);
        this.started.cron.push(p.user);
      } else if (p.kind === 'crond') {
        await T.writeFile(d.path, d.content, { mode: '644' });
        this.started.cron.push(`file:${d.path}`);
      }
    }
    // websites last (apps behind them are up)
    const sites = sel.filter((p) => p.kind === 'site');
    for (const p of sites) {
      const d = p.details;
      if (d.server === 'nginx') {
        const name = posix.basename(d.realPath).replace(/\.conf$/, '') || slug(p.name);
        await T.writeFile(`${T.W}/pub/ngx-${name}`, d.content, { mode: '644' });
        crit(`Add website ${p.title}`, `act_ngx_place ${shq(name)} ${shq(`${T.W}/pub/ngx-${name}`)}`);
        this.started.sites.push({ server: 'nginx', name });
      } else if (d.server === 'apache') {
        const name = posix.basename(d.realPath).replace(/\.conf$/, '');
        await T.writeFile(`${T.W}/pub/apache-${name}`, d.content, { mode: '644' });
        crit(`Add website ${p.title}`, `act_apache_place ${shq(name)} ${shq(`${T.W}/pub/apache-${name}`)} ${shq((this.scanData.apache.mods || []).join(' '))}`);
        this.started.sites.push({ server: 'apache', name });
      }
    }
    if (sites.some((p) => p.details.server === 'nginx')) {
      const roots = sites.flatMap((p) => p.details.roots || []);
      L.push(`act_selinux ${roots.map(shq).join(' ')} /etc/nginx /etc/letsencrypt 2>/dev/null || true`);
      crit('Start nginx with your websites', 'act_ngx_apply');
    }
    if (sites.some((p) => p.details.server === 'apache')) crit('Start Apache with your websites', 'act_apache_apply');
    if (sites.some((p) => p.details.server === 'caddy')) crit('Start Caddy', 'act_caddy_apply');
    this.save();
    this.progress({ current: 'Starting your projects on the new VPS…', services: 0.4 });
    this.logOffsets = {};
    await this.runTask(T, `start-${this.attempt('start')}`, L.join('\n'), {
      onLine: (line, type) => {
        if (type === 'T0') { this.t0 = Number(line.split(' ')[1]); return true; }
        if (type === 'LOGOFF') { const [, id, off] = line.split(' '); this.logOffsets[id] = Number(off) || 0; return true; }
        return false;
      },
    });
    this.state.records.started = this.started;
    this.progress({ services: 0.7 });
    this.log('Projects started on the new VPS', 'ok', 'new');
  }

  // ---------------------------------------------------------------- verify
  statusScript(sel) {
    const L = ['listen_list'];
    for (const [user, s] of Object.entries(this.started?.pm2 || {})) L.push(`printf '@@PM2J %s %s\\n' ${shq(user)} "$(pm2_do ${shq(user)} ${shq(s.home)} ${shq(s.pm2bin)} ${shq(s.nodebin)} jlist 2>/dev/null | base64 | tr -d '\\n')"`);
    for (const u of this.started?.units || []) L.push(`printf '@@UNITST %s %s\\n' ${shq(u)} "$(systemctl show -p ActiveState -p NRestarts -p SubState ${shq(u)} 2>/dev/null | tr '\\n' ' ' | base64 | tr -d '\\n')"`);
    for (const l of this.started?.launch || []) L.push(`act_pidfile_alive ${shq(l.name)} && echo "@@PIDF ${l.id} alive" || echo "@@PIDF ${l.id} dead"`);
    for (const c of this.started?.compose || []) L.push(`printf '@@DOCK %s %s\\n' ${shq(c.id)} "$(sh -c ${shq(`${c.cmd} ps -a -q`)} 2>/dev/null | xargs -r docker inspect -f '{{.Name}}|{{.State.Running}}|{{.RestartCount}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' 2>/dev/null | tr '\\n' ' ' | base64 | tr -d '\\n')"`);
    for (const s of this.started?.sup || []) for (const pr of s.programs) L.push(`printf '@@SUPST %s %s\\n' ${shq(pr)} "$(supervisorctl status ${shq(pr)} 2>/dev/null | base64 | tr -d '\\n')"`);
    L.push(...this.httpChecks(sel));
    return L.join('\n');
  }

  parseStatus(text) {
    const st = { listens: [], pm2: {}, units: {}, pidf: {}, dock: {}, sup: {}, http: {} };
    for (const { type, raw } of records(text)) {
      const [a, b] = raw.split(' ');
      if (type === 'L') { const [addr, port] = raw.split(' '); st.listens.push({ addr, port: +port }); }
      if (type === 'PM2J') { try { const j = dec(b); st.pm2[a] = JSON.parse(j.slice(j.indexOf('['))); } catch { st.pm2[a] = []; } }
      if (type === 'UNITST') { const o = {}; for (const kv of dec(b).trim().split(' ')) { const [k, v] = kv.split('='); o[k] = v; } st.units[a] = o; }
      if (type === 'PIDF') st.pidf[a] = b === 'alive';
      if (type === 'DOCK') st.dock[a] = dec(b).trim().split(' ').filter(Boolean).map((x) => { const [n, r, rc, h] = x.split('|'); return { name: n, running: r === 'true', restarts: +rc || 0, health: h }; });
      if (type === 'SUPST') st.sup[a] = dec(b);
      if (type === 'HTTP') st.http[a] = b;
    }
    return st;
  }

  async verify() {
    const T = this.tgt;
    const sel = this.sel();
    const wait = Math.max(10, Number(this.state.options.stabilitySeconds) || 30);
    this.progress({ current: 'Watching your projects for stability…' });
    const first = this.parseStatus((await T.sh(this.statusScript(sel), { actions: true })).stdout);
    for (let s = 0; s < wait; s += 5) {
      this.progress({ current: `Watching your projects for stability… ${wait - s}s`, services: 0.7 + (0.25 * s) / wait });
      await sleep(5000);
    }
    const last = this.parseStatus((await T.sh(this.statusScript(sel), { actions: true })).stdout);
    const results = [];
    let critical = false;
    const R = this.state.records;
    for (const p of sel) {
      const checks = [];
      const ok = (name, detail = '') => checks.push({ name, level: 'ok', detail });
      const warn = (name, detail = '') => checks.push({ name, level: 'warn', detail });
      const fail = (name, detail = '') => { checks.push({ name, level: 'error', detail }); critical = true; };
      const wasRunning = p.running;
      if (p.kind === 'pm2') {
        for (const name of [p.name]) {
          const a = (last.pm2[p.user] || []).find((x) => x.name === name);
          const a0 = (first.pm2[p.user] || []).find((x) => x.name === name);
          if (!a) { if (wasRunning) fail('Running', 'Not found in PM2'); continue; }
          const status = a.pm2_env?.status;
          const r0 = a0?.pm2_env?.restart_time || 0, r1 = a.pm2_env?.restart_time || 0;
          if (status === 'online' && r1 - r0 <= 1) ok('Running', `PM2 status: online`);
          else if (wasRunning) fail('Running', status === 'online' ? `Restarted ${r1 - r0} times in ${wait}s (crash loop)` : `PM2 status: ${status}`);
        }
      } else if (p.kind === 'systemd' || (p.kind === 'process' && p.targetUnit)) {
        const unit = p.kind === 'systemd' ? p.details.unit : p.targetUnit;
        const u1 = last.units[unit], u0 = first.units[unit];
        if (u1) {
          const restarts = (+u1.NRestarts || 0) - (+u0?.NRestarts || 0);
          if (u1.ActiveState === 'active' && restarts <= 1) ok('Running', 'Service is active');
          else if (wasRunning || p.kind === 'process') fail('Running', u1.ActiveState !== 'active' ? `Service is ${u1.ActiveState}` : `Restarted ${restarts} times (crash loop)`);
        } else if (this.started.launch.find((l) => l.id === p.id)) {
          if (last.pidf[p.id]) ok('Running'); else if (wasRunning) fail('Running', 'The process exited');
        }
      } else if (p.kind === 'process' || (p.kind === 'systemd' && !p.targetUnit)) {
        if (last.pidf[p.id]) ok('Running', 'Process is alive'); else fail('Running', 'The process exited');
      } else if (p.kind === 'compose' || p.kind === 'container') {
        const cs = last.dock[p.id] || [], c0 = first.dock[p.id] || [];
        const wanted = R[p.id]?.containers?.filter((c) => c.running).length || 0;
        const up = cs.filter((c) => c.running);
        const looping = cs.some((c) => c.restarts - (c0.find((x) => x.name === c.name)?.restarts || 0) > 1);
        const unhealthy = cs.filter((c) => c.health === 'unhealthy');
        if (up.length >= wanted && !looping && !unhealthy.length) ok('Running', `${up.length} container${up.length === 1 ? '' : 's'} up`);
        else fail('Running', looping ? 'A container keeps restarting' : unhealthy.length ? `${unhealthy[0].name} is unhealthy` : `${up.length} of ${wanted} containers running`);
      } else if (p.kind === 'supervisor') {
        const allUp = p.details.programs.every((pr) => /RUNNING/.test(last.sup[pr] || ''));
        if (allUp) ok('Running'); else fail('Running', 'Not running under supervisor');
      }
      // ports
      if (!['db', 'cron', 'crond'].includes(p.kind)) {
        for (const port of p.ports) {
          if (last.listens.some((l) => l.port === port)) ok(`Port ${port}`, 'Listening');
          else if (wasRunning) fail(`Port ${port}`, 'Nothing is listening');
        }
      }
      // http
      const keys = p.kind === 'site' ? p.domains.slice(0, 5).flatMap((d) => [`host:${d}`, `https:${d}`]) : p.ports.slice(0, 5).map((x) => `port:${x}`);
      for (const k of keys) {
        const before = R.http?.[k], after = last.http[k];
        if (before === undefined || after === undefined || before === '000') continue;
        const label = k.startsWith('port:') ? `Web check port ${k.slice(5)}` : `${k.startsWith('https') ? 'HTTPS' : 'HTTP'} ${k.split(':')[1]}`;
        if (before === after) ok(label, `Same answer as before (${after})`);
        else if (/^[234]/.test(before) && (after === '000' || /^5/.test(after))) fail(label, `Was ${before} on the old VPS, now ${after}`);
        else warn(label, `Was ${before} on the old VPS, now ${after}`);
      }
      // logs
      const logs = await this.recentLogs(p);
      if (logs) {
        for (const [re, msg] of FATAL_PATTERNS) if (re.test(logs)) { const line = logs.split('\n').find((l) => re.test(l)); fail('Logs', `${msg} “${line.trim().slice(0, 160)}”`); }
        for (const [re, msg] of WARN_PATTERNS) if (re.test(logs)) { const line = logs.split('\n').find((l) => re.test(l)); warn('Logs', `${msg} “${line.trim().slice(0, 160)}”`); }
        if (!checks.some((c) => c.name === 'Logs')) ok('Logs', 'No errors');
      }
      if (p.kind === 'db') ok('Data', 'Row counts match');
      if (p.kind === 'cron' || p.kind === 'crond') ok('Installed', 'Same schedule as before');
      if (p.kind === 'site' && !checks.length) ok('Configured');
      results.push({ id: p.id, title: p.title, checks });
    }
    // outside reachability
    const pub = this.plan.ports.slice(0, 10);
    for (const port of pub) {
      const reach = await tcpCheck(this.tgt.cfg.host, port);
      const target = results.find((r) => sel.find((p) => p.id === r.id)?.ports.includes(port)) || results[0];
      if (target) target.checks.push(reach ? { name: `Internet → port ${port}`, level: 'ok', detail: 'Reachable from outside' } : { name: `Internet → port ${port}`, level: 'warn', detail: 'Not reachable from the internet — open it in your provider\'s firewall panel' });
    }
    this.state.results.verify = results;
    this.progress({ services: 1 });
    this.update();
    if (critical) throw new Error('Some projects did not start correctly on the new VPS');
    return results.some((r) => r.checks.some((c) => c.level === 'warn')) ? 'warn' : 'done';
  }

  async recentLogs(p) {
    const T = this.tgt;
    let cmd = null;
    const since = this.t0 || Math.floor(Date.now() / 1000) - 120;
    if (p.kind === 'pm2' && p.details.errLog) {
      const off = this.logOffsets?.[p.id] || 0;
      cmd = `tail -c +${off + 1} ${shq(p.details.errLog)} 2>/dev/null | tail -n 80; ${p.details.outLog ? `tail -n 40 ${shq(p.details.outLog)} 2>/dev/null` : ''}`;
    } else if ((p.kind === 'systemd' || p.kind === 'process') && this.plan.tgtSystemd && (p.kind === 'systemd' || p.targetUnit)) {
      cmd = `journalctl -u ${shq(p.kind === 'systemd' ? p.details.unit : p.targetUnit)} --since @${since} -n 120 --no-pager -o cat 2>/dev/null`;
    } else if (p.kind === 'process' || p.kind === 'systemd') {
      const l = this.started.launch.find((x) => x.id === p.id);
      if (l) cmd = `tail -n 120 ${shq(l.log)} 2>/dev/null`;
    } else if (p.kind === 'compose' || p.kind === 'container') {
      const c = this.started.compose.find((x) => x.id === p.id);
      if (c) cmd = `sh -c ${shq(`${c.cmd} logs --since ${since} --tail 120 2>&1`)}`;
    }
    if (!cmd) return '';
    const r = await T.sh(cmd, { timeout: 60000 }).catch(() => ({ stdout: '' }));
    return r.stdout || '';
  }

  // ---------------------------------------------------------------- rollback
  async rollback(reason = 'Requested by user') {
    const S = this.src, T = this.tgt;
    this.update({ status: 'rolling-back', error: reason });
    this.progress({ current: 'Rolling back…' });
    const R = this.state.records;
    const started = R.started || this.started || {};
    // 1. stop on new VPS (best effort)
    const L = [];
    const soft = (title, cmd) => L.push(`step ${shq(title)} ${cmd} || true`);
    for (const [user, s] of Object.entries(started.pm2 || {})) soft(`Remove PM2 apps from new VPS`, `act_pm2_remove ${shq(user)} ${shq(s.home)} ${shq(s.pm2bin)} ${shq(s.nodebin)} ${s.names.map(shq).join(' ')}`);
    for (const u of started.units || []) soft(`Stop ${u} on new VPS`, `act_unit_stop ${shq(u)}`);
    for (const l of started.launch || []) soft(`Stop ${l.name} on new VPS`, `act_launch_stop ${shq(l.name)}`);
    for (const s of started.sup || []) soft('Stop supervisor programs on new VPS', `act_sup_disable ${shq(s.conf)} ${s.programs.map(shq).join(' ')}`);
    for (const c of started.compose || []) soft('Stop Docker apps on new VPS', `sh -c ${shq(`${c.cmd} stop`)}`);
    for (const c of started.cron || []) if (c.startsWith('file:')) soft('Remove cron file on new VPS', `rm -f ${shq(c.slice(5))}`); else soft(`Restore scheduled jobs of ${c} on new VPS`, `act_cron_restore ${shq(c)}`);
    for (const s of started.sites || []) {
      if (s.server === 'nginx') soft(`Remove website ${s.name} from new VPS`, `rm -f ${shq(`/etc/nginx/sites-enabled/${s.name}`)} ${shq(`/etc/nginx/conf.d/${s.name}.conf`)} && ngx_reload`);
      if (s.server === 'apache') soft(`Remove website ${s.name} from new VPS`, `{ a2dissite ${shq(s.name)} || rm -f ${shq(`/etc/httpd/conf.d/${s.name}.conf`)}; } >/dev/null 2>&1; _s=$(svc_first apache2 httpd) && svc reload "$_s"`);
    }
    if (L.length && T) {
      try { await this.runTask(T, `rollback-new-${this.attempt('rollback')}`, L.join('\n'), { critical: false }); }
      catch (e) { this.log(`Could not reach the new VPS to stop things there: ${e.message}`, 'warn'); }
    }
    // 2. restore old VPS
    const M = [];
    const crit = (title, cmd) => M.push(`step ${shq(title)} ${cmd} || FAILED=1`);
    M.push('FAILED=0');
    for (const [, rec] of Object.entries(R)) if (rec?.kind === 'db') crit(`Start ${rec.engine} again`, `act_db_unpark ${shq(rec.engine)}`);
    for (const [user, rec] of Object.entries(R.pm2 || {})) crit(`Restart PM2 apps (${rec.names.join(', ')})`, `act_pm2_rollback ${shq(user)} ${shq(rec.home)} ${shq(rec.pm2bin)} ${shq(rec.nodebin)} ${shq(`${S.BK}/pm2-rollback-${user}.json`)}`);
    for (const [, rec] of Object.entries(R)) {
      if (!rec || typeof rec !== 'object') continue;
      if (rec.kind === 'systemd') crit(`Restart service ${rec.unit}`, `act_unit_restore ${shq(rec.unit)} ${rec.enabled ? 1 : 0} ${rec.active ? 1 : 0}`);
      if (rec.kind === 'supervisor') crit(`Restore supervisor ${rec.programs.join(', ')}`, `act_sup_restore ${shq(rec.conf)}`);
      if (rec.kind === 'process') crit(`Restart ${rec.name}`, `act_relaunch ${shq(rec.user)} ${shq(rec.launcher === 'tmux' ? 'tmux' : rec.launcher === 'screen' ? 'screen' : 'nohup')} ${shq(rec.name)} ${shq(rec.script)} ${shq(rec.log)} ${shq(rec.slug)} ${shq(rec.cmdline)} ${shq(rec.alt || rec.cmdline)}`);
      if (rec.kind === 'docker') for (const c of rec.containers) {
        if (c.running) crit(`Restart container ${c.id.slice(0, 12)}`, `act_docker_restore ${shq(c.id)} ${shq(c.restart)}`);
        else M.push(`docker update --restart=${shq(c.restart)} ${shq(c.id)} >/dev/null 2>&1`);
      }
      if (rec.kind === 'cron') crit(`Restore scheduled jobs of ${rec.user}`, `act_cron_restore ${shq(rec.user)}`);
      if (rec.kind === 'crond') crit(`Restore ${rec.path}`, `act_file_unpark ${shq(rec.path)}`);
      if (rec.kind === 'site') {
        if (rec.server === 'nginx') crit(`Turn website back on`, `act_ngx_restore ${shq(rec.enabledPath)}`);
        if (rec.server === 'apache') crit(`Turn website back on`, `act_apache_restore ${shq(rec.enabledPath)}`);
        if (rec.server === 'caddy') crit('Start Caddy again', 'act_svc_unpark caddy');
      }
    }
    M.push('exit $FAILED');
    let ok = true;
    try {
      await this.runTask(S, `rollback-old-${this.attempt('rollback')}`, M.join('\n'));
    } catch (e) {
      ok = false;
      this.log(`Some things could not be restarted on the old VPS: ${e.message}`, 'error', 'old');
    }
    this.bumpAttempt('rollback');
    await this.cleanup(false).catch(() => {});
    this.update({ status: ok ? 'rolledback' : 'failed', finishedAt: new Date().toISOString() });
    this.log(ok ? 'Rollback complete — your projects are running on the old VPS again.' : 'Rollback finished with problems — check the log.', ok ? 'ok' : 'error', 'old');
    return ok;
  }

  // ---------------------------------------------------------------- cleanup
  async cleanup(success) {
    const S = this.src, T = this.tgt;
    this.progress({ current: 'Cleaning up…' });
    if (!this.transfer) { this.transfer = new Transfer(this); }
    const keyGone = await this.transfer.cleanup().catch(() => false);
    if (keyGone) this.log('Temporary transfer key removed from the new VPS', 'ok', 'new');
    for (const r of [S, T].filter(Boolean)) {
      await r.sh(`rm -rf "$SHIFT_W/db" "$SHIFT_W/mysql.cnf" "$SHIFT_W"/ak-* "$SHIFT_W"/pm2-*.json "$SHIFT_W"/cron-* "$SHIFT_W/tasks"/*.sh "$SHIFT_W/pub"/py-* 2>/dev/null; rm -f /var/tmp/shift/lock; true`).catch(() => {});
    }
    void success;
    for (const r of [S, T].filter(Boolean)) {
      if (r.sudoDropIn) {
        const res = await r.execRaw(`sudo -n /bin/sh -c ${shq(`rm -f ${r.sudoDropIn}; [ ! -e ${r.sudoDropIn} ] && echo GONE`)}`).catch(() => ({ stdout: '' }));
        if (/GONE/.test(res.stdout)) { this.log(`Temporary sudo access removed on the ${r.label}`, 'ok', r === S ? 'old' : 'new'); r.sudoDropIn = null; r.sudo = 'password'; }
        else this.log(`Please remove ${r.sudoDropIn} on the ${r.label} manually`, 'warn');
      }
    }
  }

  async reconnect(source, target) {
    this.creds = { source: { ...this.creds?.source, ...source }, target: { ...this.creds?.target, ...target } };
    for (const s of [source?.password, target?.password]) if (s) this.secrets.add(s);
    const mk = (cfg, label, fp) => new Remote(cfg, { label, fingerprint: fp, log: (m, l) => this.log(m, l || 'warn', label === 'old VPS' ? 'old' : 'new') });
    this.src = mk(this.creds.source, 'old VPS', this.state.servers.source.fingerprint);
    this.tgt = mk(this.creds.target, 'new VPS', this.state.servers.target.fingerprint);
    await Promise.all([this.src.connect(), this.tgt.connect()]);
    for (const r of [this.src, this.tgt]) { if (!r.isRoot) await r.bootstrapSudo(this.id); await r.setupWorkdir(this.id); }
    this.log('Reconnected to both servers', 'ok');
  }

  close() {
    this.src?.close();
    this.tgt?.close();
  }

  publicState() {
    return { ...this.state };
  }

  static load(id) {
    const file = path.join(DATA_DIR, 'jobs', `${id}.json`);
    const { state, plan } = JSON.parse(fs.readFileSync(file, 'utf8'));
    const job = new Job({ id: state.id, source: { host: state.servers.source.host, port: state.servers.source.port, username: state.servers.source.username },
      target: { host: state.servers.target.host, port: state.servers.target.port, username: state.servers.target.username } });
    job.state = state;
    job.plan = plan;
    try { job.logs = fs.readFileSync(path.join(DATA_DIR, 'jobs', `${id}.log`), 'utf8').split('\n').filter(Boolean).slice(-2000).map((l) => ({ t: Date.parse(l.slice(0, 24)) || 0, level: (l.match(/\[(\w+)\]/) || [])[1] || 'info', msg: l.slice(l.indexOf(']') + 2) })); } catch {}
    return job;
  }
}

function tcpCheck(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout });
    const done = (v) => { s.destroy(); resolve(v); };
    s.on('connect', () => done(true));
    s.on('timeout', () => done(false));
    s.on('error', () => done(false));
  });
}

export function listJobs() {
  const dir = path.join(DATA_DIR, 'jobs');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    try {
      const { state } = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      return { id: state.id, createdAt: state.createdAt, status: state.status, source: state.servers.source.host, target: state.servers.target.host, finishedAt: state.finishedAt, cutoverStarted: state.cutoverStarted };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export { splitArgs, parseNginx };
