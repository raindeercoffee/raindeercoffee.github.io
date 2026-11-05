import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Run against an already-started local Wrangler Worker. Never targets deployment.
const BASE = new URL(process.env.BASE_URL || 'http://127.0.0.1:8787');
assert(['http:', 'https:'].includes(BASE.protocol), 'BASE_URL 必須使用 HTTP');
assert(['localhost', '127.0.0.1', '[::1]'].includes(BASE.hostname), '只容許本機網址，禁止測試正式站');
assert(!BASE.username && !BASE.password, '網址不可包含帳密');
// Resolve the accepted localhost spelling to a literal loopback address, too.
if (BASE.hostname === 'localhost') BASE.hostname = '127.0.0.1';
assert(Number(process.versions.node.split('.')[0]) >= 24, '請使用 Node.js 24 或更新版本');
const args = process.argv.slice(2);
assert(args.every(arg => arg === '--slow'), '唯一選項是 --slow（加測30秒後過期）');
const RUN_SLOW = args.includes('--slow');
const ROOMS = ['dream-a', 'dream-b'];
const TIMEOUT = 8_000;
const clients = [];
const tokens = new Set();
let started = false;

async function request(path, options = {}) {
  const response = await fetch(new URL(path, BASE), {
    ...options, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT)
  });
  assert.equal(response.status, 200, `${path} 回應 ${response.status}`);
  return response.json();
}

async function status() {
  const result = await request('/api/rooms');
  assert.deepEqual(Object.keys(result).sort(), [...ROOMS].sort(), '房間入口必須只有兩間陪睡房');
  for (const room of ROOMS) {
    assert.equal(result[room].capacity, 10, `${room} 容量錯誤`);
    assert(Number.isInteger(result[room].count) && result[room].count >= 0 && result[room].count <= 10,
      `${room} 人數必須介於0與10`);
  }
  return result;
}

async function counts(a, b) {
  const result = await status();
  assert.equal(result['dream-a'].count, a, '夜潮人數錯誤');
  assert.equal(result['dream-b'].count, b, '霧藍人數錯誤');
}

function validateState(message) {
  if (message.type !== 'state') return;
  assert.equal(message.capacity, 10);
  assert(Array.isArray(message.members), '公開狀態必須包含訪客清單');
  assert.equal(message.count, message.members.length);
  assert(message.count <= 10 && message.count >= 0, '公開狀態不可超額');
  assert.equal(new Set(message.members.map(member => member.id)).size, message.count, '訪客不可重複');
  assert.equal(new Set(message.members.map(member => member.seat)).size, message.count, '座位不可重複');
  for (const member of message.members) {
    assert(Number.isInteger(member.seat) && member.seat >= 0 && member.seat < 10, '座位範圍錯誤');
    assert(Number.isInteger(member.ball) && member.ball >= 0 && member.ball < 4, '球款範圍錯誤');
    assert(['sleep', 'float'].includes(member.mode), '公開姿態錯誤');
    assert.equal(typeof member.reconnecting, 'boolean');
  }
  function noSecrets(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      assert(!['token', 'connectionId', 'until'].includes(key), `公開狀態洩漏 ${key}`);
      noSecrets(entry);
    }
  }
  noSecrets(message);
  const serialized = JSON.stringify(message);
  for (const token of tokens) assert(!serialized.includes(token), '私密憑證不可出現在公開狀態');
}

