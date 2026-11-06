// 夢の部屋的語言：繁體中文（預設，原文就寫在 index.html）與日文。
// 靜態文字：index.html 用 data-i18n（內文）與 data-i18n-aria（無障礙說明）標記；
// 中文自動記住原本的內容，日文從下面的字典取。動態句子用 t()。

const STORE_KEY = 'dream-house-language';
export const LANGS = ['zh-Hant', 'ja'];

const p = (...parts) => parts.map(part => `<span class="phrase">${part}</span>`).join('');

// 日文：靜態文字（index.html）。
const JA_STATIC = {
  'intro': p('何も話さなくていい。', 'ただ、静かにそばにいる。'),
  'night-description': p('心のざわめきを、', 'そっと夜に沈めて。'),
  'mist-description': p('淡い青のなかで、', 'やすらかに。'),
  'footnote': `${p('ランダムで夢の玉になります ·')} ${p('アカウントも、', 'おしゃべりもありません。', 'でも、ひとつひとつが本当のぬくもりです')}`,
  'timer-title': '音の時間',
  'float-style-title': 'ただよい方',
  'switch-room': '別の場所で眠る',
  'scene-note': 'ひとつひとつの玉が、いまここにいる人です。',
  'orientation-hint': '横向きにすると、より美しく見られます',
  'help-title': 'よくある質問',
  'help-close': 'わかりました',
  'brightness-label': '画面の明るさ',
  'volume-label': '音量',
  'lang-label': '語言 · 言語',
  'help-list': `
        <dt>玉がただよわない、オーロラが動かない？</dt>
        <dd>スマホで「視差効果を減らす」がオンになっていると、画面の動きが止まります。オンのときは、自分の玉だけがゆっくりただよいます。<br />iPhone：設定 → アクセシビリティ → 動作 → 「視差効果を減らす」をオフ。<br />Android：設定 → ユーザー補助 → 「アニメーションを削除」をオフ（名前は機種によって違います）。<br />変更したら、このページを再読み込みしてください。</dd>
        <dt>横向きにしないとだめ？</dt>
        <dd>いいえ、縦向きのままでも部屋に入れます。横向きのほうが、星空と夢の玉がより美しく見えます。</dd>
        <dt>音が聞こえない？</dt>
        <dd>iPhone がサイレントモードのときは、Webページの音も鳴らないことがあります。サイレントを解除してください。右のスピーカーを押して、音量を少し上げることもできます。</dd>
        <dt>画面をロックしたり、ほかのアプリに切り替えたら音が止まった？</dt>
        <dd>スマホは電池を節約するため、裏にあるページの音を止めることがあります。聞き続けたいときは、このページを画面に出したままにしてください。</dd>
        <dt>タイマーって？</dt>
        <dd>右の時計を押して時間を選びます。時間が近づくと音がゆっくり小さくなって止まります。そのまま部屋にいても大丈夫です。</dd>
        <dt>画面がまぶしくて眠れない？</dt>
        <dd>左の太陽を押すと、画面を暗くできます。</dd>
        <dt>ボタンが消えた？</dt>
        <dd>しばらく操作しないと、ボタンは自動で隠れます。画面を一度タップすると戻ります。</dd>
        <dt>ほかの人から私は見える？</dt>
        <dd>みんなに見えるのは、ひとつの夢の玉だけ。名前もアカウントもなく、おしゃべりもできません。</dd>
        <dt>うっかり閉じたり、再読み込みしたら？</dt>
        <dd>30秒以内にこのページへ戻れば、もとの席はそのまま残っています。</dd>
        <dt>部屋が満室？</dt>
        <dd>各部屋は最大10人です。もうひとつの部屋を試すか、少し時間をおいてまた来てください。</dd>
      `
};
const JA_ARIA = {
  'go-home': '部屋を出て、入口に戻る',
  'room-info': '部屋の情報',
  'leave': '部屋を出る',
  'room-controls': 'しぐさ・明るさ・音',
  'modes': 'わたしの姿勢',
  'brightness': '画面の明るさ',
  'help': 'よくある質問',
  'sound-panel': '環境音を選ぶ',
  'volume': '音量',
  'float-style': 'ただよい方を選ぶ',
  'settings': '部屋の設定',
  'retry': '再接続',
  'orientation-hint': 'ヒント：横向きにすると、より美しく見られます。タップで閉じる',
  'lang-switch': '言語を選ぶ'
};

