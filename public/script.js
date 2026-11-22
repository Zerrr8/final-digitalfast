/* ============================================
   LUTHZZSTORE - PREMIUM LOGIC & ADMIN SYNC
   Complete E-commerce Functionality
   ============================================ */

// ============ DEFAULT DATA (Fallback) ============
const DEFAULT_PRODUCTS = [];

const DEFAULT_SETTINGS = {
    storeName: 'LuthzzStore',
    wa: '6281234567890',
    email: 'hello@luthzzstore.com',
    address: 'Indonesia',
    description: 'Produk Digital yang membantu mu untuk upgrade lebih profesional. Mau punya bisnis digital tapi gak bisa buat? Kami solusi anda. Hanya dengan 1 klik kamu bisa memulai bisnis mu sekarang!.',
    instagram: '', tiktok: '', facebook: '', youtube: '',
    logo: '', logoShowName: true
};

// ============ LOAD DATA FROM ADMIN (SYNC SYSTEM) ============
// Data dari server (database SQLite), disisipkan server.js ke window.__STORE__
const __STORE__ = window.__STORE__ || {};
let PRODUCTS = __STORE__.products || DEFAULT_PRODUCTS;
let BANNERS = (__STORE__.banners && __STORE__.banners.length) ? __STORE__.banners : DEFAULT_BANNERS;
let SETTINGS = { ...DEFAULT_SETTINGS, ...(__STORE__.settings || {}) };

// Website Categories (Static structure to ensure filter works perfectly)
// Kategori diambil dari database (dikelola di dashboard admin); jika kosong, pakai bawaan.
const CATEGORIES = (Array.isArray(__STORE__.categories) && __STORE__.categories.length)
    ? __STORE__.categories.map(c => ({ name: c.name, id: c.name }))
    : [{ name: "Software", id: "Software" }, { name: "Lainnya", id: "Lainnya" }];

// ============ CUSTOM SVG ICONS UNTUK KATEGORI ============
const CATEGORY_ICONS = {
    all: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`,
    Digital: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
    Elektronik: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>`,
    Accessories: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>`,
    Software: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
    Lainnya: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`
};

// ============ STATE MANAGEMENT ============
let state = {
    order: null,   // produk yang sedang dibeli (beli langsung, tanpa keranjang)
    currentCategory: 'all',
    currentSlide: 0,
    displayLimit: 8
};

// ============ UTILITY FUNCTIONS ============
const formatRupiah = (num) => 'Rp ' + num.toLocaleString('id-ID');
// Stok: 0 = tanpa batas (tidak ditampilkan), >0 = terbatas, <0 = habis. Produk custom: harga tidak ditentukan & tanpa stok.
const stockInfo = (p) => { const n = Number(p.stock) || 0; return { limited: !p.custom && n > 0, soldOut: !p.custom && n < 0, n }; };
const fmtRating = (r) => (Math.max(0, Math.min(5, Number(r) || 0))).toFixed(1).replace('.', ',');
const priceHtml = (p) => p.custom ? '<span class="price-tbd">Harga tidak ditentukan</span>' : formatRupiah(p.price);

// keranjang sudah dihapus — bersihkan sisa data lama di browser
try { localStorage.removeItem('luthzz_cart_v2'); } catch {}

const showToast = (title, message, type = 'success') => {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icons = {
        success: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
        error: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
        info: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
    };
    toast.innerHTML = `
        <div class="toast-icon">${icons[type]}</div>
        <div class="toast-content">
            <div class="toast-title">${title}</div>
            <div class="toast-message">${message}</div>
        </div>
    `;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.animation = 'toastIn 0.4s ease reverse';
        setTimeout(() => toast.remove(), 400);
    }, 3000);
};

// ============ APPLY SETTINGS TO DOM ============
function applySettingsToDOM() {
    // Update Page Title
    document.title = `${SETTINGS.storeName} — Produk Digital Andalan kalian`;
    
    // Update Logo Texts
    document.querySelectorAll('.logo-text').forEach(el => {
        if (el.innerHTML.includes('Luthzz')) {
            el.innerHTML = el.innerHTML.replace('Luthzz', SETTINGS.storeName.replace('Store', ''));
        }
    });
    
    // Logo gambar dari dashboard admin (Pengaturan)
    if (SETTINGS.logo) {
        document.querySelectorAll('.logo').forEach(a => {
            const svg = a.querySelector('.logo-svg');
            if (svg) {
                const img = document.createElement('img');
                img.className = 'logo-img'; img.alt = SETTINGS.storeName; img.src = SETTINGS.logo;
                img.onerror = () => { img.replaceWith(svg); const t = a.querySelector('.logo-text'); if (t) t.style.display = ''; };
                svg.replaceWith(img);
            }
            const t = a.querySelector('.logo-text');
            if (t && SETTINGS.logoShowName === false) t.style.display = 'none';
        });
        let fav = document.querySelector('link[rel="icon"]');
        if (!fav) { fav = document.createElement('link'); fav.rel = 'icon'; document.head.appendChild(fav); }
        fav.href = SETTINGS.logo;
    }

    // Update Descriptions
    const heroDesc = document.querySelector('.hero .hero-desc');
    if (heroDesc) heroDesc.textContent = SETTINGS.description;
    
    const footerDesc = document.querySelector('.footer-desc');
    if (footerDesc) footerDesc.textContent = SETTINGS.description;
    
    // Update Footer Contacts
    const footerContacts = document.querySelectorAll('.footer-contact li');
    if (footerContacts[0]) { const s = footerContacts[0].querySelector('span'); if (s) s.textContent = `+${SETTINGS.wa}`; }
    if (footerContacts[1]) { const s = footerContacts[1].querySelector('span'); if (s) s.textContent = SETTINGS.email; }
    if (footerContacts[2]) { const s = footerContacts[2].querySelector('span'); if (s) s.textContent = SETTINGS.address; }
    
    // Update Floating WhatsApp
    const floatWa = document.querySelector('.float-wa');
    if (floatWa) floatWa.href = `https://wa.me/${SETTINGS.wa}`;
    
    // Update Social Media Links
    const socialLinks = document.querySelectorAll('.social-links a');
    const socialKeys = ['instagram', 'tiktok', 'facebook', 'youtube'];
    socialKeys.forEach((key, i) => {
        if (socialLinks[i] && SETTINGS[key]) socialLinks[i].href = SETTINGS[key];
    });
    
    // Update Copyright
    const footerBottom = document.querySelector('.footer-bottom p');
    if (footerBottom) {
        footerBottom.innerHTML = `&copy; 2026 <strong>${SETTINGS.storeName}</strong>. All rights reserved. Made with <svg width="14" height="14" viewBox="0 0 24 24" fill="#2563EB" style="vertical-align: middle;"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg> by Luthzz`;
    }
}

