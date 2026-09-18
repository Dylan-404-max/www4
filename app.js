// ==================== TimberPro v2.4 — Frontend ====================

const API_BASE_URL = (localStorage.getItem('api_base_url')) || 'https://timberpro-api.kobayashifgk.workers.dev';
const APP_VERSION = '2.4.0';
const DB_NAME = 'TimberProDB';
const DB_VERSION = 3;

let currentUser = null;
let currentPage = 'dashboard';
let products = [];
let services = [];
let cart = [];
let isOnline = navigator.onLine;
let syncInProgress = false;
let notificationInterval = null;
let lastSeenNotificationId = parseInt(localStorage.getItem('last_notif_id') || '0', 10);
let currentCategory = 'all';
let currentSearch = '';
let selectedPayment = 'cash';
let orderItems = {};
let dbReady = false;
let deferredInstallPrompt = null;
let currentCharts = {};
let _qtyModalId = null;

// ==================== OFFLINE DB ====================
class OfflineDB {
    constructor() { this.db = null; }
    init() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => { this.db = req.result; resolve(); };
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('sales_queue')) db.createObjectStore('sales_queue', { keyPath: 'id', autoIncrement: true });
                if (!db.objectStoreNames.contains('products_cache')) db.createObjectStore('products_cache', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
            };
        });
    }
    _tx(store, mode) { return this.db.transaction(store, mode).objectStore(store); }
    addToQueue(sale) { return new Promise((res, rej) => { const r = this._tx('sales_queue','readwrite').add({ ...sale, queued_at: new Date().toISOString() }); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
    getQueue() { return new Promise((res, rej) => { const r = this._tx('sales_queue','readonly').getAll(); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
    removeFromQueue(id) { return new Promise((res, rej) => { const r = this._tx('sales_queue','readwrite').delete(id); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); }); }
    cacheProducts(list) { return new Promise((res, rej) => { const tx = this.db.transaction('products_cache','readwrite'); const s = tx.objectStore('products_cache'); s.clear(); list.forEach(p=>s.put(p)); tx.oncomplete=res; tx.onerror=()=>rej(tx.error); }); }
    getCachedProducts() { return new Promise((res, rej) => { const r = this._tx('products_cache','readonly').getAll(); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
    clearAll() { if (!this.db) return Promise.resolve(); return new Promise((res) => { const tx = this.db.transaction(['sales_queue','products_cache'],'readwrite'); tx.objectStore('sales_queue').clear(); tx.objectStore('products_cache').clear(); tx.oncomplete=res; tx.onerror=res; }); }
}
const offlineDB = new OfflineDB();

// ==================== API ====================
const API = {
    token() { return localStorage.getItem('token'); },
    async request(method, endpoint, data = null) {
        const url = `${API_BASE_URL}/api${endpoint}`;
        const isLoginEndpoint = endpoint.startsWith('/auth/login') || endpoint.startsWith('/auth/bootstrap');
        const config = {
            method,
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token() || ''}` }
        };
        if (data && method !== 'GET') config.body = JSON.stringify(data);
        try {
            const res = await fetch(url, config);
            if (res.status === 401 && !isLoginEndpoint) {
                handleSessionExpired();
                return { success: false, error: 'Session expired' };
            }
            const result = await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }));
            return result;
        } catch (e) {
            console.error('API error', e);
            return { success: false, error: e.message || 'Network error' };
        }
    },
    get(e) { return this.request('GET', e); },
    post(e, d) { return this.request('POST', e, d); },
    put(e, d) { return this.request('PUT', e, d); },
    delete(e) { return this.request('DELETE', e); },
    async downloadFile(endpoint, filename) {
        try {
            const res = await fetch(`${API_BASE_URL}/api${endpoint}`, { headers: { 'Authorization': `Bearer ${this.token() || ''}` } });
            if (!res.ok) throw new Error('Download failed');
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = filename;
            document.body.appendChild(a); a.click(); a.remove();
            URL.revokeObjectURL(url);
            return true;
        } catch (e) { console.error(e); return false; }
    }
};

// ==================== HELPERS ====================
function showLoading(show) { document.getElementById('loading-overlay').classList.toggle('hidden', !show); }
function showToast(message, type = 'info', duration = 3000) {
    const c = document.getElementById('toast-container');
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    const s1 = document.createElement('span'); s1.textContent = icons[type] || 'ℹ️';
    const s2 = document.createElement('span'); s2.textContent = message;
    const b = document.createElement('button'); b.className = 'toast-close'; b.textContent = '✕';
    b.onclick = () => t.remove();
    t.append(s1, s2, b);
    c.appendChild(t);
    if (duration > 0) setTimeout(() => t.remove(), duration);
}
function openModal(html) {
    const c = document.getElementById('modal-container');
    c.querySelector('.modal-content').innerHTML = html;
    c.classList.remove('hidden');
    c.querySelector('.modal-overlay').onclick = closeModal;
}
function closeModal() {
    const c = document.getElementById('modal-container');
    c.classList.add('hidden');
    c.querySelector('.modal-content').innerHTML = '';
}
function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t == null ? '' : String(t); return d.innerHTML; }
function formatCurrency(n) { return 'GHS ' + Number(n || 0).toFixed(2); }
function formatQty(n) { return Number.isInteger(n) ? String(n) : Number(n).toFixed(2).replace(/\.?0+$/, ''); }
function formatDate(s) { if (!s) return '-'; return new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); }
function formatDateTime(s) { if (!s) return '-'; return new Date(s).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function debounce(fn, ms) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }

// ==================== AUTH ====================
async function initAuth() {
    const token = localStorage.getItem('token');
    if (!token) { showLogin(); return; }
    const result = await API.get('/auth/me');
    if (result.success && result.user) {
        currentUser = result.user;
        showApp();
        updateSidebarUser();
        loadPage('dashboard');
        startNotificationPolling();
        requestNotificationPermission();
        if (isOnline) syncQueuedSales();
    } else {
        logout(false);
    }
}
async function login(username, password) {
    showLoading(true);
    const r = await API.post('/auth/login', { username, password });
    showLoading(false);
    if (r.success && r.token) {
        localStorage.setItem('token', r.token);
        currentUser = r.user;
        showApp();
        updateSidebarUser();
        loadPage('dashboard');
        startNotificationPolling();
        requestNotificationPermission();
        if (isOnline) syncQueuedSales();
        showToast(`Welcome back, ${currentUser.full_name || currentUser.username}!`, 'success');
    } else {
        const el = document.getElementById('login-error');
        el.textContent = r.error || 'Login failed';
        el.classList.remove('hidden');
    }
}
function logout(notify = true) {
    localStorage.removeItem('token');
    currentUser = null;
    cart = [];
    closeCartDrawer();
    if (notificationInterval) clearInterval(notificationInterval);
    notificationInterval = null;
    showLogin();
    if (notify) showToast('Logged out successfully', 'info');
}
function handleSessionExpired() {
    showToast('Session expired. Please log in again.', 'warning');
    logout(false);
}
function updateSidebarUser() {
    if (!currentUser) return;
    document.getElementById('user-name').textContent = currentUser.full_name || currentUser.username;
    document.getElementById('user-role').textContent = currentUser.role || 'User';
    document.getElementById('user-avatar').textContent = (currentUser.full_name || currentUser.username || 'U').charAt(0).toUpperCase();
    document.querySelectorAll('.nav-item[data-admin]').forEach(el => {
        el.classList.toggle('hidden', currentUser.role !== 'admin');
    });
}
function showLogin() {
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');
    document.getElementById('splash-screen').classList.add('hidden');
}
function showApp() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    document.getElementById('splash-screen').classList.add('hidden');
}

// ==================== ROUTER ====================
const PAGES = {
    'dashboard':     { render: renderDashboard,     init: initDashboardPage },
    'sales':         { render: renderSales,         init: initSalesPage },
    'today':         { render: renderToday,         init: initTodayPage },
    'sales-log':     { render: renderSalesLog,      init: initSalesLogPage },
    'drafts':        { render: renderDrafts,        init: initDraftsPage },
    'orders':        { render: renderOrders,        init: initOrdersPage },
    'inventory':     { render: renderInventory,     init: initInventoryPage },
    'products':      { render: renderProducts,      init: initProductsPage },
    'services':      { render: renderServices,      init: initServicesPage },
    'expenses':      { render: renderExpenses,      init: initExpensesPage },
    'activity-log':  { render: renderActivityLog,   init: initActivityLogPage },
    'analytics':     { render: renderAnalytics,     init: initAnalyticsPage },
    'reports':       { render: renderReports,       init: initReportsPage },
    'audit-logs':    { render: renderAuditLogs,     init: initAuditLogsPage },
    'settings':      { render: renderSettings,      init: initSettingsPage },
};
function loadPage(page, params = {}) {
    if (page === 'audit-logs' && currentUser?.role !== 'admin') {
        showToast('Admin access required', 'warning');
        page = 'dashboard';
    }
    Object.values(currentCharts).forEach(c => { try { c.destroy(); } catch(e){} });
    currentCharts = {};

    currentPage = page;
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    const nav = document.querySelector(`.nav-item[data-page="${page}"]`);
    if (nav) nav.classList.add('active');
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('active');
    window.scrollTo(0, 0);
    const main = document.getElementById('main-content');
    const def = PAGES[page] || PAGES['dashboard'];
    main.innerHTML = `<div class="page">${def.render(params)}</div>`;
    if (typeof def.init === 'function') def.init(params);
}

// ==================== DASHBOARD ====================
function renderDashboard() {
    const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
    return `
        <div class="page-header">
            <div><h1 class="page-title">Dashboard</h1><p class="page-subtitle">${today}</p></div>
            <button onclick="loadPage('sales')" class="btn btn-primary">🛒 New Sale</button>
        </div>
        <div class="grid-4">
            <div class="stat-card"><div class="stat-label">💰 Today's Sales</div><div class="stat-value" id="stat-today">—</div><div class="stat-change" id="stat-today-count">0 transactions</div></div>
            <div class="stat-card success"><div class="stat-label">📈 This Month</div><div class="stat-value" id="stat-month">—</div><div class="stat-change">Revenue</div></div>
            <div class="stat-card warning"><div class="stat-label">💸 Expenses</div><div class="stat-value" id="stat-expenses">—</div><div class="stat-change">This month</div></div>
            <div class="stat-card danger"><div class="stat-label">⚠️ Low Stock</div><div class="stat-value" id="stat-low">—</div><div class="stat-change">Items need attention</div></div>
        </div>
        <div class="grid-2">
            <div class="card"><div class="card-header"><div class="card-title">📈 Sales (Last 7 Days)</div></div><div id="dash-chart"><div class="empty-state"><div class="empty-text">Loading...</div></div></div></div>
            <div class="card"><div class="card-header"><div class="card-title">💳 Payment Methods</div></div><div id="dash-payments"><div class="empty-state"><div class="empty-text">Loading...</div></div></div></div>
        </div>
        <div class="card"><div class="card-header"><div class="card-title">🌲 Top Products (This Month)</div></div><div id="dash-top-products"><div class="empty-state"><div class="empty-text">Loading...</div></div></div></div>
    `;
}
async function initDashboardPage() {
    const r = await API.get('/analytics/dashboard');
    if (!r.success) { showToast('Failed to load dashboard', 'error'); return; }
    const d = r.dashboard;
    document.getElementById('stat-today').textContent = formatCurrency(d.today_sales.total || 0);
    document.getElementById('stat-today-count').textContent = (d.today_sales.count || 0) + ' transactions';
    document.getElementById('stat-month').textContent = formatCurrency(d.month_sales.total || 0);
    document.getElementById('stat-expenses').textContent = formatCurrency(d.month_expenses.total || 0);
    document.getElementById('stat-low').textContent = d.low_stock_count || 0;

    const chart = document.getElementById('dash-chart');
    if (d.sales_chart?.length) {
        const max = Math.max(...d.sales_chart.map(x => x.total), 1);
        chart.innerHTML = `<div class="bar-chart">${d.sales_chart.map(x => `
            <div class="bar-chart-item">
                <div style="font-size:10px;font-weight:700;color:var(--primary);">${(x.total || 0).toFixed(0)}</div>
                <div class="bar-chart-bar" style="height:${Math.max((x.total / max) * 140, 4)}px"></div>
                <div class="bar-chart-label">${new Date(x.date).getDate()}/${new Date(x.date).getMonth() + 1}</div>
            </div>`).join('')}</div>`;
    } else chart.innerHTML = `<div class="empty-state"><div class="empty-icon">📊</div><div class="empty-text">No sales yet</div></div>`;

    const pay = document.getElementById('dash-payments');
    if (d.payment_breakdown?.length) {
        const colors = ['#1a5f4a', '#f4a261', '#e76f51', '#74b9ff'];
        const total = d.payment_breakdown.reduce((s, p) => s + p.total, 0) || 1;
        let ang = 0;
        const grad = d.payment_breakdown.map((p, i) => {
            const a = (p.total / total) * 360;
            const s = `${colors[i % colors.length]} ${ang}deg ${ang + a}deg`;
            ang += a; return s;
        }).join(', ');
        pay.innerHTML = `<div style="display:flex;gap:20px;flex-wrap:wrap;justify-content:center;padding:16px;align-items:center;">
            <div class="pie-chart" style="width:130px;height:130px;background:conic-gradient(${grad});box-shadow:inset 0 0 0 8px white;"></div>
            <div style="display:flex;flex-direction:column;gap:8px;">
                ${d.payment_breakdown.map((p, i) => `
                    <div style="display:flex;align-items:center;gap:8px;font-size:13px;">
                        <div style="width:14px;height:14px;border-radius:3px;background:${colors[i % colors.length]};"></div>
                        <span><strong>${p.payment_method.toUpperCase()}</strong> — ${formatCurrency(p.total)} (${p.count})</span>
                    </div>`).join('')}
            </div>
        </div>`;
    } else pay.innerHTML = `<div class="empty-state"><div class="empty-icon">💳</div><div class="empty-text">No payments yet</div></div>`;

    const top = document.getElementById('dash-top-products');
    if (d.top_products?.length) {
        top.innerHTML = `<div class="table-container table-responsive"><table class="table">
            <thead><tr><th>Product</th><th>Qty</th><th>Revenue</th></tr></thead>
            <tbody>${d.top_products.map(p => `<tr>
                <td data-label="Product">${escapeHtml(p.name)}</td>
                <td data-label="Qty">${formatQty(p.total_qty)}</td>
                <td data-label="Revenue">${formatCurrency(p.total_revenue)}</td>
            </tr>`).join('')}</tbody></table></div>`;
    } else top.innerHTML = `<div class="empty-state"><div class="empty-icon">🌲</div><div class="empty-text">No product sales yet</div></div>`;
}

// ==================== SALES PAGE ====================
function renderSales() {
    return `
        <div class="sales-header">
            <div><h1>New Sale</h1><p>Tap any item to add it to your cart</p></div>
        </div>
        <div class="sales-search">
            <span class="search-icon">🔍</span>
            <input type="text" id="sales-search-input" placeholder="Search products or services..." autocomplete="off" value="${escapeHtml(currentSearch)}">
        </div>
        <div class="category-chips" id="category-chips"></div>
        <div class="product-grid" id="product-grid"></div>
        <div class="cart-sticky-bar hidden" id="cart-sticky-bar">
            <div class="cart-sticky-info">
                <div class="cart-sticky-count" id="cart-sticky-count">0 items</div>
                <div class="cart-sticky-total" id="cart-sticky-total">GHS 0.00</div>
            </div>
            <button class="cart-sticky-btn" onclick="openCartDrawer()">View Cart <span>→</span></button>
        </div>
    `;
}
async function initSalesPage() {
    const [pRes, sRes] = await Promise.all([API.get('/products'), API.get('/services')]);
    if (pRes.success) {
        products = pRes.products.filter(p => p.is_active);
        if (dbReady) offlineDB.cacheProducts(products).catch(() => {});
    } else if (dbReady) {
        products = await offlineDB.getCachedProducts().catch(() => []);
        if (products.length) showToast('Showing cached products (offline)', 'warning');
    }
    if (sRes.success) services = sRes.services.filter(s => s.is_active);
    renderCategoryChips();
    renderProductGrid();
    updateCartUI();
    const search = document.getElementById('sales-search-input');
    if (search) {
        search.addEventListener('input', debounce(e => { currentSearch = e.target.value; renderProductGrid(); }, 150));
    }
}
function renderCategoryChips() {
    const cats = new Set();
    products.forEach(p => { if (p.category) cats.add(p.category); });
    if (services.length) cats.add('services');
    const chips = ['all', ...Array.from(cats)];
    const el = document.getElementById('category-chips');
    if (!el) return;
    el.innerHTML = chips.map(c => `
        <button class="chip ${currentCategory === c ? 'active' : ''}" onclick="setCategory('${escapeHtml(c)}')">
            ${c === 'all' ? 'All' : escapeHtml(c)}
        </button>`).join('');
}
function setCategory(cat) { currentCategory = cat; renderCategoryChips(); renderProductGrid(); }

function renderProductGrid() {
    const grid = document.getElementById('product-grid');
    if (!grid) return;
    const q = currentSearch.trim().toLowerCase();
    let list = [];
    if (currentCategory !== 'services') {
        products
            .filter(p => currentCategory === 'all' || p.category === currentCategory)
            .filter(p => !q || p.name.toLowerCase().includes(q))
            .forEach(p => list.push({ kind: 'product', data: p }));
    }
    if (currentCategory === 'all' || currentCategory === 'services') {
        services
            .filter(s => !q || s.name.toLowerCase().includes(q))
            .forEach(s => list.push({ kind: 'service', data: s }));
    }
    if (list.length === 0) {
        grid.innerHTML = `<div class="empty-search"><div class="icon">🔍</div><div>No items found</div></div>`;
        return;
    }
    grid.innerHTML = list.map(entry => {
        const isProduct = entry.kind === 'product';
        const item = entry.data;
        const inCart = cart.find(c => c.type === entry.kind && c.id === item.id);
        const stock = isProduct ? (item.stock || 0) : null;
        const isLow = isProduct && stock <= (item.stock_threshold || 0);
        const meta = isProduct
            ? `<div class="product-stock ${isLow ? 'low' : ''}">${isLow ? '⚠️ ' : ''}${stock} ${escapeHtml(item.unit || 'unit')}${stock !== 1 ? 's' : ''} left</div>`
            : `<div class="product-stock service">Service</div>`;

        const clickHandler = isProduct
            ? `openQuantityModal(${item.id})`
            : `openServicePriceModalById(${item.id})`;

        return `
            <div class="product-card ${inCart ? 'in-cart' : ''}" onclick="${clickHandler}">
                <div class="product-icon">${isProduct ? '🪵' : '⚙️'}</div>
                <div class="product-name">${escapeHtml(item.name)}</div>
                <div class="product-price">${formatCurrency(item.price)}</div>
                ${meta}
                ${inCart ? `
                    <div class="product-card-stepper">
                        <button class="stepper-btn minus" onclick="event.stopPropagation(); cartDecrement('${entry.kind}', ${item.id})">−</button>
                        <span class="stepper-qty">${formatQty(inCart.quantity)}</span>
                        <button class="stepper-btn" onclick="event.stopPropagation(); cartIncrement('${entry.kind}', ${item.id})">+</button>
                    </div>
                ` : `<div class="product-card-add">+ Add</div>`}
            </div>`;
    }).join('');
}

// ---- Mini stepper on product cards ----
function cartIncrement(type, id) {
    const item = cart.find(c => c.type === type && c.id === id);
    if (!item) return;
    const step = item.type === 'product' ? stepForUnit(item.unit) : 1;
    const next = +(item.quantity + step).toFixed(3);
    if (item.type === 'product' && item.stock && next > item.stock) {
        showToast(`Only ${formatQty(item.stock)} in stock`, 'warning'); return;
    }
    item.quantity = next;
    afterCartChange();
}
function cartDecrement(type, id) {
    const idx = cart.findIndex(c => c.type === type && c.id === id);
    if (idx === -1) return;
    const step = cart[idx].type === 'product' ? stepForUnit(cart[idx].unit) : 1;
    const next = +(cart[idx].quantity - step).toFixed(3);
    if (next <= 0) cart.splice(idx, 1);
    else cart[idx].quantity = next;
    afterCartChange();
}

// ============================================
// ⭐ PRODUCT QUANTITY PICKER MODAL (products only)
// ============================================
function openQuantityModal(productId) {
    const item = products.find(x => x.id === productId);
    if (!item) return;

    const inCart = cart.find(c => c.type === 'product' && c.id === productId);
    const currentQty = inCart ? inCart.quantity : 1;
    const stock = item.stock || 0;
    const unit = item.unit || 'piece';
    const isLow = stock <= (item.stock_threshold || 0);
    const subtotal = currentQty * item.price;

    _qtyModalId = productId;

    const modal = document.getElementById('service-modal');
    modal.querySelector('.modal-content').innerHTML = `
        <div class="modal-header">
            <div class="modal-title">${escapeHtml(item.name)}</div>
            <button class="modal-close" onclick="closeServiceModal()">✕</button>
        </div>

        <div class="qty-product-info">
            <div class="qty-info-price">
                <span class="qty-price-big">${formatCurrency(item.price)}</span>
                <span class="qty-price-unit">per ${escapeHtml(unit)}</span>
            </div>
            <div class="qty-info-stock ${isLow ? 'low' : ''}">
                ${isLow ? '⚠️ ' : '📦 '}${formatQty(stock)} in stock
            </div>
        </div>

        <div class="qty-picker-wrap">
            <button type="button" class="qty-picker-btn" onclick="qtyModalAdjust(-1)">−</button>
            <input type="number" id="qty-modal-input" min="0.01" step="0.01"
                   value="${currentQty}" inputmode="decimal" class="qty-picker-input">
            <button type="button" class="qty-picker-btn" onclick="qtyModalAdjust(1)">+</button>
        </div>
        <div class="qty-picker-hint">Tap + or − to adjust by ½ · Type for custom amount</div>

        <div class="qty-group">
            <div class="qty-group-title"><span class="qty-dot qty-dot-blue"></span>Quick set</div>
            <div class="qty-preset-grid">
                ${[0.5, 1, 1.5, 2, 2.5, 5, 10, 20].map(v =>
                    `<button type="button" class="qty-preset-btn" onclick="qtyModalSet(${v})">${v}</button>`
                ).join('')}
            </div>
        </div>

        <div class="qty-group">
            <div class="qty-group-title"><span class="qty-dot qty-dot-orange"></span>Add to current</div>
            <div class="qty-preset-grid">
                <button type="button" class="qty-add-btn highlight" onclick="qtyModalAdd(0.5)">+ ½</button>
                <button type="button" class="qty-add-btn" onclick="qtyModalAdd(1)">+ 1</button>
                <button type="button" class="qty-add-btn" onclick="qtyModalAdd(5)">+ 5</button>
                <button type="button" class="qty-add-btn" onclick="qtyModalAdd(10)">+ 10</button>
            </div>
        </div>

        <div class="qty-total-bar">
            <span class="qty-total-label">Subtotal</span>
            <span class="qty-total-value" id="qty-modal-total">${formatCurrency(subtotal)}</span>
        </div>

        <div class="qty-modal-actions">
            ${inCart ? `<button type="button" class="btn btn-danger" onclick="qtyModalRemove()">🗑️ Remove</button>` : ''}
            <button type="button" class="btn btn-success" onclick="qtyModalConfirm()">
                ${inCart ? '✓ Update Cart' : '✓ Add to Cart'}
            </button>
        </div>
    `;

    modal.classList.remove('hidden');

    setTimeout(() => {
        const inp = document.getElementById('qty-modal-input');
        if (inp) {
            inp.focus();
            inp.select();
            inp.addEventListener('input', updateQtyModalTotal);
            inp.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); qtyModalConfirm(); }
            });
        }
    }, 100);
}

function updateQtyModalTotal() {
    const item = products.find(x => x.id === _qtyModalId);
    if (!item) return;
    const qty = parseFloat(document.getElementById('qty-modal-input')?.value) || 0;
    const totalEl = document.getElementById('qty-modal-total');
    if (totalEl) totalEl.textContent = formatCurrency(qty * item.price);
}

function qtyModalAdjust(delta) {
    const inp = document.getElementById('qty-modal-input');
    if (!inp) return;
    const cur = parseFloat(inp.value) || 0;
    const next = Math.max(0.5, +(cur + delta * 0.5).toFixed(3));
    inp.value = next;
    updateQtyModalTotal();
}
function qtyModalSet(val) {
    const inp = document.getElementById('qty-modal-input');
    if (!inp) return;
    inp.value = val;
    updateQtyModalTotal();
}
function qtyModalAdd(amount) {
    const inp = document.getElementById('qty-modal-input');
    if (!inp) return;
    const cur = parseFloat(inp.value) || 0;
    inp.value = +(cur + amount).toFixed(3);
    updateQtyModalTotal();
}
function qtyModalConfirm() {
    const item = products.find(x => x.id === _qtyModalId);
    if (!item) return;
    const qty = parseFloat(document.getElementById('qty-modal-input').value);
    if (!qty || qty <= 0) { showToast('Enter a valid quantity', 'error'); return; }
    const stock = item.stock || 0;
    if (qty > stock) { showToast(`Only ${formatQty(stock)} in stock`, 'warning'); return; }

    const existing = cart.find(c => c.type === 'product' && c.id === item.id);
    if (existing) {
        existing.quantity = qty;
    } else {
        cart.push({
            type: 'product', id: item.id, name: item.name,
            price: item.price, unit: item.unit || 'piece',
            stock, quantity: qty
        });
    }
    closeServiceModal();
    afterCartChange();
    showToast(`${item.name} · ${formatQty(qty)} × ${formatCurrency(item.price)}`, 'success', 2000);
}
function qtyModalRemove() {
    const idx = cart.findIndex(c => c.type === 'product' && c.id === _qtyModalId);
    if (idx !== -1) cart.splice(idx, 1);
    closeServiceModal();
    afterCartChange();
    showToast('Removed from cart', 'info');
}

// ============================================
// ⭐ SERVICE PRICE MODAL (old, unchanged)
// ============================================
function openServicePriceModalById(id) {
    const s = services.find(x => x.id === id);
    if (s) openServicePriceModal(s);
}

function openServicePriceModal(service) {
    const c = document.getElementById('service-modal');
    c.querySelector('.modal-content').innerHTML = `
        <div class="modal-header">
            <div class="modal-title">${escapeHtml(service.name)}</div>
            <button class="modal-close" onclick="closeServiceModal()">✕</button>
        </div>
        <div class="form-group">
            <label>Price (GHS)</label>
            <input type="number" id="service-price-input" step="0.01" min="0" value="${service.price}" autofocus>
        </div>
        <div style="display:flex;gap:10px;">
            <button class="btn btn-outline btn-full" onclick="closeServiceModal()">Cancel</button>
            <button class="btn btn-primary btn-full" onclick="confirmServiceAdd(${service.id})">Add to Cart</button>
        </div>`;
    c.classList.remove('hidden');
    setTimeout(() => document.getElementById('service-price-input')?.select(), 100);
}

function confirmServiceAdd(id) {
    const s = services.find(x => x.id === id);
    const price = parseFloat(document.getElementById('service-price-input').value);
    if (!s || isNaN(price) || price < 0) { showToast('Enter a valid price', 'error'); return; }
    const existing = cart.find(c => c.type === 'service' && c.id === id);
    if (existing) {
        existing.quantity += 1;
    } else {
        cart.push({ type: 'service', id, name: s.name, price, unit: 'service', quantity: 1 });
    }
    closeServiceModal();
    afterCartChange();
}

function closeServiceModal() { document.getElementById('service-modal').classList.add('hidden'); }

// ==================== CART ====================
function afterCartChange() { updateCartUI(); renderProductGrid(); }
function updateCartUI() {
    const totalItems = cart.reduce((s, i) => s + i.quantity, 0);
    const subtotal = cart.reduce((s, i) => s + i.quantity * i.price, 0);
    const bar = document.getElementById('cart-sticky-bar');
    const cnt = document.getElementById('cart-sticky-count');
    const tot = document.getElementById('cart-sticky-total');
    if (bar && cnt && tot) {
        if (totalItems > 0) {
            bar.classList.remove('hidden');
            cnt.textContent = `${formatQty(totalItems)} item${totalItems !== 1 ? 's' : ''}`;
            tot.textContent = formatCurrency(subtotal);
        } else bar.classList.add('hidden');
    }
    const drawer = document.getElementById('cart-drawer');
    if (drawer && !drawer.classList.contains('hidden')) renderCartDrawer();
}
function openCartDrawer() {
    renderCartDrawer();
    document.getElementById('cart-drawer').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}
function closeCartDrawer() {
    document.getElementById('cart-drawer').classList.add('hidden');
    document.body.style.overflow = '';
}

function stepForUnit(unit) {
    const u = (unit || '').toLowerCase();
    if (['piece', 'box', 'bag'].includes(u)) return 1;
    return 0.5;
}

function renderCartDrawer() {
    const body = document.getElementById('cart-drawer-body');
    const footer = document.getElementById('cart-drawer-footer');
    if (cart.length === 0) {
        body.innerHTML = `<div class="cart-empty"><div class="icon">🛒</div><div class="empty-title">Your cart is empty</div><div class="empty-text">Tap items to add them</div></div>`;
        footer.innerHTML = `<button class="btn btn-outline btn-full" onclick="closeCartDrawer()">Continue Shopping</button>`;
        return;
    }
    body.innerHTML = cart.map((item, i) => {
        const step = stepForUnit(item.unit);
        const decStep = step.toFixed(2);
        return `
        <div class="cart-item-row">
            <div class="cart-item-main">
                <div class="cart-item-title">${escapeHtml(item.name)}</div>
                <div class="cart-item-meta">${formatCurrency(item.price)} per ${escapeHtml(item.unit)}${item.type === 'product' && item.stock ? ` · Stock: ${formatQty(item.stock)}` : ''}</div>

                <div class="cart-qty-controls">
                    <button onclick="changeQty(${i}, -${decStep})">−</button>
                    <input type="number" min="0.01" step="0.01" value="${item.quantity}" onchange="setQty(${i}, this.value)">
                    <button onclick="changeQty(${i}, ${decStep})">+</button>
                </div>

                <div class="cart-qty-presets">
                    <button class="cart-qty-preset" onclick="addQty(${i}, 0.5)">+0.5</button>
                    <button class="cart-qty-preset" onclick="addQty(${i}, 1)">+1</button>
                    <button class="cart-qty-preset" onclick="addQty(${i}, 2)">+2</button>
                    <button class="cart-qty-preset" onclick="addQty(${i}, 5)">+5</button>
                    <button class="cart-qty-preset" onclick="addQty(${i}, 10)">+10</button>
                    <button class="cart-qty-preset" onclick="addQty(${i}, 20)">+20</button>
                    <button class="cart-qty-preset" onclick="addQty(${i}, 50)">+50</button>
                </div>
            </div>
            <div class="cart-item-right">
                <div class="cart-item-total">${formatCurrency(item.quantity * item.price)}</div>
                <button class="cart-item-remove-btn" onclick="removeFromCart(${i})" aria-label="Remove item">
                    <span class="remove-icon">🗑️</span>
                    <span class="remove-label">Remove</span>
                </button>
            </div>
        </div>`;
    }).join('');

    const subtotal = cart.reduce((s, i) => s + i.quantity * i.price, 0);
    footer.innerHTML = `
        <div class="cart-totals">
            <div class="row"><span>Subtotal</span><span>${formatCurrency(subtotal)}</span></div>
            <div class="row total"><span>Total</span><span>${formatCurrency(subtotal)}</span></div>
        </div>
        <div class="payment-toggle">
            <button class="${selectedPayment === 'cash' ? 'selected' : ''}" onclick="setPayment('cash')">
                <span class="emoji">💵</span><span>Cash</span>
            </button>
            <button class="${selectedPayment === 'momo' ? 'selected' : ''}" onclick="setPayment('momo')">
                <span class="emoji">📱</span><span>Mobile Money</span>
            </button>
        </div>
        <div class="form-group" style="margin-bottom:10px;">
            <input type="text" id="cart-customer-name" placeholder="Customer name (optional)" style="font-size:14px;padding:10px 14px;">
        </div>
        <div class="form-group" style="margin-bottom:10px;">
            <textarea id="cart-notes" placeholder="Notes (optional) — e.g. delivery info, special requests" rows="2" style="font-size:14px;padding:10px 14px;min-height:60px;"></textarea>
        </div>
        <button class="complete-sale-btn" id="complete-sale-btn" onclick="completeSale()">
            ✅ Complete Sale — ${formatCurrency(subtotal)}
        </button>
        <button class="save-draft-btn" onclick="saveDraft()">
            💾 Save as Draft
        </button>
    `;
}

function changeQty(i, delta) {
    if (!cart[i]) return;
    const next = +(cart[i].quantity + delta).toFixed(3);
    if (next <= 0) { cart.splice(i, 1); }
    else if (cart[i].type === 'product' && cart[i].stock && next > cart[i].stock) {
        showToast(`Only ${formatQty(cart[i].stock)} in stock`, 'warning'); return;
    }
    else cart[i].quantity = next;
    afterCartChange();
}
function setQty(i, value) {
    if (!cart[i]) return;
    const n = parseFloat(value);
    if (isNaN(n) || n <= 0) { cart.splice(i, 1); }
    else if (cart[i].type === 'product' && cart[i].stock && n > cart[i].stock) {
        showToast(`Only ${formatQty(cart[i].stock)} in stock`, 'warning');
        cart[i].quantity = cart[i].stock;
    }
    else cart[i].quantity = n;
    afterCartChange();
}
function addQty(i, amount) {
    if (!cart[i]) return;
    const next = +(cart[i].quantity + amount).toFixed(3);
    if (cart[i].type === 'product' && cart[i].stock && next > cart[i].stock) {
        showToast(`Only ${formatQty(cart[i].stock)} in stock`, 'warning');
        cart[i].quantity = cart[i].stock;
    } else {
        cart[i].quantity = next;
    }
    afterCartChange();
}
function removeFromCart(i) {
    if (!cart[i]) return;
    const name = cart[i].name;
    cart.splice(i, 1);
    afterCartChange();
    showToast(`${name} removed`, 'info', 1500);
}
function setPayment(method) { selectedPayment = method; renderCartDrawer(); }

async function completeSale() {
    if (cart.length === 0) { showToast('Cart is empty', 'error'); return; }
    const customerName = document.getElementById('cart-customer-name')?.value?.trim() || null;
    const notes = document.getElementById('cart-notes')?.value?.trim() || null;

    const items = cart.map(i => ({
        product_id: i.type === 'product' ? i.id : null,
        service_id: i.type === 'service' ? i.id : null,
        item_type: i.type,
        name: i.name,
        quantity: i.quantity,
        unit_price: i.price
    }));
    const saleData = { items, customer_name: customerName, notes, payment_method: selectedPayment, sale_date: new Date().toISOString() };

    const btn = document.getElementById('complete-sale-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Processing...'; }

    if (!isOnline) {
        try {
            await offlineDB.addToQueue({ data: saleData, created_at: saleData.sale_date });
            showToast('Sale saved — will sync when online', 'warning');
            clearCart();
            closeCartDrawer();
        } catch (e) {
            showToast('Failed to save offline sale', 'error');
            if (btn) { btn.disabled = false; btn.textContent = '✅ Try Again'; }
        }
        return;
    }

    showLoading(true);
    const r = await API.post('/sales', saleData);
    showLoading(false);

    if (r.success) {
        showToast(`Sale complete! Invoice ${r.invoice_number}`, 'success');
        showBrowserNotification('Sale Complete', `${r.invoice_number} — ${formatCurrency(r.total_amount)}`, { tag: 'sale-' + r.sale_id, requireInteraction: false });
        clearCart();
        closeCartDrawer();
        const pRes = await API.get('/products');
        if (pRes.success) {
            products = pRes.products.filter(p => p.is_active);
            if (dbReady) offlineDB.cacheProducts(products).catch(() => {});
        }
        showInvoice(r.sale_id);
    } else {
        showToast(r.error || 'Failed to complete sale', 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = '✅ Complete Sale'; }
    }
}
function clearCart() { cart = []; selectedPayment = 'cash'; updateCartUI(); renderProductGrid(); }
async function saveDraft() {
    if (cart.length === 0) { showToast('Cart is empty', 'error'); return; }
    const customerName = document.getElementById('cart-customer-name')?.value?.trim() || null;
    const notes = document.getElementById('cart-notes')?.value?.trim() || null;
    const items = cart.map(i => ({
        product_id: i.type === 'product' ? i.id : null,
        service_id: i.type === 'service' ? i.id : null,
        item_type: i.type,
        name: i.name,
        quantity: i.quantity,
        unit_price: i.price
    }));
    showLoading(true);
    const r = await API.post('/drafts', { items, customer_name: customerName, notes });
    showLoading(false);
    if (r.success) { showToast('Draft saved', 'success'); clearCart(); closeCartDrawer(); }
    else showToast(r.error || 'Failed to save draft', 'error');
}

// ==================== INVOICE ====================
async function showInvoice(saleId) {
    const r = await API.get(`/sales/${saleId}`);
    if (!r.success) return;
    const s = r.sale;
    openModal(`
        <div class="invoice-wrapper">
            <div class="invoice-container" id="invoice-printable">
                <div class="invoice-header">
                    <div class="invoice-logo">🌲</div>
                    <div class="invoice-title">TIMBERPRO</div>
                    <div class="invoice-tagline">Business Management</div>
                    <div class="invoice-number">${escapeHtml(s.invoice_number)}</div>
                </div>
                <div style="margin-bottom:16px;">
                    <div class="invoice-detail"><span>Date</span><span>${formatDateTime(s.created_at)}</span></div>
                    <div class="invoice-detail"><span>Cashier</span><span>${escapeHtml(s.user_name || 'Staff')}</span></div>
                    <div class="invoice-detail"><span>Customer</span><span>${escapeHtml(s.customer_name || 'Walk-in')}</span></div>
                    <div class="invoice-detail"><span>Payment</span><span>${String(s.payment_method || '').toUpperCase()}</span></div>
                </div>
                <div class="invoice-items-block">
                    ${(s.items || []).map(it => `<div class="invoice-item">
                        <span>${escapeHtml(it.name)} × ${formatQty(it.quantity)}</span>
                        <span>${formatCurrency(it.total_price)}</span>
                    </div>`).join('')}
                    <div class="invoice-total"><span>TOTAL</span><span>${formatCurrency(s.total_amount)}</span></div>
                </div>
                ${s.notes ? `<div class="sale-notes" style="margin-bottom:16px;">📝 ${escapeHtml(s.notes)}</div>` : ''}
                <div class="invoice-footer">
                    <p><strong>Thank you for your business!</strong></p>
                    <p>TimberPro Management System</p>
                </div>
            </div>
        </div>
        <div class="invoice-actions">
            <button onclick="printInvoice()" class="btn btn-outline">🖨️ Print</button>
            <button onclick="shareInvoiceAsImage()" class="btn btn-primary">📸 Save Image</button>
            <button onclick="closeModal()" class="btn btn-outline">Close</button>
        </div>
    `);
}
function printInvoice() { window.print(); }

async function shareInvoiceAsImage() {
    const el = document.getElementById('invoice-printable');
    if (!el) { showToast('Invoice not found', 'error'); return; }
    if (typeof html2canvas === 'undefined') { showToast('Image library not loaded', 'error'); return; }

    showLoading(true);

    const modalContent = el.closest('.modal-content');
    const origOverflow = modalContent ? modalContent.style.overflow : '';
    const origMaxHeight = modalContent ? modalContent.style.maxHeight : '';
    if (modalContent) {
        modalContent.style.overflow = 'visible';
        modalContent.style.maxHeight = 'none';
    }

    try {
        await new Promise(r => setTimeout(r, 80));

        const width = el.offsetWidth;
        const height = el.offsetHeight;

        const canvas = await html2canvas(el, {
            scale: 2,
            backgroundColor: '#ffffff',
            useCORS: true,
            logging: false,
            width: width,
            height: height,
            windowWidth: width,
            windowHeight: height,
            scrollX: 0,
            scrollY: 0
        });

        if (modalContent) {
            modalContent.style.overflow = origOverflow;
            modalContent.style.maxHeight = origMaxHeight;
        }
        showLoading(false);

        const fileName = `invoice-${Date.now()}.png`;

        if (navigator.canShare && window.File) {
            canvas.toBlob(async (blob) => {
                const file = new File([blob], fileName, { type: 'image/png' });
                if (navigator.canShare({ files: [file] })) {
                    try {
                        await navigator.share({ files: [file], title: 'Invoice', text: 'Sales invoice from TimberPro' });
                        return;
                    } catch (e) {}
                }
                downloadBlob(blob, fileName);
            }, 'image/png');
        } else {
            const dataUrl = canvas.toDataURL('image/png');
            const a = document.createElement('a');
            a.href = dataUrl;
            a.download = fileName;
            document.body.appendChild(a); a.click(); a.remove();
            showToast('Invoice downloaded as image', 'success');
        }
    } catch (e) {
        if (modalContent) {
            modalContent.style.overflow = origOverflow;
            modalContent.style.maxHeight = origMaxHeight;
        }
        showLoading(false);
        console.error(e);
        showToast('Failed to generate image', 'error');
    }
}
function downloadBlob(blob, filename = `invoice-${Date.now()}.png`) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    showToast('Invoice downloaded', 'success');
}

// ==================== TODAY ====================
function renderToday() {
    const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    return `
        <div class="page-header">
            <div><h1 class="page-title">Today</h1><p class="page-subtitle">${today}</p></div>
            <button onclick="initTodayPage()" class="btn btn-outline btn-small">🔄 Refresh</button>
        </div>
        <div class="grid-4">
            <div class="stat-card success"><div class="stat-label">💰 Sales</div><div class="stat-value" id="t-sales">—</div><div class="stat-change" id="t-sales-count">0 transactions</div></div>
            <div class="stat-card danger"><div class="stat-label">💸 Expenses</div><div class="stat-value" id="t-exp">—</div><div class="stat-change" id="t-exp-count">0 items</div></div>
            <div class="stat-card info"><div class="stat-label">📊 Net</div><div class="stat-value" id="t-net">—</div><div class="stat-change">Sales − Expenses</div></div>
            <div class="stat-card"><div class="stat-label">📅 Date</div><div class="stat-value" style="font-size:15px;">${new Date().toLocaleDateString('en-GB')}</div></div>
        </div>
        <div class="today-tabs">
            <button class="active" data-tab="sales" onclick="switchTodayTab('sales', this)">🛒 Sales</button>
            <button data-tab="expenses" onclick="switchTodayTab('expenses', this)">💸 Expenses</button>
        </div>
        <div id="today-sales"></div>
        <div id="today-expenses" class="hidden"></div>
    `;
}
function switchTodayTab(tab, btn) {
    document.querySelectorAll('.today-tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('today-sales').classList.toggle('hidden', tab !== 'sales');
    document.getElementById('today-expenses').classList.toggle('hidden', tab !== 'expenses');
}
async function initTodayPage() {
    const r = await API.get('/today');
    if (!r.success) { showToast('Failed to load', 'error'); return; }
    const { sales, expenses, totals } = r;

    document.getElementById('t-sales').textContent = formatCurrency(totals.sales_total);
    document.getElementById('t-sales-count').textContent = totals.sales_count + ' transactions';
    document.getElementById('t-exp').textContent = formatCurrency(totals.expenses_total);
    document.getElementById('t-exp-count').textContent = totals.expenses_count + ' items';
    const net = document.getElementById('t-net');
    net.textContent = formatCurrency(totals.net);
    net.style.color = totals.net >= 0 ? 'var(--success)' : 'var(--danger)';

    const salesEl = document.getElementById('today-sales');
    if (sales.length === 0) {
        salesEl.innerHTML = `<div class="empty-state"><div class="empty-icon">🛒</div><div class="empty-title">No sales yet today</div></div>`;
    } else {
        salesEl.innerHTML = sales.map(s => `
            <div class="card" style="cursor:pointer;" onclick="showInvoice(${s.id})">
                <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;">
                    <div>
                        <div style="font-weight:700;">${escapeHtml(s.invoice_number)}</div>
                        <div style="font-size:12px;color:var(--text-light);margin-top:2px;">${formatDateTime(s.created_at)} · ${escapeHtml(s.user_name || '')}</div>
                        <div style="font-size:13px;margin-top:4px;">👤 ${escapeHtml(s.customer_name || 'Walk-in')}</div>
                    </div>
                    <div style="text-align:right;">
                        <div style="font-family:var(--font-display);font-size:18px;font-weight:700;color:var(--primary);">${formatCurrency(s.total_amount)}</div>
                        <div style="font-size:11px;color:var(--text-light);text-transform:uppercase;">${String(s.payment_method || '').toUpperCase()}</div>
                    </div>
                </div>
                <div style="margin-top:10px;font-size:13px;display:flex;flex-direction:column;gap:4px;">
                    ${s.items.map(i => `<div style="display:flex;justify-content:space-between;">
                        <span>${escapeHtml(i.name)} × ${formatQty(i.quantity)}</span>
                        <span style="color:var(--text-light);">${formatCurrency(i.total_price)}</span>
                    </div>`).join('')}
                </div>
                ${s.notes ? `<div class="sale-notes">📝 ${escapeHtml(s.notes)}</div>` : ''}
            </div>`).join('');
    }

    const expEl = document.getElementById('today-expenses');
    if (expenses.length === 0) {
        expEl.innerHTML = `<div class="empty-state"><div class="empty-icon">💸</div><div class="empty-title">No expenses today</div></div>`;
    } else {
        const icons = { fuel: '⛽', rent: '🏠', salaries: '💵', repairs: '🔧', miscellaneous: '📋' };
        expEl.innerHTML = expenses.map(e => `
            <div class="expense-card">
                <div class="expense-head">
                    <div style="display:flex;align-items:center;gap:12px;">
                        <div style="font-size:26px;">${icons[e.category] || '📋'}</div>
                        <div>
                            <div class="expense-category">${escapeHtml(e.category)}</div>
                            <div style="font-size:11px;color:var(--text-light);">${formatDate(e.date)} · ${escapeHtml(e.created_by_name || '')}</div>
                        </div>
                    </div>
                    <div class="expense-amount">${formatCurrency(e.amount)}</div>
                </div>
                ${e.description ? `<div class="expense-note">📝 ${escapeHtml(e.description)}</div>` : ''}
                ${e.receipt_number ? `<div class="expense-meta">Receipt: ${escapeHtml(e.receipt_number)}</div>` : ''}
            </div>`).join('');
    }
}

// ==================== SALES LOG ====================
let salesLogState = { range: 'today', customer: '', dateFrom: null, dateTo: null, groupBy: 'customer' };

function renderSalesLog() {
    return `
        <div class="page-header">
            <div><h1 class="page-title">Sales Log</h1><p class="page-subtitle">Detailed sales breakdown</p></div>
            <button onclick="exportSalesLogCSV()" class="btn btn-outline btn-small">📥 CSV</button>
        </div>

        <div class="log-group-toggle">
            <button class="${salesLogState.groupBy === 'customer' ? 'active' : ''}" data-group="customer">👥 By Customer</button>
            <button class="${salesLogState.groupBy === 'product' ? 'active' : ''}" data-group="product">📦 By Product</button>
        </div>

        <div class="segmented" id="sl-range">
            <button data-range="today"  class="${salesLogState.range === 'today'  ? 'active' : ''}">Today</button>
            <button data-range="week"   class="${salesLogState.range === 'week'   ? 'active' : ''}">7 Days</button>
            <button data-range="month"  class="${salesLogState.range === 'month'  ? 'active' : ''}">Month</button>
            <button data-range="custom" class="${salesLogState.range === 'custom' ? 'active' : ''}">Custom</button>
            <button data-range="all"    class="${salesLogState.range === 'all'    ? 'active' : ''}">All</button>
        </div>

        <div id="sl-custom" class="custom-range ${salesLogState.range === 'custom' ? '' : 'hidden'}">
            <input type="date" id="sl-from" value="${salesLogState.dateFrom || new Date().toISOString().split('T')[0]}">
            <span>→</span>
            <input type="date" id="sl-to" value="${salesLogState.dateTo || new Date().toISOString().split('T')[0]}">
            <button class="btn btn-primary btn-small" onclick="applySalesLogRange()">Apply</button>
        </div>

        <div id="sl-customer-filter" class="search-box" style="margin-bottom:16px;${salesLogState.groupBy === 'product' ? 'display:none;' : ''}">
            <span class="search-icon">🔍</span>
            <input type="text" id="sl-customer-search" placeholder="Filter by customer name..." value="${escapeHtml(salesLogState.customer)}">
        </div>

        <div class="grid-4" id="sl-summary">
            <div class="stat-card success"><div class="stat-label">💰 Total Sales</div><div class="stat-value" id="sl-total">—</div></div>
            <div class="stat-card info"><div class="stat-label">📊 Transactions</div><div class="stat-value" id="sl-txns">—</div></div>
            <div class="stat-card"><div class="stat-label" id="sl-3-label">👥 Customers</div><div class="stat-value" id="sl-cust">—</div></div>
            <div class="stat-card warning"><div class="stat-label">📈 Avg Sale</div><div class="stat-value" id="sl-avg">—</div></div>
        </div>
        <div id="sales-log-list"><div class="empty-state"><div class="empty-text">Loading...</div></div></div>
    `;
}
async function initSalesLogPage() {
    document.querySelectorAll('.log-group-toggle button').forEach(btn => {
        btn.addEventListener('click', () => {
            salesLogState.groupBy = btn.dataset.group;
            document.querySelectorAll('.log-group-toggle button').forEach(b => b.classList.toggle('active', b === btn));
            document.getElementById('sl-customer-filter').style.display = salesLogState.groupBy === 'product' ? 'none' : '';
            loadSalesLog();
        });
    });
    document.getElementById('sl-range').addEventListener('click', (e) => {
        const btn = e.target.closest('button'); if (!btn) return;
        salesLogState.range = btn.dataset.range;
        document.querySelectorAll('#sl-range button').forEach(b => b.classList.toggle('active', b === btn));
        document.getElementById('sl-custom').classList.toggle('hidden', salesLogState.range !== 'custom');
        if (salesLogState.range !== 'custom') loadSalesLog();
    });
    const search = document.getElementById('sl-customer-search');
    if (search) search.addEventListener('input', debounce(e => { salesLogState.customer = e.target.value; loadSalesLog(); }, 250));
    await loadSalesLog();
}
function applySalesLogRange() {
    const from = document.getElementById('sl-from').value;
    const to = document.getElementById('sl-to').value;
    if (!from || !to) { showToast('Select both dates', 'error'); return; }
    salesLogState.dateFrom = from;
    salesLogState.dateTo = to;
    loadSalesLog();
}
async function loadSalesLog() {
    const c = document.getElementById('sales-log-list');
    c.innerHTML = `<div class="empty-state"><div class="empty-text">Loading...</div></div>`;
    const params = new URLSearchParams({ range: salesLogState.range, group_by: salesLogState.groupBy });
    if (salesLogState.range === 'custom' && salesLogState.dateFrom && salesLogState.dateTo) {
        params.set('date_from', salesLogState.dateFrom);
        params.set('date_to', salesLogState.dateTo);
    }
    if (salesLogState.customer && salesLogState.groupBy === 'customer') params.set('customer', salesLogState.customer);
    const r = await API.get(`/sales-log?${params.toString()}`);
    if (!r.success) { c.innerHTML = `<div class="empty-state"><div class="empty-icon">❌</div><div class="empty-text">Failed to load</div></div>`; return; }

    const s = r.summary;
    document.getElementById('sl-total').textContent = formatCurrency(s.grand_total);
    document.getElementById('sl-txns').textContent = s.total_sales;
    document.getElementById('sl-3-label').textContent = salesLogState.groupBy === 'product' ? '📦 Products' : '👥 Customers';
    document.getElementById('sl-cust').textContent = salesLogState.groupBy === 'product' ? s.product_count : s.customer_count;
    document.getElementById('sl-avg').textContent = s.total_sales > 0 ? formatCurrency(s.grand_total / s.total_sales) : 'GHS 0.00';

    if (salesLogState.groupBy === 'product') renderSalesLogByProduct(c, r.products || []);
    else renderSalesLogByCustomer(c, r.customers || []);
}

function renderSalesLogByCustomer(c, customers) {
    if (!customers.length) {
        c.innerHTML = `<div class="empty-state"><div class="empty-icon">🧾</div><div class="empty-title">No sales in this range</div></div>`;
        return;
    }
    c.innerHTML = customers.map((cust, idx) => `
        <div class="customer-card">
            <div class="customer-header" onclick="toggleCustomer('cust-${idx}')">
                <div style="display:flex;gap:12px;align-items:center;flex:1;min-width:0;">
                    <div style="width:40px;height:40px;border-radius:50%;background:var(--primary);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;flex-shrink:0;">${escapeHtml(cust.name.charAt(0).toUpperCase())}</div>
                    <div style="min-width:0;">
                        <div class="customer-name">${escapeHtml(cust.name)}</div>
                        <div class="customer-meta">${cust.sales_count} sale${cust.sales_count !== 1 ? 's' : ''} · ${cust.items.length} different item${cust.items.length !== 1 ? 's' : ''}</div>
                    </div>
                </div>
                <div>
                    <div class="customer-total">${formatCurrency(cust.total_spent)}</div>
                    <div style="font-size:11px;color:var(--text-light);text-align:right;">▼ Tap to expand</div>
                </div>
            </div>
            <div class="customer-body hidden" id="body-cust-${idx}">
                <div style="margin:12px 0 8px;font-size:11px;font-weight:700;color:var(--text-light);text-transform:uppercase;letter-spacing:0.5px;">Items Purchased</div>
                <div class="customer-items">
                    ${cust.items.map(it => `
                        <div class="customer-item">
                            <div>
                                <div class="customer-item-name">${it.type === 'product' ? '🪵' : '⚙️'} ${escapeHtml(it.name)}</div>
                                <div class="customer-item-meta">${it.type === 'product' ? 'Product' : 'Service'} · Qty: ${formatQty(it.qty)}</div>
                            </div>
                            <div style="font-weight:700;color:var(--primary);">${formatCurrency(it.total)}</div>
                        </div>`).join('')}
                </div>
                <div style="margin:12px 0 8px;font-size:11px;font-weight:700;color:var(--text-light);text-transform:uppercase;letter-spacing:0.5px;">Purchase History</div>
                ${cust.sales.map(sale => `
                    <div class="customer-sale-entry">
                        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
                            <div>
                                <strong>${escapeHtml(sale.invoice_number)}</strong>
                                <span style="color:var(--text-light);"> · ${formatDateTime(sale.created_at)}</span>
                            </div>
                            <div style="font-weight:700;">${formatCurrency(sale.total_amount)}</div>
                        </div>
                        <div style="font-size:11px;color:var(--text-light);margin-top:2px;">
                            ${String(sale.payment_method || '').toUpperCase()} · ${escapeHtml(sale.user_name || '')}
                        </div>
                        <div style="font-size:12px;margin-top:6px;color:var(--text-light);">
                            ${sale.items.map(i => `${escapeHtml(i.name)} (${formatQty(i.quantity)})`).join(', ')}
                        </div>
                        ${sale.notes ? `<div class="sale-notes">📝 ${escapeHtml(sale.notes)}</div>` : ''}
                    </div>`).join('')}
            </div>
        </div>`).join('');
}

function renderSalesLogByProduct(c, products) {
    if (!products.length) {
        c.innerHTML = `<div class="empty-state"><div class="empty-icon">📦</div><div class="empty-title">No product sales in this range</div></div>`;
        return;
    }
    c.innerHTML = products.map((p, idx) => `
        <div class="product-group-card">
            <div class="product-group-header" onclick="toggleCustomer('prod-${idx}')">
                <div style="flex:1;min-width:0;">
                    <div class="product-group-name">
                        <span>${p.type === 'product' ? '🪵' : '⚙️'}</span>
                        <span>${escapeHtml(p.name)}</span>
                    </div>
                    <div class="product-group-meta">
                        ${p.sales.length} sale${p.sales.length !== 1 ? 's' : ''} · ${p.customers.length} customer${p.customers.length !== 1 ? 's' : ''}
                    </div>
                </div>
                <div class="product-group-stats">
                    <div class="product-group-stat">
                        <div class="product-group-stat-value">${formatQty(p.total_qty)}</div>
                        <div class="product-group-stat-label">Units</div>
                    </div>
                    <div class="product-group-stat">
                        <div class="product-group-stat-value">${formatCurrency(p.total_revenue)}</div>
                        <div class="product-group-stat-label">Revenue</div>
                    </div>
                </div>
            </div>
            <div class="product-group-body hidden" id="body-prod-${idx}">
                <div style="margin:12px 0 8px;font-size:11px;font-weight:700;color:var(--text-light);text-transform:uppercase;letter-spacing:0.5px;">Customers Who Bought This</div>
                ${p.customers.map(cu => `
                    <div class="product-cust-row">
                        <strong>${escapeHtml(cu.name)}</strong>
                        <span style="color:var(--text-light);">${formatQty(cu.qty)} ${p.type === 'product' ? 'units' : 'times'}</span>
                    </div>`).join('')}
                <div style="margin:14px 0 8px;font-size:11px;font-weight:700;color:var(--text-light);text-transform:uppercase;letter-spacing:0.5px;">Sales Log</div>
                ${p.sales.map(s => `
                    <div class="customer-sale-entry">
                        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
                            <div>
                                <strong>${escapeHtml(s.invoice)}</strong>
                                <span style="color:var(--text-light);"> · ${formatDateTime(s.date)}</span>
                            </div>
                            <div style="font-weight:700;">${formatCurrency(s.total)}</div>
                        </div>
                        <div style="font-size:12px;color:var(--text-light);margin-top:4px;">
                            👤 ${escapeHtml(s.customer)} · Qty ${formatQty(s.qty)} × ${formatCurrency(s.unit_price)}
                        </div>
                        ${s.notes ? `<div class="sale-notes">📝 ${escapeHtml(s.notes)}</div>` : ''}
                    </div>`).join('')}
            </div>
        </div>`).join('');
}

function toggleCustomer(id) {
    const el = document.getElementById(`body-${id}`);
    if (el) el.classList.toggle('hidden');
}
async function exportSalesLogCSV() {
    const to = new Date().toISOString().split('T')[0];
    const from = salesLogState.dateFrom || to;
    const ok = await API.downloadFile(`/reports/sales?date_from=${from}&date_to=${salesLogState.dateTo || to}&format=csv`, `sales-log-${to}.csv`);
    showToast(ok ? 'Downloaded' : 'Download failed', ok ? 'success' : 'error');
}

// ==================== DRAFTS ====================
function renderDrafts() {
    return `<div class="page-header"><div><h1 class="page-title">Drafts</h1><p class="page-subtitle">Resume or delete saved sales</p></div></div>
        <div id="drafts-list"><div class="empty-state"><div class="empty-text">Loading...</div></div></div>`;
}
async function initDraftsPage() {
    const r = await API.get('/drafts');
    const c = document.getElementById('drafts-list');
    if (!r.success || !r.drafts?.length) {
        c.innerHTML = `<div class="empty-state"><div class="empty-icon">📝</div><div class="empty-title">No Drafts</div><div class="empty-text">Save a draft from the sales page.</div></div>`;
        return;
    }
    c.innerHTML = `<div class="grid-2">${r.drafts.map(d => `
        <div class="card">
            <div style="display:flex;justify-content:space-between;gap:12px;">
                <div>
                    <div style="font-weight:700;">${escapeHtml(d.draft_number)}</div>
                    <div style="font-size:12px;color:var(--text-light);margin-top:4px;">${formatDateTime(d.created_at)}</div>
                    <div style="font-size:12px;color:var(--text-light);">${escapeHtml(d.customer_name || 'Walk-in')}</div>
                </div>
                <div style="font-weight:700;font-size:18px;color:var(--primary);">${formatCurrency(d.total_amount)}</div>
            </div>
            <div style="margin-top:12px;font-size:12px;color:var(--text-light);">${(JSON.parse(d.items || '[]')).length} items</div>
            <div style="display:flex;gap:8px;margin-top:12px;">
                <button onclick="loadDraft(${d.id})" class="btn btn-primary btn-small">Resume</button>
                <button onclick="deleteDraft(${d.id})" class="btn btn-danger btn-small">Delete</button>
            </div>
        </div>`).join('')}</div>`;
}
async function loadDraft(id) {
    const r = await API.get('/drafts');
    if (!r.success) return;
    const d = r.drafts.find(x => x.id === id);
    if (!d) return;
    let items = [];
    try { items = JSON.parse(d.items || '[]'); } catch {}
    cart = items.map(it => ({
        type: it.item_type, id: it.product_id || it.service_id, name: it.name,
        price: it.unit_price, unit: it.item_type === 'product' ? 'piece' : 'service',
        quantity: it.quantity, stock: undefined
    }));
    await API.delete(`/drafts/${id}`);
    loadPage('sales');
    showToast('Draft loaded', 'info');
}
async function deleteDraft(id) {
    if (!confirm('Delete this draft?')) return;
    const r = await API.delete(`/drafts/${id}`);
    if (r.success) { showToast('Deleted', 'success'); initDraftsPage(); }
}

// ==================== ORDERS ====================
function renderOrders() {
    return `
        <div class="page-header">
            <div><h1 class="page-title">Orders</h1><p class="page-subtitle">Pay now, deliver later</p></div>
            <button onclick="showCreateOrder()" class="btn btn-primary">+ New Order</button>
        </div>
        <div class="tabs" id="order-tabs">
            <button class="tab active" data-status="all">All</button>
            <button class="tab" data-status="pending">Pending</button>
            <button class="tab" data-status="paid">Paid</button>
            <button class="tab" data-status="ready">Ready</button>
            <button class="tab" data-status="delivered">Delivered</button>
        </div>
        <div id="orders-list"><div class="empty-state"><div class="empty-text">Loading...</div></div></div>
    `;
}
async function initOrdersPage() {
    if (products.length === 0) {
        const p = await API.get('/products');
        if (p.success) products = p.products.filter(x => x.is_active);
    }
    document.getElementById('order-tabs').addEventListener('click', e => {
        const btn = e.target.closest('.tab'); if (!btn) return;
        document.querySelectorAll('#order-tabs .tab').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        loadOrders(btn.dataset.status);
    });
    await loadOrders('all');
}
async function loadOrders(status = 'all') {
    const url = status && status !== 'all' ? `/orders?status=${status}` : '/orders';
    const r = await API.get(url);
    const c = document.getElementById('orders-list');
    if (!r.success || !r.orders?.length) {
        c.innerHTML = `<div class="empty-state"><div class="empty-icon">📦</div><div class="empty-title">No Orders</div></div>`;
        return;
    }
    c.innerHTML = `<div class="grid-2">${r.orders.map(o => `
        <div class="card">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
                <div>
                    <div style="font-weight:700;">${escapeHtml(o.order_number)}</div>
                    <div style="font-size:12px;color:var(--text-light);margin-top:4px;">${formatDateTime(o.created_at)}</div>
                </div>
                <span class="status-badge ${o.status}">${o.status}</span>
            </div>
            <div style="margin-top:12px;font-size:14px;">
                <div><strong>Customer:</strong> ${escapeHtml(o.customer_name || 'Walk-in')}</div>
                <div><strong>Total:</strong> ${formatCurrency(o.total_amount)}</div>
                <div style="font-size:12px;color:var(--text-light);margin-top:4px;">${o.items?.length || 0} item(s) · ${String(o.payment_method || '').toUpperCase()}</div>
            </div>
            ${o.notes ? `<div class="sale-notes">📝 ${escapeHtml(o.notes)}</div>` : ''}
            <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;">
                ${o.status === 'pending' ? `<button onclick="updateOrderStatus(${o.id},'paid')" class="btn btn-primary btn-small">Mark Paid</button>` : ''}
                ${o.status === 'paid' ? `<button onclick="updateOrderStatus(${o.id},'ready')" class="btn btn-primary btn-small">Mark Ready</button>` : ''}
                ${o.status === 'ready' ? `<button onclick="updateOrderStatus(${o.id},'delivered')" class="btn btn-primary btn-small">Mark Delivered</button>` : ''}
                ${!['cancelled', 'delivered'].includes(o.status) ? `<button onclick="updateOrderStatus(${o.id},'cancelled')" class="btn btn-danger btn-small">Cancel</button>` : ''}
            </div>
        </div>`).join('')}</div>`;
}
async function updateOrderStatus(id, status) {
    const r = await API.put(`/orders/${id}/status`, { status });
    if (r.success) { showToast('Order updated', 'success'); loadOrders(); }
    else showToast(r.error || 'Failed', 'error');
}
function showCreateOrder() {
    orderItems = {};
    if (products.length === 0) { showToast('No products available', 'warning'); return; }
    openModal(`
        <div class="modal-header"><div class="modal-title">New Order</div><button class="modal-close" onclick="closeModal()">✕</button></div>
        <div style="max-height:280px;overflow-y:auto;margin-bottom:16px;">
            ${products.map(p => `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border-light);gap:12px;">
                <div style="flex:1;">
                    <div style="font-weight:600;font-size:14px;">${escapeHtml(p.name)}</div>
                    <div style="font-size:12px;color:var(--text-light);">${formatCurrency(p.price)} / ${escapeHtml(p.unit)}</div>
                </div>
                <div style="display:flex;align-items:center;gap:8px;">
                    <button onclick="adjustOrderItem(${p.id}, -1)" style="width:28px;height:28px;border-radius:50%;border:1px solid var(--border);background:#fff;cursor:pointer;">−</button>
                    <span id="oi-${p.id}" style="min-width:24px;text-align:center;font-weight:700;">0</span>
                    <button onclick="adjustOrderItem(${p.id}, 1)" style="width:28px;height:28px;border-radius:50%;border:1px solid var(--border);background:#fff;cursor:pointer;">+</button>
                </div>
            </div>`).join('')}
        </div>
        <div class="form-group"><label>Customer Name</label><input type="text" id="order-customer" placeholder="Customer name"></div>
        <div class="form-group"><label>Expected Delivery</label><input type="date" id="order-delivery"></div>
        <div class="form-group"><label>Payment</label><select id="order-payment"><option value="cash">Cash</option><option value="momo">Mobile Money</option></select></div>
        <div class="form-group"><label>Notes</label><textarea id="order-notes" placeholder="Optional notes..."></textarea></div>
        <div style="display:flex;justify-content:space-between;font-size:18px;font-weight:700;margin:16px 0;">
            <span>Total</span><span id="order-total">GHS 0.00</span>
        </div>
        <div class="form-actions">
            <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
            <button class="btn btn-success" onclick="submitOrder()">Create Order</button>
        </div>
    `);
}
function adjustOrderItem(pid, delta) {
    const p = products.find(x => x.id === pid); if (!p) return;
    if (!orderItems[pid]) orderItems[pid] = { product_id: pid, name: p.name, price: p.price, quantity: 0 };
    orderItems[pid].quantity = Math.max(0, orderItems[pid].quantity + delta);
    const el = document.getElementById(`oi-${pid}`);
    if (el) el.textContent = orderItems[pid].quantity;
    const total = Object.values(orderItems).reduce((s, i) => s + i.quantity * i.price, 0);
    const t = document.getElementById('order-total'); if (t) t.textContent = formatCurrency(total);
}
async function submitOrder() {
    const items = Object.values(orderItems).filter(i => i.quantity > 0)
        .map(i => ({ product_id: i.product_id, name: i.name, quantity: i.quantity, unit_price: i.price }));
    if (items.length === 0) { showToast('Add items', 'error'); return; }
    const data = {
        items,
        customer_name: document.getElementById('order-customer').value || null,
        expected_delivery_date: document.getElementById('order-delivery').value || null,
        payment_method: document.getElementById('order-payment').value,
        notes: document.getElementById('order-notes').value || null
    };
    showLoading(true);
    const r = await API.post('/orders', data);
    showLoading(false);
    if (r.success) { showToast('Order created', 'success'); orderItems = {}; closeModal(); loadOrders(); }
    else showToast(r.error || 'Failed', 'error');
}

// ==================== INVENTORY ====================
function renderInventory() {
    return `
        <div class="page-header">
            <div><h1 class="page-title">Inventory</h1><p class="page-subtitle">Stock levels</p></div>
            <button onclick="showReceiveStock()" class="btn btn-primary">+ Receive Stock</button>
        </div>
        <div class="search-box"><span class="search-icon">🔍</span><input type="text" id="inv-search" placeholder="Search inventory..." oninput="filterInventory(this.value)"></div>
        <div id="inventory-list"><div class="empty-state"><div class="empty-text">Loading...</div></div></div>
    `;
}
async function initInventoryPage() {
    const r = await API.get('/inventory');
    const c = document.getElementById('inventory-list');
    if (!r.success || !r.inventory?.length) {
        c.innerHTML = `<div class="empty-state"><div class="empty-icon">🏷️</div><div class="empty-title">No Inventory</div></div>`;
        return;
    }
    c.innerHTML = `<div class="table-container table-responsive"><table class="table" id="inv-table">
        <thead><tr><th>Product</th><th>Stock</th><th>Reserved</th><th>Available</th><th>Status</th></tr></thead>
        <tbody>${r.inventory.map(i => {
            const avail = i.quantity - i.reserved_quantity;
            const low = avail <= i.stock_threshold;
            return `<tr>
                <td data-label="Product">${escapeHtml(i.product_name)}</td>
                <td data-label="Stock">${formatQty(i.quantity)} ${escapeHtml(i.unit || '')}</td>
                <td data-label="Reserved">${formatQty(i.reserved_quantity)}</td>
                <td data-label="Available">${formatQty(avail)}</td>
                <td data-label="Status"><span class="status-badge ${low ? 'cancelled' : 'completed'}">${low ? 'LOW' : 'OK'}</span></td>
            </tr>`;
        }).join('')}</tbody>
    </table></div>`;
}
function filterInventory(q) {
    q = q.toLowerCase();
    document.querySelectorAll('#inv-table tbody tr').forEach(tr => {
        tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
}
function showReceiveStock() {
    if (products.length === 0) { showToast('Load products first', 'warning'); return; }
    openModal(`
        <div class="modal-header"><div class="modal-title">Receive Stock</div><button class="modal-close" onclick="closeModal()">✕</button></div>
        <form onsubmit="submitReceiveStock(event)">
            <div class="form-group"><label>Product</label><select id="rs-product" required><option value="">Select product...</option>
                ${products.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}
            </select></div>
            <div class="form-row">
                <div class="form-group"><label>Quantity</label><input type="number" id="rs-qty" step="0.01" min="0.01" required></div>
                <div class="form-group"><label>Cost Price (per unit)</label><input type="number" id="rs-cost" step="0.01" min="0" value="0"></div>
            </div>
            <div class="form-group"><label>Supplier</label><input type="text" id="rs-supplier" placeholder="Optional"></div>
            <div class="form-group"><label>Notes</label><textarea id="rs-notes" placeholder="e.g. Received from supplier X"></textarea></div>
            <div class="form-actions">
                <button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button>
                <button type="submit" class="btn btn-success">Receive</button>
            </div>
        </form>
    `);
}
async function submitReceiveStock(e) {
    e.preventDefault();
    const data = {
        product_id: parseInt(document.getElementById('rs-product').value),
        quantity: parseFloat(document.getElementById('rs-qty').value),
        cost_price: parseFloat(document.getElementById('rs-cost').value) || 0,
        supplier: document.getElementById('rs-supplier').value || null,
        notes: document.getElementById('rs-notes').value || null
    };
    showLoading(true);
    const r = await API.post('/inventory/receive', data);
    showLoading(false);
    if (r.success) { showToast('Stock received', 'success'); closeModal(); initInventoryPage(); }
    else showToast(r.error || 'Failed', 'error');
}

// ==================== PRODUCTS ====================
function renderProducts() {
    return `
        <div class="page-header">
            <div><h1 class="page-title">Products</h1><p class="page-subtitle">Manage timber products</p></div>
            <button onclick="showProductForm()" class="btn btn-primary">+ Add Product</button>
        </div>
        <div class="search-box"><span class="search-icon">🔍</span><input type="text" id="prod-search" placeholder="Search products..." oninput="filterProducts(this.value)"></div>
        <div id="products-list"><div class="empty-state"><div class="empty-text">Loading...</div></div></div>
    `;
}
async function initProductsPage() {
    const r = await API.get('/products');
    const c = document.getElementById('products-list');
    if (!r.success || !r.products?.length) {
        c.innerHTML = `<div class="empty-state"><div class="empty-icon">🪵</div><div class="empty-title">No Products</div></div>`;
        return;
    }
    products = r.products;
    c.innerHTML = `<div class="grid-2" id="products-grid">${r.products.map(p => `
        <div class="card" style="opacity:${p.is_active ? 1 : 0.6}">
            <div style="display:flex;justify-content:space-between;gap:10px;">
                <div>
                    <div style="font-weight:700;font-size:16px;">${escapeHtml(p.name)}</div>
                    <div style="font-size:12px;color:var(--text-light);margin-top:4px;">${escapeHtml(p.description || '')}</div>
                </div>
                <span class="status-badge ${p.is_active ? 'completed' : 'cancelled'}">${p.is_active ? 'Active' : 'Inactive'}</span>
            </div>
            <div style="display:flex;gap:16px;margin-top:12px;font-size:14px;flex-wrap:wrap;">
                <div><strong>Price:</strong> ${formatCurrency(p.price)}</div>
                <div><strong>Cost:</strong> ${formatCurrency(p.cost_price)}</div>
                <div><strong>Threshold:</strong> ${p.stock_threshold}</div>
            </div>
            <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;">
                <button onclick="editProduct(${p.id})" class="btn btn-primary btn-small">Edit</button>
                <button onclick="toggleProduct(${p.id}, ${p.is_active ? 0 : 1})" class="btn btn-outline btn-small">${p.is_active ? 'Disable' : 'Enable'}</button>
                <button onclick="deleteProduct(${p.id})" class="btn btn-danger btn-small">Delete</button>
            </div>
        </div>`).join('')}</div>`;
}
function filterProducts(q) {
    q = q.toLowerCase();
    document.querySelectorAll('#products-grid .card').forEach(el => {
        el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
}
function showProductForm(p = null) {
    const edit = !!p;
    openModal(`
        <div class="modal-header"><div class="modal-title">${edit ? 'Edit' : 'Add'} Product</div><button class="modal-close" onclick="closeModal()">✕</button></div>
        <form onsubmit="submitProduct(event, ${edit ? p.id : 'null'})">
            <div class="form-group"><label>Name *</label><input type="text" id="f-name" required value="${edit ? escapeHtml(p.name) : ''}"></div>
            <div class="form-group"><label>Description</label><input type="text" id="f-desc" value="${edit ? escapeHtml(p.description || '') : ''}"></div>
            <div class="form-row">
                <div class="form-group"><label>Unit</label><select id="f-unit">
                    ${['piece', 'board', 'meter', 'ft', 'kg', 'bag', 'box'].map(u => `<option value="${u}" ${edit && p.unit === u ? 'selected' : ''}>${u}</option>`).join('')}
                </select></div>
                <div class="form-group"><label>Category</label><input type="text" id="f-cat" value="${edit ? escapeHtml(p.category || 'timber') : 'timber'}"></div>
            </div>
            <div class="form-row">
                <div class="form-group"><label>Price *</label><input type="number" id="f-price" step="0.01" min="0" required value="${edit ? p.price : ''}"></div>
                <div class="form-group"><label>Cost</label><input type="number" id="f-cost" step="0.01" min="0" value="${edit ? (p.cost_price || 0) : 0}"></div>
            </div>
            <div class="form-group"><label>Low Stock Alert Threshold</label><input type="number" id="f-thr" step="0.01" min="0" value="${edit ? p.stock_threshold : 10}"></div>
            <div class="form-actions">
                <button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button>
                <button type="submit" class="btn btn-success">${edit ? 'Save' : 'Create'}</button>
            </div>
        </form>
    `);
}
async function submitProduct(e, id) {
    e.preventDefault();
    const data = {
        name: document.getElementById('f-name').value,
        description: document.getElementById('f-desc').value || null,
        unit: document.getElementById('f-unit').value,
        category: document.getElementById('f-cat').value || 'timber',
        price: parseFloat(document.getElementById('f-price').value),
        cost_price: parseFloat(document.getElementById('f-cost').value) || 0,
        stock_threshold: parseFloat(document.getElementById('f-thr').value) || 10,
        is_active: 1
    };
    showLoading(true);
    const r = id ? await API.put(`/products/${id}`, data) : await API.post('/products', data);
    showLoading(false);
    if (r.success) { showToast(`Product ${id ? 'updated' : 'created'}`, 'success'); closeModal(); initProductsPage(); }
    else showToast(r.error || 'Failed', 'error');
}
async function editProduct(id) {
    const r = await API.get(`/products/${id}`);
    if (r.success) showProductForm(r.product);
}
async function toggleProduct(id, active) {
    const p = products.find(x => x.id === id); if (!p) return;
    const r = await API.put(`/products/${id}`, {
        name: p.name, description: p.description, unit: p.unit, category: p.category,
        price: p.price, cost_price: p.cost_price, stock_threshold: p.stock_threshold, is_active: active
    });
    if (r.success) { showToast(`Product ${active ? 'enabled' : 'disabled'}`, 'success'); initProductsPage(); }
}
async function deleteProduct(id) {
    if (!confirm('Delete this product?')) return;
    const r = await API.delete(`/products/${id}`);
    if (r.success) { showToast('Product deleted', 'success'); initProductsPage(); }
}

// ==================== SERVICES ====================
function renderServices() {
    return `
        <div class="page-header">
            <div><h1 class="page-title">Services</h1><p class="page-subtitle">Machine work and services</p></div>
            <button onclick="showServiceForm()" class="btn btn-primary">+ Add Service</button>
        </div>
        <div id="services-list"><div class="empty-state"><div class="empty-text">Loading...</div></div></div>
    `;
}
async function initServicesPage() {
    const r = await API.get('/services');
    const c = document.getElementById('services-list');
    if (!r.success || !r.services?.length) {
        c.innerHTML = `<div class="empty-state"><div class="empty-icon">⚙️</div><div class="empty-title">No Services</div></div>`;
        return;
    }
    services = r.services;
    c.innerHTML = `<div class="grid-2">${r.services.map(s => `
        <div class="card" style="opacity:${s.is_active ? 1 : 0.6}">
            <div style="display:flex;justify-content:space-between;gap:10px;">
                <div>
                    <div style="font-weight:700;font-size:16px;">${escapeHtml(s.name)}</div>
                    <div style="font-size:12px;color:var(--text-light);margin-top:4px;">${escapeHtml(s.description || '')}</div>
                </div>
                <span class="status-badge ${s.is_active ? 'completed' : 'cancelled'}">${s.is_active ? 'Active' : 'Inactive'}</span>
            </div>
            <div style="margin-top:12px;font-size:18px;font-weight:700;color:var(--primary);">${formatCurrency(s.price)}</div>
            <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;">
                <button onclick="editService(${s.id})" class="btn btn-primary btn-small">Edit</button>
                <button onclick="toggleService(${s.id}, ${s.is_active ? 0 : 1})" class="btn btn-outline btn-small">${s.is_active ? 'Disable' : 'Enable'}</button>
                <button onclick="deleteService(${s.id})" class="btn btn-danger btn-small">Delete</button>
            </div>
        </div>`).join('')}</div>`;
}
function showServiceForm(s = null) {
    const edit = !!s;
    openModal(`
        <div class="modal-header"><div class="modal-title">${edit ? 'Edit' : 'Add'} Service</div><button class="modal-close" onclick="closeModal()">✕</button></div>
        <form onsubmit="submitService(event, ${edit ? s.id : 'null'})">
            <div class="form-group"><label>Name *</label><input type="text" id="sv-name" required value="${edit ? escapeHtml(s.name) : ''}"></div>
            <div class="form-group"><label>Description</label><input type="text" id="sv-desc" value="${edit ? escapeHtml(s.description || '') : ''}"></div>
            <div class="form-group"><label>Default Price *</label><input type="number" id="sv-price" step="0.01" min="0" required value="${edit ? s.price : ''}"></div>
            <div class="form-actions">
                <button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button>
                <button type="submit" class="btn btn-success">${edit ? 'Save' : 'Create'}</button>
            </div>
        </form>
    `);
}
async function submitService(e, id) {
    e.preventDefault();
    const data = {
        name: document.getElementById('sv-name').value,
        description: document.getElementById('sv-desc').value || null,
        price: parseFloat(document.getElementById('sv-price').value),
        is_active: 1
    };
    showLoading(true);
    const r = id ? await API.put(`/services/${id}`, data) : await API.post('/services', data);
    showLoading(false);
    if (r.success) { showToast(`Service ${id ? 'updated' : 'created'}`, 'success'); closeModal(); initServicesPage(); }
    else showToast(r.error || 'Failed', 'error');
}
async function editService(id) {
    const s = services.find(x => x.id === id) || (await API.get(`/services/${id}`)).service;
    if (s) showServiceForm(s);
}
async function toggleService(id, active) {
    const s = services.find(x => x.id === id); if (!s) return;
    const r = await API.put(`/services/${id}`, { name: s.name, description: s.description, price: s.price, is_active: active });
    if (r.success) { showToast(`Service ${active ? 'enabled' : 'disabled'}`, 'success'); initServicesPage(); }
}
async function deleteService(id) {
    if (!confirm('Delete this service?')) return;
    const r = await API.delete(`/services/${id}`);
    if (r.success) { showToast('Service deleted', 'success'); initServicesPage(); }
}

// ==================== EXPENSES ====================
function renderExpenses() {
    return `
        <div class="page-header">
            <div><h1 class="page-title">Expenses</h1><p class="page-subtitle">Track business expenses</p></div>
            <button onclick="showExpenseForm()" class="btn btn-primary">+ Add Expense</button>
        </div>
        <div id="expenses-list"><div class="empty-state"><div class="empty-text">Loading...</div></div></div>
    `;
}
async function initExpensesPage() {
    const r = await API.get('/expenses');
    const c = document.getElementById('expenses-list');
    if (!r.success || !r.expenses?.length) {
        c.innerHTML = `<div class="empty-state"><div class="empty-icon">💸</div><div class="empty-title">No Expenses</div></div>`;
        return;
    }
    const icons = { fuel: '⛽', rent: '🏠', salaries: '💵', repairs: '🔧', miscellaneous: '📋' };
    c.innerHTML = `<div class="grid-2">${r.expenses.map(e => `
        <div class="card">
            <div style="display:flex;justify-content:space-between;gap:10px;">
                <div style="display:flex;gap:12px;align-items:center;">
                    <div style="font-size:28px;">${icons[e.category] || '📋'}</div>
                    <div>
                        <div style="font-weight:700;text-transform:capitalize;">${escapeHtml(e.category)}</div>
                        <div style="font-size:12px;color:var(--text-light);">${formatDate(e.date)}</div>
                    </div>
                </div>
                <div style="font-weight:700;color:var(--danger);">${formatCurrency(e.amount)}</div>
            </div>
            ${e.description ? `<div class="expense-note" style="margin-top:10px;">📝 ${escapeHtml(e.description)}</div>` : ''}
            ${e.receipt_number ? `<div class="expense-meta">Receipt: ${escapeHtml(e.receipt_number)}</div>` : ''}
        </div>`).join('')}</div>`;
}
function showExpenseForm() {
    openModal(`
        <div class="modal-header"><div class="modal-title">Add Expense</div><button class="modal-close" onclick="closeModal()">✕</button></div>
        <form onsubmit="submitExpense(event)">
            <div class="form-group"><label>Category *</label><select id="ex-cat" required>
                <option value="">Select...</option>
                <option value="fuel">⛽ Fuel</option>
                <option value="rent">🏠 Rent</option>
                <option value="salaries">💵 Salaries</option>
                <option value="repairs">🔧 Repairs</option>
                <option value="miscellaneous">📋 Miscellaneous</option>
            </select></div>
            <div class="form-group"><label>Amount *</label><input type="number" id="ex-amt" step="0.01" min="0.01" required></div>
            <div class="form-group"><label>Date</label><input type="date" id="ex-date" value="${new Date().toISOString().split('T')[0]}"></div>
            <div class="form-group"><label>Description / Notes</label><textarea id="ex-desc" placeholder="Details about this expense..."></textarea></div>
            <div class="form-group"><label>Receipt #</label><input type="text" id="ex-rcpt"></div>
            <div class="form-actions">
                <button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button>
                <button type="submit" class="btn btn-success">Save</button>
            </div>
        </form>
    `);
}
async function submitExpense(e) {
    e.preventDefault();
    const data = {
        category: document.getElementById('ex-cat').value,
        amount: parseFloat(document.getElementById('ex-amt').value),
        date: document.getElementById('ex-date').value,
        description: document.getElementById('ex-desc').value || null,
        receipt_number: document.getElementById('ex-rcpt').value || null
    };
    showLoading(true);
    const r = await API.post('/expenses', data);
    showLoading(false);
    if (r.success) { showToast('Expense added', 'success'); closeModal(); initExpensesPage(); }
    else showToast(r.error || 'Failed', 'error');
}

// ==================== ACTIVITY LOG ====================
let activityState = { range: 'today', type: 'all', dateFrom: null, dateTo: null };

function renderActivityLog() {
    return `
        <div class="page-header" style="align-items:flex-start;">
            <div><h1 class="page-title">Activity Log</h1><p class="page-subtitle">Every product movement — sold & received</p></div>
            <button onclick="exportActivityCSV()" class="btn btn-outline btn-small">📥 CSV</button>
        </div>
        <div class="segmented" id="range-segmented">
            <button data-range="today"  class="${activityState.range === 'today'  ? 'active' : ''}">Today</button>
            <button data-range="week"   class="${activityState.range === 'week'   ? 'active' : ''}">7 Days</button>
            <button data-range="month"  class="${activityState.range === 'month'  ? 'active' : ''}">Month</button>
            <button data-range="custom" class="${activityState.range === 'custom' ? 'active' : ''}">Custom</button>
            <button data-range="all"    class="${activityState.range === 'all'    ? 'active' : ''}">All</button>
        </div>
        <div id="custom-range" class="custom-range ${activityState.range === 'custom' ? '' : 'hidden'}">
            <input type="date" id="activity-from" value="${activityState.dateFrom || new Date().toISOString().split('T')[0]}">
            <span>→</span>
            <input type="date" id="activity-to" value="${activityState.dateTo || new Date().toISOString().split('T')[0]}">
            <button class="btn btn-primary btn-small" onclick="applyCustomRange()">Apply</button>
        </div>
        <div class="type-chips">
            <button class="type-chip ${activityState.type === 'all' ? 'active' : ''}" data-type="all">All</button>
            <button class="type-chip sold ${activityState.type === 'sold' ? 'active' : ''}" data-type="sold">🔻 Sold</button>
            <button class="type-chip received ${activityState.type === 'received' ? 'active' : ''}" data-type="received">🔺 Received</button>
        </div>
        <div class="grid-4">
            <div class="stat-card success"><div class="stat-label">🔺 Received</div><div class="stat-value" id="sum-recv-qty">—</div><div class="stat-change" id="sum-recv-amt">—</div></div>
            <div class="stat-card danger"><div class="stat-label">🔻 Sold</div><div class="stat-value" id="sum-sold-qty">—</div><div class="stat-change" id="sum-sold-amt">—</div></div>
            <div class="stat-card info"><div class="stat-label">↔️ Net Change</div><div class="stat-value" id="sum-net">—</div><div class="stat-change">Units</div></div>
            <div class="stat-card"><div class="stat-label">📊 Transactions</div><div class="stat-value" id="sum-txns">—</div><div class="stat-change">In range</div></div>
        </div>
        <div id="activity-list"><div class="empty-state"><div class="empty-icon">⏳</div><div class="empty-text">Loading...</div></div></div>
    `;
}
async function initActivityLogPage() {
    document.getElementById('range-segmented').addEventListener('click', (e) => {
        const btn = e.target.closest('button'); if (!btn) return;
        activityState.range = btn.dataset.range;
        document.querySelectorAll('#range-segmented button').forEach(b => b.classList.toggle('active', b === btn));
        document.getElementById('custom-range').classList.toggle('hidden', activityState.range !== 'custom');
        if (activityState.range !== 'custom') loadActivityLog();
    });
    document.querySelectorAll('.type-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            activityState.type = chip.dataset.type;
            document.querySelectorAll('.type-chip').forEach(c => c.classList.toggle('active', c === chip));
            loadActivityLog();
        });
    });
    await loadActivityLog();
}
function applyCustomRange() {
    const from = document.getElementById('activity-from').value;
    const to = document.getElementById('activity-to').value;
    if (!from || !to) { showToast('Select both dates', 'error'); return; }
    if (from > to) { showToast('"From" must be before "To"', 'error'); return; }
    activityState.dateFrom = from;
    activityState.dateTo = to;
    loadActivityLog();
}
async function loadActivityLog() {
    const c = document.getElementById('activity-list');
    c.innerHTML = `<div class="empty-state"><div class="empty-icon">⏳</div><div class="empty-text">Loading...</div></div>`;
    const params = new URLSearchParams({ range: activityState.range });
    if (activityState.range === 'custom' && activityState.dateFrom && activityState.dateTo) {
        params.set('date_from', activityState.dateFrom);
        params.set('date_to', activityState.dateTo);
    }
    if (activityState.type !== 'all') params.set('type', activityState.type);

    const r = await API.get(`/activity-log?${params.toString()}`);
    if (!r.success) { c.innerHTML = `<div class="empty-state"><div class="empty-icon">❌</div><div class="empty-text">Failed to load</div></div>`; return; }

    const s = r.summary || {};
    document.getElementById('sum-recv-qty').textContent = `${formatQty(s.received_qty || 0)} units`;
    document.getElementById('sum-recv-amt').textContent = formatCurrency(s.received_amount || 0);
    document.getElementById('sum-sold-qty').textContent = `${formatQty(s.sold_qty || 0)} units`;
    document.getElementById('sum-sold-amt').textContent = formatCurrency(s.sold_amount || 0);
    const net = s.net_qty || 0;
    const netEl = document.getElementById('sum-net');
    netEl.textContent = (net >= 0 ? '+' : '') + formatQty(net);
    netEl.style.color = net >= 0 ? 'var(--success)' : 'var(--danger)';
    document.getElementById('sum-txns').textContent = s.transactions || 0;

    const logs = r.logs || [];
    if (logs.length === 0) {
        c.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-title">No activity</div><div class="empty-text">No stock movements in this period.</div></div>`;
        return;
    }

    const grouped = {};
    for (const log of logs) {
        const day = (log.created_at || '').split('T')[0].split(' ')[0];
        if (!grouped[day]) grouped[day] = [];
        grouped[day].push(log);
    }

    c.innerHTML = Object.entries(grouped).map(([day, entries]) => {
        const dayTotal = entries.reduce((sum, e) => sum + (e.type === 'out' ? e.total_amount : 0), 0);
        return `<div class="day-group">
            <div class="day-header">
                <div class="day-label">${formatDayHeading(day)}</div>
                <div class="day-meta">${entries.length} movement${entries.length !== 1 ? 's' : ''} · Sales ${formatCurrency(dayTotal)}</div>
            </div>
            <div class="activity-table">
                ${entries.map(log => activityRow(log)).join('')}
            </div>
        </div>`;
    }).join('');
}
function activityRow(log) {
    const isSold = log.type === 'out';
    const typeLabel = isSold ? 'Sold' : 'Received';
    const typeClass = isSold ? 'sold' : 'received';
    const sign = isSold ? '−' : '+';
    const qty = formatQty(log.quantity);
    const balance = formatQty(log.balance);
    const price = formatCurrency(log.unit_price);
    const total = log.total_amount > 0 ? formatCurrency(log.total_amount) : '—';
    const note = log.notes ? `<div class="activity-note">📝 ${escapeHtml(log.notes)}</div>` : '';
    return `<div class="activity-row ${typeClass}">
        <div class="activity-type-badge ${typeClass}">${isSold ? '🔻' : '🔺'} ${typeLabel}</div>
        <div class="activity-main">
            <div class="activity-name">${escapeHtml(log.product_name)}</div>
            <div class="activity-meta">${sign}${qty} ${escapeHtml(log.unit || '')} · Balance: <strong>${balance}</strong> · ${escapeHtml(log.user_name || 'System')}</div>
            ${note}
        </div>
        <div class="activity-numbers">
            <div class="activity-price">${price} <span style="font-weight:400;color:var(--text-light);font-size:11px;">/ ${escapeHtml(log.unit || 'unit')}</span></div>
            <div class="activity-total ${typeClass}">${total}</div>
        </div>
    </div>`;
}
function formatDayHeading(isoDay) {
    const d = new Date(isoDay + 'T00:00:00');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    if (d.getTime() === today.getTime()) return `Today · ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
    if (d.getTime() === yesterday.getTime()) return `Yesterday · ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
}
async function exportActivityCSV() {
    const params = new URLSearchParams({ range: activityState.range });
    if (activityState.range === 'custom' && activityState.dateFrom && activityState.dateTo) {
        params.set('date_from', activityState.dateFrom);
        params.set('date_to', activityState.dateTo);
    }
    if (activityState.type !== 'all') params.set('type', activityState.type);
    const ok = await API.downloadFile(`/reports/activity?${params.toString()}`, `activity-${activityState.range}.csv`);
    showToast(ok ? 'Downloaded' : 'Download failed', ok ? 'success' : 'error');
}

// ==================== ANALYTICS ====================
function renderAnalytics() {
    return `
        <div class="page-header"><div><h1 class="page-title">Analytics</h1><p class="page-subtitle">Business insights</p></div></div>

        <div class="card">
            <div class="card-header"><div class="card-title">🏆 Product Performance — Revenue (This Month)</div></div>
            <div class="chart-wrap"><canvas id="chart-revenue"></canvas></div>
        </div>

        <div class="card">
            <div class="card-header"><div class="card-title">📦 Product Performance — Units Sold (This Month)</div></div>
            <div class="chart-wrap"><canvas id="chart-units"></canvas></div>
        </div>

        <div class="grid-2">
            <div class="card"><div class="card-header"><div class="card-title">📈 Sales (Last 7 Days)</div></div>
                <div class="chart-wrap" style="min-height:220px;"><canvas id="chart-sales"></canvas></div></div>
            <div class="card"><div class="card-header"><div class="card-title">💳 Payment Split</div></div>
                <div class="chart-wrap" style="min-height:220px;"><canvas id="chart-payments"></canvas></div></div>
        </div>

        <div class="card"><div class="card-header"><div class="card-title">💸 Expense Breakdown</div></div>
            <div id="an-exp"><div class="empty-state"><div class="empty-text">Loading...</div></div></div>
        </div>
    `;
}
async function initAnalyticsPage() {
    const [dash, exp] = await Promise.all([API.get('/analytics/dashboard'), API.get('/expenses')]);
    if (!dash.success) return;
    const d = dash.dashboard;
    const colors = ['#1a5f4a', '#f4a261', '#e76f51', '#74b9ff', '#a29bfe', '#00b894', '#fdcb6e', '#6c5ce7', '#e84393', '#0984e3'];

    if (d.top_products?.length) {
        const labels = d.top_products.map(p => p.name);
        const revenues = d.top_products.map(p => p.total_revenue);
        const ctx = document.getElementById('chart-revenue');
        if (ctx && typeof Chart !== 'undefined') currentCharts.revenue = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    label: 'Revenue (GHS)',
                    data: revenues,
                    backgroundColor: colors.slice(0, labels.length),
                    borderRadius: 6,
                    borderSkipped: false
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: 'y',
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: (ctx) => `GHS ${Number(ctx.parsed.x).toFixed(2)}` } }
                },
                scales: { x: { beginAtZero: true, ticks: { callback: v => 'GHS ' + v } } }
            }
        });
    }

    if (d.top_products?.length) {
        const labels = d.top_products.map(p => p.name);
        const units = d.top_products.map(p => p.total_qty);
        const ctx = document.getElementById('chart-units');
        if (ctx && typeof Chart !== 'undefined') currentCharts.units = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    label: 'Units Sold',
                    data: units,
                    backgroundColor: colors.slice(2, 2 + labels.length),
                    borderRadius: 6,
                    borderSkipped: false
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { y: { beginAtZero: true } }
            }
        });
    }

    if (d.sales_chart?.length) {
        const ctx = document.getElementById('chart-sales');
        if (ctx && typeof Chart !== 'undefined') currentCharts.sales = new Chart(ctx, {
            type: 'line',
            data: {
                labels: d.sales_chart.map(x => {
                    const dt = new Date(x.date);
                    return `${dt.getDate()}/${dt.getMonth()+1}`;
                }),
                datasets: [{
                    label: 'Sales (GHS)',
                    data: d.sales_chart.map(x => x.total),
                    borderColor: '#1a5f4a',
                    backgroundColor: 'rgba(26,95,74,.12)',
                    fill: true,
                    tension: 0.35,
                    pointBackgroundColor: '#1a5f4a',
                    pointRadius: 4,
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { y: { beginAtZero: true, ticks: { callback: v => 'GHS ' + v } } }
            }
        });
    }

    if (d.payment_breakdown?.length) {
        const ctx = document.getElementById('chart-payments');
        if (ctx && typeof Chart !== 'undefined') currentCharts.payments = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: d.payment_breakdown.map(p => p.payment_method.toUpperCase()),
                datasets: [{
                    data: d.payment_breakdown.map(p => p.total),
                    backgroundColor: colors.slice(0, d.payment_breakdown.length),
                    borderWidth: 3,
                    borderColor: '#fff'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom', labels: { padding: 12, font: { size: 12 } } },
                    tooltip: { callbacks: { label: (ctx) => `${ctx.label}: GHS ${Number(ctx.parsed).toFixed(2)}` } }
                },
                cutout: '62%'
            }
        });
    }

    const expEl = document.getElementById('an-exp');
    if (exp.success && exp.expenses?.length) {
        const cats = {};
        exp.expenses.forEach(x => { cats[x.category] = (cats[x.category] || 0) + x.amount; });
        const list = Object.entries(cats).sort((a, b) => b[1] - a[1]);
        const max = Math.max(...list.map(x => x[1]), 1);
        const expColors = { fuel: '#e17055', rent: '#74b9ff', salaries: '#00b894', repairs: '#fdcb6e', miscellaneous: '#a29bfe' };
        expEl.innerHTML = `<div style="padding:12px;display:flex;flex-direction:column;gap:12px;">
            ${list.map(([c, v]) => `
                <div>
                    <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;">
                        <span style="font-weight:600;text-transform:capitalize;">${c}</span>
                        <span>${formatCurrency(v)}</span>
                    </div>
                    <div style="width:100%;background:var(--border-light);border-radius:4px;height:8px;">
                        <div style="width:${(v / max) * 100}%;background:${expColors[c] || '#636e72'};height:100%;border-radius:4px;"></div>
                    </div>
                </div>`).join('')}
        </div>`;
    } else expEl.innerHTML = `<div class="empty-state"><div class="empty-text">No expenses</div></div>`;
}