// 動態句子：兩種語言都寫在這裡。
const DYNAMIC = {
  'zh-Hant': {
    'sound.stream': '水流聲', 'sound.ocean': '海浪聲', 'sound.fire': '柴火聲', 'sound.noise': '白噪音', 'sound.mute': '靜音',
    'mode.sleep': '準備睡了 · 躺下', 'mode.float': '正在做夢 · 漂浮',
    'visitor': (mine, floating, reconnecting) => `${mine ? '我的夢球' : '另一位訪客'}，${floating ? '正在漂浮' : '已經躺下'}${reconnecting ? '，暫時斷線' : ''}`,
    'switch.aria': title => `換個地方入眠，前往${title}`,
    'alternate.aria': title => `試試${title}`,
    'count': (count, capacity) => `${count} / ${capacity}${count >= capacity ? ' · 已滿' : ''}`,
    'lobby.loading': '正在看看房間裡有多少人……',
    'lobby.allFull': '兩間房目前都滿了。可以稍後再來看看。',
    'lobby.open': '房門開著。挑一間，慢慢進來。',
    'lobby.error': '暫時讀不到最新人數。可以直接選房。',
    'wake.show': '顯示操作', 'wake.hide': '收起操作',
    'timer.option': value => value === '0' ? '持續' : `${value}分鐘`,
    'timer.optionAria': value => value === '0' ? '持續播放聲音' : `${value}分鐘後淡出聲音`,
    'noise.aria': (active, label, loading) => `選擇環境聲音，目前${active ? `${label}${loading ? '準備中' : '播放中'}` : '靜音'}`,
    'source.file': '聲音來自自備音檔。',
    'source.synth': label => `${label}由瀏覽器合成。`,
    'timer.aria': minutes => `聲音定時，目前${minutes ? `${minutes} 分鐘定時` : '持續播放'}`,
    'status.loading': '正在準備聲音。選靜音可以取消。',
    'status.timer': minutes => `本次設定 ${minutes} 分鐘定時，最後 30 秒慢慢淡出。`,
    'status.continuous': '持續播放，選靜音就能停止。',
    'status.off': source => `聲音已關閉。${source}`,
    'status.faded': '聲音已慢慢淡出。你可以繼續留在房間裡。',
    'status.unsupported': '這個瀏覽器無法播放聲音。房間仍然可以使用。',
    'status.fileFailed': '這個音檔暫時無法播放。請確認檔案與格式。',
    'status.synthFailed': '暫時無法播放聲音。再按一次可以重試。',
    'population': count => `${count}人在這裡`,
    'population.unknown': '—人在這裡',
    'terminal.takeover': '你已在另一個分頁進入這間房。這裡已停止，不會搶回位置。',
    'terminal.full': '這間房剛好住滿了。可以試試另一間，或返回入口。',
    'terminal.failed': '暫時沒能重新連線。可以重新連線，或返回入口再選房。',
    'room.entered': '已進入房間。操作會在閒置後收起。',
    'room.unstable': '連線暫時不穩定，正在試著回到房間……',
    'room.interrupted': '連線暫時中斷，正在找回位置。斷線的位置最多保留 30 秒。',
    'room.entering': '正在輕輕推開房門……',
    'room.reentering': '正在重新推開房門……',
    'scene.aria': title => `${title}陪睡房`,
    'floatStyle.float': '原地小圈圈', 'floatStyle.roam': '隨意飄',
    'floatStyle.aria': current => `漂浮型態，目前${current}`,
    'meta.description': '夢の部屋：不必交談，也可以安靜地待在一起。'
  },
  ja: {
    'sound.stream': '水の流れ', 'sound.ocean': '波の音', 'sound.fire': 'たき火の音', 'sound.noise': 'ホワイトノイズ', 'sound.mute': 'ミュート',
    'mode.sleep': 'もうすぐ眠る · 横になる', 'mode.float': '夢のなか · ただよう',
    'visitor': (mine, floating, reconnecting) => `${mine ? 'わたしの夢の玉' : 'ほかの訪問者'}、${floating ? 'ただよっています' : '横になっています'}${reconnecting ? '、一時的に接続が切れています' : ''}`,
    'switch.aria': title => `別の場所で眠る。${title}へ`,
    'alternate.aria': title => `${title}を試す`,
    'count': (count, capacity) => `${count} / ${capacity}${count >= capacity ? ' · 満室' : ''}`,
    'lobby.loading': '部屋の人数を確認しています……',
    'lobby.allFull': 'ふたつの部屋は、いまいっぱいです。少し時間をおいて、また来てください。',
    'lobby.open': '扉は開いています。お好きな部屋へ、ゆっくりどうぞ。',
    'lobby.error': '最新の人数を読み込めませんでした。そのまま部屋を選べます。',
    'wake.show': 'ボタンを表示', 'wake.hide': 'ボタンをしまう',
    'timer.option': value => value === '0' ? 'ずっと' : `${value}分`,
    'timer.optionAria': value => value === '0' ? 'ずっと音を流す' : `${value}分後に音をフェードアウト`,
    'noise.aria': (active, label, loading) => `環境音を選ぶ。いまは${active ? `${label}を${loading ? '準備中' : '再生中'}` : 'ミュート'}`,
    'source.file': '用意した音源を流しています。',
    'source.synth': label => `${label}はブラウザで合成しています。`,
    'timer.aria': minutes => `音のタイマー。いまは${minutes ? `${minutes}分` : 'ずっと再生'}`,
    'status.loading': '音を準備しています。ミュートを選ぶと取り消せます。',
    'status.timer': minutes => `${minutes}分のタイマーです。最後の30秒で、ゆっくり小さくなります。`,
    'status.continuous': 'ずっと流れます。ミュートを選ぶと止まります。',
    'status.off': source => `音はオフです。${source}`,
    'status.faded': '音はゆっくり消えました。このまま部屋にいて大丈夫です。',
    'status.unsupported': 'このブラウザでは音を流せません。部屋はそのまま使えます。',
    'status.fileFailed': 'この音源はいま再生できません。ファイルと形式を確認してください。',
    'status.synthFailed': 'いまは音を流せません。もう一度押すと再試行します。',
    'population': count => `${count}人がここに`,
    'population.unknown': '—人がここに',
    'terminal.takeover': '別のタブでこの部屋に入りました。こちらは止まっています。席を取り返すことはありません。',
    'terminal.full': 'この部屋はちょうど満室になりました。もうひとつの部屋を試すか、入口に戻ってください。',
    'terminal.failed': 'うまく再接続できませんでした。再接続するか、入口に戻って部屋を選び直してください。',
    'room.entered': '部屋に入りました。しばらく操作しないと、ボタンは隠れます。',
    'room.unstable': '接続が不安定です。部屋に戻ろうとしています……',
    'room.interrupted': '接続が途切れました。席を探しています。席は最大30秒とっておかれます。',
    'room.entering': 'そっと扉を開けています……',
    'room.reentering': 'もう一度、扉を開けています……',
    'scene.aria': title => `${title}の添い寝ルーム`,
    'floatStyle.float': 'その場でくるくる', 'floatStyle.roam': '気ままにただよう',
    'floatStyle.aria': current => `ただよい方。いまは${current}`,
    'meta.description': '夢の部屋：話さなくても、静かにそばにいられる場所。'
  }
};