// ============ BANNER PROMO 16:9 (dari dashboard admin) ============
function renderPromoBanner() {
    const sec = document.getElementById('promoBanner'), track = document.getElementById('promoTrack');
    const dots = document.getElementById('promoDots');
    const list = (__STORE__.promoBanners || []).filter(b => b && b.image);
    if (!sec || !track || !list.length) return;
    track.innerHTML = '';
    list.forEach((b, i) => {
        // Jika ada teks tombol -> hanya tombol yang bisa diklik; jika tidak, seluruh banner jadi link (seperti sebelumnya)
        const hasCta = !!(b.btnText && b.link), hasText = !!(b.title || b.alt || hasCta);
        const el = document.createElement(b.link && !hasCta ? 'a' : 'div');
        el.className = 'promo-slide' + (hasText ? ' has-text' : '');
        const ext = (a) => { if (/^https?:/i.test(b.link)) { a.target = '_blank'; a.rel = 'noopener'; } };
        if (b.link && !hasCta) { el.href = b.link; ext(el); }
        const im = document.createElement('img');
        im.src = b.image; im.alt = b.alt || 'Banner promo'; im.draggable = false;
        im.loading = i === 0 ? 'eager' : 'lazy'; im.decoding = 'async';
        im.onerror = () => { el.remove(); };
        el.appendChild(im);
        if (hasText) {
            const cap = document.createElement('div'); cap.className = 'promo-cap';
            if (b.title) { const h = document.createElement('h2'); h.className = 'promo-title'; h.textContent = b.title; cap.appendChild(h); }
            if (b.alt) { const p = document.createElement('p'); p.className = 'promo-desc'; p.textContent = b.alt; cap.appendChild(p); }
            if (hasCta) { const a = document.createElement('a'); a.className = 'promo-cta'; a.href = b.link; a.textContent = b.btnText; ext(a); a.insertAdjacentHTML('beforeend', '<span aria-hidden="true">&rarr;</span>'); cap.appendChild(a); }
            el.appendChild(cap);
        }
        track.appendChild(el);
    });
    sec.hidden = false;
    const n = list.length;
    if (n < 2) { sec.classList.add('single'); return; }
    let cur = 0, timer = null;
    const slides = () => track.children;
    dots.innerHTML = list.map((_, i) => `<button type="button" aria-label="Banner ${i + 1}" data-i="${i}"></button>`).join('');
    const mark = () => dots.querySelectorAll('button').forEach((d, i) => d.classList.toggle('active', i === cur));
    const go = (i) => { cur = (i + n) % n; track.scrollTo({ left: track.clientWidth * cur, behavior: 'smooth' }); mark(); };
    const play = () => { clearInterval(timer); timer = setInterval(() => go(cur + 1), 5000); };
    dots.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { go(parseInt(b.dataset.i, 10)); play(); } });
    document.getElementById('promoPrev').onclick = () => { go(cur - 1); play(); };
    document.getElementById('promoNext').onclick = () => { go(cur + 1); play(); };
    let st; track.addEventListener('scroll', () => {
        clearTimeout(st); st = setTimeout(() => {
            const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
            if (i !== cur && i >= 0 && i < slides().length) { cur = i; mark(); }
        }, 80);
    }, { passive: true });
    ['touchstart', 'mouseenter', 'focusin'].forEach(ev => sec.addEventListener(ev, () => clearInterval(timer), { passive: true }));
    ['touchend', 'mouseleave', 'focusout'].forEach(ev => sec.addEventListener(ev, play, { passive: true }));
    window.addEventListener('resize', () => { track.scrollTo({ left: track.clientWidth * cur, behavior: 'auto' }); });
    mark(); play();
}