class Visitor {
  constructor(room, token = randomUUID()) {
    this.room = room;
    this.token = token;
    tokens.add(token);
    this.messages = [];
    this.waiters = new Set();
    this.failure = null;
    this.closed = null;
    this.welcome = null;
    const url = new URL('/api/connect', BASE);
    url.protocol = BASE.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('room', room);
    url.searchParams.set('token', token);
    this.socket = new WebSocket(url);
    clients.push(this);
    this.socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(event.data);
        validateState(message);
        this.messages.push(message);
        if (message.type === 'welcome') this.welcome = message;
        if (message.type === 'replaced') {
          // Follow the real browser protocol: relinquish only this transport.
          // Sending leave here could incorrectly remove the replacement owner.
          this.socket.close(1000, 'Replaced by another tab');
        }
      } catch (error) { this.failure ||= error; }
      this.notify();
    });
    this.socket.addEventListener('close', event => {
      this.closed = { code: event.code, reason: event.reason, wasClean: event.wasClean };
      this.notify();
    });
    this.socket.addEventListener('error', () => {
      this.failure ||= new Error(`${room} WebSocket連線失敗`);
      this.notify();
    });
  }

  notify() { for (const waiter of [...this.waiters]) waiter(); }
  mark() { return this.messages.length; }
  diagnostic() {
    return JSON.stringify({ room: this.room, memberId: this.welcome?.you?.id,
      readyState: this.socket.readyState, close: this.closed });
  }

  wait(predicate, label, { after = 0, timeout = TIMEOUT, allowClosed = false } = {}) {
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error, value) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        error ? reject(error) : resolve(value);
      };
      const check = () => {
        if (this.failure) return finish(this.failure);
        const found = this.messages.slice(after).find(predicate);
        if (found) return finish(null, found);
        if (this.closed && !allowClosed) return finish(new Error(`${label}：連線已關閉 ${this.diagnostic()}`));
      };
      this.waiters.add(check);
      timer = setTimeout(() => finish(new Error(`${label}：超過${timeout}毫秒`)), timeout);
      check();
    });
  }

  async admitted() {
    const result = await this.wait(message => ['welcome', 'full'].includes(message.type), '等待入場');
    assert.equal(result.type, 'welcome', `${this.room} 應該可以入場`);
    assert.equal(result.capacity, 10);
    assert.equal(typeof result.connectionId, 'string', '入場必須取得連線識別碼');
    assert(['sleep', 'float'].includes(result.you.mode), '入場姿態必須有效');
    return this;
  }

  send(message) {
    assert.equal(this.socket.readyState, WebSocket.OPEN, `傳送訊息時連線必須開啟 ${this.diagnostic()}`);
    this.socket.send(JSON.stringify(message));
  }

  state(predicate, label, options) {
    return this.wait(message => message.type === 'state' && predicate(message), label, options);
  }

  async closeObserved(label = '等待連線關閉') {
    const deadline = Date.now() + TIMEOUT;
    while (!this.closed && Date.now() < deadline) await delay(20);
    assert(this.closed, `${label}逾時 ${this.diagnostic()}`);
    if (this.failure) throw this.failure;
    return this.closed;
  }
}

async function enter(room, token) { return new Visitor(room, token).admitted(); }

async function rejected(room) {
  const visitor = new Visitor(room);
  const result = await visitor.wait(message => ['welcome', 'full'].includes(message.type), '第11人應被拒絕');
  assert.equal(result.type, 'full', '滿員時不可再收到入場成功');
  const close = await visitor.closeObserved();
  assert.equal(close.code, 1008, '滿員連線應以政策拒絕關閉');
  assert(!visitor.welcome, '被拒絕者不可取得席位');
}

function sameIdentity(before, after) {
  for (const key of ['id', 'ball', 'seat']) assert.equal(after[key], before[key], `重連必須保留${key}`);
}

async function postLeave(visitor) {
  assert(visitor.welcome?.connectionId, '離開清理必須使用已知連線識別碼');
  const result = await request('/api/leave', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: visitor.room, token: visitor.token, connectionId: visitor.welcome.connectionId })
  });
  assert.equal(result.left, true, '離開介面必須確認完成');
}

