import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

// Exercise the real front Worker, replacing only Cloudflare's unavailable base
// class. No room admission, WebSocket, or routing algorithm is reproduced here.
const workerSource = (await readFile(new URL('../src/index.js', import.meta.url), 'utf8'))
  .replace("import { DurableObject } from 'cloudflare:workers';", 'class DurableObject {}')
  .replace("'./rules.js'", JSON.stringify(new URL('../src/rules.js', import.meta.url).href));
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}`);

function environment() {
  const roomCalls = [];
  const assets = [];
  const env = {
    ROOM: {
      idFromName(name) { return name; },
      get(id) {
        return { async fetch(input, init) {
          const request = input instanceof Request ? input : new Request(input, init);
          roomCalls.push({ id, request });
          return Response.json(new URL(request.url).pathname === '/status'
            ? { count: id === 'v1:dream-a' ? 3 : 1, capacity: 10 }
            : { forwarded: true });
        } };
      }
    },
    ASSETS: { async fetch(request) { assets.push(request); return new Response('asset'); } }
  };
  return { env, roomCalls, assets };
}

test('subpath entry redirects to its canonical trailing slash and retains query', async () => {
  const state = environment();
  const response = await worker.fetch(new Request('https://example.test/dream-room?room=dream-a&via=a%2Fb'), state.env);
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), 'https://example.test/dream-room/?room=dream-a&via=a%2Fb');
  assert.equal(state.roomCalls.length, 0);
  assert.equal(state.assets.length, 0);
});

test('root and prefixed room APIs resolve the same independent room objects', async () => {
  for (const prefix of ['', '/dream-room']) {
    const state = environment();
    const response = await worker.fetch(new Request(`https://example.test${prefix}/api/rooms`), state.env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      'dream-a': { count: 3, capacity: 10 }, 'dream-b': { count: 1, capacity: 10 }
    });
    assert.deepEqual(state.roomCalls.map(call => call.id), ['v1:dream-a', 'v1:dream-b']);
    assert(state.roomCalls.every(call => call.request.url === 'https://internal/status'));
    assert.equal(state.assets.length, 0);
  }
});

test('prefixed connect reaches the selected room with original query and upgrade headers', async () => {
  const state = environment();
  const token = randomUUID();
  const response = await worker.fetch(new Request(`https://example.test/dream-room/api/connect?room=dream-b&token=${token}&via=a%2Fb`, {
    headers: { Upgrade: 'websocket', 'X-Test-Marker': 'preserved' }
  }), state.env);
  assert.deepEqual(await response.json(), { forwarded: true });
  assert.equal(state.roomCalls.length, 1);
  const { id, request } = state.roomCalls[0];
  assert.equal(id, 'v1:dream-b');
  assert.equal(request.url, `https://example.test/api/connect?room=dream-b&token=${token}&via=a%2Fb`);
  assert.equal(request.method, 'GET');
  assert.equal(request.headers.get('Upgrade'), 'websocket');
  assert.equal(request.headers.get('X-Test-Marker'), 'preserved');
  assert.equal(request.headers.get('X-Dream-Room'), 'dream-b');
  assert.equal(state.assets.length, 0);
});

test('prefixed POST leave retains its body and connection ownership', async () => {
  const state = environment();
  const body = { room: 'dream-a', token: randomUUID(), connectionId: randomUUID() };
  const response = await worker.fetch(new Request('https://example.test/dream-room/api/leave', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }), state.env);
  assert.deepEqual(await response.json(), { forwarded: true });
  assert.equal(state.roomCalls.length, 1);
  assert.equal(state.roomCalls[0].id, 'v1:dream-a');
  assert.equal(state.roomCalls[0].request.url, 'https://internal/leave');
  assert.equal(state.roomCalls[0].request.method, 'POST');
  assert.deepEqual(await state.roomCalls[0].request.json(), { token: body.token, connectionId: body.connectionId });
});

test('prefixed page and assets are forwarded using the stripped Request', async () => {
  for (const [suffix, expected] of [
    ['/', '/'],
    ['/styles.css?theme=night', '/styles.css?theme=night'],
    ['/assets/ball-1.png?version=2', '/assets/ball-1.png?version=2'],
    ['/audio-engine.js', '/audio-engine.js']
  ]) {
    const state = environment();
    const response = await worker.fetch(new Request(`https://example.test/dream-room${suffix}`, {
      method: 'HEAD', headers: { 'X-Test-Marker': 'asset' }
    }), state.env);
    assert.equal(response.status, 200);
    assert.equal(state.assets.length, 1);
    assert.equal(state.assets[0].url, `https://example.test${expected}`);
    assert.equal(state.assets[0].method, 'HEAD');
    assert.equal(state.assets[0].headers.get('X-Test-Marker'), 'asset');
    assert.equal(state.roomCalls.length, 0);
  }
});

