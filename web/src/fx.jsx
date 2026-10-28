import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useMotionValue, useSpring, useTransform } from 'motion/react';
const cx = (...a) => a.filter(Boolean).join(' ');

/* ---------------- Vivid aurora wallpaper + stars + cursor glow ---------------- */
const TONES = {
  blue: ['#0a84ff', '#5e5ce6', '#bf5af2', '#00d4ff'],
  green: ['#30d158', '#00c7be', '#0a84ff', '#a4ff4f'],
  orange: ['#ff9f0a', '#ff375f', '#bf5af2', '#ffd60a'],
  red: ['#ff453a', '#ff375f', '#bf5af2', '#ff9f0a'],
};

export function Aurora({ tone = 'blue' }) {
  const c = TONES[tone] || TONES.blue;
  const mx = useMotionValue(-999), my = useMotionValue(-999);
  const sx = useSpring(mx, { stiffness: 60, damping: 20 }), sy = useSpring(my, { stiffness: 60, damping: 20 });
  useEffect(() => {
    const on = (e) => { mx.set(e.clientX); my.set(e.clientY); };
    window.addEventListener('pointermove', on);
    return () => window.removeEventListener('pointermove', on);
  }, [mx, my]);
  const blobs = [
    { s: 62, x: ['-12vw', '22vw', '-6vw'], y: ['-14vh', '18vh', '-8vh'], d: 18 },
    { s: 55, x: ['62vw', '38vw', '70vw'], y: ['-10vh', '24vh', '4vh'], d: 22 },
    { s: 58, x: ['24vw', '58vw', '12vw'], y: ['58vh', '36vh', '70vh'], d: 26 },
    { s: 44, x: ['78vw', '52vw', '84vw'], y: ['62vh', '78vh', '48vh'], d: 16 },
  ];
  return (
    <div className="fixed inset-0 -z-10 overflow-hidden bg-[#e8ebff] dark:bg-[#04040a]">
      {blobs.map((b, i) => (
        <motion.div key={i} className="absolute rounded-full mix-blend-multiply dark:mix-blend-screen"
          style={{ width: `${b.s}vmax`, height: `${b.s}vmax`, filter: 'blur(70px)', opacity: 0.75 }}
          animate={{ x: b.x, y: b.y, background: `radial-gradient(circle, ${c[i]} 0%, transparent 62%)`, scale: [1, 1.15, 0.95] }}
          transition={{ duration: b.d, repeat: Infinity, repeatType: 'mirror', ease: 'easeInOut', background: { duration: 1.6 } }} />
      ))}
      {/* rotating conic sheen */}
      <motion.div className="absolute left-1/2 top-1/2 h-[160vmax] w-[160vmax] -translate-x-1/2 -translate-y-1/2 opacity-[0.18] dark:opacity-[0.14]"
        style={{ background: `conic-gradient(from 0deg, transparent, ${c[0]}, transparent 30%, ${c[2]}, transparent 60%, ${c[1]}, transparent)` , filter: 'blur(60px)' }}
        animate={{ rotate: 360 }} transition={{ duration: 60, repeat: Infinity, ease: 'linear' }} />
      <Stars />
      <motion.div className="pointer-events-none absolute h-[520px] w-[520px] rounded-full"
        style={{ x: useTransform(sx, (v) => v - 260), y: useTransform(sy, (v) => v - 260), background: `radial-gradient(circle, ${c[0]}55, transparent 60%)`, filter: 'blur(20px)' }} />
      <div className="absolute inset-0 opacity-[0.04] dark:opacity-[0.07]" style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27160%27 height=%27160%27%3E%3Cfilter id=%27n%27%3E%3CfeTurbulence type=%27fractalNoise%27 baseFrequency=%270.8%27 numOctaves=%274%27/%3E%3C/filter%3E%3Crect width=%27100%25%27 height=%27100%25%27 filter=%27url(%23n)%27/%3E%3C/svg%3E")' }} />
    </div>
  );
}

function Stars() {
  const [stars] = useState(() => Array.from({ length: 70 }, () => ({ x: Math.random() * 100, y: Math.random() * 100, s: Math.random() * 2 + 0.6, d: Math.random() * 4 + 2, o: Math.random() * 3 })));
  return (
    <div className="absolute inset-0 hidden dark:block">
      {stars.map((s, i) => (
        <motion.span key={i} className="absolute rounded-full bg-white" style={{ left: `${s.x}%`, top: `${s.y}%`, width: s.s, height: s.s }}
          animate={{ opacity: [0.1, 0.9, 0.1] }} transition={{ duration: s.d, repeat: Infinity, delay: s.o }} />
      ))}
    </div>
  );
}

