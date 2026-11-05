import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { CAPACITY, RECONNECT_MS, ROOM_IDS, nextSeat, canAdmit, allowedModes, defaultMode, isRoomId, publicMember, expiredTokens } from '../src/rules.js';

test('two room IDs and modes are isolated', () => {
  assert.deepEqual(ROOM_IDS, ['dream-a', 'dream-b']);
  for (const room of ROOM_IDS) {
    assert.equal(isRoomId(room), true);
    assert.deepEqual(allowedModes(room), ['sleep', 'float']);
    assert.equal(defaultMode(room), 'sleep');
  }
  for (const room of ['dream', 'reading', 'chat', null, undefined]) {
    assert.equal(isRoomId(room), false);
    assert.deepEqual(allowedModes(room), []);
    assert.equal(defaultMode(room), undefined);
  }
});

test('exactly ten distinct seats; the 11th cannot enter', () => {
  const members = new Map();
  for (let i = 0; i < CAPACITY; i++) {
    const seat = nextSeat(members);
    assert.equal(seat, i);
    members.set(`visitor${i}`, { seat });
  }
  assert.equal(nextSeat(members), -1);
  assert.equal(canAdmit(members, 'visitor11'), false);
  assert.equal(canAdmit(members, 'visitor3'), true);
  members.delete('visitor4');
  assert.equal(nextSeat(members), 4);
  assert.equal(canAdmit(members, 'visitor11'), true);
});

test('client public state does not expose private token', () => {
  const item = publicMember({ id:'public', seat:2, ball:1, mode:'sleep', until:null, token:'secret', connectionId:'private', room:'dream-a' });
  assert.equal(item.token, undefined);
  assert.deepEqual(item, {id:'public',seat:2,ball:1,mode:'sleep',reconnecting:false});
});

test('disconnected member retains seat for 30 seconds, then expires', () => {
  const start = 100000;
  const members = new Map([
    ['offline', { seat: 0, until: start + 30000 }],
    ['online', { seat: 1, until: null }]
  ]);
  assert.deepEqual(expiredTokens(members, start + 29999), []);
  assert.deepEqual(expiredTokens(members, start + 30000), ['offline']);
});

// Exercise the actual room handlers with a small platform shim. These tests
// cover application decisions; tools/runtime-check.mjs checks real Workers I/O.
// Only the Cloudflare base class and platform WebSocket/101 objects are stubbed.
const shim = `
class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
class Socket {
  messages = []; closed = false; attachment = null; closeCalls = [];
  standardAccepted = false; listeners = new Map();
  accept() { this.standardAccepted = true; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  dispatchEvent(event) { this.listeners.get(event.type)?.(event); }
  send(value) { if (this.closed) throw new Error('Closed socket'); this.messages.push(JSON.parse(value)); }
  close(code, reason) {
    this.closeCalls.push({ code, reason });
    if (code === 1005 || code === 1006 || code === 1015) throw new RangeError('Unsendable close code');
    this.closed = true; this.closeCode = code; this.closeReason = reason;
  }
  serializeAttachment(value) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
}
class WebSocketPair {
  constructor() { const server = new Socket(); return { 0: { server }, 1: server }; }
}
class WebSocketRequestResponsePair {}
class Response extends globalThis.Response {
  constructor(body, init) {
    if (init?.status === 101) {
      super(null);
      Object.defineProperty(this, 'status', { value: 101 });
      this.webSocket = init.webSocket;
    } else { super(body, init); }
  }
}
`;
const source = (await readFile(new URL('../src/index.js', import.meta.url), 'utf8'))
  .replace("import { DurableObject } from 'cloudflare:workers';", shim)
  .replace("'./rules.js'", JSON.stringify(new URL('../src/rules.js', import.meta.url).href));