// ==================== REPORTS ====================
function renderReports() {
    return `
        <div class="page-header"><div><h1 class="page-title">Reports</h1><p class="page-subtitle">Export business data</p></div></div>
        <div class="grid-2">
            <div class="card" style="cursor:pointer;" onclick="showSalesReport()">
                <div style="display:flex;gap:16px;align-items:center;">
                    <div style="font-size:36px;">💰</div>
                    <div><div style="font-weight:700;">Sales Report</div><div style="font-size:13px;color:var(--text-light);">Export sales as CSV</div></div>
                </div>
            </div>
            <div class="card" style="cursor:pointer;" onclick="exportInventoryReport()">
                <div style="display:flex;gap:16px;align-items:center;">
                    <div style="font-size:36px;">📦</div>
                    <div><div style="font-weight:700;">Inventory Report</div><div style="font-size:13px;color:var(--text-light);">Current stock levels</div></div>
                </div>
            </div>
            <div class="card" style="cursor:pointer;" onclick="exportActivityReport()">
                <div style="display:flex;gap:16px;align-items:center;">
                    <div style="font-size:36px;">📋</div>
                    <div><div style="font-weight:700;">Activity Report</div><div style="font-size:13px;color:var(--text-light);">Sold & received movements</div></div>
                </div>
            </div>
        </div>
    `;
}
function initReportsPage() {}
function showSalesReport() {
    const from = new Date(Date.now() - 30 * 864e5).toISOString().split('T')[0];
    const to = new Date().toISOString().split('T')[0];
    openModal(`
        <div class="modal-header"><div class="modal-title">Sales Report</div><button class="modal-close" onclick="closeModal()">✕</button></div>
        <div class="form-group"><label>Date Range</label>
            <div class="form-row">
                <input type="date" id="rep-from" value="${from}">
                <input type="date" id="rep-to" value="${to}">
            </div>
        </div>
        <div class="form-actions">
            <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
            <button class="btn btn-success" onclick="downloadSalesReport()">📥 Download CSV</button>
        </div>
    `);
}
async function downloadSalesReport() {
    const from = document.getElementById('rep-from').value;
    const to = document.getElementById('rep-to').value;
    const ok = await API.downloadFile(`/reports/sales?date_from=${from}&date_to=${to}&format=csv`, `sales-${from}_to_${to}.csv`);
    showToast(ok ? 'Downloaded' : 'Download failed', ok ? 'success' : 'error');
    closeModal();
}
async function exportInventoryReport() {
    const ok = await API.downloadFile('/reports/inventory?format=csv', 'inventory.csv');
    showToast(ok ? 'Downloaded' : 'Download failed', ok ? 'success' : 'error');
}
async function exportActivityReport() {
    const ok = await API.downloadFile('/reports/activity?range=month', 'activity.csv');
    showToast(ok ? 'Downloaded' : 'Download failed', ok ? 'success' : 'error');
}

