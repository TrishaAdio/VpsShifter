import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Button, Chip, I, bouncy, cx } from '../ui.jsx';
import { Tilt, Dock, RotatingWords, Typewriter, GlowRing } from '../fx.jsx';
import { api } from '../api.js';

const features = [
  { icon: I.Send, title: 'Bots & userbots', text: 'Telegram, Discord, WhatsApp — sessions moved safely', color: 'from-[#5ac8fa] to-[#0a84ff]' },
  { icon: I.Globe, title: 'Websites', text: 'nginx, Apache, Caddy + SSL certificates', color: 'from-[#30d158] to-[#00c7be]' },
  { icon: I.Braces, title: 'APIs & apps', text: 'PM2, systemd, Docker, screen, tmux', color: 'from-[#bf5af2] to-[#5e5ce6]' },
  { icon: I.Database, title: 'Databases', text: 'MySQL, Postgres, Redis, Mongo — row-checked', color: 'from-[#ff9f0a] to-[#ff375f]' },
];

const dock = [
  { icon: I.Send, label: 'Telegram bots', color: 'from-[#5ac8fa] to-[#0a84ff]' },
  { icon: I.Bot, label: 'Userbots', color: 'from-[#64d2ff] to-[#5e5ce6]' },
  { icon: I.Globe, label: 'Websites', color: 'from-[#30d158] to-[#00c7be]' },
  { icon: I.Braces, label: 'APIs', color: 'from-[#bf5af2] to-[#5e5ce6]' },
  { icon: I.Container, label: 'Docker', color: 'from-[#64d2ff] to-[#0a84ff]' },
  { icon: I.Database, label: 'Databases', color: 'from-[#ff9f0a] to-[#ff375f]' },
  { icon: I.Clock, label: 'Cron jobs', color: 'from-[#8e8e93] to-[#48484a]' },
];

const orbit = [
  { icon: I.Send, c: '#0a84ff', a: 0 }, { icon: I.Globe, c: '#30d158', a: 72 }, { icon: I.Database, c: '#ff9f0a', a: 144 },
  { icon: I.Braces, c: '#bf5af2', a: 216 }, { icon: I.Container, c: '#64d2ff', a: 288 },
];

const statusChip = {
  done: ['green', 'Moved'], rolledback: ['orange', 'Rolled back'], failed: ['red', 'Failed'], running: ['blue', 'Running'],
  'rolling-back': ['orange', 'Rolling back'], ready: ['gray', 'Not started'], connecting: ['gray', 'Scanning'], rehearsed: ['teal', 'Rehearsal'],
};

function HeroIcon() {
  return (
    <div className="relative grid h-[230px] w-[230px] place-items-center">
      <motion.div className="absolute inset-0" animate={{ rotate: 360 }} transition={{ duration: 24, repeat: Infinity, ease: 'linear' }}>
        <div className="absolute inset-3 rounded-full border border-dashed border-black/10 dark:border-white/15" />
        {orbit.map((o, i) => {
          const r = 103, x = Math.cos((o.a * Math.PI) / 180) * r, y = Math.sin((o.a * Math.PI) / 180) * r;
          return (
            <motion.div key={i} className="absolute left-1/2 top-1/2" style={{ x: x - 17, y: y - 17 }}
              initial={{ scale: 0 }} animate={{ scale: 1, rotate: -360 }}
              transition={{ scale: { delay: 0.9 + i * 0.1, ...bouncy }, rotate: { duration: 24, repeat: Infinity, ease: 'linear' } }}>
              <div className="glass grid h-[34px] w-[34px] place-items-center rounded-[11px]" style={{ color: o.c }}><o.icon size={17} strokeWidth={2.4} /></div>
            </motion.div>
          );
        })}
      </motion.div>
      <motion.div
        initial={{ y: -160, scale: 0.5, opacity: 0, rotate: -25 }}
        animate={{ y: [-160, 0, -30, 0, -9, 0], scale: 1, opacity: 1, rotate: 0 }}
        transition={{ duration: 1.15, times: [0, 0.4, 0.58, 0.74, 0.88, 1], ease: 'easeOut' }}
      >
        <Tilt max={18} scale={1.06} className="floaty rounded-[30px]">
          <div className="relative grid h-[112px] w-[112px] place-items-center overflow-hidden rounded-[30px] bg-gradient-to-br from-[#5ac8fa] via-[#5e5ce6] to-[#bf5af2] text-white shadow-[0_35px_80px_-20px_rgba(94,92,230,1)]">
            <motion.div className="absolute -inset-10 opacity-60" style={{ background: 'conic-gradient(from 0deg, transparent, rgba(255,255,255,.5), transparent 40%)' }}
              animate={{ rotate: 360 }} transition={{ duration: 6, repeat: Infinity, ease: 'linear' }} />
            <div className="absolute inset-0 bg-gradient-to-b from-white/40 to-transparent" style={{ maskImage: 'linear-gradient(#000, transparent 55%)' }} />
            <motion.div animate={{ x: [0, 4, -4, 0] }} transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}>
              <I.ArrowLeftRight size={52} strokeWidth={2.4} className="relative drop-shadow-lg" />
            </motion.div>
          </div>
        </Tilt>
      </motion.div>
    </div>
  );
}