const { DreamRoom, default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

function roomContext(saved = {}, sockets = []) {
  const values = new Map(Object.entries(saved));
  const context = {
    sockets, alarmAt: null, pendingTasks: [],
    blockConcurrencyWhile(operation) { return Promise.resolve().then(operation); },
    getWebSockets() { return sockets.filter(ws => !ws.closed); },
    acceptWebSocket(ws) { sockets.push(ws); },
    waitUntil(promise) { context.pendingTasks.push(promise); },
    setWebSocketAutoResponse() {},
    storage: {
      async get(key) { return structuredClone(values.get(key)); },
      async put(key, value) { values.set(key, structuredClone(value)); },
      async setAlarm(time) { context.alarmAt = time; },
      async deleteAlarm() { context.alarmAt = null; }
    }
  };
  return context;
}

function makeRoom(saved = {}, sockets = []) {
  const context = roomContext(saved, sockets);
  return { room: new DreamRoom(context, {}), context };
}

async function connect(room, token = randomUUID(), roomId = 'dream-a') {
  const response = await room.fetch(new Request(`https://internal/api/connect?token=${token}`, {
    headers: { Upgrade: 'websocket', 'X-Dream-Room': roomId }
  }));
  assert.equal(response.status, 101);
  const socket = response.webSocket.server;
  return { socket, welcome: socket.messages.find(message => message.type === 'welcome'), token };
}

function leaveRequest(token, connectionId) {
  return new Request('https://internal/leave', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, connectionId })
  });
}

test('public room list uses only the two sleeping rooms and old room URLs fail', async () => {
  const requested = [];
  const env = { ROOM: {
    idFromName(name) { requested.push(name); return name; },
    get() { return { fetch: async () => new Response(JSON.stringify({ count: 0, capacity: 10 })) }; }
  } };
  const response = await worker.fetch(new Request('https://example/api/rooms'), env);
  assert.deepEqual(await response.json(), {
    'dream-a': { count: 0, capacity: 10 }, 'dream-b': { count: 0, capacity: 10 }
  });
  assert.deepEqual(requested, ['v1:dream-a', 'v1:dream-b']);
  for (const room of ['dream', 'reading']) {
    const response = await worker.fetch(new Request(`https://example/api/connect?room=${room}`), env);
    assert.equal(response.status, 404);
  }
});

test('simultaneous arrivals fill both rooms independently, without an eleventh seat or leaked tokens', async () => {
  const rooms = ROOM_IDS.map(() => makeRoom().room);
  await Promise.all(rooms.map(async (room, index) => {
    const visitors = await Promise.all(Array.from({ length: 11 }, () => connect(room, randomUUID(), ROOM_IDS[index])));
    const admitted = visitors.filter(visitor => visitor.welcome);
    assert.equal(admitted.length, 10);
    assert.equal(visitors.filter(visitor => visitor.socket.messages[0]?.type === 'full').length, 1);
    assert.equal(room.snapshot().count, 10);
    assert.equal(new Set(admitted.map(visitor => visitor.welcome.you.seat)).size, 10);
    for (const visitor of admitted) {
      assert.equal(visitor.welcome.you.mode, 'sleep');
      assert.ok(visitor.welcome.you.ball >= 0 && visitor.welcome.you.ball < 4);
      assert.equal(JSON.stringify(visitor.socket.messages).includes(visitor.token), false);
      assert.deepEqual(Object.keys(visitor.welcome).sort(), ['capacity', 'connectionId', 'type', 'you']);
    }
    assert.deepEqual(Object.keys(room.snapshot()).sort(), ['capacity', 'count', 'members', 'type']);
  }));
});

test('both rooms validate modes against the stored room and do not affect one another', async () => {
  const first = makeRoom().room;
  const second = makeRoom().room;
  const token = randomUUID();
  const a = await connect(first, token, 'dream-a');
  const b = await connect(second, token, 'dream-b');
  await first.webSocketMessage(a.socket, JSON.stringify({ type: 'mode', room: 'dream-b', value: 'float' }));
  await first.webSocketMessage(a.socket, JSON.stringify({ type: 'mode', room: 'dream-a', value: 'read' }));
  await first.webSocketMessage(a.socket, '{broken');
  assert.equal(first.snapshot().members[0].mode, 'sleep');
  await first.webSocketMessage(a.socket, JSON.stringify({ type: 'mode', room: 'dream-a', value: 'float' }));
  assert.equal(first.snapshot().members[0].mode, 'float');
  assert.equal(second.snapshot().members[0].mode, 'sleep');
  await second.webSocketMessage(b.socket, JSON.stringify({ type: 'mode', room: 'dream-b', value: 'float' }));
  assert.equal(second.snapshot().members[0].mode, 'float');
});

