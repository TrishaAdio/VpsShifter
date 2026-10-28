import React, { useEffect, useId, useRef, useState } from 'react';
import { motion, AnimatePresence, useMotionValue, useSpring, useTransform, animate } from 'motion/react';
import * as I from 'lucide-react';

export const spring = { type: 'spring', stiffness: 380, damping: 32, mass: 0.9 };
export const softSpring = { type: 'spring', stiffness: 220, damping: 26 };
export const bouncy = { type: 'spring', stiffness: 500, damping: 18 };

export const cx = (...a) => a.filter(Boolean).join(' ');

/* ---------------- macOS window ---------------- */
export function TrafficLights({ onClose }) {
  const [hover, setHover] = useState(false);
  const dots = [
    { c: '#ff5f57', icon: <I.X size={8} strokeWidth={3} />, on: onClose },
    { c: '#febc2e', icon: <I.Minus size={8} strokeWidth={3} /> },
    { c: '#28c840', icon: <I.Plus size={8} strokeWidth={3} /> },
  ];
  return (
    <div className="flex gap-2" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      {dots.map((d, i) => (
        <button key={i} onClick={d.on} aria-label={['Close', 'Minimize', 'Zoom'][i]}
          className="grid h-3 w-3 place-items-center rounded-full text-black/60 shadow-[inset_0_0_0_0.5px_rgba(0,0,0,.25)]" style={{ background: d.c }}>
          <span className={cx('transition-opacity', hover ? 'opacity-100' : 'opacity-0')}>{d.icon}</span>
        </button>
      ))}
    </div>
  );
}

export function Window({ title, subtitle, children, toolbar, onClose, wide }) {
  const ref = useRef(null);
  const onMove = (e) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    ref.current.style.setProperty('--mx', `${e.clientX - r.left}px`);
    ref.current.style.setProperty('--my', `${e.clientY - r.top}px`);
  };
  return (
    <motion.div
      ref={ref}
      onMouseMove={onMove}
      initial={{ opacity: 0, scale: 0.94, y: 24, filter: 'blur(8px)' }}
      animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
      transition={{ ...softSpring, opacity: { duration: 0.35 } }}
      className={cx('glass window sheen relative mx-auto flex w-full flex-col overflow-hidden rounded-[22px] sm:rounded-[18px]', wide ? 'max-w-6xl' : 'max-w-5xl')}
      style={{ minHeight: 'min(760px, calc(100dvh - 48px))' }}
    >
      <div className="hairline relative z-10 flex h-[52px] shrink-0 items-center gap-3 border-b px-4">
        <div className="hidden sm:block"><TrafficLights onClose={onClose} /></div>
        <div className="pointer-events-none absolute inset-x-0 flex flex-col items-center leading-tight">
          <span className="text-[13px] font-semibold">{title}</span>
          {subtitle && <span className="text-tertiary text-[11px]">{subtitle}</span>}
        </div>
        <div className="ml-auto flex items-center gap-2">{toolbar}</div>
      </div>
      <div className="relative z-0 flex min-h-0 flex-1 flex-col">{children}</div>
    </motion.div>
  );
}

/* ---------------- Buttons & controls ---------------- */
export function Button({ children, variant = 'primary', size = 'md', className, loading, disabled, icon, ...p }) {
  const v = {
    primary: 'btn-gradient btn-shimmer text-white shadow-[0_10px_30px_-8px_rgba(94,92,230,.8)] hover:shadow-[0_14px_40px_-8px_rgba(191,90,242,.85)]',
    secondary: 'bg-black/[.06] dark:bg-white/[.10] hover:bg-black/[.09] dark:hover:bg-white/[.14]',
    ghost: 'hover:bg-black/[.05] dark:hover:bg-white/[.08]',
    danger: 'bg-[var(--color-ios-red)] text-white shadow-[0_8px_24px_-8px_rgba(255,69,58,.7)] hover:brightness-110',
    success: 'bg-[var(--color-ios-green)] text-white shadow-[0_8px_24px_-8px_rgba(48,209,88,.7)] hover:brightness-110',
    tinted: 'bg-[var(--color-ios-blue)]/12 text-[var(--color-ios-blue)] hover:bg-[var(--color-ios-blue)]/18',
  }[variant];
  const s = { sm: 'h-8 px-3 text-[13px] rounded-[10px]', md: 'h-11 px-5 text-[15px] rounded-[13px]', lg: 'h-[54px] px-7 text-[17px] rounded-[16px]' }[size];
  return (
    <motion.button
      whileHover={disabled || loading ? {} : { y: -1 }}
      whileTap={disabled || loading ? {} : { scale: 0.96 }}
      transition={bouncy}
      disabled={disabled || loading}
      className={cx('focus-ring inline-flex select-none items-center justify-center gap-2 font-semibold tracking-[-0.01em] transition-[filter,background,opacity] disabled:opacity-45', v, s, className)}
      {...p}
    >
      {loading ? <Spinner size={size === 'sm' ? 14 : 18} light={variant !== 'secondary' && variant !== 'ghost' && variant !== 'tinted'} /> : icon}
      {children}
    </motion.button>
  );
}

