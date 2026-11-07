import { DurableObject } from 'cloudflare:workers';
import { CAPACITY, RECONNECT_MS, ROOM_IDS, isRoomId, BALL_COUNT, allowedModes, defaultMode, nextSeat, canAdmit, publicMember, expiredTokens } from './rules.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});

function roomStub(env, room) {
  return env.ROOM.get(env.ROOM.idFromName(`v1:${room}`));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/dream-room') {
      url.pathname = '/dream-room/';
      return Response.redirect(url.href, 308);
    }
    if (url.pathname.startsWith('/dream-room/')) {
      url.pathname = url.pathname.slice('/dream-room'.length);
      request = new Request(url, request);
    }
    if (url.pathname === '/api/rooms') {
      const statuses = await Promise.all(ROOM_IDS.map(async room => {
        const res = await roomStub(env, room).fetch('https://internal/status');
        const data = await res.json();
        return [room, data];
      }));
      return json(Object.fromEntries(statuses));
    }
    if (url.pathname === '/api/leave' && request.method === 'POST') {
      // An explicit leave can also be sent after a WebSocket was interrupted.
      let body;
      try { body = await request.json(); } catch (_) { return json({ error: 'Invalid JSON' }, 400); }
      const room = body?.room;
      const token = body?.token;
      if (!isRoomId(room) || typeof token !== 'string' || !/^[a-f0-9-]{36}$/.test(token)) {
        return json({ error: 'Invalid room or token' }, 400);
      }
      return roomStub(env, room).fetch('https://internal/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, connectionId: body.connectionId })
      });
    }
    if (url.pathname === '/api/connect') {
      const room = url.searchParams.get('room');
      if (!isRoomId(room)) return json({ error: 'Unknown room' }, 404);
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return json({ error: 'WebSocket required' }, 426);
      }
      const headers = new Headers(request.headers);
      headers.set('X-Dream-Room', room);
      return roomStub(env, room).fetch(new Request(request, { headers }));
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    // HTML handling is disabled so asset redirects cannot escape /dream-room/.
    // Resolve the entry explicitly while retaining the method, headers and query.
    if (url.pathname === '/') {
      url.pathname = '/index.html';
      request = new Request(url, request);
    }
    return env.ASSETS.fetch(request);
  }
};

