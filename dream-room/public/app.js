import { createAmbientBuffer } from './audio-engine.js';

// 三段聲音完整提取自使用者提供的影片；白噪音由瀏覽器合成。
// 聲音檔路徑相對於夢屋入口，根目錄與子路徑都能使用。
const SOUNDS = [
  { id: 'stream', label: '水流聲', url: 'assets/audio/stream.mp3' },
  { id: 'ocean', label: '海浪聲', url: 'assets/audio/ocean.mp3' },
  { id: 'fire', label: '柴火聲', url: 'assets/audio/fire.mp3' },
  { id: 'noise', label: '白噪音', url: null }
];
let selectedSoundId = SOUNDS[0].id;
const $ = selector => document.querySelector(selector);
const APP_BASE = new URL('./', location.href);
const appUrl = path => new URL(path, APP_BASE).href;
const CAPACITY = 10;
const RECONNECT_MS = 30_000;
const ROOMS = { 'dream-a': { title: '夜潮' }, 'dream-b': { title: '霧藍' } };
const ROOM_IDS = Object.keys(ROOMS);
const BALLS = [1, 2, 3, 4].map(n => appUrl(`assets/ball-${n}.png`));
const SEATS = [[15, 39], [32, 39], [49, 39], [66, 39], [83, 39],
  [15, 76], [32, 76], [49, 76], [66, 76], [83, 76]];
const MODES = [{ value: 'sleep', label: '準備睡了 · 躺下' }, { value: 'float', label: '正在做夢 · 漂浮' }];
const portraitEntryMedia = matchMedia('(max-width: 900px) and (orientation: portrait)');

function anonymousToken() {
  const key = 'dream-house-anonymous-visitor';
  try {
    const saved = localStorage.getItem(key);
    if (/^[a-f0-9-]{36}$/.test(saved || '')) return saved;
    const value = crypto.randomUUID();
    localStorage.setItem(key, value);
    return value;
  } catch { return crypto.randomUUID(); }
}
const token = anonymousToken();
let room = null;
let ws = null;
let members = [];
let myId = null;
let myMode = null;
let ownConnectionId = null;
let connectEpoch = 0;
let disconnectedAt = null;
let retryCount = 0;
let retryTimer = null;
let heartbeatTimer = null;
let connectTimer = null;
let idleTimer = null;
let countTimer = null;
let countsRequest = null;
let terminal = false;
let connected = false;
let audio = null;
let audioEpoch = 0;
let audioLoading = false;
let soundTimer = null;
let openPanel = null;
let pendingRoom = null;
let pendingEntryFocus = null;
const visitorNodes = new Map();

function setButtonIcon(button, kind, label) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', appUrl(`assets/controls-icons.svg#icon-${kind}`));
  svg.append(use);
  button.replaceChildren(svg);
  button.setAttribute('aria-label', label);
}
function closePopovers({ restoreFocus = false } = {}) {
  const old = openPanel;
  openPanel = null;
  if (old && document.getElementById(old)?.contains(document.activeElement)) document.activeElement.blur();
  for (const panel of document.querySelectorAll('.control-popover')) panel.classList.add('hidden');
  for (const toggle of document.querySelectorAll('[data-panel-toggle]')) toggle.setAttribute('aria-expanded', 'false');
  if (restoreFocus && old) document.querySelector(`[data-panel-toggle="${old}"]`)?.focus({ preventScroll: true });
}
function togglePopover(panelId) {
  const alreadyOpen = openPanel === panelId;
  closePopovers();
  showControls();
  if (alreadyOpen) return;
  openPanel = panelId;
  const panel = document.getElementById(panelId);
  panel.classList.remove('hidden');
  document.querySelector(`[data-panel-toggle="${panelId}"]`).setAttribute('aria-expanded', 'true');
  panel.querySelector('input, button')?.focus({ preventScroll: true });
}

