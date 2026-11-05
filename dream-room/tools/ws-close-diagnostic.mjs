import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const PackageWebSocket = require('ws');
const base = new URL(process.env.BASE_URL || 'http://127.0.0.1:8787');
assert(['http:', 'https:'].includes(base.protocol));
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), '僅限本機');
if (base.hostname === 'localhost') base.hostname = '127.0.0.1';
const room = 'dream-a';
const visitors = [];
const results = { node: process.version, ws: require('ws/package.json').version, endpoint: base.origin,
  startedAt: new Date().toISOString(), events: [], probes: [], cleanup: null };
const elapsed = () => Date.now() - Date.parse(results.startedAt);

function log(entry) {
  const event = { ms: elapsed(), ...entry };
  results.events.push(event);
  console.log(JSON.stringify(event));
}

async function api(path, options) {
  const response = await fetch(new URL(path, base), { ...options, redirect: 'error', signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  return response.json();
}

async function waitFor(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await delay(20);
  return Boolean(predicate());
}

function connect(kind, label) {
  const token = randomUUID();
  const url = new URL('/api/connect', base);
  url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('room', room);
  url.searchParams.set('token', token);
  const Constructor = kind === '內建' ? WebSocket : PackageWebSocket;
  const socket = new Constructor(url);
  const visitor = { kind, label, token, socket, start: Date.now(), messages: [], welcome: null, close: null, error: null };
  visitors.push(visitor);
  const note = (event, extra = {}) => log({ label, kind, event, afterMs: Date.now() - visitor.start, ...extra });
  const message = raw => {
    try {
      const data = JSON.parse(String(raw));
      visitor.messages.push(data);
      if (data.type === 'welcome') visitor.welcome = data;
      if (data.type !== 'state') note('message', { type: data.type });
    } catch (error) { visitor.error = error.message; note('parse-error', { message: error.message }); }
  };
  const closed = (code, reason, wasClean) => {
    visitor.close = { code, reason: String(reason), wasClean, afterMs: Date.now() - visitor.start };
    note('close', visitor.close);
  };
  if (kind === '內建') {
    socket.addEventListener('open', () => note('open'));
    socket.addEventListener('message', event => message(event.data));
    socket.addEventListener('close', event => closed(event.code, event.reason, event.wasClean));
    socket.addEventListener('error', event => { visitor.error = event.message || '連線錯誤'; note('error', { message: visitor.error }); });
  } else {
    socket.on('open', () => note('open'));
    socket.on('message', message);
    socket.on('close', (code, reason) => closed(code, reason, undefined));
    socket.on('error', error => { visitor.error = error.message; note('error', { message: visitor.error }); });
  }
  return visitor;
}

async function probe(kind) {
  const visitor = connect(kind, `${kind}第11人`);
  const full = await waitFor(() => visitor.messages.some(message => message.type === 'full'));
  const close = await waitFor(() => visitor.close, 5000);
  const result = { kind, fullReceived: full, closeReceivedWithin5s: close, readyState: visitor.socket.readyState,
    close: visitor.close, error: visitor.error, admitted: Boolean(visitor.welcome) };
  results.probes.push(result);
  log({ event: 'probe-result', ...result });
  assert(full && !visitor.welcome, `${kind}必須收到滿員，不能取得席位`);
}

async function cleanup() {
  const errors = [];
  for (const visitor of visitors) {
    try {
      if (visitor.socket.readyState === 1) {
        visitor.socket.send(JSON.stringify({ type: 'leave' }));
        visitor.socket.close(1000, 'Visitor left');
      }
    } catch (error) { errors.push(error.message); }
  }
  const removed = await Promise.allSettled(visitors.filter(visitor => visitor.welcome).map(visitor => api('/api/leave', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room, token: visitor.token, connectionId: visitor.welcome.connectionId })
  }).then(response => assert.equal(response.left, true))));
  for (const result of removed) if (result.status === 'rejected') errors.push(result.reason.message);
  await waitFor(() => visitors.filter(visitor => visitor.kind !== '內建').every(visitor => visitor.close), 2000);
  for (const visitor of visitors) if (visitor.kind !== '內建' && visitor.socket.readyState !== 3) visitor.socket.terminate();
  const rooms = await api('/api/rooms');
  results.cleanup = { rooms, errors };
  log({ event: 'cleanup', ...results.cleanup });
  assert.equal(rooms['dream-a'].count, 0, '診斷後夜潮必須清空');
  assert.equal(rooms['dream-b'].count, 0, '診斷後霧藍必須清空');
  assert.equal(errors.length, 0, '診斷清理不得吞掉錯誤');
}

let failure;
try {
  const rooms = await api('/api/rooms');
  assert.equal(rooms['dream-a'].count, 0, '開跑前兩房必須空');
  assert.equal(rooms['dream-b'].count, 0, '開跑前兩房必須空');
  const fillers = Array.from({ length: 10 }, (_, index) => connect('既有套件', `席位${index + 1}`));
  assert(await waitFor(() => fillers.every(visitor => visitor.welcome)), '10人應全部入場');
  const fullRooms = await api('/api/rooms');
  assert.equal(fullRooms[room].count, 10);
  log({ event: 'room-filled', count: fullRooms[room].count });
  await probe('內建');
  await probe('既有套件');
} catch (error) {
  failure = error;
  log({ event: 'failure', error: error.stack });
} finally {
  try { await cleanup(); }
  catch (error) { failure = failure ? new AggregateError([failure, error]) : error; log({ event: 'cleanup-failure', error: error.stack }); }
  results.finishedAt = new Date().toISOString();
  await writeFile(new URL('./ws-close-diagnostic-result.json', import.meta.url), JSON.stringify(results, null, 2));
}
if (failure) { console.error(failure); process.exitCode = 1; }
console.log('診斷已結束；本檔只記錄差異，不代表正式驗收通過。');
// A stuck native closing handshake has no public terminate method.
setTimeout(() => process.exit(process.exitCode || 0), 1000).unref();
