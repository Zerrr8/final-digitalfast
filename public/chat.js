/* ============ LIVE CHAT (widget toko) — realtime lewat Server-Sent Events ============ */
(function () {
    'use strict';
    const S = window.__STORE__ || {}, ST = S.settings || {};
    const brand = ST.storeName || 'Customer Support';
    const logo = ST.logo || '';
    const $ = (s, r) => (r || document).querySelector(s);
    const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const IC = {
        chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/></svg>',
        x: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
        send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>',
        clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>',
        play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
        ck1: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>',
        ck2: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 13l4 4L16 7"/><path d="M10 15l1 1L21 7"/></svg>'
    };

    const st = { msgs: [], adminSeen: 0, userSeen: 0, closed: false, online: false, open: false, unread: 0, user: null, es: null, loaded: false, tmp: 0, typingTimer: null, lastTyping: 0, pending: null, dirty: false };
    let root, fab, panel, body, typing, ta, sendBtn, badge, statEl, audio;

    function build() {
        root = document.createElement('div'); root.className = 'lc'; root.id = 'liveChat';
        const initial = esc(brand.charAt(0).toUpperCase());
        const fb = `onerror="this.replaceWith(document.createTextNode('${initial}'))"`;
        const av = logo ? `<img src="${esc(logo)}" alt="" ${fb}>` : initial;
        root.innerHTML = `
        <button type="button" class="lc-fab" id="lcFab" aria-label="Buka live chat">${IC.chat}<span class="t">Live Chat</span><span class="lc-badge lc-hide" id="lcBadge">0</span></button>
        <section class="lc-panel" id="lcPanel" role="dialog" aria-label="Live chat" hidden>
            <header class="lc-h">
                <div class="lc-av">${av}<i></i></div>
                <div class="lc-hi"><strong>${esc(brand)} Support</strong><span id="lcStat">Menghubungkan…</span></div>
                <button type="button" class="lc-x" id="lcX" aria-label="Tutup chat">${IC.x}</button>
            </header>
            <div class="lc-body" id="lcBody" aria-live="polite"></div>
            <div class="lc-typing lc-hide" id="lcTyping"><span class="d"><i></i><i></i><i></i></span><span>Admin sedang mengetik…</span></div>
            <div class="lc-pv lc-hide" id="lcPv"></div>
            <form class="lc-f" id="lcForm" autocomplete="off">
                <input type="file" id="lcFile" accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime,video/webm" hidden>
                <button type="button" class="lc-att" id="lcAtt" aria-label="Lampirkan foto atau video">${IC.clip}</button>
                <textarea id="lcTa" rows="1" maxlength="1000" placeholder="Tulis pesan…" aria-label="Tulis pesan"></textarea>
                <button type="submit" class="lc-send" id="lcSend" aria-label="Kirim" disabled>${IC.send}</button>
            </form>
        </section>`;
        document.body.appendChild(root);
        fab = $('#lcFab', root); panel = $('#lcPanel', root); body = $('#lcBody', root); typing = $('#lcTyping', root);
        ta = $('#lcTa', root); sendBtn = $('#lcSend', root); badge = $('#lcBadge', root); statEl = $('#lcStat', root);
        root._av = av;
        $('#lcAtt', root).onclick = () => $('#lcFile', root).click();
        $('#lcFile', root).onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) pick(f); };
        ['load', 'loadedmetadata'].forEach(ev => body.addEventListener(ev, () => { if (st.stick) body.scrollTop = body.scrollHeight; }, true));
        body.addEventListener('pause', flushDirty, true); body.addEventListener('ended', flushDirty, true);
        body.addEventListener('click', (e) => { const im = e.target.closest('img.lc-img'); if (im) lightbox(im.src); });
        fab.onclick = openPanel; $('#lcX', root).onclick = closePanel;
        $('#lcForm', root).onsubmit = (e) => { e.preventDefault(); submit(); };
        ta.addEventListener('input', () => { grow(); syncSend(); pingTyping(); });
        ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && st.open) closePanel(); });
        if (window.visualViewport) window.visualViewport.addEventListener('resize', fitViewport);
    }
    function fitViewport() { if (st.open && window.innerWidth <= 560) { panel.style.height = window.visualViewport.height + 'px'; scrollEnd(true); } else if (panel) panel.style.height = ''; }
    function grow() { ta.style.height = 'auto'; ta.style.height = Math.min(120, ta.scrollHeight) + 'px'; }
    let stickT = 0;
    const scrollEnd = (force) => { const near = body.scrollHeight - body.scrollTop - body.clientHeight < 140; if (force || near) { st.stick = true; clearTimeout(stickT); stickT = setTimeout(() => { st.stick = false; }, 4000); requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; }); } };

    /* ---------- util ---------- */
    const hhmm = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false }).replace('.', ':'); };
    function dayLabel(iso) {
        const d = new Date(iso), n = new Date(), s = (x) => x.toDateString();
        if (s(d) === s(n)) return 'Hari ini';
        const y = new Date(n); y.setDate(n.getDate() - 1); if (s(d) === s(y)) return 'Kemarin';
        return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
    }
    function beep() {
        try {
            audio = audio || new (window.AudioContext || window.webkitAudioContext)();
            const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime;
            o.type = 'sine'; o.frequency.setValueAtTime(880, t); o.frequency.exponentialRampToValueAtTime(1320, t + .12);
            g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.12, t + .02); g.gain.exponentialRampToValueAtTime(.0001, t + .28);
            o.connect(g); g.connect(audio.destination); o.start(t); o.stop(t + .3);
        } catch {}
    }
    async function req(method, url, data) {
        const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined, credentials: 'same-origin' });
        let j = {}; try { j = await r.json(); } catch {}
        if (!r.ok) throw Object.assign(new Error(j.error || 'Gagal'), { status: r.status });
        return j;
    }

    /* ---------- render ---------- */
    function render() {
        let html = '';
        if (!st.msgs.length) {
            const nm = st.user && st.user.name ? ', ' + esc(st.user.name.split(' ')[0]) : '';
            html += `<div class="lc-welcome"><div class="big">${root._av}</div><h3>Halo${nm}! 👋</h3><p>Ada yang bisa kami bantu? Tim ${esc(brand)} siap membantu Anda secara langsung.</p>
                <div class="lc-quick">${['Tanya produk', 'Status pesanan', 'Kendala pembayaran', 'Cara deposit saldo'].map(q => `<button type="button" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div></div>`;
        }
        let lastDay = '', prev = null;
        st.msgs.forEach((m, i) => {
            const dl = dayLabel(m.at);
            if (dl !== lastDay) { html += `<div class="lc-day">${esc(dl)}</div>`; lastDay = dl; prev = null; }
            const me = m.from === 'user', cont = prev && prev.from === m.from;
            const read = me && typeof m.id === 'number' && m.id <= st.adminSeen;
            const next = st.msgs[i + 1], last = !next || next.from !== m.from || dayLabel(next.at) !== dl;
            html += `<div class="lc-row ${me ? 'me' : ''} ${cont ? 'cont' : ''} ${m.failed ? 'fail' : ''}">${me ? '' : `<span class="lc-mini">${root._av}</span>`}<div class="lc-b ${m.att ? 'media' : ''}">${media(m)}${m.text ? `<div class="cap">${esc(m.text)}</div>` : ''}</div></div>`;
            if (last) {
                html += `<div class="lc-meta ${me ? 'me' : ''}" ${me ? '' : 'style="margin-left:40px"'}>${m.failed ? `<span class="err" data-retry="${esc(m.id)}">Gagal terkirim · Coba lagi</span>` : `<span>${hhmm(m.at)}</span>${me ? `<span class="${read ? 'rd' : ''}" title="${read ? 'Dibaca' : 'Terkirim'}">${typeof m.id !== 'number' ? '' : read ? IC.ck2 : IC.ck1}</span>` : ''}`}</div>`;
            }
            prev = m;
        });
        const lastM = st.msgs[st.msgs.length - 1];
        if (st.closed) html += `<div class="lc-note end">Percakapan ditandai selesai. Kirim pesan baru jika masih butuh bantuan.</div>`;
        else if (lastM && lastM.from === 'user' && !st.online) html += `<div class="lc-note">Admin sedang offline. Pesan Anda sudah tersimpan dan akan dibalas secepatnya.</div>`;
        if (playing()) { st.dirty = true; return; }
        st.dirty = false;
        body.innerHTML = html;
        body.querySelectorAll('[data-q]').forEach(b => b.onclick = () => send(b.dataset.q));
        body.querySelectorAll('[data-retry]').forEach(b => b.onclick = () => retry(b.dataset.retry));
    }
    function status() {
        root.classList.toggle('on', st.online);
        if (statEl) statEl.textContent = st.online ? 'Online · biasanya membalas dalam beberapa menit' : 'Offline · tinggalkan pesan, kami balas segera';
    }
    function setBadge() {
        badge.textContent = st.unread > 9 ? '9+' : st.unread;
        badge.classList.toggle('lc-hide', !st.unread);
    }

    /* ---------- data ---------- */
    function addMsg(m) {
        if (st.msgs.some(x => x.id === m.id)) return false;
        st.msgs.push(m); return true;
    }
    async function load() {
        try {
            const j = await req('GET', '/api/chat');
            st.msgs = j.messages; st.adminSeen = j.adminSeen; st.userSeen = j.userSeen; st.closed = j.closed; st.online = j.online; st.user = j.user;
            st.unread = st.msgs.filter(m => m.from === 'admin' && m.id > st.userSeen).length;
            st.loaded = true; setBadge(); status();
            if (st.msgs.length) connect();
            if (st.open) { render(); scrollEnd(true); markSeen(); }
        } catch {}
    }
    function connect() {
        if (st.es || !window.EventSource) return;
        const es = st.es = new EventSource('/api/chat/stream');
        let first = true;
        es.onopen = () => { if (!first) load(); first = false; };
        es.onmessage = (e) => { let ev; try { ev = JSON.parse(e.data); } catch { return; } onEvent(ev); };
        es.onerror = () => { if (es.readyState === 2) { st.es = null; } };
    }
    function onEvent(ev) {
        if (ev.type === 'hello' || ev.type === 'presence') { st.online = !!ev.online; status(); if (st.open) render(); return; }
        if (ev.type === 'msg') {
            const m = ev.msg;
            if (m.from === 'user') {   // gantikan pesan sementara milik kita sendiri
                const i = st.msgs.findIndex(x => typeof x.id !== 'number' && x.text === m.text && !!x.att === !!m.att && !x.failed);
                if (i >= 0) { if (st.msgs.some(x => x.id === m.id)) st.msgs.splice(i, 1); else st.msgs[i] = m; } else addMsg(m);
            } else {
                if (!addMsg(m)) return;
                hideTyping();
                st.closed = false;
                if (!st.open || document.hidden) { st.unread++; setBadge(); beep(); } else markSeen();
            }
            if (st.open) { render(); scrollEnd(m.from === 'user'); }
            return;
        }
        if (ev.type === 'seen') { st.adminSeen = Math.max(st.adminSeen, ev.upto); if (st.open) render(); return; }
        if (ev.type === 'typing') { showTyping(); return; }
        if (ev.type === 'closed') { st.closed = !!ev.closed; if (st.open) render(); return; }
        if (ev.type === 'reset') { st.msgs = []; st.unread = 0; st.closed = false; setBadge(); if (st.open) render(); }
    }
    function showTyping() { if (!st.open) return; typing.classList.remove('lc-hide'); scrollEnd(); clearTimeout(st.typingTimer); st.typingTimer = setTimeout(hideTyping, 4000); }
    function hideTyping() { typing.classList.add('lc-hide'); clearTimeout(st.typingTimer); }
    function pingTyping() { const n = Date.now(); if (n - st.lastTyping > 2500 && st.msgs.length) { st.lastTyping = n; req('POST', '/api/chat/typing').catch(() => {}); } }
    function markSeen() { if (st.unread || st.msgs.some(m => m.from === 'admin' && m.id > st.userSeen)) { st.unread = 0; setBadge(); const last = st.msgs.filter(m => m.from === 'admin').pop(); if (last) st.userSeen = last.id; req('POST', '/api/chat/seen').catch(() => {}); } }

    async function send(text) {
        text = String(text || '').trim(); if (!text) return;
        const m = { id: 't' + (++st.tmp), from: 'user', text, at: new Date().toISOString() };
        st.msgs.push(m); st.closed = false; render(); scrollEnd(true);
        connect(); await doSend(m);
    }
    async function doSend(m) {
        try {
            const j = m.file ? await upload(m) : await req('POST', '/api/chat/send', { text: m.text });
            const i = st.msgs.indexOf(m);
            if (st.msgs.some(x => x.id === j.msg.id)) { if (i >= 0) st.msgs.splice(i, 1); } else if (i >= 0) st.msgs[i] = j.msg;
            render(); scrollEnd(true);
        } catch (e) { m.failed = true; m.err = e.message; if (m.file) flash(e.message); render(); scrollEnd(true); }
    }
    function retry(id) { const m = st.msgs.find(x => x.id === id); if (m) { m.failed = false; render(); doSend(m); } }
    function submit() {
        const t = ta.value.trim(), f = st.pending;
        if (!t && !f) return;
        ta.value = ''; grow(); st.pending = null; renderPv(); syncSend(); ta.focus();
        if (f) sendFile(f, t); else send(t);
    }
    function syncSend() { sendBtn.disabled = !(ta.value.trim() || st.pending); }

    /* ---------- lampiran foto & video ---------- */
    const MB = 1048576, LIMIT = { image: 10, video: 50 };
    function kindOf(f) { return /^image\/(jpeg|png|gif|webp)$/.test(f.type) ? 'image' : /^video\/(mp4|quicktime|webm)$/.test(f.type) ? 'video' : ''; }
    const fmtSize = (n) => n >= MB ? (n / MB).toFixed(1) + ' MB' : Math.ceil(n / 1024) + ' KB';
    function flash(msg) { const n = document.createElement('div'); n.className = 'lc-note'; n.textContent = msg; n.style.cssText = 'position:absolute;left:12px;right:12px;bottom:76px;z-index:5;max-width:none;background:#FEE2E2;color:#991B1B'; panel.appendChild(n); setTimeout(() => n.remove(), 4000); }
    function pick(f) {
        const k = kindOf(f);
        if (!k) return flash('Format tidak didukung. Pilih foto (JPG, PNG, GIF, WebP) atau video (MP4, MOV, WebM).');
        if (f.size > LIMIT[k] * MB) return flash((k === 'image' ? 'Foto' : 'Video') + ' terlalu besar. Maksimal ' + LIMIT[k] + ' MB.');
        if (st.pending && st.pending.url) URL.revokeObjectURL(st.pending.url);
        st.pending = { file: f, type: k, url: URL.createObjectURL(f) }; renderPv(); syncSend(); ta.focus();
    }
    function renderPv() {
        const pv = $('#lcPv', root), p = st.pending;
        pv.classList.toggle('lc-hide', !p);
        if (!p) { pv.innerHTML = ''; return; }
        pv.innerHTML = `<div class="th">${p.type === 'image' ? `<img src="${p.url}" alt="">` : `<video src="${p.url}#t=0.1" muted playsinline preload="metadata"></video><span class="pl">${IC.play}</span>`}</div><div class="nm"><strong>${esc(p.file.name)}</strong><small>${p.type === 'image' ? 'Foto' : 'Video'} · ${fmtSize(p.file.size)}</small></div><button type="button" aria-label="Hapus lampiran">${IC.x}</button>`;
        pv.querySelector('button').onclick = () => { URL.revokeObjectURL(p.url); st.pending = null; renderPv(); syncSend(); };
    }
    function media(m) {
        if (!m.att) return '';
        const prog = m.uploading ? `<div class="up"><i data-p="${esc(m.id)}" style="width:${Math.round((m.progress || 0) * 100)}%"></i></div>` : '';
        if (m.att.type === 'video') return `<div class="mw"><video src="${esc(m.att.url)}" controls playsinline preload="metadata"></video>${prog}</div>`;
        return `<div class="mw"><img class="lc-img" src="${esc(m.att.url)}" alt="Foto" loading="lazy">${prog}</div>`;
    }
    const playing = () => [...body.querySelectorAll('video')].some(v => !v.paused && !v.ended);
    function flushDirty() { if (st.dirty && !playing()) { render(); } }
    function lightbox(src) {
        const o = document.createElement('div'); o.className = 'lc-lb';
        o.innerHTML = `<img src="${esc(src)}" alt=""><button type="button" aria-label="Tutup">${IC.x}</button>`;
        o.onclick = () => o.remove(); document.body.appendChild(o);
    }
    function sendFile(p, text) {
        const m = { id: 't' + (++st.tmp), from: 'user', text, at: new Date().toISOString(), att: { url: p.url, type: p.type }, file: p.file, uploading: true, progress: 0 };
        st.msgs.push(m); st.closed = false; render(); scrollEnd(true); connect(); doSend(m);
    }
    function upload(m) {
        m.uploading = true; m.progress = 0;
        return new Promise((resolve, reject) => {
            const x = new XMLHttpRequest();
            x.open('POST', '/api/chat/upload?text=' + encodeURIComponent(m.text || '')); x.withCredentials = true;
            x.setRequestHeader('Content-Type', m.file.type || 'application/octet-stream');
            x.upload.onprogress = (e) => { if (e.lengthComputable) { m.progress = e.loaded / e.total; const el = body.querySelector('[data-p="' + m.id + '"]'); if (el) el.style.width = Math.round(m.progress * 100) + '%'; } };
            x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch {} m.uploading = false; (x.status >= 200 && x.status < 300) ? resolve(j) : reject(Object.assign(new Error(j.error || 'Gagal mengunggah'), { status: x.status })); };
            x.onerror = () => { m.uploading = false; reject(new Error('Koneksi terputus')); };
            x.send(m.file);
        });
    }

    /* ---------- buka / tutup ---------- */
    function openPanel() {
        st.open = true; panel.hidden = false; panel.classList.remove('out'); fab.classList.add('gone');
        if (window.innerWidth <= 560) document.documentElement.classList.add('lc-lock');
        fitViewport(); render(); scrollEnd(true); connect();
        if (!st.loaded) load(); else markSeen();
        setTimeout(() => { if (window.innerWidth > 560) ta.focus(); }, 250);
    }
    function closePanel() {
        st.open = false; fab.classList.remove('gone'); document.documentElement.classList.remove('lc-lock'); hideTyping();
        panel.classList.add('out'); setTimeout(() => { if (!st.open) { panel.hidden = true; panel.classList.remove('out'); } }, 200);
    }
    window.LiveChat = { open: () => root && !st.open && openPanel(), close: () => root && st.open && closePanel() };

    function init() { build(); status(); load(); if (location.hash === '#chat') openPanel(); window.addEventListener('hashchange', () => { if (location.hash === '#chat') window.LiveChat.open(); }); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
