import path from 'node:path';

const posix = path.posix;
const SYSTEM_DIRS = ['/usr/lib/python3/dist-packages', '/usr/lib/python3/site-packages', '/usr/lib64/python', '/usr/lib/python'];
const NEVER_SYNC = new Set(['/', '/etc', '/usr', '/usr/local', '/usr/bin', '/usr/lib', '/var', '/var/lib', '/var/log', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/proc', '/sys', '/dev',
  '/run', '/home', '/opt', '/srv', '/tmp', '/var/tmp', '/var/www', '/mnt', '/media', '/snap', '/var/lib/docker', '/etc/nginx', '/var/lib', '/var/cache', '/root/..']);
const SKIP_PREFIX = ['/proc/', '/sys/', '/dev/', '/run/', '/tmp/', '/var/tmp/shift', '/var/backups/shift', '/var/lib/docker/overlay', '/var/lib/containerd', '/snap/'];

export const DEFAULT_OPTIONS = {
  copyHomes: true,
  convertToSystemd: true,
  autoRollback: true,
  stabilitySeconds: 30,
  bandwidthLimitMBs: 0,
  replaceOldIp: false,
  rehearsal: false,
  verify: 'auto', // auto | checksum | quick
};

const under = (p, dir) => !!p && !!dir && (p === dir || p.startsWith(dir.endsWith('/') ? dir : dir + '/'));

const PKG = {
  debian: { procps: 'procps', iproute: 'iproute2', ssh: 'openssh-client', cron: 'cron' },
  rhel: { procps: 'procps-ng', iproute: 'iproute', ssh: 'openssh-clients', cron: 'cronie' },
  alpine: { procps: 'procps', iproute: 'iproute2', ssh: 'openssh-client', cron: null },
  arch: { procps: 'procps-ng', iproute: 'iproute2', ssh: 'openssh', cron: 'cronie' },
  suse: { procps: 'procps', iproute: 'iproute2', ssh: 'openssh-clients', cron: 'cronie' },
  other: { procps: 'procps', iproute: 'iproute2', ssh: 'openssh-client', cron: 'cron' },
};

const PHP_DEB = { mysqli: 'mysql', mysqlnd: 'mysql', pdo_mysql: 'mysql', pgsql: 'pgsql', pdo_pgsql: 'pgsql', curl: 'curl', gd: 'gd', mbstring: 'mbstring', xml: 'xml', dom: 'xml',
  SimpleXML: 'xml', xmlreader: 'xml', xmlwriter: 'xml', xsl: 'xml', zip: 'zip', intl: 'intl', bcmath: 'bcmath', soap: 'soap', redis: 'redis', imagick: 'imagick', sqlite3: 'sqlite3',
  pdo_sqlite: 'sqlite3', opcache: 'opcache', readline: 'readline', gmp: 'gmp', ldap: 'ldap', memcached: 'memcached', mongodb: 'mongodb', igbinary: 'igbinary', apcu: 'apcu',
  yaml: 'yaml', tidy: 'tidy', imap: 'imap', bz2: 'bz2', exif: 'common', fileinfo: 'common', tokenizer: 'common', ctype: 'common', iconv: 'common', gettext: 'common', ftp: 'common', calendar: 'common', sockets: 'common', posix: 'common', shmop: 'common', sysvmsg: 'common', sysvsem: 'common', sysvshm: 'common', phar: 'common', ffi: 'common' };
const PHP_RHEL = { mysql: 'mysqlnd', zip: 'pecl-zip', redis: 'pecl-redis', imagick: 'pecl-imagick', apcu: 'pecl-apcu', mongodb: 'pecl-mongodb', memcached: 'pecl-memcached', igbinary: 'pecl-igbinary', yaml: 'pecl-yaml', sqlite3: 'pdo', common: 'common' };

function isHomeDir(dir, scan) {
  return dir === '/root' || scan.passwd.some((u) => u.home === dir && u.uid >= 1000 && u.uid < 65534);
}
function homeOf(user, scan) {
  return scan.passwd.find((u) => u.name === user)?.home || (user === 'root' ? '/root' : `/home/${user}`);
}
function glibcVer(libc) {
  const m = String(libc || '').match(/glibc-(\d+)\.(\d+)/);
  return m ? +m[1] * 1000 + +m[2] : 0;
}
const isPublic = (addr) => ['0.0.0.0', '*', '[::]', '::', '[::ffff:0.0.0.0]'].includes(addr);

