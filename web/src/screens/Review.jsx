import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Button, Switch, Segmented, Chip, CheckBadge, Sheet, Field, ServerFlow, Spinner, I, cx, spring, bouncy, toast } from '../ui.jsx';
import { api, fmtKB } from '../api.js';

const ICONS = {
  telegram: [I.Send, 'from-[#5ac8fa] to-[#0a84ff]'],
  discord: [I.Gamepad2, 'from-[#7b83ff] to-[#5865f2]'],
  whatsapp: [I.MessageCircle, 'from-[#4cd964] to-[#25d366]'],
  database: [I.Database, 'from-[#ff9f0a] to-[#ff6b00]'],
  clock: [I.Clock, 'from-[#8e8e93] to-[#636366]'],
  globe: [I.Globe, 'from-[#30d158] to-[#00c7be]'],
  docker: [I.Container, 'from-[#64d2ff] to-[#0a84ff]'],
  api: [I.Braces, 'from-[#bf5af2] to-[#5e5ce6]'],
  python: [I.Code, 'from-[#ffd60a] to-[#3b82f6]'],
  node: [I.Box, 'from-[#34c759] to-[#248a3d]'],
  php: [I.Code, 'from-[#8e9aff] to-[#5e5ce6]'],
  folder: [I.Folder, 'from-[#64d2ff] to-[#5ac8fa]'],
};
const TAG_TONE = { 'Telegram bot': 'blue', 'Telegram userbot': 'blue', 'Telegram session': 'teal', 'Discord bot': 'purple', 'WhatsApp bot': 'green', Website: 'green', API: 'purple', Database: 'orange', Scheduled: 'gray', PHP: 'purple', 'PHP app': 'purple' };
const KIND_ORDER = { pm2: 0, systemd: 0, process: 0, supervisor: 0, compose: 1, container: 1, site: 2, db: 3, cron: 4, crond: 4, folder: 5 };

