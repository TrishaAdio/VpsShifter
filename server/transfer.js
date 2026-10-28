import net from 'node:net';
import { shq, generateTransferKey, sleep } from './ssh.js';

const rel = (p) => p.replace(/^\/+/, '');

/** rsync progress2 line: "  1,234,567  45%  12.34MB/s  0:01:23 (xfr#..)" */
export function parseRsyncProgress(line) {
  const m = line.match(/^\s*([\d,.]+)\s+(\d+)%\s+([\d.]+\s*[kMGT]?B\/s)\s+(\d+:\d+:\d+)/);
  if (!m) return null;
  return { bytes: Number(m[1].replace(/[,.]/g, '')), percent: Number(m[2]), speed: m[3].replace(/\s+/g, ''), eta: m[4] };
}

export class Transfer {
  constructor(job) {
    this.job = job;
    this.mode = null;
    this.tunnel = null;
  }

  get src() { return this.job.src; }
  get tgt() { return this.job.tgt; }

  /** Pick the best way to move files. */
  async setup() {
    const job = this.job;
    const src = this.src, tgt = this.tgt;
    const srcHasRsync = await this.ensureRsync(src, true);
    const tgtHasRsync = await this.ensureRsync(tgt, false);
    if (!srcHasRsync || !tgtHasRsync) {
      job.log('rsync is not available on both servers — files will be streamed through Shift', 'warn');
      this.mode = 'stream';
      return this.mode;
    }
    // temporary transfer key
    const tag = `shift-job-${job.id}`;
    const key = generateTransferKey(tag);
    const pub = key.public.trim();
    job.state.transfer.keyTag = tag;
    job.save();
    await tgt.sh(`H=${shq(tgt.home)}; mkdir -p "$H/.ssh" && touch "$H/.ssh/authorized_keys" && chmod 700 "$H/.ssh" && chmod 600 "$H/.ssh/authorized_keys"
grep -qF ${shq(tag)} "$H/.ssh/authorized_keys" || printf '%s\\n' ${shq('no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ' + pub)} >> "$H/.ssh/authorized_keys"
chown -R ${shq(tgt.user)} "$H/.ssh" 2>/dev/null; have restorecon && restorecon -R "$H/.ssh" 2>/dev/null; true`);
    await src.writeFile(`${src.W}/key`, key.private, { mode: '600' });
    const hostKeys = (job.tgtInfo.hostKeys || []).map((k) => k.split(/\s+/).slice(0, 2).join(' ')).filter(Boolean);
    await src.writeFile(`${src.W}/known_hosts`, hostKeys.map((k) => `shift-target ${k}`).join('\n') + '\n', { mode: '600' });

    // 1) direct
    const host = tgt.cfg.host;
    if (await this.testSsh(host, tgt.cfg.port)) {
      this.mode = 'direct';
      this.dest = { host, port: tgt.cfg.port };
      job.log(`Old VPS can reach the new VPS directly — fastest transfer mode`, 'ok');
      return this.mode;
    }
    job.log('Old VPS cannot reach the new VPS directly, trying a tunnel through Shift…', 'warn');
    // 2) tunnel via this app
    try {
      await this.openTunnel();
      if (await this.testSsh('127.0.0.1', this.tunnel.port)) {
        this.mode = 'tunnel';
        this.dest = { host: '127.0.0.1', port: this.tunnel.port };
        job.log('Tunnel works — files will flow through Shift', 'ok');
        return this.mode;
      }
    } catch (e) {
      job.log(`Tunnel not possible: ${e.message}`, 'warn');
    }
    this.closeTunnel();
    // 3) stream
    this.mode = 'stream';
    job.log('Using stream mode (tar through Shift)', 'warn');
    return this.mode;
  }

  async ensureRsync(r, isSource) {
    const has = await r.sh('have rsync && echo YES');
    if (/YES/.test(has.stdout)) {
      if (isSource) { const s = await r.sh('have ssh && echo YES'); if (!/YES/.test(s.stdout)) await r.sh('pm_detect; os_detect; case $OS_FAMILY in debian|alpine) pkg_install openssh-client ;; *) pkg_install openssh-clients || pkg_install openssh ;; esac', { timeout: 600000 }).catch(() => {}); }
      return isSource ? /YES/.test((await r.sh('have ssh && echo YES')).stdout) : true;
    }
    this.job.log(`Installing rsync on the ${r.label}…`);
    await r.sh('pm_detect; os_detect; pkg_install rsync', { timeout: 900000 }).catch(() => {});
    const again = await r.sh('have rsync && echo YES');
    if (!/YES/.test(again.stdout)) return false;
    if (isSource) {
      const s = await r.sh('have ssh && echo YES');
      if (!/YES/.test(s.stdout)) return false;
    }
    return true;
  }

