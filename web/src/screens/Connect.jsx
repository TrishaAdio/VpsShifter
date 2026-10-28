import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Button, Field, Switch, Shake, CheckBadge, Sheet, Spinner, I, cx, bouncy, toast } from '../ui.jsx';
import { api, fmtKB } from '../api.js';
import { Tilt, GlowRing } from '../fx.jsx';

function ServerCard({ side, value, onChange, result, testing, onTest, index }) {
  const isOld = side === 'source';
  const set = (k) => (v) => onChange({ ...value, [k]: v });
  return (
    <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 + index * 0.08, ...bouncy, damping: 24 }} className="min-w-0 flex-1">
      <Shake when={result && !result.ok ? result.t : 0}>
        <Tilt max={4} glare className="rounded-[22px]">
        <div className={cx('glass rounded-[22px] p-5 transition-shadow duration-500', result?.ok && 'shadow-[0_0_0_2px_rgba(48,209,88,.6),0_20px_60px_-15px_rgba(48,209,88,.55)]', result && !result.ok && 'shadow-[0_0_0_2px_rgba(255,69,58,.6),0_20px_60px_-15px_rgba(255,69,58,.5)]')}>
          <div className="mb-4 flex items-center gap-3">
            <div className={cx('grid h-11 w-11 place-items-center rounded-[13px] text-white shadow-lg', isOld ? 'bg-gradient-to-br from-[#8e8e93] to-[#3a3a3c]' : 'bg-gradient-to-br from-[#30d158] to-[#0a84ff]')}>
              <I.Server size={21} />
            </div>
            <div className="flex-1">
              <div className="text-[17px] font-semibold tracking-tight">{isOld ? 'Old VPS' : 'New VPS'}</div>
              <div className="text-secondary text-[12.5px]">{isOld ? 'Move projects from here' : 'Move projects to here'}</div>
            </div>
            <AnimatePresence mode="wait">
              {testing ? <motion.span key="s" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}><Spinner size={20} /></motion.span>
                : result?.ok ? <motion.span key="ok"><CheckBadge size={26} /></motion.span>
                : result ? <motion.span key="x"><CheckBadge size={26} tone="red" kind="x" /></motion.span> : null}
            </AnimatePresence>
          </div>
          <div className="grid grid-cols-[1fr_88px] gap-3">
            <Field label="IP address or hostname" value={value.host} onChange={set('host')} placeholder={isOld ? '203.0.113.10' : '198.51.100.20'} mono />
            <Field label="SSH port" value={value.port} onChange={(v) => set('port')(v.replace(/[^0-9]/g, ''))} placeholder="22" inputMode="numeric" mono />
          </div>
          <div className="mt-3"><Field label="Username" value={value.username} onChange={set('username')} placeholder="root" mono /></div>
          <div className="mt-3">
            {value.useKey ? (
              <label className="block">
                <span className="text-secondary mb-1.5 block px-1 text-[12px] font-medium">Private key (OpenSSH format)</span>
                <textarea className="ios-input h-24 resize-none font-mono text-[11px]" value={value.privateKey} onChange={(e) => set('privateKey')(e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" spellCheck={false} />
              </label>
            ) : null}
            <div className={value.useKey ? 'mt-3' : ''}>
              <Field label={value.useKey ? 'Password (for sudo, optional)' : 'Password'} type="password" value={value.password} onChange={set('password')} placeholder="••••••••" />
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between gap-3">
            <label className="text-secondary flex items-center gap-2.5 text-[13px]"><Switch checked={value.useKey} onChange={set('useKey')} /> Use SSH key</label>
            <Button variant="tinted" size="sm" onClick={onTest} loading={testing} icon={!testing && <I.Wifi size={14} />}>Test</Button>
          </div>
          <AnimatePresence>
            {result && (
              <motion.div initial={{ opacity: 0, height: 0, marginTop: 0 }} animate={{ opacity: 1, height: 'auto', marginTop: 14 }} exit={{ opacity: 0, height: 0, marginTop: 0 }} className="overflow-hidden">
                {result.ok ? (
                  <div className="rounded-[14px] bg-[#30d158]/10 px-3.5 py-2.5 text-[12.5px]">
                    <div className="font-semibold text-[#1f8f3c] dark:text-[#6ee28d]">Connected to {result.hostname}</div>
                    <div className="text-secondary mt-0.5">{result.os} · {result.arch} · {fmtKB(result.memKB)} RAM · {fmtKB(result.diskKB)} free</div>
                    <div className="text-secondary">{result.root ? 'Logged in as root' : result.privileges === 'password' || result.privileges === 'nopasswd' ? `User ${result.user} with sudo` : `⚠️ ${result.user} has no sudo access`}</div>
                  </div>
                ) : (
                  <div className="rounded-[14px] bg-[#ff453a]/10 px-3.5 py-2.5 text-[12.5px] font-medium text-[#c4271d] dark:text-[#ff8a82]">{result.error}</div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        </Tilt>
      </Shake>
    </motion.div>
  );
}

export default function Connect({ servers, setServers, onBack, onJob }) {
  const [results, setResults] = useState({});
  const [testing, setTesting] = useState({});
  const [sheet, setSheet] = useState(false);
  const [starting, setStarting] = useState(false);

  const payload = (s) => ({ host: s.host.trim(), port: Number(s.port) || 22, username: s.username.trim(), password: s.password, privateKey: s.useKey ? s.privateKey : undefined });
  const key = (s) => JSON.stringify(payload(s));

  const test = async (side) => {
    const s = servers[side];
    setTesting((t) => ({ ...t, [side]: true }));
    try {
      const r = await api('/test', { body: payload(s) });
      const res = { ...r, t: Date.now(), key: key(s) };
      if (r.ok && !r.root && !['password', 'nopasswd'].includes(r.privileges)) { res.ok = false; res.error = `User "${r.user}" can't become root (no sudo). Use root or a sudo user.`; }
      setResults((x) => ({ ...x, [side]: res }));
      return res;
    } catch (e) {
      const res = { ok: false, error: e.message, t: Date.now() };
      setResults((x) => ({ ...x, [side]: res }));
      return res;
    } finally {
      setTesting((t) => ({ ...t, [side]: false }));
    }
  };

  const proceed = async () => {
    const need = ['source', 'target'].filter((s) => !results[s]?.ok || results[s].key !== key(servers[s]));
    const rs = await Promise.all(need.map((s) => test(s)));
    if (rs.some((r) => !r.ok)) { toast('Check the server details', 'One of the servers could not be reached.', 'red'); return; }
    setSheet(true);
  };

  const start = async () => {
    setStarting(true);
    try {
      const r = await api('/jobs', { body: { source: payload(servers.source), target: payload(servers.target), fingerprints: { source: results.source.fingerprint, target: results.target.fingerprint } } });
      setSheet(false);
      onJob(r.id);
    } catch (e) {
      toast('Could not start', e.message, 'red');
    } finally {
      setStarting(false);
    }
  };

  const filled = (s) => s.host && s.username && (s.password || (s.useKey && s.privateKey));
  return (
    <div className="flex flex-1 flex-col px-4 py-6 sm:px-8 sm:py-8">
      <div className="mb-6 text-center">
        <h2 className="text-[28px] font-extrabold tracking-[-0.035em] sm:text-[36px]">Connect your <span className="text-rainbow">two servers</span></h2>
        <p className="text-secondary mx-auto mt-1 max-w-md text-[15px]">Enter the login you use for SSH. Shift only uses it during the move.</p>
      </div>
      <div className="flex flex-col items-stretch gap-4 lg:flex-row lg:items-center">
        <ServerCard side="source" index={0} value={servers.source} onChange={(v) => setServers((s) => ({ ...s, source: v }))} result={results.source} testing={testing.source} onTest={() => test('source')} />
        <div className="flex shrink-0 items-center justify-center lg:w-16">
          <div className="relative grid h-14 w-14 rotate-90 place-items-center lg:rotate-0">
            {[0, 1].map((i) => <motion.span key={i} className="absolute inset-0 rounded-full bg-[var(--color-ios-blue)]/30" animate={{ scale: [1, 1.9], opacity: [0.6, 0] }} transition={{ duration: 1.8, repeat: Infinity, delay: i * 0.9 }} />)}
            <motion.div animate={{ x: [0, 5, 0] }} transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
              className="relative grid h-12 w-12 place-items-center rounded-full bg-gradient-to-br from-[#0a84ff] to-[#bf5af2] text-white shadow-[0_10px_30px_-6px_rgba(94,92,230,.9)]">
              <I.ArrowRight size={22} strokeWidth={2.6} />
            </motion.div>
          </div>
        </div>
        <ServerCard side="target" index={1} value={servers.target} onChange={(v) => setServers((s) => ({ ...s, target: v }))} result={results.target} testing={testing.target} onTest={() => test('target')} />
      </div>
      <div className="mt-auto flex flex-col-reverse items-center justify-between gap-3 pt-8 sm:flex-row">
        <Button variant="ghost" onClick={onBack} icon={<I.ArrowLeft size={17} />}>Back</Button>
        <GlowRing radius={16} active={!!(filled(servers.source) && filled(servers.target))} className="w-full sm:w-auto">
          <Button size="lg" onClick={proceed} disabled={!filled(servers.source) || !filled(servers.target)} loading={testing.source || testing.target}
            icon={<I.Radar size={19} />} className="w-full sm:min-w-[260px]">Find my projects</Button>
        </GlowRing>
      </div>

      <Sheet open={sheet} onClose={() => setSheet(false)} width={520}>
        <div className="mb-4 flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-[13px] bg-[var(--color-ios-blue)] text-white"><I.Fingerprint size={22} /></div>
          <div>
            <div className="text-[17px] font-semibold">Are these your servers?</div>
            <div className="text-secondary text-[13px]">Shift will only talk to servers with these exact fingerprints.</div>
          </div>
        </div>
        {['source', 'target'].map((s) => (
          <div key={s} className="glass-soft mb-2.5 rounded-2xl px-4 py-3">
            <div className="flex items-center justify-between text-[13px] font-semibold">
              <span>{s === 'source' ? 'Old VPS' : 'New VPS'} · <span className="font-mono font-medium">{servers[s].host}</span></span>
              <span className="text-secondary font-normal">{results[s]?.hostname}</span>
            </div>
            <div className="text-secondary mt-1 break-all font-mono text-[11.5px]">{results[s]?.fingerprint}</div>
          </div>
        ))}
        <p className="text-secondary mt-3 text-[12.5px] leading-relaxed">
          Next, Shift looks for your projects. This only <b>reads</b> your old VPS. It also adds a temporary helper (a work folder{servers.source.username !== 'root' || servers.target.username !== 'root' ? ', and password-free sudo for this move' : ''}) that is removed at the end.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setSheet(false)}>Cancel</Button>
          <Button onClick={start} loading={starting} icon={<I.ShieldCheck size={17} />}>Trust & continue</Button>
        </div>
      </Sheet>
    </div>
  );
}