export function Switch({ checked, onChange, disabled }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onChange?.(!checked); }}
      className={cx('focus-ring relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors duration-300 disabled:opacity-40', checked ? 'bg-[var(--color-ios-green)]' : 'bg-black/[.12] dark:bg-white/[.16]')}
    >
      <motion.span
        layout
        transition={bouncy}
        className="absolute top-[2px] h-[27px] w-[27px] rounded-full bg-white shadow-[0_3px_8px_rgba(0,0,0,.15),0_3px_1px_rgba(0,0,0,.06)]"
        style={{ left: checked ? 22 : 2 }}
      />
    </button>
  );
}

export function Segmented({ value, onChange, options }) {
  const id = useId();
  return (
    <div className="inline-flex rounded-[10px] bg-black/[.06] p-[2px] dark:bg-white/[.10]">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)} className="focus-ring relative rounded-[8px] px-3 py-1 text-[13px] font-medium">
          {value === o.value && <motion.span layoutId={`seg-${id}`} transition={spring} className="absolute inset-0 rounded-[8px] bg-white shadow-[0_3px_8px_rgba(0,0,0,.12)] dark:bg-white/20" />}
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Field({ label, type = 'text', value, onChange, placeholder, autoFocus, inputMode, mono, right }) {
  const [show, setShow] = useState(false);
  const isPw = type === 'password';
  return (
    <label className="block">
      <span className="text-secondary mb-1.5 block px-1 text-[12px] font-medium">{label}</span>
      <div className="relative">
        <input
          className={cx('ios-input', isPw && 'pr-11', mono && 'font-mono text-[14px]')}
          type={isPw && !show ? 'password' : 'text'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoFocus={autoFocus}
          inputMode={inputMode}
          autoComplete={isPw ? 'new-password' : 'off'}
          spellCheck={false}
          autoCapitalize="off"
        />
        {isPw && (
          <button type="button" onClick={() => setShow(!show)} className="text-tertiary absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg hover:text-[var(--color-ios-blue)]" aria-label={show ? 'Hide password' : 'Show password'}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.span key={show ? 'a' : 'b'} initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.5, opacity: 0 }} transition={{ duration: 0.15 }}>
                {show ? <I.EyeOff size={17} /> : <I.Eye size={17} />}
              </motion.span>
            </AnimatePresence>
          </button>
        )}
        {right}
      </div>
    </label>
  );
}

/* ---------------- iOS activity indicator ---------------- */
export function Spinner({ size = 18, light }) {
  return (
    <span className="relative inline-block animate-spin" style={{ width: size, height: size, animationDuration: '0.9s', animationTimingFunction: 'steps(12)' }}>
      {Array.from({ length: 12 }).map((_, i) => (
        <span key={i} className="absolute left-1/2 top-0 rounded-full" style={{
          width: Math.max(2, size / 9), height: size * 0.28, marginLeft: -Math.max(2, size / 9) / 2,
          transformOrigin: `50% ${size / 2}px`, transform: `rotate(${i * 30}deg)`,
          background: light ? '#fff' : 'currentColor', opacity: 0.15 + (i / 12) * 0.85,
        }} />
      ))}
    </span>
  );
}

/* ---------------- Animated check / cross ---------------- */
export function CheckBadge({ size = 22, tone = 'green', kind = 'check', delay = 0 }) {
  const color = { green: 'var(--color-ios-green)', red: 'var(--color-ios-red)', orange: 'var(--color-ios-orange)', blue: 'var(--color-ios-blue)' }[tone];
  const path = kind === 'check' ? 'M7 12.5l3.2 3.2L17 9' : kind === 'x' ? 'M8.5 8.5l7 7M15.5 8.5l-7 7' : 'M12 7.5v5.2M12 16.3v.2';
  return (
    <motion.svg width={size} height={size} viewBox="0 0 24 24" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ ...bouncy, delay }}>
      <circle cx="12" cy="12" r="11" fill={color} />
      <motion.path d={path} fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"
        initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.35, delay: delay + 0.12, ease: 'easeOut' }} />
    </motion.svg>
  );
}