export class DreamRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.members = new Map();
    this.lock = Promise.resolve();
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get('members');
      this.members = new Map(Object.entries(saved || {}));
      // If the runtime hibernates, connected sockets survive and can be recovered.
      const active = new Set(ctx.getWebSockets().map(ws => ws.deserializeAttachment()?.connectionId));
      const now = Date.now();
      let changed = false;
      for (const [token, member] of this.members) {
        if (member.until !== null && member.until <= now) {
          this.members.delete(token);
          changed = true;
        } else if (member.until === null && !active.has(member.connectionId)) {
          // Unclean interruption: reserve a reconnect window.
          member.until = now + RECONNECT_MS;
          changed = true;
        }
      }
      if (changed) await this.save();
      await this.updateAlarm();
      try {
        ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('__ping__', '__pong__'));
      } catch (_) { /* not available in some local runtimes */ }
    });
  }

  async exclusive(operation) {
    const current = this.lock.then(async () => { await this.ready; return operation(); });
    this.lock = current.catch(() => {});
    return current;
  }

  async save() {
    await this.ctx.storage.put('members', Object.fromEntries(this.members));
  }

  async updateAlarm() {
    const untils = [...this.members.values()].map(m => m.until).filter(x => Number.isFinite(x));
    if (untils.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, Math.min(...untils)));
    else await this.ctx.storage.deleteAlarm();
  }

  async prune() {
    const now = Date.now();
    let changed = false;
    for (const token of expiredTokens(this.members, now)) {
      this.members.delete(token);
      changed = true;
    }
    if (changed) {
      await this.save();
      await this.updateAlarm();
      this.broadcast();
    }
  }

  snapshot() {
    return { type: 'state', count: this.members.size, capacity: CAPACITY,
      members: [...this.members.values()].map(publicMember) };
  }

  broadcast() {
    const data = JSON.stringify(this.snapshot());
    for (const ws of this.ctx.getWebSockets()) {
      const auth = ws.deserializeAttachment();
      if (auth && this.members.get(auth.token)?.connectionId === auth.connectionId) {
        try { ws.send(data); } catch (_) { /* close handler cleans it */ }
      }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/status') {
      return this.exclusive(async () => {
        await this.prune();
        return json({ count: this.members.size, capacity: CAPACITY });
      });
    }
    if (url.pathname === '/leave' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (_) { return json({ error: 'Invalid JSON' }, 400); }
      const token = body?.token;
      const connectionId = body?.connectionId;
      if (typeof token !== 'string' || !/^[a-f0-9-]{36}$/.test(token) || typeof connectionId !== 'string') {
        return json({ error: 'Invalid token' }, 400);
      }
      return this.exclusive(async () => {
        await this.prune();
        const member = this.members.get(token);
        if (!member || member.connectionId !== connectionId) return json({ left: true });
        this.members.delete(token);
        for (const socket of this.ctx.getWebSockets()) {
          if (socket.deserializeAttachment()?.token === token) {
            try { socket.close(1000, 'Visitor left'); } catch (_) {}
          }
        }
        await this.save();
        await this.updateAlarm();
        this.broadcast();
        return json({ left: true });
      });
    }
    const room = request.headers.get('X-Dream-Room');
    if (!isRoomId(room)) return json({ error: 'Invalid room' }, 400);
    const token = url.searchParams.get('token');
    if (!token || !/^[a-f0-9-]{36}$/.test(token)) return json({ error: 'Invalid token' }, 400);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket required' }, 426);
    return this.exclusive(async () => {
      await this.prune();
      const [client, server] = Object.values(new WebSocketPair());
      if (!canAdmit(this.members, token)) {
        // A rejected connection has no member or attachment to recover. Keep
        // its short closing handshake outside the room's hibernating sockets.
        server.accept();
        server.addEventListener('close', event => {
          try { server.close(event.code, event.reason); } catch (_) { /* already gone */ }
        });
        server.send(JSON.stringify({ type: 'full', message: '這座島暫時住滿了，請稍後再來。' }));
        server.close(1008, 'Room full');
        return new Response(null, { status: 101, webSocket: client });
      }
      this.ctx.acceptWebSocket(server);
      let member = this.members.get(token);
      // Existing visitor, e.g. page refresh within 30s: keep same ball & seat.
      if (member) {
        for (const ws of this.ctx.getWebSockets()) {
          const old = ws.deserializeAttachment();
          if (old?.token === token && old.connectionId === member.connectionId) {
            // Let the old client stop its sound/retries and initiate the close.
            // A bounded fallback captures this old socket, never its successor.
            try { ws.send(JSON.stringify({ type: 'replaced' })); } catch (_) {}
            this.ctx.waitUntil(new Promise(resolve => {
              setTimeout(() => {
                try { ws.close(1000, 'Replaced by another tab'); } catch (_) {}
                resolve();
              }, 250);
            }));
          }
        }
      } else {
        member = {
          id: crypto.randomUUID(),
          ball: Math.floor(Math.random() * BALL_COUNT),
          seat: nextSeat(this.members),
          mode: defaultMode(room),
          room,
          connectionId: null,
          until: null
        };
      }
      // The front Worker validates and supplies the room name.
      member.connectionId = crypto.randomUUID();
      member.until = null;
      this.members.set(token, member);
      server.serializeAttachment({ token, connectionId: member.connectionId });
      await this.save();
      await this.updateAlarm();
      server.send(JSON.stringify({ type: 'welcome', you: publicMember(member), connectionId: member.connectionId, capacity: CAPACITY }));
      this.broadcast();
      return new Response(null, { status: 101, webSocket: client });
    });
  }

  async webSocketMessage(ws, message) {
    if (message === '__ping__') return;
    return this.exclusive(async () => {
      const auth = ws.deserializeAttachment();
      const member = auth && this.members.get(auth.token);
      if (!member || member.connectionId !== auth.connectionId) return;
      let data;
      try { data = JSON.parse(message); } catch (_) { return; }
      if (data?.type === 'leave') {
        this.members.delete(auth.token);
        await this.save();
        await this.updateAlarm();
        this.broadcast();
        try { ws.close(1000, 'Left room'); } catch (_) {}
      } else if (data?.type === 'mode') {
        const room = data.room;
        const allowed = allowedModes(room);
        if (allowed.includes(data.value)) {
          // Validate against stored room, not only client claim.
          const actualRoom = member.room;
          if (actualRoom === room) {
            member.mode = data.value;
            await this.save();
            this.broadcast();
          }
        }
      }
    });
  }

  async disconnect(ws) {
    return this.exclusive(async () => {
      const auth = ws.deserializeAttachment();
      const member = auth && this.members.get(auth.token);
      if (!member || member.connectionId !== auth.connectionId) return;
      // Error and close events can describe the same interruption. Keep the
      // deadline from the first event instead of extending the reserved seat.
      if (member.until !== null) return;
      member.until = Date.now() + RECONNECT_MS;
      await this.save();
      await this.updateAlarm();
      this.broadcast();
    });
  }

  async webSocketClose(ws, code, reason) {
    // Finish the closing handshake even for rejected or superseded sockets,
    // which have no current member to clean up. Newer runtimes also auto-reply;
    // an explicit reply is safe there and keeps the handler self-contained.
    try { ws.close(code, reason); } catch (_) { /* already gone / unsendable close code */ }
    // The browser deliberately leaving must free its seat *now*, rather than
    // spending 30 seconds in reconnect mode. Refresh / network loss reserves it.
    if (code === 1000 && reason === 'Visitor left') {
      return this.exclusive(async () => {
        const auth = ws.deserializeAttachment();
        const member = auth && this.members.get(auth.token);
        if (!member || member.connectionId !== auth.connectionId) return;
        this.members.delete(auth.token);
        await this.save();
        await this.updateAlarm();
        this.broadcast();
      });
    }
    return this.disconnect(ws);
  }
  async webSocketError(ws) { return this.disconnect(ws); }
  async alarm() {
    return this.exclusive(async () => {
      await this.prune();
      await this.updateAlarm();
    });
  }
}