// ============ RENDER HERO CAROUSEL ============
function renderHero() {
    const carousel = document.getElementById('heroCarousel');
    const indicators = document.getElementById('carouselIndicators');
    if (!carousel || !indicators) return;

    carousel.innerHTML = BANNERS.map((b, i) => `
        <div class="hero-slide ${i === 0 ? 'active' : ''}" data-index="${i}">
            <div class="hero-slide-bg" style="background-image: url('${b.bg}')"></div>
            <div class="hero-content">
                <span class="hero-tag">${b.tag || 'PROMO'}</span>
                <h1 class="hero-title">${b.title}</h1>
                <p class="hero-desc">${b.desc}</p>
                <a href="#products" class="hero-btn">
                    ${b.cta || 'Belanja Sekarang'} <i class="fa-solid fa-arrow-right"></i>
                </a>
            </div>
        </div>
    `).join('');

    indicators.innerHTML = BANNERS.map((_, i) => `
        <div class="indicator ${i === 0 ? 'active' : ''}" data-index="${i}"></div>
    `).join('');

    indicators.querySelectorAll('.indicator').forEach(ind => {
        ind.addEventListener('click', () => goToSlide(parseInt(ind.dataset.index)));
    });

    setInterval(() => {
        goToSlide((state.currentSlide + 1) % BANNERS.length);
    }, 5000);
}

function goToSlide(index) {
    state.currentSlide = index;
    document.querySelectorAll('.hero-slide').forEach((s, i) => s.classList.toggle('active', i === index));
    document.querySelectorAll('.indicator').forEach((ind, i) => ind.classList.toggle('active', i === index));
}

// ============ CUSTOM CURSOR (Desktop Only) ============
function initCursor() {
    if (window.matchMedia('(max-width: 1024px), (hover: none)').matches) return;
    const dot = document.getElementById('cursorDot');
    const ring = document.getElementById('cursorRing');
    if (!dot || !ring) return;
    let mouseX = 0, mouseY = 0, ringX = 0, ringY = 0;
    
    document.addEventListener('mousemove', (e) => {
        mouseX = e.clientX; mouseY = e.clientY;
        dot.style.left = mouseX + 'px'; dot.style.top = mouseY + 'px';
        dot.style.opacity = '1'; ring.style.opacity = '1';
    });
    
    const animateRing = () => {
        ringX += (mouseX - ringX) * 0.15; ringY += (mouseY - ringY) * 0.15;
        ring.style.left = ringX + 'px'; ring.style.top = ringY + 'px';
        requestAnimationFrame(animateRing);
    };
    animateRing();
    
    document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) { dot.style.opacity = '0'; ring.style.opacity = '0'; } });
    const hoverElements = 'a, button, .product-card, .category-item, .feature-card, input, select, textarea';
    document.addEventListener('mouseover', (e) => { if (e.target.closest(hoverElements)) ring.classList.add('hover'); });
    document.addEventListener('mouseout', (e) => { if (e.target.closest(hoverElements)) ring.classList.remove('hover'); });
}

// ============ MAGNETIC BUTTONS (Desktop Only) ============
function initMagneticButtons() {
    if (window.matchMedia('(max-width: 1024px)').matches) return;
    document.querySelectorAll('.btn-magnetic').forEach(btn => {
        btn.addEventListener('mousemove', (e) => {
            const rect = btn.getBoundingClientRect();
            btn.style.transform = `translate(${(e.clientX - rect.left - rect.width / 2) * 0.2}px, ${(e.clientY - rect.top - rect.height / 2) * 0.2}px)`;
        });
        btn.addEventListener('mouseleave', () => { btn.style.transform = ''; });
    });
}

// ============ SCROLL REVEAL ANIMATION ============
function initScrollReveal() {
    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry, i) => {
            if (entry.isIntersecting) {
                setTimeout(() => { entry.target.classList.add('visible'); }, i * 80);
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });
    document.querySelectorAll('.reveal-up, .reveal-scale').forEach(el => observer.observe(el));
}

// ============ NUMBER COUNTER ANIMATION ============
function initCounters() {
    const counters = document.querySelectorAll('.stat-number');
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const el = entry.target;
                const target = parseInt(el.dataset.target);
                const duration = 2000;
                const start = performance.now();
                const update = (now) => {
                    const progress = Math.min((now - start) / duration, 1);
                    const eased = 1 - Math.pow(1 - progress, 3);
                    el.textContent = Math.floor(eased * target).toLocaleString('id-ID') + (target === 99 ? '%' : '+');
                    if (progress < 1) requestAnimationFrame(update);
                };
                requestAnimationFrame(update);
                observer.unobserve(el);
            }
        });
    }, { threshold: 0.5 });
    counters.forEach(c => observer.observe(c));
}

// ============ RENDER CATEGORIES ============
function renderCategories() {
    const list = document.getElementById('categoryList');
    if (!list) return;
    const escA = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    list.innerHTML = CATEGORIES.map(cat => `
        <div class="category-item ${cat.id === state.currentCategory ? 'active' : ''}" data-category="${escA(cat.id)}">
            <div class="category-icon">${CATEGORY_ICONS[cat.id] || CATEGORY_ICONS.Lainnya}</div>
            <div class="category-name">${escA(cat.name)}</div>
        </div>
    `).join('');
    list.querySelectorAll('.category-item').forEach(item => {
        item.addEventListener('click', () => {
            state.currentCategory = state.currentCategory === item.dataset.category ? 'all' : item.dataset.category;
            state.displayLimit = 8;
            renderCategories();
            renderProducts();
        });
    });
}