  rsh(port) {
    const W = this.src.W;
    return `ssh -F /dev/null -i ${W}/key -p ${port} -o BatchMode=yes -o IdentitiesOnly=yes -o HostKeyAlias=shift-target -o UserKnownHostsFile=${W}/known_hosts -o StrictHostKeyChecking=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=8 -o Compression=no -o LogLevel=ERROR`;
  }

  destSpec(host) {
    const h = host.includes(':') ? `[${host}]` : host;
    return `${this.tgt.user}@${h}`;
  }

  async testSsh(host, port) {
    const r = await this.src.sh(`${this.rsh(port)} ${shq(this.destSpec(host))} echo shift-ok 2>&1`, { timeout: 60000 }).catch((e) => ({ stdout: e.message, code: 1 }));
    if (!/shift-ok/.test(r.stdout)) { this.job.log(`SSH test from old VPS failed: ${(r.stdout || r.stderr || '').trim().slice(0, 200)}`, 'warn'); return false; }
    return true;
  }

  async openTunnel() {
    const tcfg = this.tgt.cfg;
    this.tunnel = await this.src.forwardIn((channel) => {
      const sock = net.connect(tcfg.port, tcfg.host);
      sock.on('error', () => { try { channel.close(); } catch {} });
      channel.on('error', () => sock.destroy());
      channel.pipe(sock).pipe(channel);
    });
  }

  closeTunnel() {
    try { this.tunnel?.close(); } catch {}
    this.tunnel = null;
  }

  /** Re-open the tunnel after a reconnect if needed. */
  async ensureDest() {
    if (this.mode === 'tunnel') {
      if (!this.tunnel || !this.src.conn) {
        this.closeTunnel();
        await this.src.ensure();
        await this.openTunnel();
        this.dest = { host: '127.0.0.1', port: this.tunnel.port };
      }
    }
  }

  async writeLists(plan, extraExcludes = []) {
    const W = this.src.W;
    await this.src.writeFile(`${W}/files-base.txt`, plan.base.map(rel).join('\n') + '\n');
    await this.src.writeFile(`${W}/files-proj.txt`, plan.proj.map(rel).join('\n') + '\n');
    await this.src.writeFile(`${W}/excludes.txt`, [...plan.excludes, ...extraExcludes].join('\n') + '\n');
    // tar excludes: strip leading/trailing slashes
    await this.src.writeFile(`${W}/excludes.tar`, [...plan.excludes, ...extraExcludes].map((x) => x.replace(/^\/+/, '').replace(/\/+$/, '')).join('\n') + '\n');
  }

  /** Remove paths that do not exist on the source (avoid rsync errors). */
  async filterExisting(plan) {
    const all = [...plan.base, ...plan.proj];
    if (!all.length) return;
    const r = await this.src.sh(`while IFS= read -r p; do [ -e "$p" ] || [ -L "$p" ] && echo "$p"; done <<'SHIFTEOF'\n${all.join('\n')}\nSHIFTEOF`);
    const ok = new Set(r.stdout.split('\n').filter(Boolean));
    plan.base = plan.base.filter((p) => ok.has(p));
    plan.proj = plan.proj.filter((p) => ok.has(p));
  }