// ==================== AUDIT LOGS ====================
function renderAuditLogs() {
    return `
        <div class="page-header"><div><h1 class="page-title">System Audit</h1><p class="page-subtitle">All system actions logged</p></div></div>
        <div id="audit-list"><div class="empty-state"><div class="empty-text">Loading...</div></div></div>
    `;
}
async function initAuditLogsPage() {
    const r = await API.get('/audit-logs');
    const c = document.getElementById('audit-list');
    if (!r.success || !r.logs?.length) {
        c.innerHTML = `<div class="empty-state"><div class="empty-icon">🔒</div><div class="empty-title">No Logs</div></div>`;
        return;
    }
    const icons = { create: '➕', update: '✏️', delete: '🗑️', soft_delete: '🗑️', cancel: '❌', status_change: '🔄', receive_stock: '📥' };
    c.innerHTML = `<div class="table-container table-responsive"><table class="table">
        <thead><tr><th>Action</th><th>User</th><th>Entity</th><th>Date</th></tr></thead>
        <tbody>${r.logs.map(l => `<tr>
            <td data-label="Action">${icons[l.action] || '📝'} ${escapeHtml(l.action)}</td>
            <td data-label="User">${escapeHtml(l.user_name || 'System')}</td>
            <td data-label="Entity">${escapeHtml(l.entity_type)} #${l.entity_id ?? '-'}</td>
            <td data-label="Date">${formatDateTime(l.created_at)}</td>
        </tr>`).join('')}</tbody>
    </table></div>`;
}

