// 分析工具與房間操作分開；未設定正式測量 ID、開發環境或隱私偏好開啟時不載入。
(() => {
  try {
    const id = document.querySelector('meta[name="ga-measurement-id"]')?.content?.trim();
    if (location.origin !== 'https://raindeercoffee.com' || !location.pathname.startsWith('/dream-room/')) return;
    if (!/^G-[A-Z0-9]+$/.test(id || '') || window.__dreamRoomAnalyticsStarted) return;
    if (navigator.globalPrivacyControl === true || navigator.doNotTrack === '1' || window.doNotTrack === '1') return;
    window.__dreamRoomAnalyticsStarted = true;
    let referrer = '';
    try {
      const source = new URL(document.referrer);
      if (source.protocol === 'https:' || source.protocol === 'http:') referrer = source.origin;
    } catch { /* 沒有或無效的來源網址不送出。 */ }
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', id, {
      send_page_view: true,
      page_title: document.title,
      page_location: location.origin + location.pathname,
      page_referrer: referrer,
      allow_google_signals: false,
      allow_ad_personalization_signals: false
    });
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
    script.onerror = () => {};
    document.head.append(script);
  } catch { /* 分析工具失敗不得中斷房間。 */ }
})();