  /**
   * Copy everything. phase: 'live' (apps running) | 'final' (apps stopped)
   * mapped: [{src,dst}] (docker volumes, db dumps)
   */
  async sync(plan, { phase, mapped = [], name, onProgress, sinceStamp = false }) {
    if (this.mode === 'stream') return this.streamSync(plan, { phase, mapped, onProgress, sinceStamp });
    await this.ensureDest();
    const W = this.src.W;
    const bw = plan.opt.bandwidthLimitMBs && phase === 'live' ? Math.round(plan.opt.bandwidthLimitMBs * 1024) : 0;
    const newRsync = !this.job.srcInfo.rsync || compareVer(this.job.srcInfo.rsync, '3.1.0') >= 0;
    const opts = `-aHr --partial ${newRsync ? '--info=progress2 --no-inc-recursive' : '--stats'}${bw ? ` --bwlimit=${bw}` : ''}`;
    const mapLines = mapped.map((m, i) => `run_rs map${i} --delete ${shq(m.src.replace(/\/?$/, '/'))} "$DEST:"${shq(m.dst.replace(/\/?$/, '/'))}`).join('\n');
    const script = `
RSH=${shq(this.rsh(this.dest.port))}
DEST=${shq(this.destSpec(this.dest.host))}
RP=${this.tgt.isRoot ? "''" : shq('sudo -n rsync')}
OPTS=${shq(opts)}
AX=-AX
PHASE=${phase}
FAILED=0
rsx() { if [ -n "$RP" ]; then rsync $OPTS $AX --rsync-path="$RP" -e "$RSH" "$@"; else rsync $OPTS $AX -e "$RSH" "$@"; fi; }
run_rs() {
  _l=$1; shift; _try=0
  while :; do
    echo "@@RSYNC $_l"
    rsx "$@" 2> "$SHIFT_W/rs.err"; _rc=$?
    if [ $_rc -ne 0 ] && [ -n "$AX" ] && grep -qiE 'ACL|xattr|extended attrib' "$SHIFT_W/rs.err"; then
      AX=; log "(this rsync has no ACL/xattr support — continuing without)"; continue
    fi
    cat "$SHIFT_W/rs.err" >&2
    case $_rc in
      0|24) echo "@@RSRC $_l 0"; return 0 ;;
      23) if [ "$PHASE" = live ]; then echo "@@RSRC $_l 23"; return 0; fi ;;
      10|11|12|30|35|255) _try=$((_try+1)); if [ $_try -lt 4 ]; then log "Network problem (code $_rc) — retrying in 10s"; sleep 10; continue; fi ;;
    esac
    echo "@@RSRC $_l $_rc"; FAILED=$_rc; return $_rc
  done
}
cd /
[ -s "$SHIFT_W/files-base.txt" ] && run_rs base --files-from="$SHIFT_W/files-base.txt" --exclude-from="$SHIFT_W/excludes.txt" / "$DEST:/"
[ -s "$SHIFT_W/files-proj.txt" ] && run_rs proj --delete --files-from="$SHIFT_W/files-proj.txt" --exclude-from="$SHIFT_W/excludes.txt" / "$DEST:/"
${mapLines}
exit $FAILED
`;
    const rc = await this.job.runTask(this.src, name, script, { onLine: (line) => this.onLine(line, onProgress), raw: true });
    if (rc !== 0) throw new Error(`Copying files failed (rsync code ${rc}) — see the log`);
    return rc;
  }

  onLine(line, onProgress) {
    const p = parseRsyncProgress(line);
    if (p) { onProgress?.(p); return true; }
    return false;
  }

  /** Dry-run checksum comparison. Returns list of differing paths. */
  async verify(plan, { checksum }) {
    if (this.mode === 'stream') return this.streamVerify(plan);
    await this.ensureDest();
    const script = `
RSH=${shq(this.rsh(this.dest.port))}
DEST=${shq(this.destSpec(this.dest.host))}
RP=${this.tgt.isRoot ? "''" : shq('sudo -n rsync')}
cd /
v() { if [ -n "$RP" ]; then rsync -aHrn ${checksum ? '--checksum' : ''} --itemize-changes --rsync-path="$RP" -e "$RSH" "$@"; else rsync -aHrn ${checksum ? '--checksum' : ''} --itemize-changes -e "$RSH" "$@"; fi; }
{
[ -s "$SHIFT_W/files-base.txt" ] && v --files-from="$SHIFT_W/files-base.txt" --exclude-from="$SHIFT_W/excludes.txt" / "$DEST:/"
[ -s "$SHIFT_W/files-proj.txt" ] && v --delete --files-from="$SHIFT_W/files-proj.txt" --exclude-from="$SHIFT_W/excludes.txt" / "$DEST:/"
} 2>&1 | grep -E '^(>f|\\*deleting|cL|cS|hf)' | head -n 200
exit 0`;
    const out = [];
    await this.job.runTask(this.src, `verify-files-${this.job.attempt('verify-files')}`, script, { onLine: (l) => { if (l.trim()) out.push(l.trim()); return true; }, raw: true });
    return out;
  }