function ProjectCard({ p, selected, onToggle, jobId, onAuthed, index }) {
  const [open, setOpen] = useState(false);
  const [auth, setAuth] = useState({ user: 'root', password: '' });
  const [busy, setBusy] = useState(false);
  const [Icon, grad] = ICONS[p.icon] || ICONS.folder;
  const unlock = async () => {
    setBusy(true);
    try { await api(`/jobs/${jobId}/dbauth`, { body: { projectId: p.id, ...auth } }); toast('Database unlocked', p.title, 'green'); onAuthed?.(); }
    catch (e) { toast('Login failed', e.message, 'red'); }
    finally { setBusy(false); }
  };
  return (
    <motion.div layout initial={{ opacity: 0, y: 18, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ ...bouncy, damping: 24, delay: Math.min(index * 0.05, 0.6) }}
      className={cx('glass-soft overflow-hidden rounded-[20px] transition-opacity', !selected && 'opacity-55')}>
      <div className="flex cursor-pointer items-center gap-3.5 px-4 py-3.5" onClick={() => setOpen(!open)}>
        <div className={cx('relative grid h-11 w-11 shrink-0 place-items-center rounded-[13px] bg-gradient-to-br text-white shadow-md', grad)}>
          <Icon size={20} />
          <span className={cx('absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-[2.5px] border-white dark:border-[#1c1c22]', p.running ? 'bg-[var(--color-ios-green)]' : 'bg-[#8e8e93]')} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[15px] font-semibold tracking-tight">{p.title}</span>
            {p.warnings?.length > 0 && p.needsAuth && <I.Lock size={13} className="text-[var(--color-ios-orange)]" />}
          </div>
          <div className="text-secondary truncate text-[12.5px]">
            {p.manager}{p.kind !== 'db' && p.kind !== 'cron' && p.dir ? ` · ${p.dir}` : ''}{p.size ? ` · ${fmtKB(p.size)}` : ''}{p.runtime?.version ? ` · ${p.runtime.type} ${p.runtime.version}` : ''}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {p.tags.map((t) => <Chip key={t} tone={TAG_TONE[t] || 'gray'}>{t}</Chip>)}
            {p.ports?.slice(0, 3).map((x) => <Chip key={x}>:{x}</Chip>)}
            {p.domains?.slice(0, 2).map((d) => <Chip key={d} tone="green"><I.Globe size={10} />{d}</Chip>)}
            {p.kind === 'db' && p.databases?.slice(0, 3).map((d) => <Chip key={d} tone="orange">{d}</Chip>)}
          </div>
        </div>
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={spring} className="text-tertiary hidden sm:block"><I.ChevronRight size={18} /></motion.span>
        <Switch checked={selected} onChange={onToggle} />
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring} className="overflow-hidden">
            <div className="hairline space-y-2.5 border-t px-4 py-3.5 text-[13px]">
              {p.cmd && (
                <div>
                  <div className="text-tertiary mb-1 text-[11px] font-semibold uppercase tracking-wide">{p.kind === 'cron' ? 'Jobs' : p.kind === 'site' ? 'Domains' : 'Command'}</div>
                  <pre className="scroll-thin overflow-x-auto whitespace-pre-wrap break-all rounded-xl bg-black/[.05] px-3 py-2 font-mono text-[12px] dark:bg-white/[.06]">{p.cmd}</pre>
                </div>
              )}
              <div className="text-secondary flex flex-wrap gap-x-5 gap-y-1">
                <span>Runs as <b className="font-semibold">{p.user}</b></span>
                <span>Status: {p.status}</span>
                {p.runtime?.venv && <span>venv: {p.runtime.venv}</span>}
              </div>
              {p.notes?.map((n) => <div key={n} className="text-secondary flex gap-2"><I.Info size={15} className="mt-0.5 shrink-0" />{n}</div>)}
              {p.warnings?.map((w) => <div key={w} className="flex gap-2 text-[#b86e00] dark:text-[#ffc266]"><I.ShieldCheck size={15} className="mt-0.5 shrink-0" />{w}</div>)}
              {p.needsAuth && (
                <div className="grid grid-cols-1 gap-2 pt-1 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                  <Field label="Database admin user" value={auth.user} onChange={(v) => setAuth({ ...auth, user: v })} mono />
                  <Field label="Password" type="password" value={auth.password} onChange={(v) => setAuth({ ...auth, password: v })} />
                  <Button size="md" onClick={unlock} loading={busy} icon={<I.KeyRound size={16} />}>Unlock</Button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function CheckRow({ c, i }) {
  const tone = c.level === 'ok' ? 'green' : c.level === 'warn' ? 'orange' : 'red';
  return (
    <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.15 + i * 0.07, ...spring }} className="flex gap-3 py-2">
      <div className="pt-0.5"><CheckBadge size={20} tone={tone} kind={c.level === 'ok' ? 'check' : c.level === 'warn' ? 'bang' : 'x'} delay={0.15 + i * 0.07} /></div>
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium leading-snug">{c.title}</div>
        {c.detail && <div className="text-secondary break-words text-[12px] leading-snug">{c.detail}</div>}
      </div>
    </motion.div>
  );
}

export default function Review({ state, jobId, onBack }) {
  const [selection, setSelection] = useState(state.selection || []);
  const [options, setOptions] = useState({ autoRollback: true, copyHomes: true, convertToSystemd: true, rehearsal: false, stabilitySeconds: 30, bandwidthLimitMBs: 0, ...state.options });
  const [checking, setChecking] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [starting, setStarting] = useState(false);
  const [adv, setAdv] = useState(false);
  const first = useRef(true);
  const pf = state.preflight;
  const projects = useMemo(() => [...state.projects].sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9)), [state.projects]);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setChecking(true);
    const t = setTimeout(() => {
      api(`/jobs/${jobId}/preflight`, { body: { selection, options } }).catch((e) => toast('Check failed', e.message, 'red')).finally(() => setChecking(false));
    }, 450);
    return () => clearTimeout(t);
  }, [JSON.stringify(selection), JSON.stringify(options)]);

  const toggle = (id) => setSelection((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const sel = projects.filter((p) => selection.includes(p.id));
  const errors = pf?.checks?.filter((c) => c.level === 'error') || [];
  const warns = pf?.checks?.filter((c) => c.level === 'warn') || [];
  const ready = pf?.ok && !checking && sel.length > 0;
  const src = state.servers.source, tgt = state.servers.target;

  const start = async () => {
    setStarting(true);
    try { await api(`/jobs/${jobId}/start`, { body: { selection, options } }); setConfirm(false); }
    catch (e) { toast('Could not start', e.message, 'red'); }
    finally { setStarting(false); }
  };

  const Opt = ({ k, title, desc }) => (
    <div className="flex items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1"><div className="text-[13.5px] font-medium">{title}</div><div className="text-secondary text-[12px] leading-snug">{desc}</div></div>
      <Switch checked={!!options[k]} onChange={(v) => setOptions((o) => ({ ...o, [k]: v }))} />
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="hairline border-b px-4 py-4 sm:px-6">
        <ServerFlow active={false}
          left={{ label: 'Old VPS', host: src.host, os: src.info?.name }}
          right={{ label: 'New VPS', host: tgt.host, os: tgt.info?.name, tone: 'green' }} />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="scroll-thin min-h-0 overflow-y-auto px-4 py-5 sm:px-6 lg:max-h-[calc(100dvh-210px)]">
          <div className="mb-3 flex items-end justify-between px-1">
            <div>
              <h2 className="text-[22px] font-bold tracking-[-0.02em]">Found {projects.length} thing{projects.length === 1 ? '' : 's'} to move</h2>
              <p className="text-secondary text-[13px]">Everything is selected. Untick anything you want to leave behind.</p>
            </div>
            <button className="text-[13px] font-medium text-[var(--color-ios-blue)]" onClick={() => setSelection(selection.length === projects.length ? [] : projects.map((p) => p.id))}>
              {selection.length === projects.length ? 'Select none' : 'Select all'}
            </button>
          </div>
          {projects.length === 0 && (
            <div className="glass-soft rounded-[20px] px-6 py-10 text-center">
              <I.Search size={28} className="text-tertiary mx-auto" />
              <div className="mt-3 font-semibold">No projects found</div>
              <div className="text-secondary text-[13px]">Shift looks for PM2, systemd, Docker, screen/tmux, cron, nginx and databases.</div>
            </div>
          )}
          <div className="space-y-2.5">
            {projects.map((p, i) => <ProjectCard key={p.id} p={p} index={i} jobId={jobId} selected={selection.includes(p.id)} onToggle={() => toggle(p.id)} />)}
          </div>
        </div>
        <div className="hairline border-t px-4 py-5 sm:px-6 lg:border-l lg:border-t-0">
          <div className="lg:sticky lg:top-0">
            <div className="mb-1 flex items-center justify-between">
              <h3 className="text-[17px] font-semibold tracking-tight">Pre-flight checks</h3>
              {checking ? <Spinner size={16} /> : pf && <span className="text-tertiary text-[12px]">{errors.length ? `${errors.length} to fix` : warns.length ? `${warns.length} note${warns.length > 1 ? 's' : ''}` : 'All good'}</span>}
            </div>
            <div className="glass-soft scroll-thin max-h-[340px] overflow-y-auto rounded-[18px] px-4 py-1.5">
              {(pf?.checks || []).map((c, i) => <CheckRow key={c.id + c.title} c={c} i={i} />)}
              {!pf && <div className="text-secondary py-4 text-center text-[13px]">Checking…</div>}
            </div>
            <button onClick={() => setAdv(!adv)} className="text-secondary mt-4 flex w-full items-center justify-between px-1 text-[13px] font-medium">
              <span className="flex items-center gap-1.5"><I.Settings2 size={15} /> Options</span>
              <motion.span animate={{ rotate: adv ? 180 : 0 }} transition={spring}><I.ChevronDown size={16} /></motion.span>
            </button>
            <AnimatePresence initial={false}>
              {adv && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring} className="overflow-hidden">
                  <div className="glass-soft hairline mt-2 divide-y divide-black/5 rounded-[18px] px-4 dark:divide-white/5">
                    <Opt k="autoRollback" title="Automatic rollback" desc="If anything fails, restart everything on the old VPS." />
                    <Opt k="rehearsal" title="Rehearsal mode" desc="Copy and prepare everything, but don't stop anything. A safe test run." />
                    <Opt k="copyHomes" title="Copy whole home folders" desc="Brings along configs, keys and sessions next to your projects." />
                    <Opt k="convertToSystemd" title="Run scripts as services" desc="screen/nohup scripts restart automatically after a reboot." />
                    <div className="flex items-center justify-between gap-3 py-2.5">
                      <div className="text-[13.5px] font-medium">Watch for crashes</div>
                      <Segmented value={options.stabilitySeconds} onChange={(v) => setOptions((o) => ({ ...o, stabilitySeconds: v }))} options={[{ value: 15, label: '15s' }, { value: 30, label: '30s' }, { value: 60, label: '60s' }]} />
                    </div>
                    <div className="flex items-center justify-between gap-3 py-2.5">
                      <div className="text-[13.5px] font-medium">Speed limit</div>
                      <Segmented value={options.bandwidthLimitMBs} onChange={(v) => setOptions((o) => ({ ...o, bandwidthLimitMBs: v }))} options={[{ value: 0, label: 'None' }, { value: 50, label: '50 MB/s' }, { value: 10, label: '10 MB/s' }]} />
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            <div className="mt-5">
              <div className="text-secondary mb-2 flex justify-between px-1 text-[12.5px]">
                <span>{sel.length} selected</span>
                <span>{fmtKB((pf?.totalKB || 0) + (pf?.dbKB || 0))} to copy</span>
              </div>
              <Button size="lg" className="w-full" disabled={!ready} onClick={() => setConfirm(true)} icon={<I.Play size={18} fill="currentColor" />}>
                {options.rehearsal ? 'Start rehearsal' : 'Start transfer'}
              </Button>
              <Button variant="ghost" className="mt-2 w-full" onClick={onBack}>Change servers</Button>
            </div>
          </div>
        </div>
      </div>

      <Sheet open={confirm} onClose={() => setConfirm(false)} width={480}>
        <div className="mb-3 flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-[13px] bg-[var(--color-ios-blue)] text-white">{options.rehearsal ? <I.FlaskConical size={22} /> : <I.Rocket size={22} />}</div>
          <div className="text-[18px] font-semibold tracking-tight">{options.rehearsal ? 'Start a rehearsal?' : `Move ${sel.length} item${sel.length === 1 ? '' : 's'} now?`}</div>
        </div>
        {options.rehearsal ? (
          <p className="text-secondary text-[14px] leading-relaxed">Shift copies everything and prepares the new VPS, but <b>nothing is stopped</b> on the old VPS. Use it to test before the real move.</p>
        ) : (
          <ol className="text-secondary space-y-2 text-[14px] leading-relaxed">
            <li className="flex gap-2.5"><span className="font-semibold text-[var(--color-ios-blue)]">1</span>Files are copied while your projects keep running.</li>
            <li className="flex gap-2.5"><span className="font-semibold text-[var(--color-ios-blue)]">2</span>Projects are stopped on the old VPS for a short moment, and the last changes are copied.</li>
            <li className="flex gap-2.5"><span className="font-semibold text-[var(--color-ios-blue)]">3</span>They start on the new VPS and are checked.</li>
            <li className="flex gap-2.5"><span className="font-semibold text-[var(--color-ios-green)]"><I.ShieldCheck size={16} /></span>{options.autoRollback ? 'If anything fails, the old VPS is restarted automatically.' : 'Automatic rollback is OFF — you can still roll back with one click.'}</li>
          </ol>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirm(false)}>Not yet</Button>
          <Button onClick={start} loading={starting} icon={<I.Play size={16} fill="currentColor" />}>{options.rehearsal ? 'Start rehearsal' : 'Start'}</Button>
        </div>
      </Sheet>
    </div>
  );
}