/* ---------------- 3D tilt with moving glare ---------------- */
export function Tilt({ children, className, max = 10, glare = true, scale = 1.02 }) {
  const ref = useRef(null);
  const rx = useMotionValue(0), ry = useMotionValue(0), gx = useMotionValue(50), gy = useMotionValue(50);
  const srx = useSpring(rx, { stiffness: 200, damping: 18 }), sry = useSpring(ry, { stiffness: 200, damping: 18 });
  const [hover, setHover] = useState(false);
  const bg = useTransform([gx, gy], ([x, y]) => `radial-gradient(circle at ${x}% ${y}%, rgba(255,255,255,.45), transparent 50%)`);
  const move = (e) => {
    const r = ref.current.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    ry.set((px - 0.5) * max * 2); rx.set(-(py - 0.5) * max * 2); gx.set(px * 100); gy.set(py * 100);
  };
  return (
    <motion.div ref={ref} onPointerMove={move} onPointerEnter={() => setHover(true)} onPointerLeave={() => { rx.set(0); ry.set(0); setHover(false); }}
      style={{ rotateX: srx, rotateY: sry, transformPerspective: 900, transformStyle: 'preserve-3d' }}
      animate={{ scale: hover ? scale : 1 }} transition={{ type: 'spring', stiffness: 300, damping: 20 }}
      className={cx('relative', className)}>
      {children}
      {glare && <motion.div className="pointer-events-none absolute inset-0 rounded-[inherit] mix-blend-overlay" style={{ background: bg, opacity: hover ? 1 : 0, transition: 'opacity .3s' }} />}
    </motion.div>
  );
}

/* ---------------- macOS Dock with magnification ---------------- */
export function Dock({ items }) {
  const mouseX = useMotionValue(Infinity);
  return (
    <motion.div onMouseMove={(e) => mouseX.set(e.clientX)} onMouseLeave={() => mouseX.set(Infinity)}
      className="glass mx-auto flex h-[76px] items-end gap-3 rounded-[24px] px-3 pb-3">
      {items.map((it, i) => <DockIcon key={i} mouseX={mouseX} {...it} index={i} />)}
    </motion.div>
  );
}
function DockIcon({ mouseX, icon: Icon, label, color, index }) {
  const ref = useRef(null);
  const dist = useTransform(mouseX, (v) => { const r = ref.current?.getBoundingClientRect() ?? { x: 0, width: 0 }; return v - r.x - r.width / 2; });
  const size = useSpring(useTransform(dist, [-160, 0, 160], [52, 84, 52]), { stiffness: 260, damping: 18 });
  const [hover, setHover] = useState(false);
  const [bounce, setBounce] = useState(0);
  return (
    <motion.div ref={ref} style={{ width: size, height: size }} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onClick={() => setBounce((b) => b + 1)}
      initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.7 + index * 0.08, type: 'spring', stiffness: 300, damping: 16 }}
      className="relative cursor-pointer">
      <AnimatePresence>
        {hover && (
          <motion.span initial={{ opacity: 0, y: 6, scale: 0.9 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 4 }}
            className="absolute -top-10 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-[8px] bg-black/75 px-2.5 py-1 text-[12px] font-medium text-white backdrop-blur">
            {label}
          </motion.span>
        )}
      </AnimatePresence>
      <motion.div key={bounce} animate={bounce ? { y: [0, -26, 0, -12, 0] } : {}} transition={{ duration: 0.7 }}
        className={cx('grid h-full w-full place-items-center rounded-[22%] bg-gradient-to-br text-white shadow-[0_10px_25px_-8px_rgba(0,0,0,.45)]', color)}>
        <div className="absolute inset-0 rounded-[22%] bg-gradient-to-b from-white/40 to-transparent" style={{ maskImage: 'linear-gradient(#000, transparent 55%)' }} />
        <Icon className="relative h-[45%] w-[45%]" strokeWidth={2.2} />
      </motion.div>
    </motion.div>
  );
}

