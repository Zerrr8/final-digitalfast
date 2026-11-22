/* Util pembayaran bersama (toko + halaman akun): QRIS, polling status, tampilan produk terkirim. */
(function () {
  const rp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const size = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    let j = {}; try { j = await r.json(); } catch {}
    if (!r.ok) throw Object.assign(new Error(j.error || 'Terjadi kesalahan, coba lagi.'), { status: r.status, data: j });
    return j;
  }

  // Daftar produk + tombol unduh / isi teks
  function deliveryHtml(order) {
    return '<div class="pay-items">' + order.items.map((it, i) => {
      let d = '';
      if (it.delivery && it.delivery.type === 'file')
        d = `<a class="pay-dl" href="${esc(it.delivery.url)}">⬇ Unduh ${esc(it.delivery.filename)} <small>(${size(it.delivery.size)})</small></a>`;
      else if (it.delivery && it.delivery.type === 'text')
        d = `<div class="pay-text"><pre id="pt-${esc(order.id)}-${i}">${esc(it.delivery.text)}</pre><button type="button" class="pay-copy" data-copy="pt-${esc(order.id)}-${i}">Salin</button></div>`;
      else if (it.manual) d = '<div class="pay-note">Produk ini dikirim manual oleh admin. Kami akan menghubungi Anda.</div>';
      return `<div class="pay-item"><div class="pay-item-h"><strong>${esc(it.name)}</strong><span>${it.qty} × ${rp(it.price)}</span></div>${d}</div>`;
    }).join('') + '</div>';
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.pay-copy'); if (!b) return;
    const el = document.getElementById(b.dataset.copy); if (!el) return;
    const done = () => { b.textContent = 'Tersalin ✓'; setTimeout(() => (b.textContent = 'Salin'), 1500); };
    if (navigator.clipboard) navigator.clipboard.writeText(el.textContent).then(done, () => {});
    else { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); try { document.execCommand('copy'); done(); } catch {} }
  });

  /**
   * Tampilkan QRIS di `el` dan pantau status.
   * kind: 'order' | 'deposit', v: view dari server, cb.onPaid(view, balance), cb.onEnd(view)
   * Mengembalikan fungsi stop().
   */
  function qris(el, kind, v, cb = {}) {
    let stopped = false, timer = null, tick = null;
    const url = () => (kind === 'order' ? '/api/orders/' : '/api/deposits/') + v.id;
    const exp = v.expiresAt ? Date.parse(v.expiresAt) : 0;
    el.innerHTML = `<div class="pay-qris">
      <div class="pay-total">Bayar tepat <strong>${rp(v.totalPay)}</strong></div>
      ${v.qrUrl ? `<img class="pay-qr" src="${esc(v.qrUrl)}" alt="QRIS" width="260" height="260">` : '<div class="pay-note">QR tidak tersedia, gunakan tombol di bawah.</div>'}
      <div class="pay-hint">Scan dengan aplikasi bank / e-wallet apa pun. Nominal harus sama persis (termasuk kode unik).</div>
      <div class="pay-count" id="pc-${esc(v.id)}"></div>
      <div class="pay-status" id="ps-${esc(v.id)}"><span class="pay-spin"></span> Menunggu pembayaran…</div>
      ${v.paymentUrl ? `<a class="pay-link" href="${esc(v.paymentUrl)}" target="_blank" rel="noopener">Buka halaman pembayaran</a>` : ''}
      ${v.test ? '<div class="pay-note">Mode uji coba (sandbox) — tidak ada uang asli.</div>' : ''}
      <button type="button" class="pay-check">Saya sudah bayar — cek status</button>
      <button type="button" class="pay-cancel">Batalkan pembayaran</button></div>`;
    const stat = el.querySelector('#ps-' + CSS.escape(v.id));
    const cnt = el.querySelector('#pc-' + CSS.escape(v.id));
    const render = () => {
      if (!exp || !cnt) return;
      const s = Math.max(0, Math.floor((exp - Date.now()) / 1000));
      cnt.textContent = s ? `Berlaku ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} lagi` : 'Waktu pembayaran habis';
    };
    render(); tick = setInterval(render, 1000);
    const stop = () => { stopped = true; clearTimeout(timer); clearInterval(tick); };
    const poll = async (manual) => {
      if (stopped) return;
      try {
        const j = await api('GET', url());
        const nv = j.order || j.deposit;
        if (nv.state === 'paid') { stop(); cb.onPaid && cb.onPaid(nv, j.balance); return; }
        if (nv.state === 'expired' || nv.state === 'failed') { stop(); stat.innerHTML = '⚠ Pembayaran ' + (nv.state === 'expired' ? 'kedaluwarsa' : 'gagal') + '. Silakan ulangi.'; cb.onEnd && cb.onEnd(nv); return; }
        if (manual) stat.innerHTML = '<span class="pay-spin"></span> Belum terdeteksi, menunggu pembayaran…';
      } catch (e) { if (e.status === 401) { stop(); location.href = '/login'; return; } }
      if (!stopped) timer = setTimeout(poll, 4000);
    };
    el.querySelector('.pay-check').addEventListener('click', () => { clearTimeout(timer); poll(true); });
    const cancelBtn = el.querySelector('.pay-cancel');
    cancelBtn.addEventListener('click', async () => {
      if (!confirm('Batalkan pembayaran ini?')) return;
      cancelBtn.disabled = true; cancelBtn.textContent = 'Membatalkan…';
      try {
        const j = await api('POST', url() + '/cancel');
        stop();
        cb.onCancel && cb.onCancel(j.order || j.deposit);
      } catch (e) {
        cancelBtn.disabled = false; cancelBtn.textContent = 'Batalkan pembayaran';
        if (e.status === 401) { stop(); location.href = '/login'; return; }
        stat.innerHTML = '⚠ ' + esc(e.message);
      }
    });
    timer = setTimeout(poll, 3000);
    return stop;
  }

  window.Pay = { rp, esc, api, qris, deliveryHtml, size };
})();