// ============ RENDER PRODUCTS ============
function productCardHtml(p, i) {
    const badgeClass = p.badge === 'SALE' ? 'badge-sale' : p.badge === 'NEW' ? 'badge-new' : p.badge === 'BEST' ? 'badge-best' : '';
        return `
            <div class="product-card" data-id="${p.id}" style="animation-delay: ${i * 0.06}s">
                <div class="product-image">
                    ${p.badge ? `<span class="product-badge ${badgeClass}">${p.badge}</span>` : ''}
                    <button class="product-wishlist" onclick="event.stopPropagation(); showToast('Wishlist', 'Fitur segera hadir', 'info')">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                    </button>
                    <img src="${p.image}" alt="${p.name}" loading="lazy">
                </div>
                <div class="product-info">
                    <div class="product-category">${p.category}</div>
                    <h3 class="product-name">${p.name}</h3>
                    <div class="product-rating">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                        <span>${fmtRating(p.rating)}</span>${p.custom ? '<span>• Custom Order</span>' : stockInfo(p).soldOut ? '<span class="stock-out">• Stok habis</span>' : stockInfo(p).limited ? `<span>• Stok ${p.stock}</span>` : ''}
                    </div>
                    <div class="product-price-wrap">
                        <div class="product-price">${priceHtml(p)}</div>
                        ${!p.custom && p.oldPrice ? `<div class="product-price-old">${formatRupiah(p.oldPrice)}</div>` : ''}
                    </div>
                    <button class="product-add-btn" onclick="event.stopPropagation(); buyNow(${p.id})">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                        ${p.custom ? 'Request Custom' : stockInfo(p).soldOut ? 'Stok Habis' : 'Beli Sekarang'}
                    </button>
                </div>
            </div>
        `;
}

function renderProducts() {
    const grid = document.getElementById('productGrid');
    const empty = document.getElementById('emptyState');
    const loadMoreWrap = document.getElementById('loadMoreWrap');
    const title = document.getElementById('productsTitle');
    if (!grid) return;

    let filtered = [...PRODUCTS];
    if (state.currentCategory !== 'all') filtered = filtered.filter(p => p.category === state.currentCategory);
    
    title.textContent = state.currentCategory !== 'all' ? `Kategori: ${CATEGORIES.find(c => c.id === state.currentCategory)?.name}` : 'Produk Tersedia';

    if (filtered.length === 0) {
        grid.innerHTML = ''; empty.style.display = 'block'; loadMoreWrap.style.display = 'none'; return;
    }
    empty.style.display = 'none';
    const displayed = filtered.slice(0, state.displayLimit);

    grid.innerHTML = displayed.map((p, i) => productCardHtml(p, i)).join('');

    loadMoreWrap.style.display = filtered.length > state.displayLimit ? 'block' : 'none';
    grid.querySelectorAll('.product-card').forEach(card => {
        card.addEventListener('click', () => openProductModal(parseInt(card.dataset.id)));
    });
    initMagneticButtons();
}

