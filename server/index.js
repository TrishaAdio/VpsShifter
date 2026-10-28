import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWs from '@fastify/websocket';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Remote, SCRIPTS } from './ssh.js';
import { parseProbe } from './scan.js';
import { Job, listJobs } from './engine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 7300;
const HOST = process.env.HOST || '127.0.0.1';
const PASSWORD = process.env.SHIFT_PASSWORD || '';

const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
await app.register(fastifyWs);

if (PASSWORD) {
  app.addHook('onRequest', async (req, reply) => {
    const h = req.headers.authorization || '';
    const ok = h.startsWith('Basic ') && Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':') === PASSWORD;
    if (!ok) { reply.header('WWW-Authenticate', 'Basic realm="Shift"').code(401).send('Login required'); }
  });
} else if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
  console.warn('\n⚠️  Shift is reachable from the network without a password. Set SHIFT_PASSWORD=... to protect it.\n');
}

/** @type {Map<string, Job>} */
const jobs = new Map();
const getJob = (id) => {
  if (jobs.has(id)) return jobs.get(id);
  try { const j = Job.load(id); jobs.set(id, j); return j; } catch { return null; }
};

const cleanCfg = (c = {}) => ({
  host: String(c.host || '').trim().replace(/^\[|\]$/g, ''),
  port: Number(c.port) || 22,
  username: String(c.username || '').trim(),
  password: c.password || undefined,
  privateKey: c.privateKey || undefined,
  passphrase: c.passphrase || undefined,
  otp: c.otp || undefined,
});

function validate(c, label) {
  if (!c.host) throw new Error(`${label}: enter the IP address`);
  if (!c.username) throw new Error(`${label}: enter the username`);
  if (!c.password && !c.privateKey) throw new Error(`${label}: enter the password`);
  if (!(c.port > 0 && c.port < 65536)) throw new Error(`${label}: invalid port`);
}