// ==================== SETTINGS ====================
function renderSettings() {
    return `
        <div class="page-header"><div><h1 class="page-title">Settings</h1><p class="page-subtitle">System configuration</p></div></div>
        <div class="card">
            <div class="card-header"><div class="card-title">🔐 Change Password</div></div>
            <form onsubmit="changePassword(event)">
                <div class="form-group"><label>Current Password</label><input type="password" id="pw-current" required></div>
                <div class="form-group"><label>New Password</label><input type="password" id="pw-new" required minlength="6"></div>
                <div class="form-group"><label>Confirm New Password</label><input type="password" id="pw-confirm" required minlength="6"></div>
                <button class="btn btn-primary" type="submit">Update Password</button>
            </form>
        </div>
        <div class="card">
            <div class="card-header"><div class="card-title">⚙️ System</div></div>
            <div style="display:flex;flex-direction:column;gap:10px;">
                <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border-light);"><span>App Version</span><span style="font-weight:600;">${APP_VERSION}</span></div>
                <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border-light);"><span>Signed in as</span><span style="font-weight:600;">${escapeHtml(currentUser?.username || '-')}</span></div>
                <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border-light);"><span>Status</span><span style="font-weight:600;color:${isOnline ? 'var(--success)' : 'var(--danger)'}">${isOnline ? 'Online' : 'Offline'}</span></div>
            </div>
            <button class="btn btn-outline btn-full" style="margin-top:14px;" onclick="clearCache()">🗑️ Clear Local Cache</button>
        </div>
    `;
}
function initSettingsPage() {}
async function changePassword(e) {
    e.preventDefault();
    const cur = document.getElementById('pw-current').value;
    const nw = document.getElementById('pw-new').value;
    const cf = document.getElementById('pw-confirm').value;
    if (nw !== cf) { showToast('New passwords do not match', 'error'); return; }
    showLoading(true);
    const r = await API.post('/auth/change-password', { current_password: cur, new_password: nw });
    showLoading(false);
    if (r.success) { showToast('Password updated', 'success'); e.target.reset(); }
    else showToast(r.error || 'Failed', 'error');
}
function clearCache() {
    if (!confirm('Clear cached data?')) return;
    offlineDB.clearAll().then(() => showToast('Cache cleared', 'success'));
}

