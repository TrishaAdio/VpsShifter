import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Button, Chip, I, bouncy, cx } from '../ui.jsx';
import { api } from '../api.js';

const features = [
  { icon: I.Send, label: 'Telegram bots & userbots', color: 'from-[#5ac8fa] to-[#0a84ff]' },
  { icon: I.Globe, label: 'Websites & SSL', color: 'from-[#30d158] to-[#00c7be]' },
  { icon: I.Braces, label: 'APIs & apps', color: 'from-[#bf5af2] to-[#5e5ce6]' },
  { icon: I.Database, label: 'Databases', color: 'from-[#ff9f0a] to-[#ff375f]' },
];

const statusChip = {
  done: ['green', 'Moved'], rolledback: ['orange', 'Rolled back'], failed: ['red', 'Failed'], running: ['blue', 'Running'],
  'rolling-back': ['orange', 'Rolling back'], ready: ['gray', 'Not started'], connecting: ['gray', 'Scanning'], rehearsed: ['teal', 'Rehearsal'],
};

export default function Welcome({ onStart, onOpen }) {
  const [jobs, setJobs] = useState([]);
  useEffect(() => { api('/jobs').then(setJobs).catch(() => {}); }, []);
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center">
      <motion.div
        initial={{ y: -120, scale: 0.6, opacity: 0 }}
        animate={{ y: [-120, 0, -28, 0, -8, 0], scale: 1, opacity: 1 }}
        transition={{ duration: 1.1, times: [0, 0.4, 0.58, 0.74, 0.88, 1], ease: 'easeOut' }}
        className="relative mb-7 grid h-[104px] w-[104px] place-items-center rounded-[28px] bg-gradient-to-br from-[#5ac8fa] via-[#5e5ce6] to-[#bf5af2] text-white shadow-[0_30px_70px_-20px_rgba(94,92,230,.9)]"
      >
        <div className="absolute inset-0 rounded-[28px] bg-gradient-to-b from-white/35 to-transparent" style={{ maskImage: 'linear-gradient(#000, transparent 60%)' }} />
        <I.ArrowLeftRight size={46} strokeWidth={2.3} />
      </motion.div>
      <motion.h1 initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35, ...bouncy, damping: 26 }}
        className="text-[40px] font-bold tracking-[-0.035em] sm:text-[52px]">Shift</motion.h1>
      <motion.p initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.45 }}
        className="text-secondary mt-2 max-w-md text-[17px] leading-snug">
        Move everything from your old VPS to a new one. Copied, stopped there, started here — and checked.
      </motion.p>
      <div className="mt-8 grid w-full max-w-lg grid-cols-2 gap-2.5 sm:grid-cols-4">
        {features.map((f, i) => (
          <motion.div key={f.label} initial={{ opacity: 0, y: 16, scale: 0.9 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ delay: 0.55 + i * 0.07, ...bouncy, damping: 22 }}
            className="glass-soft flex flex-col items-center gap-2 rounded-2xl px-2 py-3.5">
            <div className={cx('grid h-9 w-9 place-items-center rounded-[11px] bg-gradient-to-br text-white', f.color)}><f.icon size={18} /></div>
            <span className="text-[12px] font-medium leading-tight">{f.label}</span>
          </motion.div>
        ))}
      </div>
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.9 }} className="mt-9 flex flex-col items-center gap-3">
        <Button size="lg" onClick={onStart} icon={<I.Rocket size={19} />} className="min-w-[220px]">Get Started</Button>
        <span className="text-tertiary flex items-center gap-1.5 text-[12px]"><I.ShieldCheck size={13} /> Your old VPS is never wiped. If anything fails, it rolls back.</span>
      </motion.div>
      {jobs.length > 0 && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.1 }} className="mt-10 w-full max-w-lg text-left">
          <div className="text-tertiary mb-2 px-1 text-[12px] font-semibold uppercase tracking-wide">Recent moves</div>
          <div className="glass-soft divide-y divide-black/5 overflow-hidden rounded-2xl dark:divide-white/5">
            {jobs.slice(0, 5).map((j) => {
              const [tone, label] = statusChip[j.status] || ['gray', j.status];
              return (
                <button key={j.id} onClick={() => onOpen(j.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-black/[.03] dark:hover:bg-white/[.04]">
                  <I.History size={16} className="text-tertiary" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{j.source} → {j.target}</span>
                  <span className="text-tertiary hidden text-[12px] sm:inline">{new Date(j.createdAt).toLocaleDateString()}</span>
                  <Chip tone={tone}>{label}</Chip>
                  <I.ChevronRight size={16} className="text-tertiary" />
                </button>
              );
            })}
          </div>
        </motion.div>
      )}
    </div>
  );
}