function message(text) { $('#room-message').textContent = text || ''; }
function otherRoom() { return ROOM_IDS.find(id => id !== room); }
function setConnected(value) {
  connected = value;
  for (const button of document.querySelectorAll('#modes button')) button.disabled = !value;
}
function socketUrl(roomId) {
  const url = new URL('api/connect', APP_BASE);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('room', roomId);
  url.searchParams.set('token', token);
  return url.href;
}
function clearVisitors() { visitorNodes.clear(); $('#visitors').replaceChildren(); }
function renderVisitors() {
  const present = new Set();
  for (const member of members) {
    const pos = SEATS[member.seat];
    if (!pos) continue;
    present.add(member.id);
    let element = visitorNodes.get(member.id);
    if (!element) {
      element = document.createElement('div');
      element.className = 'visitor-slot';
      element.setAttribute('role', 'img');
      const anchor = document.createElement('span');
      anchor.className = 'visitor-anchor';
      const ball = document.createElement('span');
      ball.className = 'visitor';
      const img = document.createElement('img');
      img.src = BALLS[member.ball] || BALLS[0];
      img.alt = '';
      img.draggable = false;
      ball.append(img);
      anchor.append(ball);
      const bed = document.createElement('span');
      bed.className = 'dream-bed';
      element.append(bed, anchor);
      element.style.setProperty('--drift-duration', `${19 + member.seat * .9}s`);
      element.style.setProperty('--drift-delay', `${-member.seat * 2.7}s`);
      $('#visitors').append(element);
      visitorNodes.set(member.id, element);
    }
    element.style.left = `${pos[0]}%`;
    element.style.top = `${pos[1]}%`;
    element.classList.toggle('floating', member.mode === 'float');
    element.classList.toggle('sleeping', member.mode === 'sleep');
    element.classList.toggle('reconnecting', Boolean(member.reconnecting));
    element.classList.toggle('is-mine', member.id === myId);
    const who = member.id === myId ? '我的夢球' : '另一位訪客';
    element.setAttribute('aria-label', `${who}，${member.mode === 'float' ? '正在漂浮' : '已經躺下'}${member.reconnecting ? '，暫時斷線' : ''}`);
  }
  for (const [id, element] of visitorNodes) {
    if (!present.has(id)) { element.remove(); visitorNodes.delete(id); }
  }
  for (const button of document.querySelectorAll('#modes button')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === myMode));
  }
}
function renderControls() {
  $('#modes').replaceChildren();
  for (const mode of MODES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'glass-button';
    button.dataset.mode = mode.value;
    setButtonIcon(button, mode.value, mode.label);
    button.setAttribute('aria-pressed', 'false');
    button.disabled = !connected;
    button.addEventListener('click', () => {
      if (connected && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'mode', room, value: mode.value }));
      }
    });
    $('#modes').append(button);
  }
  $('#switch-room').setAttribute('aria-label', `換個地方入眠，前往${ROOMS[otherRoom()].title}`);
  $('#alternate-room').setAttribute('aria-label', `試試${ROOMS[otherRoom()].title}`);
  $('#brightness').value = '85';
  updateBrightness();
  $('#sound-timer').value = '0';
  updateSoundUI();
}
function updateBrightness() {
  const value = Number($('#brightness').value);
  $('#scene').style.filter = `brightness(${value / 100})`;
  $('#brightness-value').textContent = `${value}%`;
}