test('close handler replies even for a full-room rejection without a member attachment', async () => {
  const { room } = makeRoom();
  await Promise.all(Array.from({ length: CAPACITY }, () => connect(room)));
  const rejected = await connect(room);
  assert.equal(rejected.socket.messages[0].type, 'full');
  assert.equal(rejected.socket.deserializeAttachment(), null);
  assert.equal(rejected.socket.closeCalls.length, 1);
  await room.webSocketClose(rejected.socket, 1008, 'Room full');
  assert.deepEqual(rejected.socket.closeCalls, [
    { code: 1008, reason: 'Room full' }, { code: 1008, reason: 'Room full' }
  ]);
  assert.equal(room.snapshot().count, CAPACITY);
});

test('full-room rejection uses a short standard socket, preserves the protocol and never joins room sockets', async () => {
  const { room, context } = makeRoom();
  const admitted = await Promise.all(Array.from({ length: CAPACITY }, () => connect(room)));
  const rejected = await connect(room);
  assert.equal(rejected.socket.standardAccepted, true);
  assert.equal(rejected.welcome, undefined);
  assert.deepEqual(rejected.socket.messages, [
    { type: 'full', message: '這座島暫時住滿了，請稍後再來。' }
  ]);
  assert.deepEqual(rejected.socket.closeCalls, [{ code: 1008, reason: 'Room full' }]);
  assert.equal(rejected.socket.deserializeAttachment(), null);
  assert.equal(context.sockets.includes(rejected.socket), false);
  assert.equal(context.sockets.length, CAPACITY);
  for (const visitor of admitted) assert.equal(visitor.socket.standardAccepted, false);
  rejected.socket.dispatchEvent({ type: 'close', code: 1008, reason: 'Room full' });
  assert.deepEqual(rejected.socket.closeCalls.at(-1), { code: 1008, reason: 'Room full' });
  assert.equal(rejected.socket.closeCalls.length, 2);
  assert.equal(room.snapshot().count, CAPACITY);
});

test('explicit WebSocket and HTTP leave immediately release their seats', async () => {
  const { room } = makeRoom();
  const visitors = await Promise.all(Array.from({ length: CAPACITY }, () => connect(room)));
  const first = visitors[0];
  await room.webSocketMessage(first.socket, JSON.stringify({ type: 'leave' }));
  assert.equal(room.snapshot().count, 9);
  const replacement = await connect(room);
  assert.equal(replacement.welcome.you.seat, first.welcome.you.seat);
  const response = await room.fetch(leaveRequest(replacement.token, replacement.welcome.connectionId));
  assert.deepEqual(await response.json(), { left: true });
  assert.equal(room.snapshot().count, 9);
  assert.equal(replacement.socket.closed, true);
});

test('latest tab owns one full-room seat; stale messages, close, error and HTTP leave cannot change it', async () => {
  const { room, context } = makeRoom();
  const visitors = await Promise.all(Array.from({ length: CAPACITY }, () => connect(room)));
  const old = visitors[0];
  const current = await connect(room, old.token);
  assert.equal(room.snapshot().count, 10);
  assert.deepEqual(current.welcome.you, old.welcome.you);
  assert.notEqual(current.welcome.connectionId, old.welcome.connectionId);
  assert.deepEqual(old.socket.messages.at(-1), { type: 'replaced' });
  assert.equal(old.socket.closeCalls.length, 0);
  assert.equal(context.pendingTasks.length, 1);
  await room.webSocketMessage(old.socket, JSON.stringify({ type: 'mode', room: 'dream-a', value: 'float' }));
  await room.webSocketMessage(old.socket, JSON.stringify({ type: 'leave' }));
  await room.webSocketClose(old.socket, 1000, 'Visitor left');
  await room.webSocketError(old.socket);
  await room.fetch(leaveRequest(old.token, old.welcome.connectionId));
  const member = room.members.get(old.token);
  assert.equal(member.connectionId, current.welcome.connectionId);
  assert.equal(member.mode, 'sleep');
  assert.equal(member.until, null);
  assert.equal(room.snapshot().count, 10);
  await room.webSocketMessage(current.socket, JSON.stringify({ type: 'mode', room: 'dream-a', value: 'float' }));
  assert.equal(room.members.get(old.token).mode, 'float');
  await Promise.all(context.pendingTasks);
  assert.equal(old.socket.closeReason, 'Replaced by another tab');
  assert.equal(current.socket.closed, false);
  assert.equal(room.members.get(old.token).connectionId, current.welcome.connectionId);
  assert.equal(room.snapshot().count, CAPACITY);
});

