import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ActivityRings, ServerFlow, Terminal, Spinner, CheckBadge, Button, Sheet, I, cx, spring, toast } from '../ui.jsx';
import { api } from '../api.js';

export function StepIcon({ status }) {
  if (status === 'done') return <CheckBadge size={22} />;
  if (status === 'warn') return <CheckBadge size={22} tone="orange" kind="bang" />;
  if (status === 'failed') return <CheckBadge size={22} tone="red" kind="x" />;
  if (status === 'running') return <span className="grid h-[22px] w-[22px] place-items-center rounded-full bg-[var(--color-ios-blue)]/15 text-[var(--color-ios-blue)]"><Spinner size={13} /></span>;
  if (status === 'skipped') return <span className="grid h-[22px] w-[22px] place-items-center rounded-full bg-black/[.06] dark:bg-white/[.08]"><I.Minus size={12} /></span>;
  return <span className="block h-[22px] w-[22px] rounded-full border-2 border-black/15 dark:border-white/15" />;
}

function useNow(active) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!active) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [active]);
  return now;
}
const dur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };

export function Steps({ steps, compact }) {
  const now = useNow(true);
  return (
    <div className="relative">
      {steps.map((s, i) => (
        <motion.div key={s.id} layout initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04, ...spring }} className="relative flex gap-3 pb-3.5 last:pb-0">
          {i < steps.length - 1 && <span className={cx('absolute left-[10.5px] top-[24px] h-[calc(100%-22px)] w-[1.5px]', ['done', 'warn', 'skipped'].includes(s.status) ? 'bg-[var(--color-ios-green)]/50' : 'bg-black/10 dark:bg-white/10')} />}
          <div className="relative z-10 shrink-0 bg-transparent"><StepIcon status={s.status} /></div>
          <div className="min-w-0 flex-1 pt-0.5">
            <div className={cx('flex items-baseline justify-between gap-2 text-[13.5px] leading-tight', s.status === 'running' ? 'font-semibold' : 'font-medium', s.status === 'pending' && 'text-tertiary')}>
              <span>{s.title}</span>
              {s.startedAt && <span className="text-tertiary shrink-0 text-[11.5px] font-normal tabular-nums">{dur((s.endedAt || now) - s.startedAt)}</span>}
            </div>
            {!compact && s.detail && <div className={cx('text-[12px] leading-snug', s.status === 'failed' ? 'text-[#c4271d] dark:text-[#ff8a82]' : 'text-secondary')}>{s.detail}</div>}
          </div>
        </motion.div>
      ))}
    </div>
  );
}

export default function Transfer({ state, logs, jobId }) {
  const [showLog, setShowLog] = useState(true);
  const [cancelSheet, setCancelSheet] = useState(false);
  const p = state.progress || {};
  const rolling = state.status === 'rolling-back';
  const pct = Math.round((p.overall || 0) * 100);
  const cancel = async () => {
    try { await api(`/jobs/${jobId}/cancel`, { body: {} }); toast('Cancelling…', 'Your old VPS was not changed.', 'orange'); setCancelSheet(false); }
    catch (e) { toast('Cannot cancel', e.message, 'red'); }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="hairline border-b px-4 pb-4 pt-14 sm:px-6 sm:pt-12">
        <ServerFlow active tone={rolling ? 'orange' : 'blue'} reverse={rolling}
          left={{ label: 'Old VPS', host: state.servers.source.host, os: state.servers.source.info?.name, dim: state.cutoverStarted && !rolling }}
          right={{ label: 'New VPS', host: state.servers.target.host, os: state.servers.target.info?.name, tone: 'green', dim: rolling }} />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_330px]">
        <div className="flex min-w-0 flex-col items-center">
          <ActivityRings size={230} values={[p.files || 0, p.databases || 0, p.services || 0]}
            labels={<div><div className="text-[40px] font-bold tabular-nums tracking-[-0.04em]">{pct}<span className="text-[22px]">%</span></div><div className="text-secondary -mt-1 text-[12px]">{rolling ? 'rolling back' : 'complete'}</div></div>} />
          <div className="mt-4 flex gap-4 text-[12.5px]">
            {[['Files', '#ff2d55', p.files], ['Databases', '#30d158', p.databases], ['Services', '#0a84ff', p.services]].map(([n, c, v]) => (
              <span key={n} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: c }} />{n} <span className="text-tertiary tabular-nums">{Math.round((v || 0) * 100)}%</span></span>
            ))}
          </div>
          <AnimatePresence mode="wait">
            <motion.div key={p.current} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} className="mt-5 text-center text-[16px] font-semibold tracking-tight">
              {p.current}
            </motion.div>
          </AnimatePresence>
          <div className="text-secondary mt-1 text-[13px]">
            {rolling ? 'Something went wrong, so Shift is putting everything back on the old VPS.' : state.cutoverStarted ? 'Projects are paused on the old VPS — this part is quick.' : 'Your projects are still running on the old VPS.'}
          </div>
          <div className="mt-6 w-full">
            <button onClick={() => setShowLog(!showLog)} className="text-secondary mb-2 flex items-center gap-1.5 text-[13px] font-medium">
              <I.Terminal size={15} /> {showLog ? 'Hide' : 'Show'} live log
            </button>
            <AnimatePresence initial={false}>
              {showLog && <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring} className="overflow-hidden"><Terminal logs={logs} height={240} /></motion.div>}
            </AnimatePresence>
          </div>
        </div>
        <div>
          <div className="glass-soft rounded-[20px] p-4">
            <div className="text-tertiary mb-3 text-[11px] font-semibold uppercase tracking-wide">Steps</div>
            <Steps steps={state.steps} />
          </div>
          {!state.cutoverStarted && !rolling && (
            <Button variant="secondary" className="mt-3 w-full" onClick={() => setCancelSheet(true)} icon={<I.CircleX size={16} />}>Cancel</Button>
          )}
          {state.transfer?.mode && <div className="text-tertiary mt-3 text-center text-[12px]">Transfer mode: <b>{state.transfer.mode}</b>{state.transfer.mode === 'direct' ? ' (server to server)' : ' (through Shift)'}</div>}
        </div>
      </div>
      <Sheet open={cancelSheet} onClose={() => setCancelSheet(false)}>
        <div className="text-[18px] font-semibold">Cancel the move?</div>
        <p className="text-secondary mt-2 text-[14px]">Nothing has been stopped yet. Your projects keep running on the old VPS.</p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setCancelSheet(false)}>Keep going</Button>
          <Button variant="danger" onClick={cancel}>Cancel move</Button>
        </div>
      </Sheet>
    </div>
  );
}