async function refreshCounts() {
  if (room || document.hidden) return null;
  countsRequest?.abort();
  const controller = new AbortController();
  countsRequest = controller;
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(appUrl('api/rooms'), { cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new Error('Counts unavailable');
    const counts = await res.json();
    if (room || countsRequest !== controller) return null;
    if (!ROOM_IDS.every(id => Number.isInteger(counts?.[id]?.count))) throw new Error('Invalid counts');
    for (const id of ROOM_IDS) {
      const count = counts[id].count;
      $(`#${id}-count`).textContent = `${count} / ${CAPACITY}${count >= CAPACITY ? ' · 已滿' : ''}`;
      document.querySelector(`[data-room="${id}"]`).classList.toggle('is-full', count >= CAPACITY);
    }
    $('#lobby-message').textContent = ROOM_IDS.every(id => counts[id].count >= CAPACITY)
      ? '兩間房目前都滿了。可以稍後再來看看。' : '房門開著。挑一間，慢慢進來。';
    return counts;
  } catch (error) {
    if (!room && countsRequest === controller) {
      $('#lobby-message').textContent = '暫時讀不到最新人數。可以直接選房。';
      for (const id of ROOM_IDS) $(`#${id}-count`).textContent = '— / 10';
    }
    return null;
  } finally { clearTimeout(timeout); if (countsRequest === controller) countsRequest = null; }
}
function startLobbyPolling() {
  clearInterval(countTimer);
  void refreshCounts();
  countTimer = setInterval(() => { void refreshCounts(); }, 30_000);
}
function controlsHaveFocus() {
  const focused = document.activeElement;
  return Boolean(focused?.matches('button, input, select, textarea, a, [contenteditable]') && focused.closest('.quiet-ui, #wake-controls, .room-feedback'));
}
function hideControls() {
  clearTimeout(idleTimer);
  idleTimer = null;
  if (!room || openPanel || controlsHaveFocus()) return;
  document.body.classList.add('controls-resting');
  $('#wake-controls').setAttribute('aria-label', '顯示操作');
  $('#wake-controls').setAttribute('aria-expanded', 'false');
}
function showControls(event) {
  // 這顆按鈕自己處理顯示／收起，避免同一次觸碰或按鍵先喚回、又反轉。
  if (event?.target?.closest?.('#wake-controls')) return;
  if (!room) return;
  document.body.classList.remove('controls-resting');
  $('#wake-controls').setAttribute('aria-label', '收起操作');
  $('#wake-controls').setAttribute('aria-expanded', 'true');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(hideControls, 8000);
}

function currentSound() { return SOUNDS.find(sound => sound.id === selectedSoundId) || SOUNDS[0]; }
function renderSoundOptions() {
  const select = $('#sound-source');
  select.replaceChildren();
  $('#sound-options').replaceChildren();
  for (const sound of SOUNDS) {
    const option = document.createElement('option');
    option.value = sound.id;
    option.textContent = sound.label;
    select.append(option);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'glass-button';
    button.dataset.sound = sound.id;
    setButtonIcon(button, sound.id, sound.label);
    button.addEventListener('click', () => { changeSound(sound.id, true); closePopovers({ restoreFocus: true }); });
    $('#sound-options').append(button);
  }
  select.value = selectedSoundId;
  const mute = document.createElement('button');
  mute.type = 'button';
  mute.className = 'glass-button';
  mute.dataset.sound = 'mute';
  setButtonIcon(mute, 'mute', '靜音');
  mute.addEventListener('click', () => { stopNoise(); closePopovers({ restoreFocus: true }); });
  $('#sound-options').append(mute);
}
function changeSound(nextId = $('#sound-source').value, play = false) {
  const next = SOUNDS.find(sound => sound.id === nextId);
  if (!next || (next.id === selectedSoundId && (audio || audioLoading))) return;
  const shouldPlay = Boolean(audio) || audioLoading;
  stopNoise();
  selectedSoundId = next.id;
  $('#sound-source').value = selectedSoundId;
  updateSoundUI();
  if (play || shouldPlay) void toggleNoise();
}
function renderTimerOptions() {
  const options = [ ['0', '持續'], ['15', '15分鐘'], ['30', '30分鐘'], ['60', '60分鐘'] ];
  for (const [value, label] of options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'timer-choice';
    button.dataset.timer = value;
    button.textContent = label;
    button.setAttribute('aria-label', value === '0' ? '持續播放聲音' : `${value}分鐘後淡出聲音`);
    button.addEventListener('click', () => {
      $('#sound-timer').value = value;
      $('#sound-timer').dispatchEvent(new Event('change'));
      closePopovers({ restoreFocus: true });
    });
    $('#timer-options').append(button);
  }
}
function updateSoundUI(extra = '') {
  const sound = currentSound();
  const active = Boolean(audio) || audioLoading;
  $('#noise-toggle').setAttribute('aria-label', `選擇環境聲音，目前${active ? `${sound.label}${audioLoading ? '準備中' : '播放中'}` : '靜音'}`);
  $('#noise-toggle').setAttribute('aria-pressed', String(active));
  $('#volume-value').textContent = `${$('#volume').value}%`;
  for (const button of document.querySelectorAll('[data-sound]')) {
    button.setAttribute('aria-pressed', String(active ? button.dataset.sound === sound.id : button.dataset.sound === 'mute'));
  }
  const source = sound.url ? '聲音來自自備音檔。' : `${sound.label}由瀏覽器合成。`;
  const minutes = Number($('#sound-timer').value);
  $('#timer-toggle').setAttribute('aria-label', `聲音定時，目前${minutes ? `${minutes} 分鐘定時` : '持續播放'}`);
  for (const button of document.querySelectorAll('[data-timer]')) {
    button.setAttribute('aria-pressed', String(button.dataset.timer === String(minutes)));
  }
  let status = audioLoading ? '正在準備聲音。選靜音可以取消。' : active
    ? `${source}${minutes ? `本次設定 ${minutes} 分鐘定時，最後 30 秒慢慢淡出。` : '持續播放，選靜音就能停止。'}`
    : `聲音已關閉。${source}`;
  if (extra) status = extra;
  $('#sound-status').textContent = status;
}
function clearSoundTimer() { clearTimeout(soundTimer); soundTimer = null; }
function scheduleSoundFade(restart = false) {
  if (!audio) return;
  clearSoundTimer();
  const { context, gain } = audio;
  const now = context.currentTime;
  const minutes = Number($('#sound-timer').value);
  if (restart || audio.deadline === undefined) audio.deadline = minutes ? now + minutes * 60 : null;
  const target = Number($('#volume').value) / 100;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(gain.gain.value, now);
  if (audio.deadline === null) { gain.gain.linearRampToValueAtTime(target, now + .25); return; }
  const remaining = Math.max(0, audio.deadline - now);
  const factor = Math.min(1, remaining / 30);
  gain.gain.linearRampToValueAtTime(target * factor, now + Math.min(.25, remaining));
  if (remaining > 30) gain.gain.setValueAtTime(target, audio.deadline - 30);
  gain.gain.linearRampToValueAtTime(0, audio.deadline);
  const owner = audio;
  soundTimer = setTimeout(() => {
    if (audio !== owner) return;
    stopNoise();
    updateSoundUI('聲音已慢慢淡出。你可以繼續留在房間裡。');
  }, remaining * 1000);
}
function stopNoise() {
  audioEpoch++;
  audioLoading = false;
  clearSoundTimer();
  const old = audio;
  audio = null;
  if (old) {
    old.controller?.abort();
    try { old.source?.stop(); } catch { /* 已停止 */ }
    void old.context.close().catch(() => {});
  }
  updateSoundUI();
}
async function toggleNoise() {
  if (audio || audioLoading) { stopNoise(); return; }
  const sound = currentSound();
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) { updateSoundUI('這個瀏覽器無法播放聲音。房間仍然可以使用。'); return; }
  const epoch = ++audioEpoch;
  const thisRoom = room;
  let context;
  audioLoading = true;
  updateSoundUI();
  try {
    context = new Context();
    const source = context.createBufferSource();
    const gain = context.createGain();
    gain.gain.value = 0;
    const controller = new AbortController();
    const current = { context, source, gain, controller };
    audio = current;
    // 必須在點擊當下喚醒，避免手機瀏覽器擋住聲音。
    await context.resume();
    if (epoch !== audioEpoch || room !== thisRoom) return;
    if (sound.url) {
      const res = await fetch(appUrl(sound.url), { signal: controller.signal });
      if (!res.ok) throw new Error('Sound unavailable');
      source.buffer = await context.decodeAudioData(await res.arrayBuffer());
      source.connect(gain);
    } else {
      source.buffer = createAmbientBuffer(context, sound.id);
      source.connect(gain);
    }
    if (epoch !== audioEpoch || room !== thisRoom) return;
    source.loop = true;
    gain.connect(context.destination);
    source.start();
    audioLoading = false;
    scheduleSoundFade(true);
    updateSoundUI();
  } catch (error) {
    if (epoch === audioEpoch) {
      stopNoise();
      updateSoundUI(sound.url ? '這個音檔暫時無法播放。請確認檔案與格式。' : '暫時無法播放聲音。再按一次可以重試。');
    } else if (context && context.state !== 'closed') { void context.close().catch(() => {}); }
  }
}