test('a takeover fallback closes only its captured old socket even after another takeover', async () => {
  const { room, context } = makeRoom();
  const original = await connect(room);
  const middle = await connect(room, original.token);
  const latest = await connect(room, original.token);
  assert.deepEqual(original.socket.messages.at(-1), { type: 'replaced' });
  assert.deepEqual(middle.socket.messages.at(-1), { type: 'replaced' });
  assert.equal(original.socket.closed, false);
  assert.equal(middle.socket.closed, false);
  assert.equal(context.pendingTasks.length, 2);
  await Promise.all(context.pendingTasks);
  assert.equal(original.socket.closed, true);
  assert.equal(middle.socket.closed, true);
  assert.equal(latest.socket.closed, false);
  assert.equal(room.snapshot().count, 1);
  assert.equal(room.members.get(original.token).connectionId, latest.welcome.connectionId);
  assert.equal(room.members.get(original.token).until, null);
});

test('unexpected disconnection reserves once, reconnects with the same ball and seat, and alarm expires the reservation', async t => {
  let now = 100_000;
  t.mock.method(Date, 'now', () => now);
  const { room, context } = makeRoom();
  const visitor = await connect(room);
  visitor.socket.closed = true;
  await room.webSocketError(visitor.socket);
  assert.equal(room.members.get(visitor.token).until, now + RECONNECT_MS);
  assert.equal(context.alarmAt, now + RECONNECT_MS);
  assert.equal(room.snapshot().members[0].reconnecting, true);
  now += 5_000;
  await room.webSocketClose(visitor.socket, 1006, '');
  assert.equal(room.members.get(visitor.token).until, 130_000);
  const reconnected = await connect(room, visitor.token);
  assert.deepEqual(reconnected.welcome.you, visitor.welcome.you);
  assert.equal(context.alarmAt, null);
  reconnected.socket.closed = true;
  await room.webSocketClose(reconnected.socket, 1006, '');
  now += RECONNECT_MS - 1;
  await room.alarm();
  assert.equal(room.snapshot().count, 1);
  now += 1;
  await room.alarm();
  assert.equal(room.snapshot().count, 0);
  assert.equal(context.alarmAt, null);
});

test('a normal explicit close releases immediately and a disconnected visitor can leave over HTTP', async () => {
  const { room, context } = makeRoom();
  const visitor = await connect(room);
  await room.webSocketClose(visitor.socket, 1000, 'Visitor left');
  assert.equal(room.snapshot().count, 0);
  const disconnected = await connect(room);
  disconnected.socket.closed = true;
  await room.webSocketError(disconnected.socket);
  const response = await room.fetch(leaveRequest(disconnected.token, disconnected.welcome.connectionId));
  assert.equal(response.status, 200);
  assert.equal(room.snapshot().count, 0);
  assert.equal(context.alarmAt, null);
});

test('restoring from storage retains live sockets and reserves missing sockets for thirty seconds', async t => {
  t.mock.method(Date, 'now', () => 200_000);
  const original = makeRoom().room;
  const live = await connect(original);
  const missing = await connect(original);
  const { room, context } = makeRoom({ members: Object.fromEntries(original.members) }, [live.socket]);
  await room.ready;
  assert.equal(room.members.get(live.token).until, null);
  assert.equal(room.members.get(missing.token).until, 230_000);
  assert.equal(context.alarmAt, 230_000);
  assert.equal(room.snapshot().count, 2);
});