// ==================== NOTIFICATIONS ====================
function startNotificationPolling() {
    if (notificationInterval) clearInterval(notificationInterval);
    checkNotifications();
    notificationInterval = setInterval(checkNotifications, 30000);
}
async function checkNotifications() {
    if (!currentUser) return;
    const r = await API.get('/notifications/unread-count');
    if (!r.success) return;
    const badge = document.getElementById('notification-badge');
    if (badge) { if (r.count > 0) { badge.textContent = r.count; badge.classList.remove('hidden'); } else badge.classList.add('hidden'); }
    if (r.count > 0 && Notification.permission === 'granted') {
        const list = await API.get('/notifications');
        if (list.success) {
            const unread = list.notifications.filter(n => !n.is_read);
            const newest = unread[0];
            if (newest && newest.id > lastSeenNotificationId) {
                lastSeenNotificationId = newest.id;
                localStorage.setItem('last_notif_id', String(lastSeenNotificationId));
                showBrowserNotification(newest.title, newest.message, { tag: 'notif-' + newest.id });
            }
        }
    }
}
async function loadNotifications() {
    const r = await API.get('/notifications');
    if (!r.success) { showToast('Failed to load notifications', 'error'); return; }
    const list = r.notifications || [];
    const icons = { sale: '💰', order: '📦', stock: '⚠️', system: '🔧', summary: '📈' };
    let html = `<div class="modal-header"><div class="modal-title">🔔 Notifications</div><button class="modal-close" onclick="closeModal()">✕</button></div><div style="max-height:420px;overflow-y:auto;">`;
    if (list.length === 0) {
        html += `<div class="empty-state"><div class="empty-icon">🔔</div><div class="empty-title">No notifications</div></div>`;
    } else {
        html += `<div style="display:flex;justify-content:flex-end;margin-bottom:8px;"><button class="btn btn-outline btn-small" onclick="markAllRead()">Mark all as read</button></div>`;
        html += list.map(n => `
            <div style="padding:14px 0;border-bottom:1px solid var(--border-light);${n.is_read ? '' : 'background:#f0f7ff;margin:0 -24px;padding-left:24px;padding-right:24px;'}">
                <div style="display:flex;gap:12px;">
                    <div style="font-size:22px;">${icons[n.type] || '🔔'}</div>
                    <div style="flex:1;">
                        <div style="font-weight:600;font-size:14px;">${escapeHtml(n.title)}</div>
                        <div style="font-size:13px;color:var(--text-light);margin-top:2px;">${escapeHtml(n.message)}</div>
                        <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">${formatDateTime(n.created_at)}</div>
                    </div>
                    ${!n.is_read ? `<button class="btn btn-primary btn-small" onclick="markRead(${n.id})">Mark read</button>` : ''}
                </div>
            </div>`).join('');
    }
    html += `</div>`;
    openModal(html);
}
async function markRead(id) { await API.put(`/notifications/${id}/read`, {}); loadNotifications(); checkNotifications(); }
async function markAllRead() { await API.put('/notifications/read-all', {}); loadNotifications(); checkNotifications(); }