function clearConnectionTimers() {
  clearTimeout(retryTimer);
  clearTimeout(connectTimer);
  clearInterval(heartbeatTimer);
  retryTimer = connectTimer = heartbeatTimer = null;
}
function sendExplicitLeave(roomId, connectionId) {
  if (!connectionId) return;
  void fetch(appUrl('api/leave'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: roomId, token, connectionId }), keepalive: true }).catch(() => {});
}
function leaveRoom({ focus = true } = {}) {
  if (!room) return;
  closePopovers();
  const oldRoom = room;
  const oldConnectionId = ownConnectionId;
  connectEpoch++;
  clearConnectionTimers();
  clearTimeout(idleTimer);
  idleTimer = null;
  terminal = true;
  setConnected(false);
  const socket = ws;
  ws = null;
  if (socket) {
    try {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'leave' }));
      socket.close(1000, 'Visitor left');
    } catch { /* 已關閉 */ }
  }
  sendExplicitLeave(oldRoom, oldConnectionId);
  stopNoise();
  room = null;
  members = [];
  myId = myMode = ownConnectionId = null;
  disconnectedAt = null;
  retryCount = 0;
  clearVisitors();
  document.body.classList.remove('controls-resting');
  document.body.classList.remove('in-room');
  $('#room-view').classList.add('hidden');
  $('#lobby').classList.remove('hidden');
  $('#alternate-room').classList.add('hidden');
  $('#retry-connect').classList.add('hidden');
  startLobbyPolling();
  if (focus) document.querySelector('.room-card')?.focus({ preventScroll: true });
}
function showTerminal(text, { full = false } = {}) {
  closePopovers();
  terminal = true;
  setConnected(false);
  clearConnectionTimers();
  stopNoise();
  showControls();
  message(text);
  $('#alternate-room').classList.toggle('hidden', !full);
  $('#retry-connect').classList.toggle('hidden', full);
}
function handleReplaced(socket) {
  ownConnectionId = null;
  myId = myMode = null;
  members = [];
  clearVisitors();
  $('#population').textContent = '—人在這裡';
  showTerminal('你已在另一個分頁進入這間房。這裡已停止，不會搶回位置。');
  clearTimeout(idleTimer);
  idleTimer = null;
  $('#retry-connect').classList.add('hidden');
  ws = null;
  // 只完成舊連線的關閉握手，不送離開請求，避免影響新分頁的席位。
  try { socket.close(1000, 'Replaced by another tab'); } catch { /* 已關閉 */ }
}
function connectSocket(epoch) {
  if (terminal || epoch !== connectEpoch || !room) return;
  clearConnectionTimers();
  const thisRoom = room;
  let socket;
  try { socket = new WebSocket(socketUrl(thisRoom)); }
  catch { scheduleReconnect(epoch); return; }
  ws = socket;
  let full = false;
  let lastSeen = Date.now();
  const isCurrent = () => epoch === connectEpoch && room === thisRoom && ws === socket;
  connectTimer = setTimeout(() => {
    if (!isCurrent() || connected) return;
    try { socket.close(4000, 'Connection timeout'); } catch { /* 正在關閉 */ }
  }, 10_000);
  socket.addEventListener('open', () => {
    if (!isCurrent()) { socket.close(1000, 'Visitor left'); return; }
    lastSeen = Date.now();
    heartbeatTimer = setInterval(() => {
      if (!isCurrent() || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastSeen > 55_000) { socket.close(4000, 'Heartbeat timeout'); return; }
      socket.send('__ping__');
    }, 20_000);
  });
  socket.addEventListener('message', event => {
    if (!isCurrent()) return;
    lastSeen = Date.now();
    if (event.data === '__pong__') return;
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === 'replaced') {
      handleReplaced(socket);
      return;
    }
    if (data.type === 'full') {
      full = true;
      $('#population').textContent = `${CAPACITY}人在這裡`;
      showTerminal('這間房剛好住滿了。可以試試另一間，或返回入口。', { full: true });
      return;
    }
    if (data.type === 'welcome' && data.you) {
      clearTimeout(connectTimer);
      connectTimer = null;
      myId = data.you.id;
      myMode = data.you.mode;
      ownConnectionId = data.connectionId;
      retryCount = 0;
      disconnectedAt = null;
      setConnected(true);
      message('已進入房間。操作會在閒置後收起。');
      $('#retry-connect').classList.add('hidden');
    }
    if (data.type === 'state' && Array.isArray(data.members)) {
      members = data.members;
      const mine = members.find(item => item.id === myId);
      if (mine) myMode = mine.mode;
      $('#population').textContent = `${data.count}人在這裡`;
      renderVisitors();
    }
  });
  socket.addEventListener('close', event => {
    if (!isCurrent()) return;
    if (event.reason === 'Replaced by another tab') {
      handleReplaced(socket);
      return;
    }
    ws = null;
    clearConnectionTimers();
    setConnected(false);
    if (full || terminal) return;
    scheduleReconnect(epoch);
  });
  socket.addEventListener('error', () => {
    if (isCurrent() && !terminal) message('連線暫時不穩定，正在試著回到房間……');
  });
}
function scheduleReconnect(epoch) {
  if (epoch !== connectEpoch || terminal || !room) return;
  setConnected(false);
  if (disconnectedAt === null) disconnectedAt = Date.now();
  const remaining = RECONNECT_MS - (Date.now() - disconnectedAt);
  if (remaining < 1000) {
    showTerminal('暫時沒能重新連線。可以重新連線，或返回入口再選房。');
    return;
  }
  retryCount++;
  message('連線暫時中斷，正在找回位置。斷線的位置最多保留 30 秒。');
  members = members.map(member => member.id === myId ? { ...member, reconnecting: true } : member);
  renderVisitors();
  retryTimer = setTimeout(() => connectSocket(epoch), Math.min(1000 * retryCount, 4000, remaining - 500));
}
function updateOrientationGate() {
  $('#orientation-enter').disabled = portraitEntryMedia.matches;
}
function clearPendingEntry({ restoreFocus = true } = {}) {
  const previous = pendingEntryFocus;
  pendingRoom = null;
  pendingEntryFocus = null;
  if ($('#orientation-dialog').open) $('#orientation-dialog').close();
  if (restoreFocus && !room && previous?.isConnected) previous.focus({ preventScroll: true });
}
function enter(roomId) {
  if (!ROOMS[roomId]) return;
  // 入口先提醒，還未建立連線，也不占用房間名額；轉橫不會自動進入。
  if (!room && portraitEntryMedia.matches) {
    pendingRoom = roomId;
    if (!$('#orientation-dialog').open) {
      pendingEntryFocus = document.activeElement;
      updateOrientationGate();
      $('#orientation-dialog').showModal();
    }
    return;
  }
  if (room) leaveRoom({ focus: false });
  clearInterval(countTimer);
  countTimer = null;
  countsRequest?.abort();
  countsRequest = null;
  room = roomId;
  closePopovers();
  document.body.classList.add('in-room');
  terminal = false;
  disconnectedAt = Date.now();
  retryCount = 0;
  myId = myMode = ownConnectionId = null;
  members = [];
  setConnected(false);
  const epoch = ++connectEpoch;
  $('#lobby').classList.add('hidden');
  $('#room-view').classList.remove('hidden');
  $('#room-name').textContent = ROOMS[room].title;
  $('#population').textContent = '—人在這裡';
  $('#scene').dataset.room = room;
  $('#scene').setAttribute('aria-label', `${ROOMS[room].title}陪睡房`);
  $('#alternate-room').classList.add('hidden');
  $('#retry-connect').classList.add('hidden');
  clearVisitors();
  renderControls();
  showControls();
  message('正在輕輕推開房門……');
  $('#room-name').focus({ preventScroll: true });
  window.scrollTo(0, 0);
  connectSocket(epoch);
}
function retryConnection() {
  if (!room) return;
  terminal = false;
  disconnectedAt = Date.now();
  retryCount = 0;
  $('#retry-connect').classList.add('hidden');
  message('正在重新推開房門……');
  connectSocket(++connectEpoch);
}