// ============ PRODUCT DETAIL MODAL ============
function openProductModal(id) {
    const product = PRODUCTS.find(p => p.id === id);
    if (!product) return;
    const modal = document.getElementById('productModal');
    const body = document.getElementById('modalBody');
    const esc = (typeof Pay !== 'undefined' && Pay.esc) ? Pay.esc : (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
    const si = stockInfo(product), custom = !!product.custom;
    const stock = si.n;
    const maxQty = si.limited ? Math.max(1, Math.min(99, stock)) : 99;
    const hasOld = !custom && product.oldPrice && product.oldPrice > product.price;
    const pct = hasOld ? Math.round((1 - product.price / product.oldPrice) * 100) : 0;
    const rating = Math.max(0, Math.min(5, Number(product.rating) || 0));
    const starSvg = on => `<svg class="pm-star${on ? ' on' : ''}" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
    const stars = [1, 2, 3, 4, 5].map(i => starSvg(i <= Math.round(rating))).join('');
    const name = esc(product.name), initial = esc(String(product.name || '?').trim().charAt(0).toUpperCase() || '?');
    const stockTone = si.soldOut ? 'out' : stock <= 10 ? 'low' : 'ok';
    const stockText = si.soldOut ? 'Stok habis' : stock <= 10 ? `Tersisa ${stock} pcs` : `${stock.toLocaleString('id-ID')} pcs`;
    const icon = {
        star: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
        box: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
        bolt: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>'
    };
    body.innerHTML = `
        <div class="pm-gallery">
            <div class="pm-ph">${initial}</div>
            ${product.image ? `<img class="pm-bg" src="${esc(product.image)}" alt="" aria-hidden="true" onerror="this.remove()"><img class="pm-img" src="${esc(product.image)}" alt="${name}" onerror="this.remove()">` : ''}
            <div class="pm-tags">
                ${product.badge ? `<span class="pm-chip pm-chip-badge">${esc(product.badge)}</span>` : ''}
                ${pct > 0 ? `<span class="pm-chip pm-chip-off">-${pct}%</span>` : ''}
            </div>
        </div>
        <div class="pm-info">
            <div class="pm-scroll">
                <div class="pm-cat">${esc(product.category)}</div>
                <h2 class="pm-title">${name}</h2>
                <div class="pm-rate">
                    <span class="pm-stars">${stars}</span>
                    <b>${fmtRating(rating)}</b><span class="pm-rate-of">/ 5,0</span>
                </div>
                <div class="pm-price">
                    <span class="pm-price-now${custom ? ' pm-price-tbd' : ''}">${custom ? 'Harga tidak ditentukan' : formatRupiah(product.price)}</span>
                    ${hasOld ? `<span class="pm-price-old">${formatRupiah(product.oldPrice)}</span><span class="pm-save">Hemat ${formatRupiah(product.oldPrice - product.price)}</span>` : ''}
                </div>
                <div class="pm-facts">
                    <div class="pm-fact"><span class="pm-fact-ic">${icon.star}</span><div><small>Rating</small><b>${fmtRating(rating)} / 5</b></div></div>
                    ${custom ? `<div class="pm-fact pm-fact-ok"><span class="pm-fact-ic">${icon.bolt}</span><div><small>Tipe</small><b>Custom Order</b></div></div>` : (si.limited || si.soldOut) ? `<div class="pm-fact pm-fact-${stockTone}"><span class="pm-fact-ic">${icon.box}</span><div><small>Stok</small><b>${stockText}</b></div></div>` : ''}
                    ${product.digital && !custom ? `<div class="pm-fact pm-fact-ok"><span class="pm-fact-ic">${icon.bolt}</span><div><small>Pengiriman</small><b>Otomatis</b></div></div>` : ''}
                </div>
                <div class="pm-sec">
                    <h4>Deskripsi</h4>
                    <p>${esc(product.description || 'Belum ada deskripsi untuk produk ini.')}</p>
                </div>
                ${custom ? `<div class="pm-note">${icon.bolt}<span>Produk custom — harga ditentukan setelah Anda mengisi form request (nama, fitur, kontak). Admin akan menghubungi Anda untuk kesepakatan harga.</span></div>` : ''}
                ${product.digital && !custom ? `<div class="pm-note">${icon.bolt}<span>Produk digital — dikirim otomatis setelah pembayaran berhasil.</span></div>` : ''}
            </div>
            <div class="pm-bar">
                ${custom ? '' : `<div class="pm-bar-row">
                    <div class="pm-total"><small>Total</small><b id="modalTotal">${formatRupiah(product.price)}</b></div>
                    <div class="pm-step" ${si.soldOut ? 'data-off="1"' : ''}>
                        <button type="button" class="pm-step-btn" id="modalQtyMinus" aria-label="Kurangi jumlah" onclick="changeModalQty(-1)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
                        <span class="pm-step-val" id="modalQty" data-max="${maxQty}" data-price="${product.price}" aria-live="polite">1</span>
                        <button type="button" class="pm-step-btn" id="modalQtyPlus" aria-label="Tambah jumlah" onclick="changeModalQty(1)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
                    </div>
                </div>`}
                <button class="btn-magnetic btn-primary pm-buy" ${si.soldOut ? 'disabled' : ''} onclick="buyNow(${product.id}, ${custom ? 1 : 'getModalQty()'})">
                    <span>${custom ? 'Request / Pesan Custom' : si.soldOut ? 'Stok Habis' : 'Beli Sekarang'}</span>
                    ${si.soldOut ? '' : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>'}
                </button>
            </div>
        </div>
    `;
    body.querySelector('.pm-scroll').scrollTop = 0;
    changeModalQty(0);
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
    initMagneticButtons();
}

function getModalQty() { const el = document.getElementById('modalQty'); return el ? parseInt(el.textContent) : 1; }
function changeModalQty(delta) {
    const el = document.getElementById('modalQty'); if (!el) return;
    const max = Math.min(99, parseInt(el.dataset.max) || 99);
    const val = Math.max(1, Math.min(max, (parseInt(el.textContent) || 1) + delta));
    el.textContent = val;
    const total = document.getElementById('modalTotal');
    if (total) total.textContent = formatRupiah((Number(el.dataset.price) || 0) * val);
    const minus = document.getElementById('modalQtyMinus'), plus = document.getElementById('modalQtyPlus');
    if (minus) minus.disabled = val <= 1;
    if (plus) plus.disabled = val >= max;
    if (delta) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
}
function closeModal(id) { const modal = document.getElementById(id); if (modal) { modal.classList.remove('active'); document.body.style.overflow = ''; } }
function buyNow(id, qty = 1) {
    const product = PRODUCTS.find(p => p.id === id); if (!product) return;
    if (product.custom) { closeModal('productModal'); openCustomRequest(product.id); return; }
    if (stockInfo(product).soldOut) { showToast('Stok Habis', `${product.name} sedang habis`, 'error'); return; }
    state.order = [{ id: product.id, name: product.name, price: product.price, image: product.image, qty: Math.max(1, Math.min(99, qty | 0 || 1)) }];
    closeModal('productModal');
    openCheckout();
}

// ============ CHECKOUT ============
function openCheckout() {
    const items = state.order || [];
    if (items.length === 0) return;
    const total = items.reduce((sum, item) => sum + (item.price * item.qty), 0);
    const cu = __STORE__.user; const pay = __STORE__.pay || {};
    document.getElementById('coTitle').textContent = 'Checkout Pesanan';
    document.getElementById('coSub').textContent = 'Produk digital dikirim otomatis setelah pembayaran berhasil';
    document.getElementById('checkoutForm').style.display = '';
    const res = document.getElementById('coResult'); res.style.display = 'none'; res.innerHTML = '';
    document.getElementById('coErr').textContent = '';
    document.getElementById('coList').innerHTML = items.map(i => `<div class="co-row"><span>${Pay.esc(i.name)} × ${i.qty}</span><strong>${formatRupiah(i.price * i.qty)}</strong></div>`).join('');
    document.getElementById('coSubtotal').textContent = formatRupiah(total);
    document.getElementById('coTotal').textContent = formatRupiah(total);
    const btn = document.getElementById('coSubmit'); btn.disabled = false;
    const bal = document.getElementById('coBal'); const how = document.getElementById('coHow');
    if (!cu) {
        bal.innerHTML = '<span>Anda belum masuk</span><a href="/login?next=/">Masuk / Daftar</a>';
        how.textContent = 'Masuk dulu agar produk yang dibeli tersimpan di akun Anda dan bisa diunduh kapan saja.';
        btn.querySelector('span').textContent = 'Masuk untuk Membayar';
    } else {
        bal.innerHTML = `<span>Saldo Anda: <strong>${formatRupiah(cu.balance || 0)}</strong></span><a href="/account#saldo">+ Deposit</a>`;
        if ((cu.balance || 0) >= total) { how.textContent = 'Saldo cukup — pembayaran dipotong dari saldo dan produk langsung terkirim.'; btn.querySelector('span').textContent = 'Bayar dengan Saldo'; }
        else if (pay.qris) { how.textContent = 'Saldo tidak cukup — akan dibuatkan pembayaran QRIS langsung. Produk terkirim otomatis begitu pembayaran terdeteksi.'; btn.querySelector('span').textContent = 'Bayar via QRIS'; }
        else { how.textContent = 'Saldo tidak cukup. Silakan deposit dulu.'; btn.querySelector('span').textContent = 'Bayar Sekarang'; }
    }
    document.getElementById('checkoutModal').classList.add('active'); document.body.style.overflow = 'hidden';
}

let stopQris = null;
function showPaid(order, balance) {
    if (stopQris) { stopQris(); stopQris = null; }
    if (typeof balance === 'number' && __STORE__.user) __STORE__.user.balance = balance;
    document.getElementById('checkoutForm').style.display = 'none';
    document.getElementById('coTitle').textContent = 'Pembayaran Berhasil';
    document.getElementById('coSub').textContent = `Pesanan ${order.id} — produk Anda sudah tersedia di bawah dan di menu Akun.`;
    const res = document.getElementById('coResult'); res.style.display = 'block';
    res.innerHTML = '<div class="pay-ok">✓ Lunas</div>' + Pay.deliveryHtml(order) + '<a class="pay-link" href="/account#orders" style="text-align:center;margin-top:10px">Lihat semua pesanan saya</a>';
    state.order = null;
    showToast('Pembayaran Berhasil!', 'Produk terkirim otomatis', 'success');
}

async function submitCheckout(e) {
    e.preventDefault();
    const cu = __STORE__.user;
    if (!cu) { location.href = '/login?next=/'; return; }
    const btn = document.getElementById('coSubmit'); const err = document.getElementById('coErr');
    err.textContent = ''; btn.disabled = true;
    try {
        const j = await Pay.api('POST', '/api/checkout', { items: (state.order || []).map(i => ({ id: i.id, qty: i.qty })) });
        if (j.paid) return showPaid(j.order, j.balance);
        document.getElementById('checkoutForm').style.display = 'none';
        document.getElementById('coTitle').textContent = 'Bayar dengan QRIS';
        document.getElementById('coSub').textContent = `Pesanan ${j.order.id}`;
        const res = document.getElementById('coResult'); res.style.display = 'block';
        stopQris = Pay.qris(res, 'order', j.order, {
            onPaid: showPaid,
            onEnd: () => { btn.disabled = false; },
            onCancel: () => {
                stopQris = null; btn.disabled = false;
                res.style.display = 'none'; res.innerHTML = '';
                document.getElementById('checkoutForm').style.display = '';
                document.getElementById('coTitle').textContent = 'Checkout Pesanan';
                document.getElementById('coSub').textContent = 'Produk digital dikirim otomatis setelah pembayaran berhasil';
                closeModal('checkoutModal');
                showToast('Pembayaran dibatalkan', 'Pesanan dibatalkan', 'success');
            }
        });
    } catch (ex) {
        if (ex.status === 401) { location.href = '/login?next=/'; return; }
        err.textContent = ex.message; btn.disabled = false;
    }
}

// ============ AKUN PENGGUNA (navbar) ============
function initAuth() {
    const btn = document.getElementById('authBtn');
    const u = __STORE__.user;
    if (!btn || !u) return;
    const first = (u.name || u.email).split(' ')[0];
    const wrap = document.createElement('div');
    wrap.className = 'user-menu';
    const av = u.picture
        ? `<img src="${u.picture.replace(/"/g, '')}" alt="" referrerpolicy="no-referrer">`
        : `<span class="user-ini">${first.charAt(0).toUpperCase().replace(/[<>&]/g, '')}</span>`;
    wrap.innerHTML = `<button type="button" class="user-btn" aria-haspopup="true" aria-expanded="false">${av}<span class="user-name"></span></button>
        <div class="user-drop"><div class="user-info"><strong></strong><small></small></div><a class="user-link" href="/account">Profile</a><button type="button" class="user-out">Keluar</button></div>`;
    wrap.querySelector('.user-name').textContent = first;
    wrap.querySelector('.user-info strong').textContent = u.name;
    wrap.querySelector('.user-info small').textContent = u.email;
    btn.replaceWith(wrap);
    const tg = wrap.querySelector('.user-btn');
    tg.addEventListener('click', (e) => { e.stopPropagation(); const o = wrap.classList.toggle('open'); tg.setAttribute('aria-expanded', o); });
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) wrap.classList.remove('open'); });
    wrap.querySelector('.user-out').addEventListener('click', async () => {
        try { await fetch('/api/user/logout', { method: 'POST' }); } catch {}
        location.reload();
    });
}


