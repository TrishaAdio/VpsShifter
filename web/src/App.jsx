import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Wallpaper, Window, Toasts, toast, DynamicIsland, I } from './ui.jsx';
import { api, useJob } from './api.js';
import Welcome from './screens/Welcome.jsx';
import Connect from './screens/Connect.jsx';
import Scanning from './screens/Scanning.jsx';
import Review from './screens/Review.jsx';
import Transfer from './screens/Transfer.jsx';
import Done from './screens/Done.jsx';

const emptyServer = () => ({ host: '', port: '22', username: 'root', password: '', privateKey: '', useKey: false });

function screenFor(state) {
  if (!state) return null;
  const s = state.status;
  if (s === 'connecting') return 'scanning';
  if (s === 'ready') return 'review';
  if (s === 'running' || s === 'rolling-back') return 'transfer';
  if (s === 'failed' && !state.steps?.some((x) => ['prepare', 'sync'].includes(x.id) && x.status !== 'pending')) return 'scanning';
  return 'done';
}

const pageVariants = {
  initial: (dir) => ({ x: dir > 0 ? 60 : -60, opacity: 0, filter: 'blur(6px)' }),
  animate: { x: 0, opacity: 1, filter: 'blur(0px)', transition: { type: 'spring', stiffness: 260, damping: 30 } },
  exit: (dir) => ({ x: dir > 0 ? -60 : 60, opacity: 0, filter: 'blur(6px)', transition: { duration: 0.2 } }),
};
const ORDER = ['welcome', 'connect', 'scanning', 'review', 'transfer', 'done'];

export default function App() {
  const [screen, setScreenRaw] = useState('welcome');
  const [dir, setDir] = useState(1);
  const [servers, setServers] = useState({ source: emptyServer(), target: emptyServer() });
  const [jobId, setJobId] = useState(() => sessionStorage.getItem('shift-job') || null);
  const { state, logs, connected } = useJob(jobId);

  const setScreen = (s) => { setDir(ORDER.indexOf(s) >= ORDER.indexOf(screen) ? 1 : -1); setScreenRaw(s); };

  useEffect(() => { if (jobId) sessionStorage.setItem('shift-job', jobId); else sessionStorage.removeItem('shift-job'); }, [jobId]);

  // follow the job's status
  useEffect(() => {
    const s = screenFor(state);
    if (s && s !== screen && !(screen === 'connect' && s === 'scanning')) setScreen(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.status]);

  useEffect(() => {
    if (!state) return;
    if (state.status === 'done') toast('Move complete', 'All projects are running on the new VPS.', 'green');
    if (state.status === 'rolledback') toast('Rolled back safely', 'Your projects run on the old VPS again.', 'orange');
    if (state.status === 'rehearsed') toast('Rehearsal finished', 'Nothing was stopped on the old VPS.', 'blue');
  }, [state?.status]);

  const startOver = (keep = true) => {
    setJobId(null);
    if (!keep) setServers({ source: emptyServer(), target: emptyServer() });
    setScreen('connect');
  };

  const tone = state?.status === 'done' ? 'green' : state?.status === 'rolling-back' || state?.status === 'rolledback' ? 'orange' : state?.status === 'failed' ? 'red' : 'blue';
  const live = screen === 'transfer' && state;
  const title = { welcome: 'Shift', connect: 'Connect your servers', scanning: 'Scanning', review: 'Review & start', transfer: 'Moving your projects', done: 'Summary' }[screen];

  return (
    <div className="min-h-dvh px-3 py-6 sm:px-6 sm:py-8">
      <Wallpaper tone={tone} />
      <Toasts />
      {live && (
        <DynamicIsland
          title={state.progress?.current || 'Working…'}
          detail={[state.transfer?.mode && `${state.transfer.mode} mode`, state.progress?.speed, state.progress?.eta && state.progress.eta !== '0:00:00' && `${state.progress.eta} left`].filter(Boolean).join(' · ')}
          progress={state.progress?.overall || 0}
          tone={state.status === 'rolling-back' ? 'orange' : 'blue'}
        />
      )}
      <Window
        title={title}
        subtitle={state && screen !== 'welcome' && screen !== 'connect' ? `${state.servers.source.host} → ${state.servers.target.host}` : 'VPS Transfer'}
        onClose={() => { if (screen !== 'transfer') { setJobId(null); setScreen('welcome'); } }}
        toolbar={jobId && screen !== 'welcome' ? (
          <span className="text-tertiary flex items-center gap-1.5 text-[11px]">
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-[var(--color-ios-green)]' : 'bg-[var(--color-ios-orange)]'}`} />
            <span className="hidden sm:inline">{connected ? 'Live' : 'Reconnecting'}</span>
          </span>
        ) : null}
      >
        <AnimatePresence mode="wait" custom={dir}>
          <motion.div key={screen} custom={dir} variants={pageVariants} initial="initial" animate="animate" exit="exit" className="flex min-h-0 flex-1 flex-col">
            {screen === 'welcome' && <Welcome onStart={() => setScreen('connect')} onOpen={(id) => setJobId(id)} />}
            {screen === 'connect' && (
              <Connect servers={servers} setServers={setServers} onBack={() => setScreen('welcome')}
                onJob={(id) => { setJobId(id); setScreen('scanning'); }} />
            )}
            {screen === 'scanning' && <Scanning state={state} logs={logs} onBack={() => startOver(true)} />}
            {screen === 'review' && state && <Review state={state} jobId={jobId} onBack={() => startOver(true)} />}
            {screen === 'transfer' && state && <Transfer state={state} logs={logs} jobId={jobId} />}
            {screen === 'done' && state && <Done state={state} logs={logs} jobId={jobId} onAgain={() => startOver(true)} onNew={() => startOver(false)} />}
          </motion.div>
        </AnimatePresence>
      </Window>
      <p className="text-tertiary mt-4 text-center text-[11px]">
        <I.Lock size={11} className="mr-1 inline -translate-y-px" />Passwords stay in memory on this computer only — never saved or logged.
      </p>
    </div>
  );
}

export { api };