for (const card of document.querySelectorAll('[data-room].room-card')) {
  card.addEventListener('click', () => enter(card.dataset.room));
}
$('#orientation-cancel').addEventListener('click', () => clearPendingEntry());
$('#orientation-enter').addEventListener('click', () => {
  if (!pendingRoom || portraitEntryMedia.matches) return;
  const nextRoom = pendingRoom;
  clearPendingEntry({ restoreFocus: false });
  enter(nextRoom);
});
$('#orientation-dialog').addEventListener('cancel', event => {
  event.preventDefault();
  clearPendingEntry();
});
$('#orientation-dialog').addEventListener('close', () => {
  if (pendingRoom) clearPendingEntry();
});
portraitEntryMedia.addEventListener('change', updateOrientationGate);
window.addEventListener('resize', updateOrientationGate);
window.addEventListener('orientationchange', updateOrientationGate);
$('#back-btn').addEventListener('click', () => leaveRoom());
$('#go-home').addEventListener('click', () => leaveRoom());
$('#switch-room').addEventListener('click', () => enter(otherRoom()));
$('#alternate-room').addEventListener('click', () => enter(otherRoom()));
$('#retry-connect').addEventListener('click', retryConnection);
$('#brightness').addEventListener('input', updateBrightness);
for (const button of document.querySelectorAll('[data-panel-toggle]')) {
  button.addEventListener('click', () => togglePopover(button.dataset.panelToggle));
}
$('#sound-source').addEventListener('change', () => changeSound());
$('#volume').addEventListener('input', () => { scheduleSoundFade(); updateSoundUI(); });
$('#sound-timer').addEventListener('change', () => { scheduleSoundFade(true); updateSoundUI(); });
$('#wake-controls').addEventListener('click', () => {
  if (document.body.classList.contains('controls-resting')) showControls();
  else { closePopovers(); $('#wake-controls').blur(); hideControls(); }
});
document.addEventListener('pointerdown', event => {
  if (openPanel && !event.target.closest('.control-popover, [data-panel-toggle]')) closePopovers();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && openPanel) {
    event.preventDefault();
    closePopovers({ restoreFocus: true });
  }
});
document.addEventListener('pointermove', showControls, { passive: true });
document.addEventListener('pointerdown', showControls, { passive: true });
document.addEventListener('keydown', showControls);
document.addEventListener('focusin', showControls);
document.addEventListener('focusout', showControls);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (!room) void refreshCounts();
  else {
    showControls();
    if (audio?.deadline != null && audio.context.currentTime >= audio.deadline) {
      stopNoise();
      updateSoundUI('聲音已慢慢淡出。你可以繼續留在房間裡。');
    }
  }
});
window.addEventListener('pagehide', () => {
  clearPendingEntry({ restoreFocus: false });
  closePopovers();
  // 重新整理保留後端的 30 秒回位機會；只有按離開才立即釋位。
  connectEpoch++;
  clearConnectionTimers();
  clearTimeout(idleTimer);
  clearInterval(countTimer);
  countsRequest?.abort();
  stopNoise();
  try { ws?.close(1001, 'Page hidden'); } catch { /* 已關閉 */ }
  ws = null;
  setConnected(false);
});
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  if (room && !terminal) retryConnection();
  else if (!room) startLobbyPolling();
});
renderSoundOptions();
renderTimerOptions();
updateSoundUI();
startLobbyPolling();