// ============ POPUP PENGUMUMAN ============
function initAnnouncements() {
    const overlay = document.getElementById('announcementOverlay');
    if (!overlay) return;
    const list = Array.isArray(__STORE__.announcements) ? __STORE__.announcements : [];
    if (!list.length) return;

    const modal = document.getElementById('announcementModal');
    const img = document.getElementById('annImage');
    const readBtn = document.getElementById('annReadBtn');
    const cta = document.getElementById('annCtaLink');
    const LABELS = { info: 'Info', success: 'Kabar Baik', warning: 'Penting', promo: 'Promo' };
    const ICONS = {
        info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>',
        success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/></svg>',
        warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
        promo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><path d="M7.5 7.5h.01"/></svg>'
    };
    const keyOf = (a) => a.id + ':' + (a.updatedAt || '');   // diedit admin -> muncul lagi
    const load = (store, k, d) => { try { return JSON.parse(store.getItem(k)) || d; } catch { return d; } };
    const save = (store, k, v) => { try { store.setItem(k, JSON.stringify(v)); } catch {} };

    const eligible = () => {
        const read = load(localStorage, 'ann_read', {}), snooze = load(localStorage, 'ann_snooze', {}), seen = load(sessionStorage, 'ann_seen', {});
        const now = Date.now();
        return list.filter(a => { const k = keyOf(a); return !read[k] && !(snooze[k] > now) && !seen[k]; });
    };
    // muat gambar dulu supaya popup tidak "loncat" saat gambar selesai dimuat
    const preload = (src) => new Promise((resolve) => {
        if (!src) return resolve(false);
        const im = new Image(); const to = setTimeout(() => resolve(false), 3500);
        im.onload = () => { clearTimeout(to); resolve(true); };
        im.onerror = () => { clearTimeout(to); resolve(false); };
        im.src = src;
    });

    let current = null, busy = false;
    const close = (how) => {
        if (!current) return;
        const k = keyOf(current);
        if (how === 'read') { const r = load(localStorage, 'ann_read', {}); r[k] = 1; save(localStorage, 'ann_read', r); }
        else if (how === 'snooze') { const s = load(localStorage, 'ann_snooze', {}); s[k] = Date.now() + 3 * 3600 * 1000; save(localStorage, 'ann_snooze', s); }
        const seen = load(sessionStorage, 'ann_seen', {}); seen[k] = 1; save(sessionStorage, 'ann_seen', seen);
        current = null;
        overlay.classList.remove('active'); document.body.style.overflow = '';
        setTimeout(next, 600);
    };

    const show = (a, hasImage) => {
        current = a;
        const type = LABELS[a.type] ? a.type : 'info';
        modal.className = 'announcement-modal type-' + type + (hasImage ? ' has-image' : '');
        document.getElementById('annIcon').innerHTML = '<span>' + ICONS[type] + '</span>';
        if (hasImage) img.src = a.image; else img.removeAttribute('src');
        document.getElementById('annTypeBadge').textContent = LABELS[type];
        document.getElementById('annTitle').textContent = a.title;
        document.getElementById('annMessage').textContent = a.message;
        if (a.ctaUrl) {
            document.getElementById('annCtaText').textContent = a.ctaText || 'Lihat Detail';
            cta.href = a.ctaUrl; cta.style.display = '';
            if (/^(https?:)?\/\//i.test(a.ctaUrl)) { cta.target = '_blank'; cta.rel = 'noopener'; } else { cta.removeAttribute('target'); cta.removeAttribute('rel'); }
            readBtn.className = 'ann-btn ann-btn-secondary';     // CTA jadi tombol utama
        } else { cta.style.display = 'none'; readBtn.className = 'ann-btn ann-btn-primary'; }
        modal.scrollTop = 0;
        overlay.classList.add('active'); document.body.style.overflow = 'hidden';
    };

    const next = async () => {
        if (current || busy) return;
        const a = eligible()[0]; if (!a) return;
        busy = true;
        const ok = await preload(a.image);
        busy = false;
        if (!current) show(a, ok);
    };

    readBtn.addEventListener('click', () => close('read'));
    document.getElementById('annSnoozeBtn').addEventListener('click', () => close('snooze'));
    document.getElementById('announcementClose').addEventListener('click', () => close('close'));
    cta.addEventListener('click', () => close('read'));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close('close'); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && current) close('close'); });

    setTimeout(next, 1200);
}