// ==================== BROWSER NOTIFICATIONS ====================
async function requestNotificationPermission() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    try { const p = await Notification.requestPermission(); return p === 'granted'; } catch { return false; }
}
function showBrowserNotification(title, body, options = {}) {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    try {
        const n = new Notification(title, {
            body,
            icon: 'icons/icon.svg',
            badge: 'icons/icon.svg',
            tag: options.tag || 'timberpro-' + Date.now(),
            requireInteraction: options.requireInteraction !== false,
            silent: options.silent || false
        });
        n.onclick = () => {
            window.focus();
            n.close();
            if (options.openPage) loadPage(options.openPage);
            else if (options.tag?.startsWith('sale')) loadPage('sales-log');
        };
        if (options.requireInteraction === false) {
            setTimeout(() => n.close(), 8000);
        }
    } catch (e) { console.error(e); }
}

// ==================== PROFILE ====================
function showProfile() {
    if (!currentUser) return;
    openModal(`
        <div class="modal-header"><div class="modal-title">👤 Profile</div><button class="modal-close" onclick="closeModal()">✕</button></div>
        <div style="text-align:center;padding:20px;">
            <div style="font-size:64px;margin-bottom:12px;">👤</div>
            <div style="font-size:20px;font-weight:700;">${escapeHtml(currentUser.full_name)}</div>
            <div style="font-size:14px;color:var(--text-light);text-transform:capitalize;margin-bottom:20px;">${escapeHtml(currentUser.role)}</div>
            <div style="text-align:left;display:flex;flex-direction:column;gap:10px;font-size:14px;">
                <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border-light);"><span>Username</span><span>${escapeHtml(currentUser.username)}</span></div>
                <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border-light);"><span>Role</span><span style="text-transform:capitalize;">${escapeHtml(currentUser.role)}</span></div>
            </div>
            <button class="btn btn-danger btn-full" style="margin-top:20px;" onclick="closeModal(); logout();">Logout</button>
        </div>
    `);
}

