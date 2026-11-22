/* Izin notifikasi web + langganan Web Push.
 * Pasang dengan: <script src="/push.js" data-role="user|admin" defer></script>
 * Tombol/status manual: letakkan <div data-push-control></div> di halaman mana pun. */
(function () {
  'use strict';
  var me = document.currentScript;
  var ROLE = me && me.getAttribute('data-role') === 'admin' ? 'admin' : 'user';
  var UA = navigator.userAgent || '';
  var isIOS = /iPad|iPhone|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  var secure = window.isSecureContext;
  var supported = secure && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  var DISMISS_KEY = 'sp_dismiss_' + ROLE, DISMISS_MS = (ROLE === 'admin' ? 1 : 3) * 86400e3;
  var COPY = ROLE === 'admin'
    ? { title: 'Aktifkan notifikasi admin?', text: 'Pesanan baru, deposit, chat pelanggan & stok menipis langsung muncul di notifikasi HP kamu.' }
    : { title: 'Aktifkan notifikasi?', text: 'Dapatkan info status pesanan, saldo, balasan chat & promo langsung di notifikasi HP kamu.' };

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* abaikan */ } }
  function toU8(b64) {
    var s = (b64 + '==='.slice((b64.length + 3) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(s), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function toB64u(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function api(path, body) {
    return fetch(path, {
      method: body ? 'POST' : 'GET', credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Gagal (' + r.status + ')'); return j; }); });
  }

  var regP = null;
  function getReg() {
    if (!regP) regP = navigator.serviceWorker.register('/sw.js').then(function () { return navigator.serviceWorker.ready; });
    return regP;
  }
  function getSub() { return getReg().then(function (reg) { return reg.pushManager.getSubscription(); }); }

  // Daftarkan/perbarui langganan di server (juga memperbarui pemilik: tamu/pengguna/admin).
  function sync(welcome) {
    return Promise.all([getReg(), api('/api/push/key')]).then(function (r) {
      var reg = r[0], key = r[1].key;
      return reg.pushManager.getSubscription().then(function (sub) {
        if (sub && sub.options && sub.options.applicationServerKey && toB64u(sub.options.applicationServerKey) !== key) {
          return sub.unsubscribe().then(function () { return null; });   // kunci server berganti
        }
        return sub;
      }).then(function (sub) {
        return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toU8(key) });
      }).then(function (sub) {
        return api('/api/push/subscribe', { subscription: sub.toJSON(), role: ROLE, welcome: !!welcome }).then(function () { return sub; });
      });
    });
  }

  // Dipanggil dari klik tombol (wajib gestur pengguna). requestPermission sengaja dipanggil paling awal.
  function enable(welcome) {
    if (!supported) return Promise.reject(new Error(unsupportedReason()));
    var ask = Notification.permission === 'default' ? Notification.requestPermission() : Promise.resolve(Notification.permission);
    return Promise.resolve(ask).then(function (perm) {
      if (perm !== 'granted') { emit(); return perm; }
      return sync(welcome !== false).then(function () { emit(); return 'granted'; });
    });
  }
  function disable() {
    return getSub().then(function (sub) {
      if (!sub) return;
      var ep = sub.endpoint;
      return sub.unsubscribe().then(function () { return api('/api/push/unsubscribe', { endpoint: ep, role: ROLE }).catch(function () {}); });
    }).then(emit);
  }
  function test() {
    return getSub().then(function (sub) {
      if (!sub) throw new Error('Notifikasi belum aktif di perangkat ini');
      return api('/api/push/test', { endpoint: sub.endpoint, role: ROLE });
    });
  }
  function unsupportedReason() {
    if (!secure) return 'Notifikasi butuh koneksi aman (HTTPS).';
    if (isIOS && !standalone) return 'Di iPhone/iPad: ketuk Bagikan → "Tambah ke Layar Utama", lalu buka web dari ikon itu dan aktifkan notifikasi.';
    return 'Browser ini belum mendukung notifikasi web.';
  }
  function status() {
    if (!supported) return Promise.resolve({ state: 'unsupported', reason: unsupportedReason(), iosInstall: isIOS && !standalone });
    if (Notification.permission === 'denied') return Promise.resolve({ state: 'denied' });
    if (Notification.permission === 'default') return Promise.resolve({ state: 'default' });
    return getSub().then(function (sub) { return { state: sub ? 'on' : 'off' }; }).catch(function () { return { state: 'off' }; });
  }
  function emit() { try { window.dispatchEvent(new Event('sp:change')); } catch (e) { /* abaikan */ } }

  /* ---------- Gaya (netral, mengikuti warna teks halaman) ---------- */
  var css = document.createElement('style');
  css.textContent =
    '.sp-banner{position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));max-width:420px;margin:0 auto;z-index:2147483000;background:#fff;color:#0F172A;border:1px solid #E2E8F0;border-radius:16px;box-shadow:0 12px 40px rgba(15,23,42,.22);padding:14px;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;animation:spIn .35s cubic-bezier(.2,.9,.3,1.2)}' +
    '@keyframes spIn{from{opacity:0;transform:translateY(24px) scale(.97)}to{opacity:1;transform:none}}' +
    '.sp-banner .sp-row{display:flex;gap:12px;align-items:flex-start}' +
    '.sp-ico{flex:none;width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,#2563EB,#1E40AF);display:grid;place-items:center}' +
    '.sp-ico svg{width:22px;height:22px;stroke:#fff;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
    '.sp-t{font-weight:700;font-size:15px;margin:0 0 2px}.sp-d{margin:0;color:#475569;font-size:13px}' +
    '.sp-act{display:flex;gap:8px;margin-top:12px;justify-content:flex-end}' +
    '.sp-btn{appearance:none;border:1px solid #CBD5E1;background:transparent;color:inherit;border-radius:10px;padding:9px 14px;font:600 13px system-ui,sans-serif;cursor:pointer}' +
    '.sp-btn.pri{background:#2563EB;border-color:#2563EB;color:#fff}.sp-btn:disabled{opacity:.6;cursor:default}' +
    '.sp-ctl{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}' +
    '.sp-ctl .sp-info{flex:1 1 220px;min-width:0}.sp-ctl .sp-info b{display:block;font-size:14px}.sp-ctl .sp-info span{display:block;font-size:12.5px;opacity:.75;margin-top:2px}' +
    '.sp-ctl .sp-btns{display:flex;gap:8px;flex-wrap:wrap}' +
    '@media (prefers-color-scheme:dark){.sp-banner{background:#111827;color:#F1F5F9;border-color:#1F2937}.sp-d{color:#94A3B8}.sp-btn{border-color:#334155}}';
  document.head.appendChild(css);
  var BELL = '<svg viewBox="0 0 24 24"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';

  /* ---------- Banner minta izin ---------- */
  var banner = null;
  function closeBanner() { if (banner) { banner.remove(); banner = null; } }
  function dismissed() { var t = parseInt(lsGet(DISMISS_KEY) || '0', 10); return t && Date.now() - t < DISMISS_MS; }
  function showBanner(mode) {
    if (banner || dismissed()) return;
    banner = document.createElement('div'); banner.className = 'sp-banner'; banner.setAttribute('role', 'dialog'); banner.setAttribute('aria-label', 'Izin notifikasi');
    var ios = mode === 'ios';
    banner.innerHTML = '<div class="sp-row"><div class="sp-ico">' + BELL + '</div><div><p class="sp-t"></p><p class="sp-d"></p></div></div><div class="sp-act"><button type="button" class="sp-btn" data-x>' + (ios ? 'Mengerti' : 'Nanti') + '</button>' + (ios ? '' : '<button type="button" class="sp-btn pri" data-ok>Aktifkan</button>') + '</div>';
    banner.querySelector('.sp-t').textContent = ios ? 'Notifikasi di iPhone' : COPY.title;
    banner.querySelector('.sp-d').textContent = ios ? unsupportedReason() : COPY.text;
    document.body.appendChild(banner);
    banner.querySelector('[data-x]').onclick = function () { lsSet(DISMISS_KEY, String(Date.now())); closeBanner(); };
    var ok = banner.querySelector('[data-ok]');
    if (ok) ok.onclick = function () {
      ok.disabled = true; ok.textContent = 'Memproses…';
      enable(true).then(function (perm) {
        if (perm === 'granted') { banner.querySelector('.sp-t').textContent = 'Notifikasi aktif ✅'; banner.querySelector('.sp-d').textContent = 'Kamu akan menerima notifikasi di HP ini.'; banner.querySelector('.sp-act').remove(); setTimeout(closeBanner, 2200); }
        else if (perm === 'denied') { lsSet(DISMISS_KEY, String(Date.now())); closeBanner(); }
        else { ok.disabled = false; ok.textContent = 'Aktifkan'; }
      }).catch(function (e) { ok.disabled = false; ok.textContent = 'Coba lagi'; banner.querySelector('.sp-d').textContent = e.message || 'Gagal mengaktifkan notifikasi.'; });
    };
  }

  /* ---------- Kontrol manual (di halaman Akun / Pengaturan admin) ---------- */
  function renderControls() {
    var nodes = document.querySelectorAll('[data-push-control]');
    if (!nodes.length) return;
    status().then(function (st) {
      nodes.forEach(function (n) {
        var msg = { on: 'Aktif di perangkat ini — notifikasi masuk ke HP kamu.', off: 'Belum aktif di perangkat ini.', default: 'Aktifkan agar notifikasi masuk ke HP kamu.', denied: 'Diblokir di pengaturan browser. Buka pengaturan situs (ikon gembok) lalu izinkan Notifikasi.', unsupported: st.reason || '' }[st.state];
        n.innerHTML = '<div class="sp-ctl"><div class="sp-info"><b>Notifikasi HP</b><span></span></div><div class="sp-btns"></div></div>';
        n.querySelector('.sp-info span').textContent = msg;
        var box = n.querySelector('.sp-btns');
        function btn(label, cls, fn) {
          var b = document.createElement('button'); b.type = 'button'; b.className = 'sp-btn' + (cls ? ' ' + cls : ''); b.textContent = label;
          b.onclick = function () {
            b.disabled = true; var old = b.textContent; b.textContent = '…';
            Promise.resolve().then(fn).then(function (r) { if (r && r.__msg) { n.querySelector('.sp-info span').textContent = r.__msg; } }).catch(function (e) { n.querySelector('.sp-info span').textContent = e.message || 'Gagal.'; }).then(function () { b.disabled = false; b.textContent = old; });
          };
          box.appendChild(b);
        }
        if (st.state === 'default' || st.state === 'off') btn('Aktifkan', 'pri', function () { return enable(true); });
        if (st.state === 'on') {
          btn('Kirim tes', '', function () { return test().then(function (r) { return { __msg: r.ok ? 'Tes terkirim — cek notifikasi HP kamu.' : 'Tes gagal dikirim. Coba matikan lalu aktifkan lagi.' }; }); });
          btn('Matikan', '', disable);
        }
      });
    });
  }
  window.addEventListener('sp:change', renderControls);

  /* ---------- Pesan dari service worker ---------- */
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (e) {
      var d = e.data || {};
      if (d.type === 'push-open' && d.url) {
        var t; try { t = new URL(d.url, location.href); } catch (x) { return; }
        if (t.origin !== location.origin) return;
        if (t.pathname === location.pathname) {
          if (!t.hash) return;
          if (t.hash === location.hash) { try { history.replaceState(null, '', location.pathname + location.search); } catch (x) { /* abaikan */ } }
          location.hash = t.hash;   // memicu hashchange (buka chat / pindah tab)
        } else location.href = t.href;
      } else if (d.type === 'push-resubscribe' && Notification.permission === 'granted') { sync(false).catch(function () {}); }
    });
  }

  window.StorePush = { enable: enable, disable: disable, test: test, status: status, supported: supported, role: ROLE };

  function start() {
    renderControls();
    if (!supported) {
      if (isIOS && !standalone && secure) setTimeout(function () { showBanner('ios'); }, 3000);
      return;
    }
    getReg().catch(function () {});
    if (Notification.permission === 'granted') { sync(false).then(emit).catch(function () {}); return; }
    if (Notification.permission === 'default') setTimeout(function () { if (document.visibilityState === 'visible' && Notification.permission === 'default') showBanner('ask'); }, 3000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