/* ---------------- Apple-Watch style activity rings ---------------- */
export function ActivityRings({ values, size = 210, labels }) {
  const rings = [
    { color: ['#ff2d55', '#ff6482'], track: 'rgba(255,45,85,.18)' },
    { color: ['#a4ff00', '#30d158'], track: 'rgba(48,209,88,.18)' },
    { color: ['#00e5ff', '#0a84ff'], track: 'rgba(10,132,255,.18)' },
  ];
  const stroke = size * 0.1;
  const gap = stroke * 0.18;
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <defs>
          {rings.map((r, i) => (
            <linearGradient key={i} id={`ring-${i}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor={r.color[0]} />
              <stop offset="1" stopColor={r.color[1]} />
            </linearGradient>
          ))}
        </defs>
        {rings.map((r, i) => {
          const rad = size / 2 - stroke / 2 - i * (stroke + gap);
          const circ = 2 * Math.PI * rad;
          const v = Math.max(0, Math.min(1, values[i] || 0));
          return (
            <g key={i}>
              <circle cx={size / 2} cy={size / 2} r={rad} fill="none" stroke={r.track} strokeWidth={stroke} />
              <motion.circle cx={size / 2} cy={size / 2} r={rad} fill="none" stroke={`url(#ring-${i})`} strokeWidth={stroke} strokeLinecap="round"
                strokeDasharray={circ} initial={{ strokeDashoffset: circ }} animate={{ strokeDashoffset: circ * (1 - Math.max(v, 0.002)) }}
                transition={{ type: 'spring', stiffness: 60, damping: 18 }} style={{ filter: v > 0 ? `drop-shadow(0 0 ${stroke / 3}px ${r.color[1]}66)` : 'none' }} />
            </g>
          );
        })}
      </svg>
      {labels && <div className="absolute inset-0 grid place-items-center text-center">{labels}</div>}
    </div>
  );
}

/* ---------------- Dynamic Island ---------------- */
export function DynamicIsland({ title, detail, tone = 'blue', progress = 0, spinning = true, icon }) {
  const [open, setOpen] = useState(false);
  const color = { blue: '#0a84ff', green: '#30d158', orange: '#ff9f0a', red: '#ff453a' }[tone];
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center px-3">
      <motion.button
        layout
        onClick={() => setOpen(!open)}
        transition={{ type: 'spring', stiffness: 420, damping: 30 }}
        className="pointer-events-auto flex items-center gap-3 overflow-hidden bg-black text-white shadow-[0_18px_50px_-12px_rgba(0,0,0,.55)]"
        style={{ borderRadius: open ? 30 : 22, padding: open ? '14px 20px' : '8px 14px', maxWidth: 'min(560px, calc(100vw - 24px))' }}
      >
        <motion.div layout className="relative grid h-7 w-7 shrink-0 place-items-center">
          <svg viewBox="0 0 28 28" className="absolute inset-0 -rotate-90">
            <circle cx="14" cy="14" r="12" stroke="rgba(255,255,255,.18)" strokeWidth="3" fill="none" />
            <motion.circle cx="14" cy="14" r="12" stroke={color} strokeWidth="3" fill="none" strokeLinecap="round" strokeDasharray={75.4}
              animate={{ strokeDashoffset: 75.4 * (1 - Math.max(0.02, progress)) }} transition={softSpring} />
          </svg>
          <span className="relative" style={{ color }}>{icon || (spinning ? <Spinner size={12} light /> : <I.Check size={14} strokeWidth={3} />)}</span>
        </motion.div>
        <motion.div layout className="min-w-0 text-left">
          <motion.div layout className="truncate text-[13px] font-semibold">{title}</motion.div>
          <AnimatePresence>
            {open && detail && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="text-[12px] text-white/60">
                {detail}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
        {!open && detail && <motion.span layout className="hidden shrink-0 text-[12px] tabular-nums text-white/55 sm:inline">{String(detail).split(' · ').slice(-2).join(' · ')}</motion.span>}
      </motion.button>
    </div>
  );
}

/* ---------------- AirDrop-style radar ---------------- */
export function Radar({ icon, size = 220 }) {
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      {[0, 1, 2, 3].map((i) => (
        <motion.span key={i} className="absolute rounded-full border-2 border-[var(--color-ios-blue)]/50"
          style={{ width: size * 0.3, height: size * 0.3 }}
          animate={{ scale: [1, 3.3], opacity: [0.7, 0] }}
          transition={{ duration: 3.2, repeat: Infinity, delay: i * 0.8, ease: 'easeOut' }} />
      ))}
      <motion.div className="relative grid place-items-center rounded-[28%] bg-gradient-to-br from-[#5ac8fa] to-[#5e5ce6] text-white shadow-[0_20px_50px_-15px_rgba(10,132,255,.8)]"
        style={{ width: size * 0.32, height: size * 0.32 }}
        animate={{ scale: [1, 1.05, 1] }} transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}>
        {icon}
      </motion.div>
    </div>
  );
}