export default function Welcome({ onStart, onOpen }) {
  const [jobs, setJobs] = useState([]);
  useEffect(() => { api('/jobs').then(setJobs).catch(() => {}); }, []);
  return (
    <div className="scroll-thin flex flex-1 flex-col items-center overflow-y-auto px-5 py-8 text-center sm:px-8">
      <HeroIcon />
      <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4, ...bouncy, damping: 24 }}
        className="glass-soft mt-2 inline-flex items-center gap-2 rounded-full px-3 py-1 text-[12px] font-semibold">
        <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-ios-green)] opacity-75" /><span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--color-ios-green)]" /></span>
        Zero data loss · automatic rollback
      </motion.div>
      <motion.h1 initial={{ opacity: 0, y: 16, filter: 'blur(10px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} transition={{ delay: 0.5, duration: 0.7 }}
        className="mt-4 text-[38px] font-extrabold leading-[1.05] tracking-[-0.045em] sm:text-[60px]">
        Move your <RotatingWords words={['userbots', 'Telegram bots', 'websites', 'APIs', 'databases', 'everything']} />
        <br />to a new VPS.
      </motion.h1>
      <motion.p initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.65 }}
        className="text-secondary mt-4 max-w-lg text-[17px] leading-snug">
        Enter two logins, press start. Shift copies, stops, starts and checks — and rolls back if anything goes wrong.
      </motion.p>
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.8 }} className="mt-7 flex flex-col items-center gap-3 sm:flex-row">
        <GlowRing radius={16}>
          <Button size="lg" onClick={onStart} icon={<I.Rocket size={19} />} className="min-w-[230px]">Start a move</Button>
        </GlowRing>
        <span className="text-tertiary flex items-center gap-1.5 text-[12.5px]"><I.ShieldCheck size={14} /> Old VPS is never wiped</span>
      </motion.div>

      <div className="mt-12 hidden sm:block"><Dock items={dock} /></div>

      <div className="mt-12 grid w-full max-w-4xl grid-cols-1 gap-3 text-left sm:grid-cols-2 lg:grid-cols-4">
        {features.map((f, i) => (
          <motion.div key={f.title} initial={{ opacity: 0, y: 24, scale: 0.92 }} whileInView={{ opacity: 1, y: 0, scale: 1 }} viewport={{ once: true }} transition={{ delay: i * 0.08, ...bouncy, damping: 20 }}>
            <Tilt max={12} className="h-full rounded-[22px]">
              <div className="glass-soft h-full rounded-[22px] p-4">
                <div className={cx('grid h-11 w-11 place-items-center rounded-[13px] bg-gradient-to-br text-white shadow-lg', f.color)}><f.icon size={21} /></div>
                <div className="mt-3 text-[15px] font-semibold tracking-tight">{f.title}</div>
                <div className="text-secondary mt-0.5 text-[12.5px] leading-snug">{f.text}</div>
              </div>
            </Tilt>
          </motion.div>
        ))}
      </div>

      <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ ...bouncy, damping: 24 }} className="mt-8 w-full max-w-2xl text-left">
        <Tilt max={6} glare={false} className="rounded-[16px]">
          <div className="overflow-hidden rounded-[16px] bg-[#1c1c22]/95 shadow-[0_30px_70px_-25px_rgba(0,0,0,.7)] ring-1 ring-white/10">
            <div className="flex h-8 items-center gap-2 border-b border-white/5 px-3">
              <span className="h-3 w-3 rounded-full bg-[#ff5f57]" /><span className="h-3 w-3 rounded-full bg-[#febc2e]" /><span className="h-3 w-3 rounded-full bg-[#28c840]" />
              <span className="flex-1 text-center text-[12px] text-white/45">shift — what happens</span>
            </div>
            <Typewriter className="min-h-[150px] px-4 py-3 text-[12.5px] leading-[1.7] text-white/85" lines={[
              'found userbot (screen) · shop-api (PM2) · 2 websites · MariaDB',
              'copying 305 MB old → new …  done in 3s',
              'stopped on old VPS · session safe ✓',
              'started on new VPS · ports ✓ http ✓ logs ✓  🎉',
            ]} />
          </div>
        </Tilt>
      </motion.div>

      {jobs.length > 0 && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.1 }} className="mt-10 w-full max-w-2xl text-left">
          <div className="text-tertiary mb-2 px-1 text-[12px] font-semibold uppercase tracking-wide">Recent moves</div>
          <div className="glass-soft divide-y divide-black/5 overflow-hidden rounded-2xl dark:divide-white/5">
            {jobs.slice(0, 5).map((j) => {
              const [tone, label] = statusChip[j.status] || ['gray', j.status];
              return (
                <motion.button key={j.id} whileHover={{ x: 4 }} onClick={() => onOpen(j.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-black/[.03] dark:hover:bg-white/[.04]">
                  <I.History size={16} className="text-tertiary" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{j.source} → {j.target}</span>
                  <span className="text-tertiary hidden text-[12px] sm:inline">{new Date(j.createdAt).toLocaleDateString()}</span>
                  <Chip tone={tone}>{label}</Chip>
                  <I.ChevronRight size={16} className="text-tertiary" />
                </motion.button>
              );
            })}
          </div>
        </motion.div>
      )}
    </div>
  );
}
