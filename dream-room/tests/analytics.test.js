import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/analytics.js', import.meta.url), 'utf8');
function setup(options = {}) {
  const scripts = [];
  const document = {
    title: '夢の部屋',
    referrer: options.referrer ?? 'https://example.com/private?token=secret#private',
    querySelector: () => options.id === null ? null : { content: options.id ?? 'G-TEST12345' },
    createElement: tag => ({ tag }),
    head: { append: script => { if (options.appendError) throw new Error('blocked'); scripts.push(script); } }
  };
  const context = vm.createContext({
    URL, Date, document,
    location: new URL(options.url ?? 'https://raindeercoffee.com/dream-room/?token=secret#private'),
    navigator: { doNotTrack: options.dnt, globalPrivacyControl: options.gpc },
    doNotTrack: options.windowDnt
  });
  context.window = context;
  return { context, scripts, run: () => vm.runInContext(source, context), commands: () => Array.from(context.dataLayer ?? [], entry => Array.from(entry)) };
}

test('正式夢屋載入官方非同步標籤，僅設定一般頁面瀏覽並停用廣告訊號', () => {
  const page = setup(); page.run();
  assert.equal(page.scripts.length, 1);
  assert.equal(page.scripts[0].src, 'https://www.googletagmanager.com/gtag/js?id=G-TEST12345');
  assert.equal(page.scripts[0].async, true);
  const commands = page.commands();
  assert.deepEqual(commands.map(c => c[0]), ['js', 'config']);
  assert.equal(commands[1][1], 'G-TEST12345');
  const config = commands[1][2];
  assert.equal(config.send_page_view, true);
  assert.equal(config.allow_google_signals, false);
  assert.equal(config.allow_ad_personalization_signals, false);
  assert.equal(config.page_title, '夢の部屋');
});

test('頁面網址去掉查詢與片段，來源只保留網域，不送出訪客或聲音識別', () => {
  const page = setup(); page.run();
  const config = page.commands()[1][2];
  assert.equal(config.page_location, 'https://raindeercoffee.com/dream-room/');
  assert.equal(config.page_referrer, 'https://example.com');
  assert.deepEqual(Object.keys(config).sort(), ['allow_ad_personalization_signals', 'allow_google_signals', 'page_location', 'page_referrer', 'page_title', 'send_page_view'].sort());
  assert.doesNotMatch(JSON.stringify(config), /secret|token|private|sound|visitor|user_id/);
});

test('同頁再次執行不重複載入或計數', () => {
  const page = setup(); page.run(); page.run();
  assert.equal(page.scripts.length, 1);
  assert.equal(page.commands().length, 2);
});

for (const id of [null, '', 'G-', 'G-<YOUR_ID>', 'UA-123', 'G-bad', 'G-TEST?x=1']) {
  test(`沒有有效測量 ID 不載入：${String(id)}`, () => {
    const page = setup({ id }); page.run();
    assert.equal(page.scripts.length, 0);
    assert.equal(page.commands().length, 0);
  });
}

for (const url of ['http://raindeercoffee.com/dream-room/', 'http://127.0.0.1:8788/dream-room/', 'https://other.example/dream-room/', 'https://raindeercoffee.com/', 'https://raindeercoffee.com/dream-rooms/', 'https://raindeercoffee.com/dream-room']) {
  test(`其他來源或路徑不載入：${url}`, () => {
    const page = setup({ url }); page.run();
    assert.equal(page.scripts.length, 0);
    assert.equal(page.commands().length, 0);
  });
}

test('同子站關於頁也可統計，仍不帶查詢內容', () => {
  const page = setup({ url: 'https://raindeercoffee.com/dream-room/about.html?token=secret' }); page.run();
  assert.equal(page.commands()[1][2].page_location, 'https://raindeercoffee.com/dream-room/about.html');
});

for (const preference of [{ dnt: '1' }, { gpc: true }, { windowDnt: '1' }]) {
  test(`尊重不追蹤偏好：${JSON.stringify(preference)}`, () => {
    const page = setup(preference); page.run();
    assert.equal(page.scripts.length, 0);
    assert.equal(page.commands().length, 0);
  });
}

for (const referrer of ['', 'not a url', 'data:text/plain,secret', 'about:blank']) {
  test(`沒有一般網頁來源時不送出來源：${referrer}`, () => {
    const page = setup({ referrer }); page.run();
    assert.equal(page.commands()[1][2].page_referrer, '');
  });
}

test('載入被擋或插入失敗不丟錯，不影響其他程式', () => {
  const page = setup(); page.run();
  assert.doesNotThrow(() => page.scripts[0].onerror(new Error('blocked')));
  assert.doesNotThrow(() => setup({ appendError: true }).run());
});
