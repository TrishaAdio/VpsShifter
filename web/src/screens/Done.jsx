import React, { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ActivityRings, CheckBadge, Button, Terminal, Sheet, Field, Chip, I, cx, spring, bouncy, toast } from '../ui.jsx';
import { Steps } from './Transfer.jsx';
import { api } from '../api.js';

function Hero({ status, error }) {
  const conf = {
    done: { tone: 'green', kind: 'check', title: 'Moved!', text: 'Your projects now run on the new VPS and passed all checks.' },
    rolledback: { tone: 'orange', kind: 'bang', title: 'Rolled back — nothing lost', text: 'Something didn\u2019t work on the new VPS, so Shift restarted everything on the old VPS.' },
    failed: { tone: 'red', kind: 'x', title: 'The move didn\u2019t finish', text: 'See the details below.' },
    rehearsed: { tone: 'blue', kind: 'check', title: 'Rehearsal complete', text: 'Everything was copied and prepared. Nothing was stopped on the old VPS.' },
  }[status] || { tone: 'blue', kind: 'check', title: status, text: '' };
  return (
    <div className="flex flex-col items-center text-center">
      <motion.div initial={{ scale: 0.3, opacity: 0, rotate: -20 }} animate={{ scale: 1, opacity: 1, rotate: 0 }} transition={{ ...bouncy, damping: 14 }}>
        <CheckBadge size={84} tone={conf.tone} kind={conf.kind} delay={0.1} />
      </motion.div>
      <motion.h2 initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }} className="mt-5 text-[30px] font-bold tracking-[-0.03em]">{conf.title}</motion.h2>
      <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.35 }} className="text-secondary mt-1 max-w-md text-[15px]">{conf.text}</motion.p>
      {error && status !== 'done' && <p className="mt-2 max-w-lg rounded-xl bg-[#ff453a]/10 px-3 py-2 text-[13px] font-medium text-[#c4271d] dark:text-[#ff8a82]">{error}</p>}
    </div>
  );
}

function CopyBtn({ text }) {
  const [ok, setOk] = useState(false);
  return (
    <button onClick={() => { navigator.clipboard?.writeText(text); setOk(true); setTimeout(() => setOk(false), 1400); }} className="text-[var(--color-ios-blue)]" aria-label="Copy">
      <AnimatePresence mode="wait" initial={false}>
        <motion.span key={ok ? 'y' : 'n'} initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.5, opacity: 0 }} className="block">{ok ? <I.Check size={16} /> : <I.Copy size={16} />}</motion.span>
      </AnimatePresence>
    </button>
  );
}

