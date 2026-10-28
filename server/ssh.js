import ssh2 from 'ssh2';

const { Client, utils: sshUtils } = ssh2;
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, 'remote', f), 'utf8');
export const SCRIPTS = {
  lib: read('lib.sh'),
  actions: read('actions.sh'),
  scan: read('scan.sh'),
  probe: read('probe.sh'),
  inspect: read('inspect.sh'),
};

export const shq = (s) => "'" + String(s ?? '').replace(/'/g, `'\\''`) + "'";
export const dec = (s) => (!s || s === '-' ? '' : Buffer.from(s, 'base64').toString('utf8'));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Parse "@@TYPE payload" lines. */
export function records(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.startsWith('@@')) continue;
    const sp = line.indexOf(' ');
    out.push({ type: sp < 0 ? line.slice(2).trim() : line.slice(2, sp), raw: sp < 0 ? '' : line.slice(sp + 1).trim() });
  }
  return out;
}
/** Fields of a record written by `out` (base64 of \x1f-joined fields). */
export const fieldsOf = (raw) => dec(raw).split('\x1f');

export class LostConnection extends Error {
  constructor(msg = 'SSH connection lost') { super(msg); this.lost = true; }
}

const LEGACY = {
  kex: { append: ['diffie-hellman-group-exchange-sha1', 'diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1'] },
  serverHostKey: { append: ['ssh-dss'] },
  cipher: { append: ['aes128-cbc', 'aes192-cbc', 'aes256-cbc', '3des-cbc'] },
};

export function fingerprintOf(keyBuf) {
  return 'SHA256:' + crypto.createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '');
}

export function generateTransferKey(comment) {
  return sshUtils.generateKeyPairSync('ed25519', { comment });
}

export class Remote {
  /**
   * @param {{host:string,port?:number,username:string,password?:string,privateKey?:string,passphrase?:string,otp?:string}} cfg
   */
  constructor(cfg, { label = 'server', log = () => {}, fingerprint = null } = {}) {
    this.cfg = { ...cfg, port: Number(cfg.port) || 22, host: String(cfg.host || '').trim(), username: String(cfg.username || '').trim() };
    this.label = label;
    this.log = log;
    this.expectedFingerprint = fingerprint;
    this.fingerprint = null;
    this.conn = null;
    this.closed = false;
    this.pending = new Set();
    this.isRoot = false;
    this.sudo = 'none'; // none | nopasswd | password
    this.W = null; // job work dir
    this.BK = null; // backup dir
    this.slots = 6;
    this.queue = [];
  }

  _connectOnce() {
    return new Promise((resolve, reject) => {
      const c = new Client();
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (err) { try { c.end(); } catch {} reject(err); } else resolve(c);
      };
      c.on('ready', () => finish());
      c.on('error', (e) => {
        if (!settled) {
          if (this.hostKeyMismatch) e = new Error(`The ${this.label} server's identity changed (fingerprint mismatch). Stopped for safety.`);
          else if (/authentication methods failed/i.test(e.message)) e = Object.assign(new Error('Wrong username or password (or SSH key)'), { auth: true });
          else if (e.code === 'ECONNREFUSED') e = new Error(`Connection refused on ${this.cfg.host}:${this.cfg.port} — is SSH running on that port?`);
          else if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') e = new Error(`Cannot find host "${this.cfg.host}"`);
          else if (e.level === 'client-timeout' || /Timed out/i.test(e.message)) e = new Error(`Timed out connecting to ${this.cfg.host}:${this.cfg.port}`);
          finish(e);
        }
      });
      c.on('close', () => {
        if (this.conn === c) {
          this.conn = null;
          for (const p of this.pending) p.reject(new LostConnection());
          this.pending.clear();
          if (!this.closed) this.log(`Connection to ${this.label} closed`, 'warn');
        }
        finish(new LostConnection('Connection closed during login'));
      });
      c.on('keyboard-interactive', (_n, _i, _l, prompts, done) => {
        done(prompts.map((p) => (/code|token|otp|verif|2fa|authenticator/i.test(p.prompt) ? this.cfg.otp || '' : this.cfg.password || '')));
      });
      const opts = {
        host: this.cfg.host,
        port: this.cfg.port,
        username: this.cfg.username,
        readyTimeout: 30000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 6,
        tryKeyboard: true,
        algorithms: LEGACY,
        hostVerifier: (key) => {
          const fp = fingerprintOf(key);
          this.fingerprint = fp;
          this.hostKeyRaw = key;
          if (this.expectedFingerprint && this.expectedFingerprint !== fp) { this.hostKeyMismatch = true; return false; }
          return true;
        },
      };
      if (this.cfg.privateKey) { opts.privateKey = this.cfg.privateKey; if (this.cfg.passphrase) opts.passphrase = this.cfg.passphrase; }
      if (this.cfg.password) opts.password = this.cfg.password;
      try { c.connect(opts); } catch (e) { finish(e); }
    });
  }

  async connect() {
    this.closed = false;
    this.conn = await this._connectOnce();
    if (!this.expectedFingerprint) this.expectedFingerprint = this.fingerprint;
    const r = await this.execRaw(`/bin/sh -c 'id -u; id -un; echo "$HOME"'`);
    const [uid, name, home] = r.stdout.trim().split('\n');
    this.uid = Number(uid);
    this.user = name;
    this.home = home;
    this.isRoot = this.uid === 0;
    return this;
  }

  async ensure() {
    if (this.conn) return this.conn;
    if (this.closed) throw new Error(`${this.label}: connection closed`);
    if (!this._reconnecting) {
      this._reconnecting = (async () => {
        let delay = 1000;
        const start = Date.now();
        let last;
        while (Date.now() - start < 15 * 60 * 1000 && !this.closed) {
          try {
            this.conn = await this._connectOnce();
            this.log(`Reconnected to ${this.label}`, 'info');
            return this.conn;
          } catch (e) {
            last = e;
            if (this.hostKeyMismatch || e.auth) throw e;
            this.log(`${this.label} unreachable (${e.message}). Retrying in ${Math.round(delay / 1000)}s…`, 'warn');
            await sleep(delay);
            delay = Math.min(delay * 2, 15000);
          }
        }
        throw last || new Error('Could not reconnect');
      })().finally(() => { this._reconnecting = null; });
    }
    return this._reconnecting;
  }

  async _slot() {
    if (this.slots > 0) { this.slots--; return; }
    await new Promise((r) => this.queue.push(r));
  }
  _release() {
    const n = this.queue.shift();
    if (n) n(); else this.slots++;
  }

  /** Run a raw command (interpreted by the login shell). */
  async execRaw(command, opts = {}) {
    await this._slot();
    try {
      const conn = await this.ensure();
      return await new Promise((resolve, reject) => {
        const pend = { reject };
        this.pending.add(pend);
        const done = (fn, v) => { this.pending.delete(pend); clearTimeout(timer); fn(v); };
        let timer;
        conn.exec(command, opts.pty ? { pty: { term: 'dumb', cols: 220, rows: 40 } } : {}, (err, stream) => {
          if (err) return done(reject, /Channel open failure|No response/i.test(err.message) ? new LostConnection(err.message) : err);
          const out = [];
          const errb = [];
          if (opts.timeout) {
            timer = setTimeout(() => {
              try { stream.signal('KILL'); } catch {}
              try { stream.close(); } catch {}
              done(reject, new Error(`${this.label}: command timed out`));
            }, opts.timeout);
          }
          stream.on('data', (d) => { out.push(d); opts.onStdout?.(d); });
          stream.stderr.on('data', (d) => { errb.push(d); opts.onStderr?.(d); });
          stream.on('error', (e) => done(reject, e));
          stream.on('close', (code, signal) => {
            if (code == null && signal == null) return done(reject, new LostConnection());
            done(resolve, { code: code ?? 255, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errb).toString('utf8') });
          });
          if (opts.stdinStream) opts.stdinStream.pipe(stream);
          else if (opts.stdin != null) stream.end(opts.stdin);
          else stream.end();
          opts.onStream?.(stream);
        });
      });
    } finally {
      this._release();
    }
  }

  /** Command prefix to become root. */
  rootPrefix() {
    if (this.isRoot) return '';
    return 'sudo -n ';
  }

  env() {
    let e = '';
    if (this.W) e += `export SHIFT_W=${shq(this.W)}\n`;
    if (this.BK) e += `export SHIFT_BK=${shq(this.BK)}\n`;
    return e;
  }

  /**
   * Run a POSIX sh script (given via stdin, never on the command line).
   * @param {string} script
   * @param {{root?:boolean, actions?:boolean, timeout?:number, retry?:boolean}} o
   */
  async sh(script, o = {}) {
    const root = o.root !== false;
    const body = this.env() + SCRIPTS.lib + '\n' + (o.actions ? SCRIPTS.actions + '\n' : '') + script + '\n';
    const cmd = (root ? this.rootPrefix() : '') + '/bin/sh -s';
    let attempt = 0;
    for (;;) {
      try {
        return await this.execRaw(cmd, { stdin: body, timeout: o.timeout ?? 180000 });
      } catch (e) {
        if (e.lost && o.retry !== false && attempt++ < 3) { await sleep(1500); continue; }
        throw e;
      }
    }
  }

  async writeFile(file, content, { mode = '600', owner = null, root = true } = {}) {
    const script = `umask 077; mkdir -p "$(dirname "$0")" && cat > "$0.shift-tmp" && chmod ${mode} "$0.shift-tmp"${owner ? ` && chown ${shq(owner)} "$0.shift-tmp"` : ''} && mv -f "$0.shift-tmp" "$0"`;
    const cmd = `${root ? this.rootPrefix() : ''}/bin/sh -c ${shq(script)} ${shq(file)}`;
    let attempt = 0;
    for (;;) {
      try {
        const r = await this.execRaw(cmd, { stdin: content, timeout: 120000 });
        if (r.code !== 0) throw new Error(`${this.label}: could not write ${file}: ${r.stderr.trim()}`);
        return;
      } catch (e) {
        if (e.lost && attempt++ < 3) { await sleep(1500); continue; }
        throw e;
      }
    }
  }

  async readFile(file, { root = true } = {}) {
    const r = await this.execRaw(`${root ? this.rootPrefix() : ''}/bin/sh -c ${shq('cat "$0"')} ${shq(file)}`, { timeout: 60000 });
    if (r.code !== 0) return null;
    return r.stdout;
  }

  /** Check sudo: returns 'root' | 'nopasswd' | 'password' | 'none' */
  async checkPrivileges() {
    if (this.isRoot) return 'root';
    const r = await this.execRaw('sudo -k -n true', { timeout: 20000 }).catch(() => ({ code: 1, stderr: '' }));
    if (r.code === 0) return (this.sudo = 'nopasswd');
    this.sudoError = r.stderr.trim();
    if (/not found|command not found/i.test(r.stderr)) { this.sudoError = 'sudo is not installed'; return (this.sudo = 'none'); }
    if (/no new privileges|nosuid|effective uid is not 0/i.test(r.stderr)) return (this.sudo = 'none');
    if (!this.cfg.password) return (this.sudo = 'none');
    let t = await this.execRaw(`sudo -S -k -p '' true`, { stdin: this.cfg.password + '\n', timeout: 20000 }).catch(() => ({ code: 1, stderr: '' }));
    if (t.code !== 0) this.sudoError = (t.stderr || '').replace(/\[sudo\][^\n]*/g, '').trim() || 'wrong password or not in sudoers';
    if (t.code !== 0 && /tty/i.test(t.stderr)) {
      t = await this.execRaw(`sudo -S -k -p '' true`, { stdin: this.cfg.password + '\n', pty: true, timeout: 20000 }).catch(() => ({ code: 1, stderr: '' }));
      if (t.code === 0) this.needsTty = true;
    }
    return (this.sudo = t.code === 0 ? 'password' : 'none');
  }

  /** Temporarily allow password-less sudo for this job (removed during cleanup). */
  async bootstrapSudo(jobId) {
    if (this.isRoot) return;
    const p = await this.checkPrivileges();
    if (p === 'nopasswd') return;
    if (p !== 'password') throw new Error(`${this.label}: user "${this.user}" cannot become root (${(this.sudoError || 'no sudo access').split('\n')[0]}). Log in as root or a sudo user.`);
    const f = `/etc/sudoers.d/zz-shift-${jobId}`;
    const script = [
      `printf '%s\\n' 'Defaults:${this.user} !requiretty' '${this.user} ALL=(ALL) NOPASSWD: ALL' > '${f}.tmp'`,
      `chmod 440 '${f}.tmp'`,
      `if command -v visudo >/dev/null 2>&1; then visudo -cf '${f}.tmp' >/dev/null || { rm -f '${f}.tmp'; exit 3; }; fi`,
      `mv '${f}.tmp' '${f}'`,
    ].join('\n');
    const bfile = `${this.home}/.shift-bootstrap-${jobId}.sh`;
    await this.writeFile(bfile, script + '\n', { mode: '600', root: false });
    const r = await this.execRaw(`sudo -S -k -p '' /bin/sh ${shq(bfile)}`, { stdin: this.cfg.password + '\n', pty: !!this.needsTty, timeout: 30000 });
    await this.execRaw(`rm -f ${shq(bfile)}`).catch(() => {});
    const ok = await this.execRaw('sudo -n true', { timeout: 20000 });
    if (r.code !== 0 || ok.code !== 0) throw new Error(`${this.label}: could not get root access through sudo`);
    this.sudo = 'nopasswd';
    this.sudoDropIn = f;
  }

  async setupWorkdir(jobId) {
    this.W = `/var/tmp/shift/${jobId}`;
    this.BK = `/var/backups/shift/${jobId}`;
    const owner = this.isRoot ? 'root' : this.user;
    const r = await this.sh(
      `mkdir -p "$SHIFT_W/tasks" "$SHIFT_W/pub" "$SHIFT_BK" && chmod 711 "$SHIFT_W" && chmod 755 "$SHIFT_W/pub" && chmod 700 "$SHIFT_BK" && chown ${shq(owner)} "$SHIFT_W/tasks" && chmod 700 "$SHIFT_W/tasks"`
    );
    if (r.code !== 0) throw new Error(`${this.label}: could not create work folder: ${r.stderr}`);
  }

  /** Start a detached background task that survives SSH disconnects. Idempotent per name. */
  async startTask(name, script, { actions = true } = {}) {
    const T = `${this.W}/tasks/${name}`;
    const body = this.env() + SCRIPTS.lib + '\n' + (actions ? SCRIPTS.actions + '\n' : '') + script + '\n';
    const st = await this.sh(`T=${shq(T)}; if [ -f "$T.rc" ]; then echo DONE; elif [ -f "$T.pid" ] && pid_alive "$(cat "$T.pid")"; then echo RUNNING; else echo NEW; fi`);
    const state = st.stdout.trim();
    if (state === 'DONE' || state === 'RUNNING') return state;
    await this.writeFile(`${T}.sh`, body, { mode: '600' });
    const starter = `
T=${shq(T)}
rm -f "$T.rc" "$T.pid"
cat > "$T.run" <<EOF
echo \\$\\$ > "$T.pid"
/bin/sh "$T.sh" > "$T.log" 2>&1
echo \\$? > "$T.rc.tmp"; mv "$T.rc.tmp" "$T.rc"
EOF
if has_systemd && have systemd-run; then
  systemd-run --quiet --unit="shift-${name.replace(/[^a-zA-Z0-9-]/g, '-')}-$(date +%s)" /bin/sh "$T.run" >/dev/null 2>&1 || { setsid nohup /bin/sh "$T.run" >/dev/null 2>&1 < /dev/null & }
elif have setsid; then setsid nohup /bin/sh "$T.run" >/dev/null 2>&1 < /dev/null &
else nohup /bin/sh "$T.run" >/dev/null 2>&1 < /dev/null &
fi
echo STARTED`;
    const r = await this.sh(starter);
    if (!/STARTED/.test(r.stdout)) throw new Error(`${this.label}: could not start task ${name}: ${r.stderr}`);
    return 'STARTED';
  }

  async pollTask(name, offset) {
    const T = `${this.W}/tasks/${name}`;
    const script = `T=${shq(T)}
if [ -f "$T.rc" ]; then echo "RC $(cat "$T.rc")"; elif [ -f "$T.pid" ] && { [ -d "/proc/$(cat "$T.pid")" ] || kill -0 "$(cat "$T.pid")" 2>/dev/null; }; then echo RUNNING; elif [ -f "$T.pid" ]; then echo LOST; else echo PENDING; fi
SZ=$(wc -c < "$T.log" 2>/dev/null || echo 0); SZ=$(echo $SZ)
N=$((SZ-${offset})); [ $N -lt 0 ] && N=0; [ $N -gt 262144 ] && N=262144
echo "SIZE $SZ $N"
echo DATA
[ $N -gt 0 ] && tail -c +${offset + 1} "$T.log" 2>/dev/null | head -c $N
exit 0`;
    const r = await this.execRaw('/bin/sh -s', { stdin: script, timeout: 60000 });
    const i = r.stdout.indexOf('DATA\n');
    const head = r.stdout.slice(0, i).split('\n');
    const data = i >= 0 ? r.stdout.slice(i + 5) : '';
    const status = head[0] || 'PENDING';
    const [, size, n] = (head[1] || 'SIZE 0 0').split(' ').map(Number);
    return { status, size: size || 0, n: n || 0, data };
  }

  /**
   * Wait for a task, streaming its log.
   * @param {(chunk:string)=>void} onData
   */
  async waitTask(name, { onData = () => {}, timeout = 6 * 3600 * 1000, interval = 1200, isCancelled = () => false } = {}) {
    let offset = 0;
    let pendingSince = Date.now();
    let lostChecks = 0;
    const start = Date.now();
    for (;;) {
      let p;
      try {
        p = await this.pollTask(name, offset);
      } catch (e) {
        if (e.lost || /timed out/i.test(e.message)) { await sleep(2000); continue; }
        throw e;
      }
      if (p.size < offset) offset = 0;
      if (p.n > 0) { offset += p.n; onData(p.data); }
      if (p.status.startsWith('RC ')) {
        if (p.size > offset) continue; // drain the rest of the log
        return Number(p.status.slice(3)) || 0;
      }
      if (p.status === 'LOST') {
        // maybe hidden by hidepid — double check as root
        const r = await this.sh(`T=${shq(this.W + '/tasks/' + name)}; if [ -f "$T.rc" ]; then echo RC; elif pid_alive "$(cat "$T.pid")"; then echo RUNNING; else echo LOST; fi`);
        if (/LOST/.test(r.stdout) && ++lostChecks > 2) throw new Error(`${this.label}: background task "${name}" stopped unexpectedly (server rebooted or out of memory?)`);
      }
      if (p.status === 'PENDING' && Date.now() - pendingSince > 60000) throw new Error(`${this.label}: background task "${name}" never started`);
      if (p.status !== 'PENDING') pendingSince = Date.now();
      if (Date.now() - start > timeout) throw new Error(`${this.label}: task "${name}" took too long`);
      if (isCancelled()) throw new Error('Cancelled');
      await sleep(interval);
    }
  }

  /** Remote port forward on this server: 127.0.0.1:<port> -> handler(stream) */
  async forwardIn(onConnection) {
    const conn = await this.ensure();
    return new Promise((resolve, reject) => {
      conn.forwardIn('127.0.0.1', 0, (err, port) => {
        if (err) return reject(err);
        const handler = (info, accept) => {
          if (info.destPort !== port) return;
          onConnection(accept());
        };
        conn.on('tcp connection', handler);
        resolve({ port, close: () => { conn.removeListener('tcp connection', handler); try { conn.unforwardIn('127.0.0.1', port, () => {}); } catch {} } });
      });
    });
  }

  close() {
    this.closed = true;
    for (const p of this.pending) p.reject(new LostConnection('closed'));
    this.pending.clear();
    try { this.conn?.end(); } catch {}
    this.conn = null;
  }
}
