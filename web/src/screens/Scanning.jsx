import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Radar, Button, Spinner, CheckBadge, Terminal, I } from '../ui.jsx';

export default function Scanning({ state, logs, onBack }) {
  const failed = state?.status === 'failed';
  const steps = (state?.steps || []).slice(0, 3);
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center">
      <AnimatePresence mode="wait">
        {!failed ? (
          <motion.div key="scan" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} className="flex flex-col items-center">
            <Radar icon={<I.Search size={30} strokeWidth={2.4} />} />
            <h2 className="mt-6 text-[26px] font-bold tracking-[-0.025em]">Looking for your projects…</h2>
            <motion.p key={state?.progress?.current} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="text-secondary mt-1.5 min-h-[22px] text-[15px]">
              {state?.progress?.current || 'Connecting to both servers…'}
            </motion.p>
            <div className="mt-7 flex flex-wrap justify-center gap-2">
              {steps.map((s, i) => (
                <motion.div key={s.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.1 }}
                  className="glass-soft flex items-center gap-2 rounded-full py-1.5 pl-2 pr-3.5 text-[13px] font-medium">
                  {s.status === 'done' || s.status === 'warn' ? <CheckBadge size={18} /> : s.status === 'running' ? <span className="grid h-[18px] w-[18px] place-items-center"><Spinner size={14} /></span> : <span className="h-[18px] w-[18px] rounded-full border-2 border-current opacity-20" />}
                  {s.title}
                </motion.div>
              ))}
            </div>
            <p className="text-tertiary mt-8 max-w-sm text-[12.5px]">Reading only — nothing on your old VPS is changed yet.</p>
          </motion.div>
        ) : (
          <motion.div key="fail" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex w-full max-w-xl flex-col items-center">
            <CheckBadge size={64} tone="red" kind="x" />
            <h2 className="mt-5 text-[24px] font-bold tracking-[-0.02em]">Couldn’t scan the servers</h2>
            <p className="text-secondary mt-2 text-[15px]">{state?.error}</p>
            <p className="text-tertiary mt-1 text-[13px]">Nothing was changed on your servers.</p>
            <div className="mt-6 w-full text-left"><Terminal logs={logs} height={180} /></div>
            <Button className="mt-6" onClick={onBack} icon={<I.ArrowLeft size={17} />}>Back to the servers</Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