test('similar prefixes and encoded separators do not become room API routes', async () => {
  for (const [input, expected] of [
    ['/dream-room-evil/api/rooms', '/dream-room-evil/api/rooms'],
    ['/dream-roomish/api/rooms', '/dream-roomish/api/rooms'],
    ['/dream-room%2Fapi/rooms', '/dream-room%2Fapi/rooms'],
    ['/dream-room%5Capi/rooms', '/dream-room%5Capi/rooms'],
    ['/dream-room/%5Capi/rooms', '/%5Capi/rooms'],
    ['/dream-room//elsewhere.invalid/api/rooms', '//elsewhere.invalid/api/rooms'],
    ['/dream-room/https://elsewhere.invalid/api/rooms', '/https://elsewhere.invalid/api/rooms'],
    // Fetch/URL normalizes literal backslashes before the Worker receives them.
    // An unrelated prefix must remain unrelated after that normalization, too.
    [String.raw`/dream-room-evil\api\rooms`, '/dream-room-evil/api/rooms']
  ]) {
    const state = environment();
    const response = await worker.fetch(new Request(`https://example.test${input}`), state.env);
    assert.equal(response.status, 200);
    assert.equal(state.roomCalls.length, 0, input);
    assert.equal(state.assets.length, 1, input);
    assert.equal(state.assets[0].url, `https://example.test${expected}`, input);
    assert.equal(new URL(state.assets[0].url).origin, 'https://example.test', input);
  }
});

test('unknown prefixed API stays 404 while root assets and root APIs remain available', async () => {
  const state = environment();
  assert.equal((await worker.fetch(new Request('https://example.test/dream-room/api/unknown'), state.env)).status, 404);
  assert.equal(state.assets.length, 0);
  assert.equal(state.roomCalls.length, 0);
  await worker.fetch(new Request('https://example.test/assets/ball-1.png?root=1'), state.env);
  assert.equal(state.assets[0].url, 'https://example.test/assets/ball-1.png?root=1');
});

const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
function actualClientFunction(name) {
  const marker = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(appSource);
  assert(marker, `Actual function ${name} must exist`);
  const remainder = appSource.slice(marker.index + marker[0].length);
  const following = /^(?:async )?function\s/m.exec(remainder);
  assert(following, `Actual function ${name} needs a clear boundary`);
  return appSource.slice(marker.index, marker.index + marker[0].length + following.index);
}

test('client actual asset, icon, room-list, connect and leave paths follow root or canonical subpath', async () => {
  assert.match(appSource, /^import \{ createAmbientBuffer \} from '\.\/audio-engine\.js';/);
  const header = appSource.slice(0, appSource.indexOf('const SEATS =')).replace(/^import[^\n]*\n/gm, '');
  const functions = ['setButtonIcon', 'socketUrl', 'refreshCounts', 'sendExplicitLeave'].map(actualClientFunction).join('\n');
  for (const [href, base] of [
    ['http://127.0.0.1:8787/?entry=1', 'http://127.0.0.1:8787/'],
    ['https://example.test/dream-room/?entry=1', 'https://example.test/dream-room/'],
    ['https://example.test/dream-room/index.html?entry=1', 'https://example.test/dream-room/']
  ]) {
    const calls = [];
    const nodes = new Map();
    const element = () => ({
      attributes: new Map(), children: [], classList: { toggle() {} },
      setAttribute(key, value) { this.attributes.set(key, value); },
      append(child) { this.children.push(child); },
      replaceChildren(...children) { this.children = children; }
    });
    const button = element();
    // 球圖依螢幕挑手機或電腦柔邊版；用可切換的替身檢查兩種路徑。
    const media = { phone: false };
    const context = vm.createContext({
      URL, AbortController, setTimeout, clearTimeout, location: new URL(href), button,
      matchMedia: query => ({ get matches() { return query.includes('max-width: 900px') ? media.phone : false; } }),
      document: {
        hidden: false,
        createElementNS() { return element(); },
        querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); }
      },
      async fetch(url, options) {
        calls.push({ url: String(url), options });
        return Response.json({ 'dream-a': { count: 1 }, 'dream-b': { count: 0 } });
      }
    });
    const token = randomUUID();
    vm.runInContext(`${header}\nconst token = ${JSON.stringify(token)}; let room = null; let countsRequest = null;\n${functions}`, context);
    for (const [phone, tag] of [[false, 'd'], [true, 'p']]) {
      media.phone = phone;
      assert.deepEqual([0, 1, 2, 3].map(index => vm.runInContext(`ballUrl(${index})`, context)), [1, 2, 3, 4].map(number => `${base}assets/ball-${number}-soft-${tag}.png`));
      assert.equal(vm.runInContext('ballUrl(undefined)', context), `${base}assets/ball-1-soft-${tag}.png`);
    }
    vm.runInContext("setButtonIcon(button, 'float', '漂浮')", context);
    assert.equal(button.children[0].children[0].attributes.get('href'), `${base}assets/controls-icons.svg#icon-float`);
    const socket = new URL(vm.runInContext("socketUrl('dream-a')", context));
    assert.equal(socket.protocol, base.startsWith('https:') ? 'wss:' : 'ws:');
    assert.equal(socket.pathname, new URL('api/connect', base).pathname);
    assert.equal(socket.host, new URL(base).host);
    assert.equal(socket.searchParams.get('token'), token);
    assert.equal(socket.searchParams.get('room'), 'dream-a');
    await vm.runInContext('refreshCounts()', context);
    assert.equal(calls[0].url, `${base}api/rooms`);
    vm.runInContext("sendExplicitLeave('dream-a', 'owned-connection')", context);
    assert.equal(calls[1].url, `${base}api/leave`);
    assert.equal(calls[1].options.method, 'POST');
    assert.equal(calls[1].options.keepalive, true);
    assert.deepEqual(JSON.parse(calls[1].options.body), { room: 'dream-a', token, connectionId: 'owned-connection' });
  }
});