app.post('/api/test', async (req) => {
  const cfg = cleanCfg(req.body);
  try {
    validate(cfg, 'Server');
    const r = new Remote(cfg, { label: 'server' });
    await r.connect();
    try {
      const priv = await r.checkPrivileges();
      const p = parseProbe((await r.sh(SCRIPTS.probe, { root: false })).stdout);
      return { ok: true, fingerprint: r.fingerprint, user: r.user, root: r.isRoot, privileges: priv, os: p.name, arch: p.arch, hostname: p.hostname,
        memKB: p.memKB, diskKB: p.diskKB, cpus: p.cpus, uptime: p.uptime };
    } finally { r.close(); }
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

app.post('/api/jobs', async (req, reply) => {
  const { source, target, fingerprints } = req.body || {};
  const s = cleanCfg(source), t = cleanCfg(target);
  try { validate(s, 'Old VPS'); validate(t, 'New VPS'); } catch (e) { return reply.code(400).send({ error: e.message }); }
  if (s.host === t.host && s.port === t.port) return reply.code(400).send({ error: 'Old and new VPS have the same address' });
  const job = new Job({ source: s, target: t, fingerprints: fingerprints || {} });
  jobs.set(job.id, job);
  (async () => {
    try {
      await job.connect();
      await job.scan();
      await job.preflight(job.state.selection, {});
    } catch (e) {
      job.log(e.message, 'error');
      job.update({ status: 'failed', error: e.message });
      await job.cleanup(false).catch(() => {});
    }
  })();
  return { id: job.id };
});

app.get('/api/jobs', async () => {
  const disk = listJobs();
  return disk.map((d) => ({ ...d, live: jobs.has(d.id) && !!jobs.get(d.id).src }));
});

app.get('/api/jobs/:id', async (req, reply) => {
  const job = getJob(req.params.id);
  if (!job) return reply.code(404).send({ error: 'Not found' });
  return { state: job.publicState(), logs: job.logs.slice(-600), live: !!job.src };
});

const action = (fn) => async (req, reply) => {
  const job = getJob(req.params.id);
  if (!job) return reply.code(404).send({ error: 'Not found' });
  try { return (await fn(job, req.body || {})) ?? { ok: true }; } catch (e) { return reply.code(400).send({ error: e.message }); }
};

app.post('/api/jobs/:id/preflight', action(async (job, b) => {
  if (!job.scanData) throw new Error('This migration needs to be started again');
  if (job.running || job.state.cutoverStarted) throw new Error('Already running');
  return job.preflight(b.selection, b.options || {});
}));
app.post('/api/jobs/:id/dbauth', action(async (job, b) => { await job.setDbAuth(b.projectId, b); return job.preflight(job.state.selection, {}); }));
app.post('/api/jobs/:id/start', action(async (job, b) => {
  if (job.running) throw new Error('Already running');
  if (b.selection || b.options) await job.preflight(b.selection || job.state.selection, b.options || {});
  if (!job.state.preflight?.ok) throw new Error('Some pre-flight checks are red');
  job.start();
  return { ok: true };
}));
app.post('/api/jobs/:id/cancel', action(async (job) => { job.cancel(); }));
app.post('/api/jobs/:id/rollback', action(async (job) => {
  if (job.running) throw new Error('Please wait for the current step to finish');
  if (!job.src) throw new Error('Reconnect first');
  job.running = true;
  job.rollback('Requested by you').finally(() => { job.running = false; });
}));
app.post('/api/jobs/:id/reconnect', action(async (job, b) => {
  await job.reconnect(cleanCfg({ ...job.state.servers.source, ...b.source }), cleanCfg({ ...job.state.servers.target, ...b.target }));
}));
app.delete('/api/jobs/:id', action(async (job) => {
  if (job.running) throw new Error('Migration is running');
  if (!job.state.cutoverStarted) await job.cleanup(false).catch(() => {});
  job.close();
  jobs.delete(job.id);
}));
app.get('/api/jobs/:id/report', async (req, reply) => {
  const job = getJob(req.params.id);
  if (!job) return reply.code(404).send({ error: 'Not found' });
  reply.header('Content-Disposition', `attachment; filename="shift-report-${job.id}.json"`);
  return { generatedAt: new Date().toISOString(), state: job.publicState(), log: job.logs.map((l) => `${new Date(l.t).toISOString()} [${l.level}]${l.server ? ' [' + l.server + ']' : ''} ${l.msg}`) };
});

app.register(async (f) => {
  f.get('/api/ws', { websocket: true }, (socket, req) => {
    const id = new URL(req.url, 'http://x').searchParams.get('job');
    const job = getJob(id);
    if (!job) { socket.close(); return; }
    let timer = null;
    const sendState = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; try { socket.send(JSON.stringify({ type: 'state', state: job.publicState() })); } catch {} }, 150);
    };
    const onLog = (line) => { try { socket.send(JSON.stringify({ type: 'log', line })); } catch {} };
    job.on('state', sendState);
    job.on('log', onLog);
    socket.send(JSON.stringify({ type: 'state', state: job.publicState() }));
    socket.on('close', () => { job.off('state', sendState); job.off('log', onLog); clearTimeout(timer); });
  });
});

const dist = path.join(here, '..', 'web', 'dist');
if (fs.existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist, prefix: '/' });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html')));
} else {
  app.get('/', async () => 'Shift API is running. Build the website with: npm run build');
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) process.exit(0);
  shuttingDown = true;
  console.log('\nShutting down… removing temporary access from servers that are not mid-migration.');
  await Promise.all([...jobs.values()].map(async (j) => {
    if (!j.running && !j.state.cutoverStarted && j.src) await j.cleanup(false).catch(() => {});
    j.save();
  }));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (e) => console.error('Unhandled:', e?.message || e));

await app.listen({ port: PORT, host: HOST });
console.log(`\n  ✨ Shift is running → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
