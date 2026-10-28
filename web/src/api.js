import { useEffect, useRef, useState } from 'react';

export async function api(path, { method, body } = {}) {
  const res = await fetch(`/api${path}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** Live job state over WebSocket (auto-reconnects). */
export function useJob(id) {
  const [state, setState] = useState(null);
  const [logs, setLogs] = useState([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);

  useEffect(() => {
    if (!id) return;
    let closed = false;
    let retry = 0;
    setLogs([]);
    api(`/jobs/${id}`).then((d) => { setState(d.state); setLogs(d.logs || []); }).catch(() => {});
    const open = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/api/ws?job=${id}`);
      wsRef.current = ws;
      ws.onopen = () => { setConnected(true); retry = 0; };
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === 'state') setState(m.state);
        if (m.type === 'log') setLogs((l) => (l.length > 3000 ? [...l.slice(-2500), m.line] : [...l, m.line]));
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        retry++;
        setTimeout(() => {
          if (closed) return;
          api(`/jobs/${id}`).then((d) => { setState(d.state); setLogs(d.logs || []); }).catch(() => {});
          open();
        }, Math.min(8000, 500 * 2 ** retry));
      };
    };
    open();
    return () => { closed = true; wsRef.current?.close(); };
  }, [id]);

  return { state, logs, connected, setState };
}

export function fmtKB(kb) {
  kb = Number(kb) || 0;
  if (kb < 1024) return `${kb} KB`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(kb < 10240 ? 1 : 0)} MB`;
  return `${(kb / 1024 / 1024).toFixed(1)} GB`;
}