  // ---------------- stream mode (tar through Shift)
  async streamSync(plan, { phase, mapped, onProgress, sinceStamp }) {
    const W = this.src.W;
    const all = [...plan.base, ...plan.proj];
    if (phase === 'live' && !sinceStamp) await this.src.sh(`touch "$SHIFT_W/stream-stamp"`);
    let listCmd;
    if (sinceStamp) {
      listCmd = `cd / && while IFS= read -r p; do [ -n "$p" ] && find "$p" -newer "$SHIFT_W/stream-stamp" \\( -type f -o -type l \\) 2>/dev/null; done < "$SHIFT_W/files-all.txt" | sed 's|^/||' > "$SHIFT_W/stream-list.txt"`;
    } else {
      listCmd = `cd / && sed 's|^/||' "$SHIFT_W/files-all.txt" > "$SHIFT_W/stream-list.txt"`;
    }
    await this.src.writeFile(`${W}/files-all.txt`, all.join('\n') + '\n');
    const lr = await this.src.sh(listCmd);
    if (lr.code !== 0) throw new Error('Could not prepare the file list');
    const total = (this.job.state.preflight?.plan?.totalKB || 1) * 1024;
    let sent = 0;
    const t0 = Date.now();
    const tick = (n) => {
      sent += n;
      const secs = Math.max(1, (Date.now() - t0) / 1000);
      onProgress?.({ bytes: sent, percent: Math.min(99, Math.round((sent / total) * 100)), speed: `${(sent / secs / 1048576).toFixed(1)}MB/s`, eta: '' });
    };
    await this.pipe(`cd / && tar -cpf - -X ${shq(W + '/excludes.tar')} -T ${shq(W + '/stream-list.txt')} 2>/dev/null; true`, `tar -C / -xpf -`, tick);
    for (const m of mapped) {
      await this.tgt.sh(`mkdir -p ${shq(m.dst)}`);
      await this.pipe(`tar -C ${shq(m.src)} -cpf - . 2>/dev/null; true`, `tar -C ${shq(m.dst)} -xpf -`, tick);
    }
    return 0;
  }

  async pipe(srcCmd, dstCmd, tick) {
    const s = await this.src.ensure();
    const t = await this.tgt.ensure();
    const sc = `${this.src.rootPrefix()}/bin/sh -c ${shq(srcCmd)}`;
    const dc = `${this.tgt.rootPrefix()}/bin/sh -c ${shq(dstCmd)}`;
    await new Promise((resolve, reject) => {
      t.exec(dc, (err, tStream) => {
        if (err) return reject(err);
        let tErr = '';
        tStream.stderr.on('data', (d) => { tErr += d; });
        tStream.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Unpacking on new VPS failed: ${tErr.slice(0, 300)}`))));
        s.exec(sc, (err2, sStream) => {
          if (err2) { tStream.end(); return reject(err2); }
          sStream.on('data', (d) => tick(d.length));
          sStream.stderr.on('data', () => {});
          sStream.pipe(tStream);
          sStream.on('error', reject);
        });
      });
    });
  }

  async streamVerify(plan) {
    const count = async (r) => {
      const res = await r.sh(`cd / && for p in ${[...plan.base, ...plan.proj].map(shq).join(' ')}; do [ -e "$p" ] && find "$p" -type f 2>/dev/null; done | wc -l`);
      return Number(res.stdout.trim()) || 0;
    };
    const [a, b] = await Promise.all([count(this.src), count(this.tgt)]);
    if (b < a * 0.98) return [`File count differs: ${a} on old VPS, ${b} on new VPS`];
    return [];
  }

  async cleanup() {
    this.closeTunnel();
    const tag = this.job.state.transfer.keyTag || `shift-job-${this.job.id}`;
    await this.tgt.sh(`for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys ${shq(this.tgt.home + '/.ssh/authorized_keys')}; do [ -f "$f" ] && grep -qF ${shq(tag)} "$f" && { grep -vF ${shq(tag)} "$f" > "$f.shift-tmp"; cat "$f.shift-tmp" > "$f"; rm -f "$f.shift-tmp"; }; done; true`).catch(() => {});
    await this.src.sh(`rm -f "$SHIFT_W/key" "$SHIFT_W/known_hosts"`).catch(() => {});
    const chk = await this.tgt.sh(`grep -lF ${shq(tag)} /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys 2>/dev/null; true`).catch(() => ({ stdout: '' }));
    return !chk.stdout.trim();
  }
}

function compareVer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

export { sleep };