// ============ INITIALIZATION ============
document.addEventListener('DOMContentLoaded', () => {
    // Apply Admin Settings & Render Hero
    applySettingsToDOM();
    initAuth();
    renderPromoBanner();
    renderHero();
    initAnnouncements();
    
    // Initial render
    renderCategories();
    renderProducts();
    
    // Init effects
    initCursor();
    initMagneticButtons();
    setTimeout(() => { initScrollReveal(); initCounters(); }, 100);
    
    // Navbar scroll effect
    window.addEventListener('scroll', () => {
        const navbar = document.getElementById('navbar'); const backToTop = document.getElementById('backToTop');
        if (navbar) navbar.classList.toggle('scrolled', window.scrollY > 50);
        if (backToTop) backToTop.classList.toggle('visible', window.scrollY > 400);
    });
    
    // Mobile search toggle
    const searchToggle = document.getElementById('searchToggle'); const mobileSearch = document.getElementById('mobileSearch'); const searchInput = document.getElementById('searchInput');
    if (searchToggle && mobileSearch) searchToggle.addEventListener('click', () => { mobileSearch.classList.toggle('active'); if (mobileSearch.classList.contains('active') && searchInput) searchInput.focus(); });
    
    // Search functionality
    const handleSearch = (value) => {
        if (value.trim() === '') { state.currentCategory = 'all'; renderCategories(); renderProducts(); return; }
        const grid = document.getElementById('productGrid'); const empty = document.getElementById('emptyState'); const loadMoreWrap = document.getElementById('loadMoreWrap'); const title = document.getElementById('productsTitle');
        const filtered = PRODUCTS.filter(p => p.name.toLowerCase().includes(value.toLowerCase()) || p.category.toLowerCase().includes(value.toLowerCase()));
        title.textContent = `Hasil: "${value}"`;
        if (filtered.length === 0) { grid.innerHTML = ''; empty.style.display = 'block'; loadMoreWrap.style.display = 'none'; return; }
        empty.style.display = 'none'; loadMoreWrap.style.display = 'none';
        grid.innerHTML = filtered.map((p, i) => productCardHtml(p, i)).join('');
        grid.querySelectorAll('.product-card').forEach(card => card.addEventListener('click', () => openProductModal(parseInt(card.dataset.id))));
    };
    if (searchInput) searchInput.addEventListener('input', (e) => handleSearch(e.target.value));
    const clearSearch = document.getElementById('clearSearch');
    if (clearSearch) clearSearch.addEventListener('click', () => { if (searchInput) searchInput.value = ''; state.currentCategory = 'all'; renderCategories(); renderProducts(); });
    
    // Load more products
    const loadMoreBtn = document.getElementById('loadMoreBtn');
    if (loadMoreBtn) loadMoreBtn.addEventListener('click', () => { state.displayLimit += 8; renderProducts(); });
    
    // Checkout & Modals
    const checkoutForm = document.getElementById('checkoutForm'); const closeCheckout = document.getElementById('closeCheckout');
    if (checkoutForm) checkoutForm.addEventListener('submit', submitCheckout);
    if (closeCheckout) closeCheckout.addEventListener('click', () => { if (stopQris) { stopQris(); stopQris = null; } closeModal('checkoutModal'); });
    
    const closeModalBtn = document.getElementById('closeModal'); const productModal = document.getElementById('productModal'); const checkoutModal = document.getElementById('checkoutModal');
    if (closeModalBtn) closeModalBtn.addEventListener('click', () => closeModal('productModal'));
    if (productModal) productModal.addEventListener('click', (e) => { if (e.target.id === 'productModal') closeModal('productModal'); });
    if (checkoutModal) checkoutModal.addEventListener('click', (e) => { if (e.target.id === 'checkoutModal') closeModal('checkoutModal'); });
    
    // Back to top
    const backToTop = document.getElementById('backToTop');
    if (backToTop) backToTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    
    // ESC key to close modals
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal('productModal'); closeModal('checkoutModal'); } });
});