// ==================== SYNC ====================
async function syncQueuedSales() {
    if (syncInProgress || !isOnline || !dbReady) return;
    syncInProgress = true;
    try {
        const queue = await offlineDB.getQueue();
        let ok = 0;
        for (const item of queue) {
            const r = await API.post('/sales', item.data);
            if (r.success) { await offlineDB.removeFromQueue(item.id); ok++; }
            else if (r.error?.includes('stock')) await offlineDB.removeFromQueue(item.id);
        }
        if (ok > 0) showToast(`${ok} queued sale(s) synced`, 'success');
    } catch (e) { console.error(e); }
    finally { syncInProgress = false; }
}

// ==================== PWA INSTALL ====================
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    const dismissedAt = parseInt(localStorage.getItem('install_banner_dismissed') || '0', 10);
    if (Date.now() - dismissedAt < 7 * 864e5) return;
    document.getElementById('install-banner')?.classList.remove('hidden');
});
function hideInstallBanner() {
    document.getElementById('install-banner')?.classList.add('hidden');
    localStorage.setItem('install_banner_dismissed', String(Date.now()));
}
async function installApp() {
    if (!deferredInstallPrompt) {
        showToast('Install from your browser menu instead', 'info');
        return;
    }
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') showToast('Installing TimberPro…', 'success');
    deferredInstallPrompt = null;
    hideInstallBanner();
}
window.addEventListener('appinstalled', () => {
    hideInstallBanner();
    showToast('TimberPro installed!', 'success');
});