/* ---------------- Data flowing between two servers ---------------- */
export function ServerFlow({ left, right, active = true, tone = 'blue', reverse }) {
  const color = { blue: '#0a84ff', green: '#30d158', orange: '#ff9f0a', red: '#ff453a' }[tone];
  return (
    <div className="flex w-full items-center gap-3 sm:gap-5">
      <ServerChip {...left} />
      <div className="relative h-10 flex-1">
        <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox="0 0 100 40">
          <line x1="0" y1="20" x2="100" y2="20" stroke={color} strokeOpacity=".25" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          {active && <line x1="0" y1="20" x2="100" y2="20" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" className="flow-dash" style={reverse ? { animationDirection: 'reverse' } : {}} />}
        </svg>
        {active && [0, 1, 2, 3, 4].map((i) => (
          <motion.span key={i} className="absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full" style={{ background: color, boxShadow: `0 0 12px ${color}` }}
            initial={{ left: reverse ? '100%' : '0%', opacity: 0, scale: 0.5 }}
            animate={{ left: reverse ? ['100%', '0%'] : ['0%', '100%'], opacity: [0, 1, 1, 0], scale: [0.5, 1, 1, 0.5] }}
            transition={{ duration: 2.2, repeat: Infinity, delay: i * 0.44, ease: 'easeInOut' }} />
        ))}
      </div>
      <ServerChip {...right} />
    </div>
  );
}

export function ServerChip({ label, host, os, tone = 'blue', dim }) {
  return (
    <div className={cx('glass-soft card-hover flex min-w-0 items-center gap-2.5 rounded-2xl px-3 py-2 transition-opacity sm:px-4 sm:py-3', dim && 'opacity-60')}>
      <div className={cx('grid h-9 w-9 shrink-0 place-items-center rounded-xl text-white', tone === 'green' ? 'bg-gradient-to-br from-[#30d158] to-[#0a84ff]' : 'bg-gradient-to-br from-[#8e8e93] to-[#48484a]')}>
        <I.Server size={18} />
      </div>
      <div className="min-w-0 leading-tight">
        <div className="text-tertiary text-[11px] font-semibold uppercase tracking-wide">{label}</div>
        <div className="truncate font-mono text-[13px] font-medium">{host}</div>
        {os && <div className="text-secondary hidden truncate text-[11px] sm:block">{os}</div>}
      </div>
    </div>
  );
}

/* ---------------- macOS terminal window ---------------- */
export function Terminal({ logs, height = 260 }) {
  const ref = useRef(null);
  const [stick, setStick] = useState(true);
  useEffect(() => { if (stick && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [logs, stick]);
  const color = (l) => ({ error: 'text-[#ff6b6b]', warn: 'text-[#ffd479]', ok: 'text-[#7ee787]', step: 'text-[#79c0ff]', out: 'text-white/55' }[l] || 'text-white/80');
  return (
    <div className="overflow-hidden rounded-[14px] bg-[#1e1e22]/95 shadow-[0_20px_60px_-20px_rgba(0,0,0,.6)] ring-1 ring-white/10">
      <div className="flex h-8 items-center gap-2 border-b border-white/5 px-3">
        <span className="h-3 w-3 rounded-full bg-[#ff5f57]" /><span className="h-3 w-3 rounded-full bg-[#febc2e]" /><span className="h-3 w-3 rounded-full bg-[#28c840]" />
        <span className="flex-1 text-center text-[12px] text-white/45">shift — live log</span>
      </div>
      <div ref={ref} onScroll={(e) => { const t = e.currentTarget; setStick(t.scrollHeight - t.scrollTop - t.clientHeight < 40); }}
        className="scroll-thin overflow-auto px-3 py-2 font-mono text-[12px] leading-[1.55]" style={{ height }}>
        {logs.length === 0 && <div className="text-white/35">Waiting for output…</div>}
        {logs.map((l, i) => (
          <div key={i} className={cx('whitespace-pre-wrap break-words', color(l.level))}>
            <span className="text-white/25">{new Date(l.t).toLocaleTimeString([], { hour12: false })} </span>
            {l.server && <span className={l.server === 'old' ? 'text-[#c9a7ff]' : 'text-[#64d2ff]'}>{l.server === 'old' ? 'old' : 'new'} › </span>}
            {l.level === 'step' ? '▸ ' : ''}{l.msg}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------- Sheet (macOS: slides from the title bar; iOS: from bottom) ---------------- */
export function Sheet({ open, onClose, children, width = 460 }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-start sm:pt-[12vh]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div className="absolute inset-0 bg-black/25 backdrop-blur-[2px]" onClick={onClose} />
          <motion.div
            role="dialog"
            className="glass relative w-full rounded-t-[28px] p-6 sm:rounded-[22px]"
            style={{ maxWidth: width }}
            initial={{ y: typeof window !== 'undefined' && window.innerWidth < 640 ? '100%' : -40, opacity: 0, scale: 0.97 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: typeof window !== 'undefined' && window.innerWidth < 640 ? '100%' : -30, opacity: 0, scale: 0.97 }}
            transition={spring}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ---------------- Notifications (macOS banners) ---------------- */
const toastBus = new EventTarget();
export function toast(title, body = '', tone = 'blue') {
  toastBus.dispatchEvent(new CustomEvent('t', { detail: { id: Math.random(), title, body, tone } }));
}
export function Toasts() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const on = (e) => {
      setItems((x) => [...x.slice(-3), e.detail]);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== e.detail.id)), 5200);
    };
    toastBus.addEventListener('t', on);
    return () => toastBus.removeEventListener('t', on);
  }, []);
  const icon = { blue: <I.Info size={18} />, green: <I.CircleCheck size={18} />, red: <I.CircleAlert size={18} />, orange: <I.TriangleAlert size={18} /> };
  const col = { blue: 'bg-[var(--color-ios-blue)]', green: 'bg-[var(--color-ios-green)]', red: 'bg-[var(--color-ios-red)]', orange: 'bg-[var(--color-ios-orange)]' };
  return (
    <div className="pointer-events-none fixed right-3 top-16 z-[70] flex w-[min(360px,calc(100vw-24px))] flex-col gap-2 sm:right-5 sm:top-5">
      <AnimatePresence>
        {items.map((t) => (
          <motion.div key={t.id} layout initial={{ x: 380, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 380, opacity: 0 }} transition={spring}
            className="glass pointer-events-auto flex gap-3 rounded-[18px] p-3.5" onClick={() => setItems((x) => x.filter((i) => i.id !== t.id))}>
            <div className={cx('grid h-9 w-9 shrink-0 place-items-center rounded-[10px] text-white', col[t.tone])}>{icon[t.tone]}</div>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold">{t.title}</div>
              {t.body && <div className="text-secondary text-[12.5px] leading-snug">{t.body}</div>}
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/* ---------------- Misc ---------------- */
export function Chip({ children, tone = 'gray' }) {
  const t = {
    gray: 'bg-black/[.06] dark:bg-white/[.09] text-secondary',
    blue: 'bg-[#0a84ff]/12 text-[#0a6fd6] dark:text-[#64b5ff]',
    green: 'bg-[#30d158]/14 text-[#1f8f3c] dark:text-[#6ee28d]',
    purple: 'bg-[#bf5af2]/14 text-[#9241c4] dark:text-[#d79cf5]',
    orange: 'bg-[#ff9f0a]/16 text-[#b86e00] dark:text-[#ffc266]',
    teal: 'bg-[#64d2ff]/16 text-[#0b7aa6] dark:text-[#8fdfff]',
    red: 'bg-[#ff453a]/14 text-[#c4271d] dark:text-[#ff8a82]',
  }[tone];
  return <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-[2px] text-[11.5px] font-medium', t)}>{children}</span>;
}

export function Shake({ when, children, className }) {
  const [k, setK] = useState(0);
  useEffect(() => { if (when) setK((x) => x + 1); }, [when]);
  return (
    <motion.div key={k} className={className} animate={k ? { x: [0, -14, 12, -9, 7, -4, 2, 0] } : {}} transition={{ duration: 0.55 }}>
      {children}
    </motion.div>
  );
}

export function Counter({ value, format = (v) => Math.round(v) }) {
  const mv = useMotionValue(0);
  const sp = useSpring(mv, { stiffness: 80, damping: 20 });
  const txt = useTransform(sp, (v) => format(v));
  useEffect(() => { mv.set(value); }, [value, mv]);
  return <motion.span>{txt}</motion.span>;
}

export function useCountdown() {
  return { animate };
}

export { I, motion, AnimatePresence };
export { Aurora as Wallpaper } from './fx.jsx';
