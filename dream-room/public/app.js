import { createAmbientBuffer } from './audio-engine.js';
import { createSeamlessLoop } from './audio-loop.js';
import { t, applyStaticText, setLanguage } from './i18n.js';

// 三段聲音取自使用者提供的影片，已事先做成無縫循環（使用者 11/06 試聽通過；水流 11/06 下午改用「小小溪流」約 10 秒慢慢起伏版）；白噪音由瀏覽器合成。
// 用無壓縮 WAV，避免壓縮檔頭尾補靜音造成接縫；播放時不可再交疊一次。
// 聲音檔路徑相對於夢屋入口，根目錄與子路徑都能使用。
const SOUNDS = [
  { id: 'stream', label: '水流聲', url: 'assets/audio/stream-loop.wav', preLooped: true },
  { id: 'ocean', label: '海浪聲', url: 'assets/audio/ocean-loop.wav', preLooped: true },
  { id: 'fire', label: '柴火聲', url: 'assets/audio/fire-loop.wav', preLooped: true },
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
// 球的柔邊事先畫進圖片（手機 3.5%、電腦 7.5%，使用者 11/06 調整台定稿），
// 不用 CSS 遮罩與濾鏡：iPhone 上那兩種特效曾畫出紫紅色雜線。
const phoneLayoutMedia = matchMedia('(max-width: 900px), (max-height: 550px)');
const portraitSceneMedia = matchMedia('(orientation: portrait)');
const ballUrl = index => appUrl(`assets/ball-${(index in [0, 1, 2, 3] ? index : 0) + 1}-soft-${phoneLayoutMedia.matches ? 'p' : 'd'}.png`);
// 手機直拿時畫面窄，改排成兩欄五列，球才不會擠在一起。
const PORTRAIT_SEATS = Array.from({ length: 10 }, (_, i) => [i % 2 ? 72 : 28, 12 + Math.floor(i / 2) * 18]);
const SEATS = [[15, 39], [32, 39], [49, 39], [66, 39], [83, 39],
  [15, 76], [32, 76], [49, 76], [66, 76], [83, 76]];
const MODES = [{ value: 'sleep' }, { value: 'float' }];
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

function openHelp() {
  closePopovers();
  const dialog = $('#help-dialog');
  if (!dialog.open) dialog.showModal();
  $('#help-close').focus({ preventScroll: true });
  // 開啟時會自動聚焦「知道了」而捲到底；拉回最上面，從第一題開始讀。
  dialog.scrollTop = 0;
}
function closeHelp() {
  const dialog = $('#help-dialog');
  if (dialog?.open) dialog.close();
}

let populationCount = null;
function setPopulation(count) {
  populationCount = count;
  $('#population').textContent = count == null ? t('population.unknown') : t('population', count);
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
    const pos = (portraitSceneMedia.matches ? PORTRAIT_SEATS : SEATS)[member.seat];
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
      img.dataset.ball = String(member.ball);
      img.src = ballUrl(member.ball);
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
    element.setAttribute('aria-label', t('visitor', member.id === myId, member.mode === 'float', Boolean(member.reconnecting)));
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
    setButtonIcon(button, mode.value, t(`mode.${mode.value}`));
    button.setAttribute('aria-pressed', 'false');
    button.disabled = !connected;
    button.addEventListener('click', () => {
      if (connected && ws?.readyState === WebSocket.OPEN) {
        if (mode.value === 'float') document.body.dataset.floatMotion = 'on';
        else delete document.body.dataset.floatMotion;
        ws.send(JSON.stringify({ type: 'mode', room, value: mode.value }));
      }
    });
    $('#modes').append(button);
  }
  $('#switch-room').setAttribute('aria-label', t('switch.aria', ROOMS[otherRoom()].title));
  $('#alternate-room').setAttribute('aria-label', t('alternate.aria', ROOMS[otherRoom()].title));
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
      $(`#${id}-count`).textContent = t('count', count, CAPACITY);
      document.querySelector(`[data-room="${id}"]`).classList.toggle('is-full', count >= CAPACITY);
    }
    $('#lobby-message').textContent = ROOM_IDS.every(id => counts[id].count >= CAPACITY)
      ? t('lobby.allFull') : t('lobby.open');
    return counts;
  } catch (error) {
    if (!room && countsRequest === controller) {
      $('#lobby-message').textContent = t('lobby.error');
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
  $('#wake-controls').setAttribute('aria-label', t('wake.show'));
  $('#wake-controls').setAttribute('aria-expanded', 'false');
}
function showControls(event) {
  // 這顆按鈕自己處理顯示／收起，避免同一次觸碰或按鍵先喚回、又反轉。
  if (event?.target?.closest?.('#wake-controls')) return;
  if (!room) return;
  document.body.classList.remove('controls-resting');
  $('#wake-controls').setAttribute('aria-label', t('wake.hide'));
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
    option.textContent = t(`sound.${sound.id}`);
    select.append(option);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'glass-button';
    button.dataset.sound = sound.id;
    setButtonIcon(button, sound.id, t(`sound.${sound.id}`));
    button.addEventListener('click', () => { changeSound(sound.id, true); closePopovers({ restoreFocus: true }); });
    $('#sound-options').append(button);
  }
  select.value = selectedSoundId;
  const mute = document.createElement('button');
  mute.type = 'button';
  mute.className = 'glass-button';
  mute.dataset.sound = 'mute';
  setButtonIcon(mute, 'mute', t('sound.mute'));
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
  $('#timer-options').replaceChildren();
  for (const value of ['0', '15', '30', '60']) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'timer-choice';
    button.dataset.timer = value;
    button.textContent = t('timer.option', value);
    button.setAttribute('aria-label', t('timer.optionAria', value));
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
  $('#noise-toggle').setAttribute('aria-label', t('noise.aria', active, t(`sound.${sound.id}`), audioLoading));
  $('#noise-toggle').setAttribute('aria-pressed', String(active));
  $('#volume-value').textContent = `${$('#volume').value}%`;
  for (const button of document.querySelectorAll('[data-sound]')) {
    button.setAttribute('aria-pressed', String(active ? button.dataset.sound === sound.id : button.dataset.sound === 'mute'));
  }
  const source = sound.url ? t('source.file') : t('source.synth', t(`sound.${sound.id}`));
  const minutes = Number($('#sound-timer').value);
  $('#timer-toggle').setAttribute('aria-label', t('timer.aria', minutes));
  for (const button of document.querySelectorAll('[data-timer]')) {
    button.setAttribute('aria-pressed', String(button.dataset.timer === String(minutes)));
  }
  let status = audioLoading ? t('status.loading') : active
    ? `${source}${minutes ? t('status.timer', minutes) : t('status.continuous')}`
    : t('status.off', source);
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
    updateSoundUI(t('status.faded'));
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
  if (!Context) { updateSoundUI(t('status.unsupported')); return; }
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
      const decoded = await context.decodeAudioData(await res.arrayBuffer());
      source.buffer = sound.preLooped ? decoded : createSeamlessLoop(context, decoded);
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
      updateSoundUI(sound.url ? t('status.fileFailed') : t('status.synthFailed'));
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
  delete document.body.dataset.floatMotion;
  closeHelp();
  hideOrientationHint();
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
  delete document.body.dataset.floatMotion;
  closeHelp();
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
  setPopulation(null);
  showTerminal(t('terminal.takeover'));
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
      setPopulation(CAPACITY);
      showTerminal(t('terminal.full'), { full: true });
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
      message(t('room.entered'));
      $('#retry-connect').classList.add('hidden');
    }
    if (data.type === 'state' && Array.isArray(data.members)) {
      members = data.members;
      const mine = members.find(item => item.id === myId);
      if (mine) myMode = mine.mode;
      setPopulation(data.count);
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
    if (isCurrent() && !terminal) message(t('room.unstable'));
  });
}
function scheduleReconnect(epoch) {
  if (epoch !== connectEpoch || terminal || !room) return;
  setConnected(false);
  if (disconnectedAt === null) disconnectedAt = Date.now();
  const remaining = RECONNECT_MS - (Date.now() - disconnectedAt);
  if (remaining < 1000) {
    showTerminal(t('terminal.failed'));
    return;
  }
  retryCount++;
  message(t('room.interrupted'));
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
  delete document.body.dataset.floatMotion;
  // 使用者 11/06 決定：直拿也可以直接進房，不再強制轉橫；只溫柔提醒一次。
  const suggestLandscape = !room && portraitEntryMedia.matches;
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
  setPopulation(null);
  $('#scene').dataset.room = room;
  $('#scene').setAttribute('aria-label', t('scene.aria', ROOMS[room].title));
  $('#alternate-room').classList.add('hidden');
  $('#retry-connect').classList.add('hidden');
  clearVisitors();
  renderControls();
  showControls();
  message(t('room.entering'));
  $('#room-name').focus({ preventScroll: true });
  window.scrollTo(0, 0);
  connectSocket(epoch);
  if (suggestLandscape) showOrientationHint();
}
let orientationHintTimer = null;
function showOrientationHint() {
  const hint = $('#orientation-hint');
  hint.classList.remove('hidden');
  clearTimeout(orientationHintTimer);
  orientationHintTimer = setTimeout(hideOrientationHint, 5000);
}
function hideOrientationHint() {
  clearTimeout(orientationHintTimer);
  $('#orientation-hint')?.classList.add('hidden');
}
function retryConnection() {
  if (!room) return;
  terminal = false;
  disconnectedAt = Date.now();
  retryCount = 0;
  $('#retry-connect').classList.add('hidden');
  message(t('room.reentering'));
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
portraitEntryMedia.addEventListener('change', () => { updateOrientationGate(); if (!portraitEntryMedia.matches) hideOrientationHint(); });
// 轉向或換尺寸時，重排座位、換對應的柔邊球圖。
portraitSceneMedia.addEventListener('change', () => { if (room) renderVisitors(); });
phoneLayoutMedia.addEventListener('change', () => {
  for (const img of document.querySelectorAll('#visitors img[data-ball]')) img.src = ballUrl(Number(img.dataset.ball));
});
window.addEventListener('resize', updateOrientationGate);
window.addEventListener('orientationchange', updateOrientationGate);
$('#back-btn').addEventListener('click', () => leaveRoom());
$('#help-toggle').addEventListener('click', openHelp);
$('#orientation-hint').addEventListener('click', hideOrientationHint);
$('#help-close').addEventListener('click', () => { closeHelp(); $('#help-toggle').focus({ preventScroll: true }); });
// 點視窗外的暗處也能關閉。
$('#help-dialog').addEventListener('click', event => {
  if (event.target !== event.currentTarget) return;
  const box = event.currentTarget.getBoundingClientRect();
  const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
  if (!inside) closeHelp();
});
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
      updateSoundUI(t('status.faded'));
    }
  }
});
window.addEventListener('pagehide', () => {
  delete document.body.dataset.floatMotion;
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
applyStaticText();
for (const button of document.querySelectorAll('[data-lang]')) button.addEventListener('click', () => setLanguage(button.dataset.lang));
// 換語言時，把程式畫出來的按鈕與說明重畫一次。
document.addEventListener('dream-language-change', () => {
  renderSoundOptions();
  renderTimerOptions();
  updateSoundUI();
  if (room) {
    renderControls();
    for (const button of document.querySelectorAll('#modes button')) button.setAttribute('aria-pressed', String(button.dataset.mode === myMode));
    renderVisitors();
    setPopulation(populationCount);
    $('#scene').setAttribute('aria-label', t('scene.aria', ROOMS[room].title));
  } else {
    $('#lobby-message').textContent = t('lobby.loading');
    void refreshCounts();
  }
});
renderSoundOptions();
renderTimerOptions();
updateSoundUI();
startLobbyPolling();