// ============ REQUEST PRODUK CUSTOM ============
let crProduct = null;
function openCustomRequest(id) {
    const product = PRODUCTS.find(p => p.id === id); if (!product) return;
    crProduct = product;
    const cu = __STORE__.user;
    const modal = document.getElementById('customModal'); if (!modal) return;
    document.getElementById('crTitle').textContent = 'Request ' + product.name;
    const form = document.getElementById('crForm'), done = document.getElementById('crDone'), err = document.getElementById('crErr');
    done.style.display = 'none'; done.innerHTML = ''; form.style.display = ''; err.textContent = '';
    form.reset();
    document.getElementById('crLogin').style.display = cu ? 'none' : 'block';
    if (cu) {
        document.getElementById('crEmail').value = cu.email || '';
        document.getElementById('crWa').value = cu.phone || '';
    }
    document.getElementById('crSubmit').querySelector('span').textContent = cu ? 'Kirim Request' : 'Masuk untuk Mengirim Request';
    document.getElementById('crSubmit').disabled = false;
    modal.classList.add('active'); document.body.style.overflow = 'hidden';
}
async function submitCustomRequest(e) {
    e.preventDefault();
    if (!__STORE__.user) { location.href = '/login?next=/'; return; }
    const v = (id) => document.getElementById(id).value.trim();
    const err = document.getElementById('crErr'), btn = document.getElementById('crSubmit');
    err.textContent = '';
    if (!v('crName')) { err.textContent = 'Nama web/bot wajib diisi'; return; }
    if (v('crFeatures').length < 10) { err.textContent = 'Jelaskan fitur yang diinginkan (minimal 10 karakter)'; return; }
    if (!v('crWa') && !v('crEmail')) { err.textContent = 'Isi minimal satu kontak: WhatsApp atau email'; return; }
    btn.disabled = true;
    try {
        const j = await Pay.api('POST', '/api/custom-request', {
            productId: crProduct.id, projectName: v('crName'), features: v('crFeatures'), contactWa: v('crWa'), contactEmail: v('crEmail'),
            reference: v('crRef'), budget: v('crBudget'), deadline: v('crDeadline'), notes: v('crNotes')
        });
        document.getElementById('crForm').style.display = 'none';
        document.getElementById('crTitle').textContent = 'Request Terkirim';
        const done = document.getElementById('crDone'); done.style.display = 'block';
        done.innerHTML = `<div class="pay-ok">✓ ${Pay.esc(j.request.id)} diterima</div><p class="cr-done-p">Terima kasih! Admin akan menghubungi Anda lewat WhatsApp/email untuk membahas detail dan harga. Status request bisa dipantau di menu Akun &rarr; Pesanan.</p><a class="pay-link" href="/account#orders" style="text-align:center">Lihat request saya</a>`;
        showToast('Request terkirim', 'Admin akan segera menghubungi Anda', 'success');
    } catch (ex) {
        if (ex.status === 401) { location.href = '/login?next=/'; return; }
        err.textContent = ex.message; btn.disabled = false;
    }
}
document.addEventListener('DOMContentLoaded', () => {
    const f = document.getElementById('crForm'); if (f) f.addEventListener('submit', submitCustomRequest);
    const c = document.getElementById('closeCustom'); if (c) c.addEventListener('click', () => closeModal('customModal'));
    const m = document.getElementById('customModal'); if (m) m.addEventListener('click', (e) => { if (e.target.id === 'customModal') closeModal('customModal'); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal('customModal'); });
});