// ==================== INIT ====================
window.addEventListener('load', () => {
    setTimeout(() => { const bar = document.querySelector('.splash-loader-bar'); if (bar) bar.style.width = '100%'; }, 100);
    setTimeout(initAuth, 1200);
});

document.addEventListener('DOMContentLoaded', () => {
    if (!navigator.onLine) { isOnline = false; document.getElementById('offline-banner')?.classList.remove('hidden'); }

    document.getElementById('login-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        login(document.getElementById('username').value, document.getElementById('password').value);
    });

    const toggleSidebar = (open) => {
        document.getElementById('sidebar')?.classList.toggle('open', open);
        document.getElementById('sidebar-overlay')?.classList.toggle('active', open);
    };
    document.getElementById('menu-toggle')?.addEventListener('click', () =>
        toggleSidebar(!document.getElementById('sidebar').classList.contains('open')));
    document.getElementById('sidebar-close')?.addEventListener('click', () => toggleSidebar(false));
    document.getElementById('sidebar-overlay')?.addEventListener('click', () => toggleSidebar(false));

    document.getElementById('sidebar')?.addEventListener('click', (e) => {
        const nav = e.target.closest('.nav-item');
        if (!nav) return;
        e.preventDefault();
        const page = nav.dataset.page;
        if (page) loadPage(page);
    });

    document.getElementById('logout-btn')?.addEventListener('click', () => logout());
    document.getElementById('notifications-btn')?.addEventListener('click', () => loadNotifications());
    document.getElementById('profile-btn')?.addEventListener('click', showProfile);

    window.addEventListener('online', () => {
        isOnline = true;
        document.getElementById('offline-banner')?.classList.add('hidden');
        showToast('Back online', 'success');
        syncQueuedSales();
    });
    window.addEventListener('offline', () => {
        isOnline = false;
        document.getElementById('offline-banner')?.classList.remove('hidden');
        showToast('You are offline', 'warning');
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { closeModal(); closeServiceModal(); closeCartDrawer(); }
    });

    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('sw.js').catch(e => console.error('SW registration failed', e));
        });
    }

    Promise.race([
        offlineDB.init(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('IndexedDB timeout')), 2500))
    ]).then(() => { dbReady = true; })
      .catch((e) => { console.warn('[TimberPro] IndexedDB unavailable:', e.message); dbReady = false; });
});
