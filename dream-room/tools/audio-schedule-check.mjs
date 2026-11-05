import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

// Execute the product's actual functions; only browser facilities are replaced.
// This file never starts a browser, opens a socket, or changes product files.
const sourceUrl = new URL('../public/app.js', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const digest = value => createHash('sha256').update(value).digest('hex');
function extract(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert(start >= 0 && source.indexOf(marker, start + marker.length) < 0, `${name}必須能唯一定位`);
  const following = /^(?:async )?function\s/m.exec(source.slice(start + marker.length));
  assert(following, `${name}後面必須有明確的函式邊界`);
  return source.slice(start, start + marker.length + following.index).trim();
}
const productFunctions = ['clearSoundTimer', 'scheduleSoundFade', 'stopNoise'].map(extract).join('\n\n');
let assertions = 0;
function equal(actual, expected, label) { assertions++; assert.equal(actual, expected, label); }
function near(actual, expected, label) { assertions++; assert(Math.abs(actual - expected) < 1e-9, `${label}：${actual} !== ${expected}`); }
function truth(value, label) { assertions++; assert(value, label); }

const controls = new Map([
  ['#volume', { value: '40' }],
  ['#sound-timer', { value: '0' }]
]);
const automation = [];
const timers = new Map();
const ui = [];
const effects = { sourceStop: 0, contextClose: 0, abort: 0, socketSend: 0, socketClose: 0, roomLeave: 0 };
let virtualTime = 100;
let nextTimer = 1;
const audioFixture = {
  context: {
    currentTime: virtualTime,
    close() { effects.contextClose++; return Promise.resolve(); }
  },
  gain: { gain: {
    value: 0.01,
    cancelScheduledValues(time) { automation.push({ operation: 'cancel', time }); },
    setValueAtTime(value, time) { automation.push({ operation: 'set', value, time }); },
    linearRampToValueAtTime(value, time) { automation.push({ operation: 'linear', value, time }); }
  } },
  source: { stop() { effects.sourceStop++; } },
  controller: { abort() { effects.abort++; } }
};
const socketFixture = {
  readyState: 1,
  send() { effects.socketSend++; },
  close() { effects.socketClose++; }
};
const sandbox = vm.createContext({
  fixture: audioFixture,
  socketFixture,
  $(selector) { assert(controls.has(selector), `非預期畫面控制項：${selector}`); return controls.get(selector); },
  setTimeout(callback, milliseconds) {
    const id = nextTimer++;
    timers.set(id, { callback, milliseconds, due: virtualTime * 1000 + milliseconds });
    return id;
  },
  clearTimeout(id) { timers.delete(id); },
  updateSoundUI(text) { ui.push(text); },
  leaveRoom() { effects.roomLeave++; throw new Error('聲音定時不可以離房'); }
});
vm.runInContext(`
  let audio = fixture;
  let soundTimer = null;
  let audioEpoch = 0;
  let audioLoading = false;
  let room = 'dream-a';
  let ws = socketFixture;
  ${productFunctions}
`, sandbox, { filename: 'public/app.js:實際聲音函式', timeout: 1000 });
const run = code => vm.runInContext(code, sandbox, { timeout: 1000 });
const schedule = restart => { automation.length = 0; run(`scheduleSoundFade(${restart ? 'true' : 'false'})`); };
const setTime = seconds => { virtualTime = seconds; audioFixture.context.currentTime = seconds; };
const onlyTimer = () => {
  equal(timers.size, 1, '只有一個停止排程');
  return [...timers.values()][0];
};
const lastRamp = () => automation.filter(event => event.operation === 'linear').at(-1);

// Continuous play: no deadline, no stop timer, no room or audio shutdown.
schedule(true);
equal(audioFixture.deadline, null, '持續播放沒有截止');
equal(timers.size, 0, '持續播放沒有停止計時器');
near(lastRamp().value, 0.4, '持續播放依音量設定增益');
near(lastRamp().time, 100.25, '音量變化保留四分之一秒過渡');
setTime(100 + 24 * 60 * 60);
equal(run('audio'), audioFixture, '沒有停止排程，隔天仍保有聲音物件');
equal(effects.sourceStop, 0, '持續播放沒有停止音源');
equal(effects.contextClose, 0, '持續播放沒有關閉聲音環境');

// A 15-minute timer uses the actual AudioContext clock, with a final 30s ramp.
setTime(200);
controls.get('#sound-timer').value = '15';
schedule(true);
equal(audioFixture.deadline, 1100, '15分鐘截止等於啟動時間加900秒');
equal(onlyTimer().milliseconds, 900_000, '停止排程為15分鐘');
equal(onlyTimer().due, 1_100_000, '停止排程指向同一截止');
truth(automation.some(event => event.operation === 'set' && event.time === 1070 && event.value === 0.4), '最後30秒才開始淡出');
equal(lastRamp().operation, 'linear', '淡出使用線性漸變');
equal(lastRamp().value, 0, '淡出最後降為零');
equal(lastRamp().time, 1100, '音量歸零時間等於截止');

// Move forward 14 minutes and change volume using the normal non-restart path.
setTime(1040);
controls.get('#volume').value = '60';
schedule(false);
equal(audioFixture.deadline, 1100, '過14分鐘調音量不延長截止');
equal(onlyTimer().milliseconds, 60_000, '調音量後僅剩1分鐘');
equal(onlyTimer().due, 1_100_000, '重排停止計時器仍指向原截止');
truth(automation.some(event => event.operation === 'set' && event.time === 1070 && Math.abs(event.value - 0.6) < 1e-9), '新音量仍在原定最後30秒淡出');
equal(lastRamp().value, 0, '調音量仍會淡出至零');
equal(lastRamp().time, 1100, '調音量後歸零時間不變');
equal(effects.sourceStop, 0, '截止前音源仍未停止');

// A change halfway through the last 30s must retain both attenuation and end.
setTime(1085);
controls.get('#volume').value = '20';
schedule(false);
const firstRamp = automation.find(event => event.operation === 'linear');
near(firstRamp.value, 0.1, '淡出中改音量仍維持剩餘15秒的一半增益');
near(firstRamp.time, 1085.25, '淡出中音量變化仍保留短過渡');
equal(lastRamp().value, 0, '淡出中改音量最終仍為零');
equal(lastRamp().time, 1100, '淡出中改音量仍不延長');
equal(onlyTimer().milliseconds, 15_000, '淡出中停止排程僅剩15秒');
equal(onlyTimer().due, 1_100_000, '淡出中停止排程仍指向原截止');

// Fire the callback produced by the actual scheduleSoundFade, which calls the
// actual stopNoise. The outer browser/event loop alone is represented here.
const deadlineTimer = onlyTimer();
setTime(1100);
deadlineTimer.callback();
await Promise.resolve();
equal(run('audio'), null, '到期釋放聲音物件');
equal(effects.sourceStop, 1, '到期停止音源一次');
equal(effects.contextClose, 1, '到期關閉聲音環境一次');
equal(effects.abort, 1, '到期中止舊音源工作');
equal(timers.size, 0, '到期清除停止計時器');
equal(run('soundTimer'), null, '到期清除計時器參照');
equal(run('audioEpoch'), 1, '到期使舊聲音工作失效');
equal(run('room'), 'dream-a', '到期仍留在原房間');
equal(run('ws'), socketFixture, '到期保留原房間連線');
equal(socketFixture.readyState, 1, '到期房間連線仍開啟');
equal(effects.socketSend, 0, '到期不傳送離開訊息');
equal(effects.socketClose, 0, '到期不關閉房間連線');
equal(effects.roomLeave, 0, '到期不呼叫離房');
truth(ui.at(-1).includes('可以繼續留在房間'), '到期提示說明可以繼續留房');
equal(digest(await readFile(sourceUrl, 'utf8')), digest(source), '驗證期間產品檔案未改變');

console.log(`聲音排程邊界驗證通過：${assertions}項斷言。`);
console.log(`實際函式摘要：${digest(productFunctions)}`);
console.log('限制：使用虛擬時間與聲音替身；未證明實際音質、瀏覽器15分鐘計時精度、背景頁節流或手機鎖屏行為。');