async function cleanup() {
  const errors = [];
  // Let explicit leave finish its own closing handshake before HTTP cleanup.
  // Sending leave, close, and HTTP leave at once races three shutdown paths.
  // Stale connection IDs still cannot remove new owners.
  for (const visitor of clients) {
    try {
      if (visitor.socket.readyState === WebSocket.OPEN) {
        visitor.socket.send(JSON.stringify({ type: 'leave' }));
      } else if (visitor.socket.readyState === WebSocket.CONNECTING) {
        visitor.socket.close();
      }
    } catch (error) { errors.push(error); }
  }
  const closing = await Promise.allSettled(clients.map(visitor => visitor.closeObserved('清理連線')));
  for (const result of closing) if (result.status === 'rejected') errors.push(result.reason);
  const results = await Promise.allSettled(clients.filter(visitor => visitor.welcome).map(postLeave));
  for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
  for (const visitor of clients) if (visitor.failure && !errors.includes(visitor.failure)) errors.push(visitor.failure);
  clients.length = 0;
  if (started) {
    try { await counts(0, 0); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, '清理未完全成功');
}

async function fastChecks() {
  // Concurrent attempts exercise admission serialization in both real objects.
  const admissions = await Promise.allSettled(ROOMS.flatMap(room => Array.from({ length: 10 }, () => enter(room))));
  const failures = admissions.filter(result => result.status === 'rejected').map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, '同時入場失敗');
  const all = admissions.map(result => result.value);
  const a = all.filter(visitor => visitor.room === 'dream-a');
  const b = all.filter(visitor => visitor.room === 'dream-b');
  for (const visitor of all) assert.equal(visitor.welcome.you.mode, 'sleep', '新訪客預設躺下');
  await Promise.all([a[0].state(s => s.count === 10, '夜潮10人同步'), b[0].state(s => s.count === 10, '霧藍10人同步')]);
  await counts(10, 10);
  await Promise.all(ROOMS.map(rejected));
  await counts(10, 10);
  console.log('通過：兩房同時各10人，第11人皆拒絕。');

  let markA = a[1].mark();
  const markB = b[1].mark();
  a[0].send({ type: 'mode', room: 'dream-a', value: 'float' });
  const stateA = await a[1].state(s => s.members.some(m => m.id === a[0].welcome.you.id && m.mode === 'float'), '夜潮姿態同步', { after: markA });
  assert(!stateA.members.some(m => m.id === b[0].welcome.you.id), '房間訪客不可混在一起');
  b[0].send({ type: 'mode', room: 'dream-b', value: 'float' });
  const stateB = await b[1].state(s => s.members.some(m => m.id === b[0].welcome.you.id && m.mode === 'float'), '霧藍姿態同步', { after: markB });
  assert(!stateB.members.some(m => m.id === a[0].welcome.you.id), '房間訪客不可混在一起');
  assert(stateB.members.filter(m => m.id !== b[0].welcome.you.id).every(m => m.mode === 'sleep'), '夜潮姿態不可影響霧藍');
  markA = a[1].mark();
  a[0].send({ type: 'mode', room: 'dream-b', value: 'sleep' });
  a[0].send({ type: 'mode', room: 'dream-a', value: 'invalid-mode' });
  // A valid update acts as a same-socket ordering barrier for invalid requests.
  a[0].send({ type: 'mode', room: 'dream-a', value: 'float' });
  await a[1].state(s => s.members.some(m => m.id === a[0].welcome.you.id && m.mode === 'float'), '姿態檢查屏障', { after: markA });
  for (const state of a[1].messages.slice(markA).filter(message => message.type === 'state')) {
    assert.equal(state.members.find(m => m.id === a[0].welcome.you.id).mode, 'float', '錯誤房間或姿態不得改動自己');
  }
  const beforeFloat = a[1].mark();
  a[2].send({ type: 'mode', room: 'dream-a', value: 'float' });
  await a[1].state(s => s.members.some(m => m.id === a[2].welcome.you.id && m.mode === 'float'), '準備保留姿態驗收', { after: beforeFloat });
  console.log('通過：兩房姿態同步、訪客隔離、錯誤姿態拒絕、公開狀態無私密憑證。');

  markA = a[1].mark();
  a[0].send({ type: 'leave' });
  await a[1].state(s => s.count === 9, '主動離開立即釋位', { after: markA });
  await a[0].closeObserved();
  await counts(9, 10);
  a[0] = await enter('dream-a');
  await counts(10, 10);
  const markPost = b[1].mark();
  await postLeave(b[0]);
  await b[1].state(s => s.count === 9, '離開介面立即釋位', { after: markPost });
  await counts(10, 9);
  b[0] = await enter('dream-b');
  await counts(10, 10);
  console.log('通過：訊息離開與離開介面均立即釋位，可立刻補人。');

  const interrupted = a[2];
  markA = a[1].mark();
  interrupted.socket.close(4001, 'Simulated network interruption');
  await interrupted.closeObserved();
  await a[1].state(s => s.count === 10 && s.members.some(m => m.id === interrupted.welcome.you.id && m.reconnecting), '意外斷線保留席位', { after: markA });
  await counts(10, 10);
  await rejected('dream-a');
  a[2] = await enter('dream-a', interrupted.token);
  sameIdentity(interrupted.welcome.you, a[2].welcome.you);
  assert.equal(a[2].welcome.you.mode, 'float', '重連必須保留姿態');
  assert.equal(a[2].welcome.you.reconnecting, false);
  await counts(10, 10);
  console.log('通過：異常斷線仍佔席，30秒內同憑證重連保留球、座位和姿態。');

  const old = a[3];
  markA = a[1].mark();
  a[3] = await enter('dream-a', old.token);
  sameIdentity(old.welcome.you, a[3].welcome.you);
  assert.notEqual(a[3].welcome.connectionId, old.welcome.connectionId);
  const notice = await old.wait(message => message.type === 'replaced', '舊分頁必須收到接管通知');
  assert.equal(notice.type, 'replaced');
  const replaced = await old.closeObserved('舊分頁必須被接管');
  assert.equal(replaced.code, 1000);
  assert.equal(replaced.reason, 'Replaced by another tab', '接管必須以指定原因正常關閉');
  await a[1].state(s => s.count === 10 && s.members.filter(m => m.id === old.welcome.you.id).length === 1, '接管只保留一席', { after: markA });
  await postLeave(old);
  await counts(10, 10);
  const afterStale = a[1].mark();
  a[3].send({ type: 'mode', room: 'dream-a', value: 'float' });
  await a[1].state(s => s.count === 10 && s.members.some(m => m.id === old.welcome.you.id && m.mode === 'float'), '舊連線離開不可移除新連線', { after: afterStale });
  console.log('通過：同憑證新分頁接管，舊連線離開請求不能移除新席位。');
}