export default function Done({ state, logs, jobId, onAgain, onNew }) {
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recon, setRecon] = useState(false);
  const [pw, setPw] = useState({ source: '', target: '' });
  const verify = state.results?.verify || [];
  const domains = useMemo(() => [...new Set(state.projects.filter((p) => state.selection.includes(p.id)).flatMap((p) => p.domains || []))], [state]);
  const warnings = [...new Set(state.results?.warnings || [])];
  const newIp = state.servers.target.host;

  const rollback = async () => {
    setBusy(true);
    try { await api(`/jobs/${jobId}/rollback`, { body: {} }); setSheet(false); toast('Rolling back…', 'Restarting projects on the old VPS.', 'orange'); }
    catch (e) {
      if (/Reconnect/.test(e.message)) { setSheet(false); setRecon(true); } else toast('Rollback', e.message, 'red');
    } finally { setBusy(false); }
  };
  const reconnect = async () => {
    setBusy(true);
    try { await api(`/jobs/${jobId}/reconnect`, { body: { source: { password: pw.source }, target: { password: pw.target } } }); setRecon(false); toast('Reconnected', 'You can roll back now.', 'green'); setSheet(true); }
    catch (e) { toast('Could not reconnect', e.message, 'red'); }
    finally { setBusy(false); }
  };

  return (
    <div className="scroll-thin flex-1 overflow-y-auto px-4 py-8 sm:px-8">
      <Hero status={state.status} error={state.error} />
      {state.status === 'done' && (
        <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.4, ...spring }} className="mt-6 flex justify-center">
          <ActivityRings size={120} values={[1, 1, 1]} />
        </motion.div>
      )}

      <div className="mx-auto mt-8 grid max-w-5xl grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-5">
          {state.status === 'done' && domains.length > 0 && (
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }} className="glass-soft rounded-[20px] p-5">
              <div className="flex items-center gap-2 text-[16px] font-semibold"><I.Globe size={18} className="text-[var(--color-ios-green)]" />One last thing: update your DNS</div>
              <p className="text-secondary mt-1 text-[13px]">At your domain provider (e.g. Cloudflare), set the <b>A record</b> of these domains to the new IP. Until then, visitors still reach the old VPS.</p>
              <div className="mt-3 space-y-1.5">
                {domains.map((d) => (
                  <div key={d} className="flex items-center gap-3 rounded-xl bg-black/[.04] px-3 py-2 font-mono text-[13px] dark:bg-white/[.05]">
                    <span className="flex-1 truncate">{d}</span><span className="text-tertiary">A →</span><span className="font-semibold">{newIp}</span><CopyBtn text={newIp} />
                  </div>
                ))}
              </div>
            </motion.div>
          )}
          {verify.length > 0 && (
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.55 }} className="glass-soft rounded-[20px] p-5">
              <div className="mb-3 text-[16px] font-semibold">Checks on the new VPS</div>
              <div className="space-y-3">
                {verify.map((r, i) => (
                  <motion.div key={r.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.6 + i * 0.05 }}>
                    <div className="flex items-center gap-2 text-[14px] font-semibold">
                      <CheckBadge size={18} tone={r.checks.some((c) => c.level === 'error') ? 'red' : r.checks.some((c) => c.level === 'warn') ? 'orange' : 'green'}
                        kind={r.checks.some((c) => c.level === 'error') ? 'x' : r.checks.some((c) => c.level === 'warn') ? 'bang' : 'check'} delay={0.6 + i * 0.05} />
                      {r.title}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1.5 pl-[26px]">
                      {r.checks.map((c, j) => (
                        <span key={j} title={c.detail} className={cx('inline-flex items-center gap-1 rounded-full px-2 py-[2px] text-[11.5px]',
                          c.level === 'ok' ? 'bg-[#30d158]/12 text-[#1f8f3c] dark:text-[#6ee28d]' : c.level === 'warn' ? 'bg-[#ff9f0a]/14 text-[#b86e00] dark:text-[#ffc266]' : 'bg-[#ff453a]/12 text-[#c4271d] dark:text-[#ff8a82]')}>
                          {c.name}{c.level !== 'ok' && c.detail ? `: ${c.detail}` : ''}
                        </span>
                      ))}
                    </div>
                  </motion.div>
                ))}
              </div>
            </motion.div>
          )}
          {warnings.length > 0 && (
            <div className="glass-soft rounded-[20px] p-5">
              <div className="mb-2 text-[15px] font-semibold">Notes</div>
              {warnings.map((w) => <div key={w} className="text-secondary flex gap-2 py-1 text-[13px]"><I.Info size={15} className="mt-0.5 shrink-0" />{w}</div>)}
            </div>
          )}
          <Terminal logs={logs} height={220} />
        </div>
        <div className="space-y-3">
          <div className="glass-soft rounded-[20px] p-4"><Steps steps={state.steps} /></div>
          <a href={`/api/jobs/${jobId}/report`} className="block"><Button variant="secondary" className="w-full" icon={<I.Download size={16} />}>Download report</Button></a>
          {state.status === 'done' && <Button variant="danger" className="w-full" onClick={() => setSheet(true)} icon={<I.Undo2 size={16} />}>Roll back to old VPS</Button>}
          {(state.status === 'rolledback' || state.status === 'failed') && <Button className="w-full" onClick={onAgain} icon={<I.RefreshCw size={16} />}>Try again</Button>}
          {state.status === 'failed' && state.cutoverStarted && <Button variant="danger" className="w-full" onClick={() => setSheet(true)} icon={<I.Undo2 size={16} />}>Roll back now</Button>}
          {state.status === 'rehearsed' && <Button className="w-full" onClick={onAgain} icon={<I.Rocket size={16} />}>Do the real move</Button>}
          <Button variant="ghost" className="w-full" onClick={onNew}>New migration</Button>
          {state.status === 'done' && (
            <p className="text-tertiary px-1 text-[12px] leading-relaxed">Your old VPS still has all files — projects there are only stopped. Delete it when you’re happy.</p>
          )}
        </div>
      </div>

      <Sheet open={sheet} onClose={() => setSheet(false)}>
        <div className="text-[18px] font-semibold">Roll back to the old VPS?</div>
        <p className="text-secondary mt-2 text-[14px]">Shift stops the projects on the new VPS and starts them again on the old VPS, exactly as they were. Data written on the new VPS since the move stays there.</p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setSheet(false)}>Cancel</Button>
          <Button variant="danger" loading={busy} onClick={rollback}>Roll back</Button>
        </div>
      </Sheet>
      <Sheet open={recon} onClose={() => setRecon(false)}>
        <div className="text-[18px] font-semibold">Reconnect to both servers</div>
        <p className="text-secondary mt-1 text-[13.5px]">Shift was restarted, so it needs the passwords again.</p>
        <div className="mt-4 space-y-3">
          <Field label={`Old VPS password (${state.servers.source.username}@${state.servers.source.host})`} type="password" value={pw.source} onChange={(v) => setPw({ ...pw, source: v })} />
          <Field label={`New VPS password (${state.servers.target.username}@${state.servers.target.host})`} type="password" value={pw.target} onChange={(v) => setPw({ ...pw, target: v })} />
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setRecon(false)}>Cancel</Button>
          <Button loading={busy} onClick={reconnect}>Reconnect</Button>
        </div>
      </Sheet>
    </div>
  );
}