export function computePlan({ scan, ins, projects, selected, options, src, tgt, srcHost, tgtSshPort }) {
  const opt = { ...DEFAULT_OPTIONS, ...(options || {}) };
  const sel = projects.filter((p) => selected.includes(p.id));
  const checks = [];
  const add = (level, title, detail = '', id = title) => checks.push({ id, level, title, detail });
  const fam = tgt.family in PKG ? tgt.family : 'other';
  const crossArch = normArch(src.arch) !== normArch(tgt.arch);
  const libcChange = String(src.libc).split('-')[0] !== String(tgt.libc).split('-')[0];
  const olderGlibc = !libcChange && glibcVer(tgt.libc) && glibcVer(src.libc) && glibcVer(tgt.libc) < glibcVer(src.libc);
  const rebuildNative = crossArch || libcChange || olderGlibc;
  const tgtSystemd = tgt.init === 'systemd';

  const plan = {
    users: [], groups: [], packages: new Set(['rsync', 'curl', 'ca-certificates', 'tar', 'gzip', PKG[fam].procps, PKG[fam].iproute]),
    needs: {}, nodes: [], pythons: [], base: new Set(), proj: new Set(), mapped: [], excludes: [], ports: new Set(), rebuild: [],
    volumes: [], localImages: [], crossArch, libcChange, rebuildNative, tgtSystemd, projects: sel.map((p) => p.id), opt,
  };

  // ---------------- users
  const users = new Set();
  for (const p of sel) {
    if (p.user) users.add(p.user);
    if (p.kind === 'systemd' && p.details.unitParsed?.user) users.add(p.details.unitParsed.user);
  }
  for (const u of users) {
    if (u === 'root') continue;
    const pw = scan.passwd.find((x) => x.name === u);
    if (!pw) { add('warn', `User "${u}" not found on the old VPS`, 'Files will be owned by numeric IDs.'); continue; }
    const g = scan.groups.find((x) => x.gid === pw.gid);
    if (g && !plan.groups.find((x) => x.name === g.name)) plan.groups.push({ name: g.name, gid: g.gid });
    const sup = scan.groups.filter((x) => x.members.includes(u) && !['sudo', 'wheel', 'adm', 'admin'].includes(x.name)).map((x) => x.name);
    plan.users.push({ name: u, uid: pw.uid, group: g?.name || u, home: pw.home, shell: pw.shell, sup });
  }

  // ---------------- sync paths
  const addBase = (p) => { if (p && p.startsWith('/') && !NEVER_SYNC.has(p) && !SKIP_PREFIX.some((s) => p.startsWith(s))) plan.base.add(p.replace(/\/+$/, '')); };
  const addProj = (p, proj) => {
    if (!p || !p.startsWith('/')) return;
    const c = p.replace(/\/+$/, '') || '/';
    if (NEVER_SYNC.has(c) || SKIP_PREFIX.some((s) => c.startsWith(s))) {
      if (proj && !['db', 'cron', 'crond', 'site'].includes(proj.kind)) add('warn', `${proj.title}: runs from ${c}`, 'Only its own files are copied, not the whole folder.', `dir-${proj.id}`);
      return;
    }
    plan.proj.add(c);
  };
  const projUsers = new Set();
  for (const p of sel) {
    if (['pm2', 'systemd', 'process', 'supervisor', 'folder', 'compose'].includes(p.kind)) addProj(p.dir, p);
    if (p.kind === 'process' || p.kind === 'systemd') {
      const argv = p.kind === 'process' ? p.details.argv : p.details.unitParsed?.argv || [];
      for (const a of argv.slice(0, 3)) if (a.startsWith('/') && !a.startsWith('/usr/') && !a.startsWith('/bin/') && !under(a, p.dir)) addBase(a);
    }
    if (p.kind === 'systemd') {
      for (const f of p.details.envFiles || []) addBase(f);
      if (p.details.dropins) addBase(p.details.dropins);
    }
    if (p.kind === 'compose') {
      for (const f of p.details.configFiles) if (!under(f, p.dir)) addBase(f);
      for (const f of p.details.envFiles) if (!under(f, p.dir)) addBase(f);
    }
    if (p.kind === 'compose' || p.kind === 'container') {
      for (const b of p.details.binds) if (!b.startsWith('/var/run/') && !b.startsWith('/run/') && !b.startsWith('/etc/localtime') && !b.startsWith('/sys') && !b.startsWith('/proc')) addProj(b, null);
      const dv = scan.docker?.volumes || [];
      for (const v of p.details.volumes) {
        if (plan.volumes.find((x) => x.name === v.name)) continue;
        const info = dv.find((x) => x.Name === v.name) || {};
        if (info.Driver && info.Driver !== 'local') { add('warn', `Docker volume "${v.name}" uses driver ${info.Driver}`, 'Only local volumes can be copied automatically.'); continue; }
        plan.volumes.push({ name: v.name, labels: info.Labels || {}, src: info.Mountpoint || v.source });
      }
      for (const im of p.details.images) {
        if (!im.digests.length && !plan.localImages.find((x) => x.ref === im.ref)) plan.localImages.push(im);
      }
    }
    if (p.kind === 'site') {
      for (const r of p.details.roots || []) addProj(r, p);
      for (const f of p.details.files || []) {
        if (f.startsWith('/etc/letsencrypt/')) addBase('/etc/letsencrypt');
        else addBase(f);
      }
      if (p.details.server === 'caddy') { addBase('/etc/caddy'); addBase('/var/lib/caddy'); }
    }
    if (p.user && !['db', 'site', 'crond'].includes(p.kind)) projUsers.add(p.user);
  }
  if (opt.copyHomes) for (const u of projUsers) addBase(homeOf(u, scan));
  // PM2 state + node prefixes inside homes
  for (const p of sel.filter((x) => x.kind === 'pm2')) addBase(`${p.details.home}/.pm2`);

  // ---------------- runtimes: node
  const nodeBins = new Map();
  for (const p of sel) {
    if (p.runtime?.type !== 'node' || !p.runtime.bin || !p.runtime.bin.startsWith('/')) continue;
    const info = ins.node[p.runtime.bin];
    const version = info?.version || p.runtime.version;
    if (!version || !/^v\d+\.\d+\.\d+$/.test(version)) { add('warn', `${p.title}: unknown Node.js version`, 'The same files are copied; Node.js is not reinstalled.'); continue; }
    if (!nodeBins.has(p.runtime.bin)) nodeBins.set(p.runtime.bin, { bin: p.runtime.bin, version, globals: info?.globals || [], projects: [] });
    nodeBins.get(p.runtime.bin).projects.push(p);
  }
  for (const n of nodeBins.values()) {
    const prefix = posix.dirname(posix.dirname(n.bin));
    const inHome = scan.passwd.some((u) => (u.uid === 0 || u.uid >= 1000) && u.home !== '/' && under(n.bin, u.home));
    const entry = { ...n, prefix, kind: inHome ? 'home' : 'system', links: [] };
    if (inHome) {
      addBase(prefix);
      if (rebuildNative) plan.excludes.push(`${prefix}/bin/node`, `${prefix}/include/`, `${prefix}/lib/node_modules/npm/`, `${prefix}/lib/node_modules/corepack/`);
    } else {
      entry.installPrefix = prefix === '/usr' ? '/usr/local' : prefix;
      if (entry.installPrefix !== prefix) for (const b of ['node', 'npm', 'npx']) entry.links.push([`${entry.installPrefix}/bin/${b}`, `${prefix}/bin/${b}`]);
      entry.globals = entry.globals.filter((g) => g && !/^(npm|corepack)@/.test(g) && /@\d/.test(g));
      for (const p of n.projects) {
        if (p.kind === 'pm2' && p.details.pm2bin && !under(p.details.pm2bin, entry.installPrefix)) entry.links.push([`${entry.installPrefix}/bin/pm2`, p.details.pm2bin]);
      }
    }
    plan.nodes.push(entry);
    if (rebuildNative) for (const p of n.projects) {
      if (!plan.rebuild.find((r) => r.dir === p.dir) && !NEVER_SYNC.has(p.dir)) {
        plan.rebuild.push({ dir: p.dir, owner: p.user, nodebin: n.bin });
        plan.excludes.push(`${p.dir}/node_modules/`);
      }
    }
  }
  // pm2 installed but node bin unknown (e.g. pm2 running python only)
  for (const p of sel.filter((x) => x.kind === 'pm2' && x.runtime.type === 'python')) {
    const nb = p.details.nodebin;
    if (nb && !plan.nodes.find((x) => x.bin === nb)) {
      const info = ins.node[nb];
      if (info?.version) plan.nodes.push({ bin: nb, version: info.version, prefix: posix.dirname(posix.dirname(nb)), kind: scan.passwd.some((u) => u.home !== '/' && under(nb, u.home)) ? 'home' : 'system',
        installPrefix: posix.dirname(posix.dirname(nb)) === '/usr' ? '/usr/local' : posix.dirname(posix.dirname(nb)), globals: (info.globals || []).filter((g) => /@\d/.test(g) && !/^(npm|corepack)@/.test(g)), links: [], projects: [p] });
    }
  }

  // ---------------- runtimes: python
  const pyKeys = new Map();
  for (const p of sel) {
    if (p.runtime?.type !== 'python') continue;
    if (!p.runtime.interp) { add('warn', `${p.title}: Python interpreter not found`, 'Files are copied as they are.'); continue; }
    const info = ins.py[`${p.runtime.interp}|${p.runtime.user || p.user}`];
    if (!info?.version) { add('warn', `${p.title}: could not read its Python setup`, 'Files are copied as they are.'); continue; }
    const key = info.venv ? `venv:${info.venv}` : `${p.runtime.interp}|${p.user}|${p.dir}`;
    if (!pyKeys.has(key)) {
      const skip = /^(pip|setuptools|wheel|distribute|pkg-resources|uv)$/i;
      const req = [], opt2 = [];
      for (const pk of info.pkgs) {
        if (skip.test(pk.name) || !/==/.test(pk.spec)) continue;
        if (SYSTEM_DIRS.some((d) => pk.loc.startsWith(d))) opt2.push(pk.spec); else req.push(pk.spec);
      }
      pyKeys.set(key, { key, interp: p.runtime.interp, version: info.version, venv: info.venv, owner: p.user, cwd: p.dir,
        req: [...new Set(req)], opt: info.venv ? [] : [...new Set(opt2)], newVenv: info.venv ? null : `${p.dir}/.shift-venv`, projects: [] });
      if (info.venv && !under(info.venv, p.dir)) addBase(info.venv);
    }
    pyKeys.get(key).projects.push(p.id);
  }
  plan.pythons = [...pyKeys.values()];
  if (plan.pythons.some((x) => !x.venv)) for (const s of ins.localSites) addBase(s);
  if (plan.pythons.some((x) => !x.venv)) for (const s of ins.userSites) if (projUsers.has(s.user)) addBase(s.path);

  // ---------------- services needed on target
  const kinds = new Set(sel.map((p) => p.kind));
  if (kinds.has('compose') || kinds.has('container')) plan.needs.docker = true;
  if (kinds.has('supervisor')) plan.needs.supervisor = true;
  if (kinds.has('cron') || kinds.has('crond') || (!tgtSystemd && sel.some((p) => ['process', 'systemd', 'pm2'].includes(p.kind)))) plan.needs.cron = true;
  for (const p of sel) {
    if (p.kind === 'process' && (!tgtSystemd || !opt.convertToSystemd) && p.details.launcher === 'screen') plan.packages.add('screen');
    if (p.kind === 'process' && (!tgtSystemd || !opt.convertToSystemd) && p.details.launcher === 'tmux') plan.packages.add('tmux');
    if (p.kind === 'site') {
      plan.needs[p.details.server] = true;
      if ((p.details.fastcgi || []).some((f) => /php/.test(f)) && scan.php?.version) {
        const map = fam === 'debian' ? PHP_DEB : null;
        const mods = new Set();
        for (const m of scan.php.modules) {
          const d = PHP_DEB[m];
          if (!d || d === 'common') continue;
          mods.add(fam === 'rhel' ? PHP_RHEL[d] || d : d);
        }
        plan.needs.php = { version: scan.php.version, mods: [...mods] };
        void map;
      }
      if ((p.details.files || []).some((f) => f.startsWith('/etc/letsencrypt/'))) plan.needs.certbot = true;
      for (const port of p.ports) plan.ports.add(port);
    }
    if (p.kind === 'db') {
      const e = p.details.engine;
      const v = p.details.version || '';
      if (e === 'mysql') plan.needs.mysql = p.details.flavor;
      if (e === 'postgres') plan.needs.postgres = (v.match(/^(\d+)/) || [])[1] || '16';
      if (e === 'redis') plan.needs.redis = true;
      if (e === 'mongodb') plan.needs.mongodb = (v.match(/v?(\d+\.\d+)/) || [])[1] || '7.0';
    }
    for (const l of p.listen || []) if (isPublic(l.addr) && p.kind !== 'db') plan.ports.add(l.port);
    if (p.kind === 'compose' || p.kind === 'container') for (const port of p.ports) plan.ports.add(port);
  }
  plan.ports.delete(22);
  plan.ports.delete(Number(tgtSshPort) || 22);
  if (src.tools.includes('git')) plan.packages.add('git');
  if (plan.needs.cron && PKG[fam].cron) plan.needs.cronService = true;

  // ---------------- excludes
  plan.excludes.unshift(
    '/root/.cache/', '/home/*/.cache/', '/root/.npm/_cacache/', '/home/*/.npm/_cacache/', '/root/.vscode-server/', '/home/*/.vscode-server/',
    '/root/.cursor-server/', '/home/*/.cursor-server/', '/root/.local/share/Trash/', '/home/*/.local/share/Trash/', '/root/snap/', '/home/*/snap/',
    '/root/.ssh/authorized_keys', '/home/*/.ssh/authorized_keys', '/root/.shift-bootstrap-*', '/home/*/.shift-bootstrap-*',
    '/root/.pm2/*.sock', '/home/*/.pm2/*.sock', '/root/.pm2/pids/', '/home/*/.pm2/pids/', '/root/.pm2/pm2.pid', '/home/*/.pm2/pm2.pid',
    '/root/.pm2/dump.pm2', '/home/*/.pm2/dump.pm2', '/root/.pm2/dump.pm2.bak', '/home/*/.pm2/dump.pm2.bak', '/root/.pm2/touch', '/home/*/.pm2/touch',
    '.shift-venv/', '*.shift-old-*', 'lost+found/', '/root/.local/share/uv/python/', '/home/*/.local/share/uv/python/',
  );

  // ---------------- dedupe: keep top-level paths
  const top = (set) => {
    const arr = [...set].sort((a, b) => a.length - b.length);
    const out = [];
    for (const p of arr) if (!out.some((o) => under(p, o))) out.push(p);
    return out;
  };
  plan.base = top(plan.base);
  plan.proj = top(plan.proj);

  // ---------------- size estimate
  const sizeOf = (p) => ins.dirs[p]?.size || 0;
  const allTop = top(new Set([...plan.base, ...plan.proj]));
  let totalKB = allTop.reduce((a, p) => a + sizeOf(p), 0);
  for (const v of plan.volumes) totalKB += sizeOf(v.src);
  const dbKB = sel.filter((p) => p.kind === 'db').reduce((a, p) => a + (p.size || 0), 0);
  plan.totalKB = totalKB;
  plan.dbKB = dbKB;

  // ---------------- checks
  add('ok', 'Root access on both servers', `${src.user === 'root' ? 'root' : 'sudo'} on old · ${tgt.user === 'root' ? 'root' : 'sudo'} on new`);
  const needKB = Math.round((totalKB + dbKB * 2) * 1.2) + 2 * 1024 * 1024;
  const freeKB = tgt.diskKB;
  if (freeKB && freeKB < needKB) add('error', 'Not enough disk space on the new VPS', `Needs about ${fmtKB(needKB)}, only ${fmtKB(freeKB)} free.`, 'disk');
  else if (freeKB && freeKB < needKB * 1.3) add('warn', 'Disk space on the new VPS is tight', `Needs about ${fmtKB(needKB)}, ${fmtKB(freeKB)} free.`, 'disk');
  else add('ok', 'Enough disk space', `${fmtKB(totalKB + dbKB)} to copy · ${fmtKB(freeKB)} free on the new VPS`, 'disk');
  if (tgt.memKB && src.memKB && tgt.memKB < src.memKB * 0.5) add('warn', 'New VPS has much less memory', `${fmtKB(tgt.memKB)} RAM vs ${fmtKB(src.memKB)} on the old VPS.`, 'ram');
  else add('ok', 'Memory', `${fmtKB(tgt.memKB)} RAM on the new VPS`, 'ram');
  if (crossArch) {
    add('warn', `Different CPU type (${src.arch} → ${tgt.arch})`, 'Node/Python dependencies will be rebuilt and Docker images pulled for the new CPU.', 'arch');
    for (const p of sel) if (p.runtime?.type === 'binary') add('warn', `${p.title} is a compiled program`, `It was built for ${src.arch} and may not run on ${tgt.arch}.`, `bin-${p.id}`);
    for (const im of plan.localImages) add('warn', `Docker image ${im.ref} was built locally`, 'It will be rebuilt on the new VPS if its Dockerfile is in the project folder.', `img-${im.ref}`);
  } else add('ok', 'Same CPU type', src.arch, 'arch');
  if (libcChange) add('warn', `Different system type (${src.libc} → ${tgt.libc})`, 'Native dependencies will be rebuilt.', 'libc');
  if (src.family !== tgt.family) add('warn', `Different Linux family (${src.name} → ${tgt.name})`, 'Packages are installed with the new system\'s package manager.', 'family');
  else add('ok', 'Operating systems', `${src.name} → ${tgt.name}`, 'family');
  if (!tgtSystemd && sel.some((p) => ['systemd', 'process', 'pm2'].includes(p.kind)))
    add('warn', 'The new VPS has no systemd', 'Apps will run as background processes and start again after reboot through cron.', 'init');
  if (tgt.pm === 'none' && (plan.nodes.length || plan.pythons.length || Object.keys(plan.needs).length))
    add('error', 'The new VPS has no package manager', 'Shift cannot install the software your projects need.', 'pm');
  if (!src.tools.includes('rsync') && src.pm === 'none') add('warn', 'rsync is missing on the old VPS', 'Files will be streamed through Shift instead (slower).', 'rsync');
  for (const p of sel) if (p.needsAuth) add('error', `${p.title}: password needed`, 'Enter the database admin login, or untick the database.', `dbauth-${p.id}`);
  if (src.lock && !src.lock.startsWith(String(opt.jobId))) add('warn', 'Another Shift migration was started on the old VPS', `Lock: ${src.lock}`, 'lock-src');
  if (tgt.lock && !tgt.lock.startsWith(String(opt.jobId))) add('warn', 'Another Shift migration was started on the new VPS', `Lock: ${tgt.lock}`, 'lock-tgt');
  const tgList = sel.filter((p) => p.tags.includes('Telegram userbot') || p.tags.includes('Telegram session'));
  if (tgList.length) add('ok', 'Telegram sessions protected', `${tgList.length} project${tgList.length > 1 ? 's' : ''}: never running on both servers at once.`, 'tg');
  if (!sel.length) add('error', 'Nothing selected', 'Choose at least one project to move.', 'none');
  plan.ports = [...plan.ports].filter(Boolean).sort((a, b) => a - b);
  plan.packages = [...plan.packages].filter(Boolean);
  plan.srcHost = srcHost;
  return { plan, checks };
}

export function normArch(a) {
  const x = String(a || '').toLowerCase();
  if (['x86_64', 'amd64'].includes(x)) return 'x86_64';
  if (['aarch64', 'arm64'].includes(x)) return 'aarch64';
  return x;
}

export function fmtKB(kb) {
  kb = Number(kb) || 0;
  if (kb < 1024) return `${kb} KB`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(kb < 10240 ? 1 : 0)} MB`;
  return `${(kb / 1024 / 1024).toFixed(1)} GB`;
}