/* ---------------- Rotating words (blur flip) ---------------- */
export function RotatingWords({ words, className, interval = 2200 }) {
  const [i, setI] = useState(0);
  useEffect(() => { const t = setInterval(() => setI((x) => (x + 1) % words.length), interval); return () => clearInterval(t); }, [words.length, interval]);
  return (
    <span className={cx('relative inline-grid', className)}>
      <AnimatePresence mode="popLayout">
        <motion.span key={words[i]} initial={{ y: '60%', opacity: 0, filter: 'blur(10px)', rotateX: -60 }} animate={{ y: 0, opacity: 1, filter: 'blur(0px)', rotateX: 0 }}
          exit={{ y: '-60%', opacity: 0, filter: 'blur(10px)', rotateX: 60 }} transition={{ type: 'spring', stiffness: 220, damping: 22 }}
          className="col-start-1 row-start-1 bg-gradient-to-r from-[#0a84ff] via-[#bf5af2] to-[#ff375f] bg-clip-text text-transparent">
          {words[i]}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/* ---------------- Confetti (canvas) ---------------- */
export function Confetti({ fire }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!fire) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const cv = ref.current, ctx = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; ctx.scale(dpr, dpr);
    const cols = ['#ff375f', '#ff9f0a', '#ffd60a', '#30d158', '#64d2ff', '#0a84ff', '#bf5af2'];
    const P = [];
    for (const side of [0, 1]) for (let i = 0; i < 110; i++) {
      const a = side ? Math.PI + 0.35 + Math.random() * 0.6 : -0.35 - Math.random() * 0.6;
      const v = 9 + Math.random() * 11;
      P.push({ x: side ? innerWidth + 10 : -10, y: innerHeight * 0.75, vx: Math.cos(a) * v * (side ? 1 : 1), vy: Math.sin(a) * v - 6, r: Math.random() * 6 + 4,
        c: cols[(Math.random() * cols.length) | 0], rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, shape: Math.random() > 0.5 });
    }
    let raf, t = 0;
    const tick = () => {
      t++;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (const p of P) {
        p.vy += 0.32; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.c;
        if (p.shape) ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2 * Math.abs(Math.cos(t / 8 + p.rot)) + 1);
        else { ctx.beginPath(); ctx.arc(0, 0, p.r / 2.4, 0, 6.3); ctx.fill(); }
        ctx.restore();
      }
      if (t < 260) raf = requestAnimationFrame(tick); else ctx.clearRect(0, 0, innerWidth, innerHeight);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [fire]);
  return <canvas ref={ref} className="pointer-events-none fixed inset-0 z-[80] h-full w-full" />;
}

/* ---------------- Shimmer border wrapper (animated gradient ring) ---------------- */
export function GlowRing({ children, className, active = true, radius = 22 }) {
  return (
    <div className={cx('relative', className)} style={{ borderRadius: radius }}>
      {active && (
        <div className="pointer-events-none absolute -inset-[2px] overflow-hidden" style={{ borderRadius: radius + 2 }}>
          <motion.div className="absolute left-1/2 top-1/2 aspect-square w-[200%] -translate-x-1/2 -translate-y-1/2"
            style={{ background: 'conic-gradient(from 0deg, #0a84ff, #bf5af2, #ff375f, #ff9f0a, #30d158, #0a84ff)' }}
            animate={{ rotate: 360 }} transition={{ duration: 4, repeat: Infinity, ease: 'linear' }} />
        </div>
      )}
      <div className="relative h-full" style={{ borderRadius: radius }}>{children}</div>
    </div>
  );
}

/* ---------------- Typewriter terminal line ---------------- */
export function Typewriter({ lines, className }) {
  const [n, setN] = useState(0);
  const total = lines.join('\n').length;
  useEffect(() => {
    const t = setInterval(() => setN((x) => (x >= total + 40 ? 0 : x + 1)), 38);
    return () => clearInterval(t);
  }, [total]);
  const text = lines.join('\n').slice(0, n);
  return (
    <pre className={cx('whitespace-pre-wrap font-mono', className)}>
      {text.split('\n').map((l, i) => <div key={i}><span className="text-[#7ee787]">❯ </span>{l}</div>)}
      <motion.span animate={{ opacity: [1, 0] }} transition={{ duration: 0.6, repeat: Infinity }} className="inline-block h-[1.05em] w-[0.55em] translate-y-[2px] bg-white/80" />
    </pre>
  );
}

/* ---------------- Number that springs ---------------- */
export function SpringNumber({ value, className }) {
  const mv = useSpring(0, { stiffness: 70, damping: 18 });
  const [v, setV] = useState(0);
  useEffect(() => { mv.set(value); }, [value, mv]);
  useEffect(() => mv.on('change', (x) => setV(Math.round(x))), [mv]);
  return <span className={className}>{v}</span>;
}