function initialLanguage() {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (LANGS.includes(saved)) return saved;
  } catch { /* 無法存取就用預設 */ }
  const wanted = (navigator.languages || [navigator.language || '']).map(code => String(code).toLowerCase());
  return wanted.some(code => code.startsWith('ja')) ? 'ja' : 'zh-Hant';
}

export let lang = initialLanguage();

export function t(key, ...args) {
  const value = DYNAMIC[lang][key] ?? DYNAMIC['zh-Hant'][key];
  return typeof value === 'function' ? value(...args) : value;
}

const originalHtml = new WeakMap();
const originalAria = new WeakMap();
export function applyStaticText(root = document) {
  document.documentElement.lang = lang;
  for (const element of root.querySelectorAll('[data-i18n]')) {
    if (!originalHtml.has(element)) originalHtml.set(element, element.innerHTML);
    const ja = JA_STATIC[element.dataset.i18n];
    element.innerHTML = lang === 'ja' && ja != null ? ja : originalHtml.get(element);
  }
  for (const element of root.querySelectorAll('[data-i18n-aria]')) {
    if (!originalAria.has(element)) originalAria.set(element, element.getAttribute('aria-label'));
    const ja = JA_ARIA[element.dataset.i18nAria];
    element.setAttribute('aria-label', lang === 'ja' && ja != null ? ja : originalAria.get(element));
  }
  document.querySelector('meta[name="description"]')?.setAttribute('content', t('meta.description'));
  for (const button of root.querySelectorAll('[data-lang]')) button.setAttribute('aria-pressed', String(button.dataset.lang === lang));
}

export function setLanguage(next) {
  if (!LANGS.includes(next) || next === lang) return;
  lang = next;
  try { localStorage.setItem(STORE_KEY, next); } catch { /* 無法記住也照常切換 */ }
  applyStaticText();
  document.dispatchEvent(new CustomEvent('dream-language-change', { detail: { lang } }));
}