async function slowChecks() {
  const observer = await enter('dream-a');
  const interrupted = await enter('dream-a');
  const mark = observer.mark();
  interrupted.socket.close(4001, 'Simulated network interruption');
  await interrupted.closeObserved();
  await observer.state(s => s.count === 2 && s.members.some(m => m.id === interrupted.welcome.you.id && m.reconnecting), '等待斷線保留', { after: mark });
  const reservedAt = Date.now();
  const expiryState = observer.state(s => s.count === 1 && !s.members.some(m => m.id === interrupted.welcome.you.id), '30秒後自動推播清位', { after: mark, timeout: 38_000 });
  // Register a handler now to avoid an unhandled rejection during the timed wait.
  const expiryOutcome = expiryState.then(value => ({ value }), error => ({ error }));
  await delay(27_000);
  await counts(2, 0);
  const latest = observer.messages.filter(message => message.type === 'state').at(-1);
  assert(latest.members.some(member => member.id === interrupted.welcome.you.id && member.reconnecting), '30秒前不可提早清位');
  const outcome = await expiryOutcome;
  if (outcome.error) throw outcome.error;
  assert(Date.now() - reservedAt >= 29_000, '斷線保留時間不可明顯少於30秒');
  await counts(1, 0);
  console.log('通過：斷線27秒仍保留，約30秒後自動推播清位。');
}

async function main() {
  let failure;
  try {
    await counts(0, 0);
    started = true;
    console.log(`本機連線驗收：${BASE.origin}；${RUN_SLOW ? '包含30秒過期組' : '一般組（未加測30秒過期）'}`);
    await fastChecks();
    await cleanup();
    if (RUN_SLOW) await slowChecks();
  } catch (error) { failure = error; }
  finally {
    try { await cleanup(); }
    catch (error) { failure = failure ? new AggregateError([failure, error], '驗收失敗且清理失敗') : error; }
  }
  if (failure) throw failure;
  console.log(`全部所選驗收通過，兩房已清空。${RUN_SLOW ? '' : '30秒後過期尚未執行，請加 --slow。'}`);
}

function reportError(error, label = '驗收失敗') {
  // Explicitly walk aggregates/causes so console inspection depth cannot hide
  // the original failure behind a second failure in finally cleanup.
  console.error(`${label}：${error?.stack || String(error)}`);
  if (error?.errors) error.errors.forEach((entry, index) => reportError(entry, `${label}／子錯誤${index + 1}`));
  if (error?.cause) reportError(error.cause, `${label}／原因`);
}

main().catch(error => {
  reportError(error);
  process.exitCode = 1;
  // Native WebSocket has no terminate(). This fallback runs only if a broken
  // closing handshake still holds Node open after all finally cleanup attempts.
  setTimeout(() => process.exit(1), 1_000).unref();
});
