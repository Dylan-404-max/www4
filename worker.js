// ==================== TimberPro v2.2 Worker ====================

const DEFAULT_JWT_SECRET = 'tp-v22-a7f3d9e1c4b8f2a5d6e9c1b4a7f3d9e1-x9k2m4p6q8r1s3t5v7w9y1z3c5d7f9h1';
const getSecret = (env) => env.JWT_SECRET || DEFAULT_JWT_SECRET;

async function hashPassword(password, env) {
  const secret = getSecret(env);
  const data = new TextEncoder().encode(password + secret);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function verifyPassword(password, hash, env) {
  return (await hashPassword(password, env)) === hash;
}

function b64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}
async function signJWT(payload, env) {
  const secret = getSecret(env);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + 604800 }));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(String.fromCharCode(...new Uint8Array(sig)))}`;
}
async function verifyJWT(token, env) {
  try {
    const secret = getSecret(env);
    const [h, p, s] = token.split('.');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const expected = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${h}.${p}`));
    const expectedB64 = b64url(String.fromCharCode(...new Uint8Array(expected)));
    if (s !== expectedB64) return null;
    const payload = JSON.parse(b64urlDecode(p));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const ok = (data = {}) => json({ success: true, ...data });
const err = (message, status = 400) => json({ success: false, error: message }, status);

async function authMiddleware(request, env) {
  const header = request.headers.get('Authorization');
  if (!header || !header.startsWith('Bearer ')) return { user: null, error: 'Missing token' };
  const decoded = await verifyJWT(header.slice(7), env);
  if (!decoded) return { user: null, error: 'Invalid token' };
  const user = await env.DB.prepare(
    'SELECT id, username, full_name, role, is_active FROM users WHERE id = ?'
  ).bind(decoded.userId).first();
  if (!user || !user.is_active) return { user: null, error: 'User not found or inactive' };
  return { user, error: null };
}
async function requireAuth(request, env) {
  const { user, error } = await authMiddleware(request, env);
  if (error) return { user: null, response: err(error, 401) };
  return { user, response: null };
}
async function requireAdmin(request, env) {
  const r = await requireAuth(request, env);
  if (r.response) return r;
  if (r.user.role !== 'admin') return { user: null, response: err('Admin access required', 403) };
  return r;
}

async function audit(env, userId, action, entityType, entityId, oldV, newV, request) {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_values, new_values, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(userId, action, entityType, entityId,
      oldV ? JSON.stringify(oldV) : null,
      newV ? JSON.stringify(newV) : null,
      request.headers.get('CF-Connecting-IP') || 'unknown',
      request.headers.get('User-Agent') || 'unknown'
    ).run();
  } catch (e) { console.error('audit failed', e); }
}

async function genInvoice(env) {
  const d = new Date();
  const stem = `INV-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const r = await env.DB.prepare('SELECT COUNT(*) as c FROM sales WHERE invoice_number LIKE ?')
    .bind(`${stem}%`).first();
  return `${stem}-${String((r?.c || 0) + 1).padStart(4, '0')}`;
}
async function genOrder(env) {
  const d = new Date();
  const stem = `ORD-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const r = await env.DB.prepare('SELECT COUNT(*) as c FROM orders WHERE order_number LIKE ?')
    .bind(`${stem}%`).first();
  return `${stem}-${String((r?.c || 0) + 1).padStart(4, '0')}`;
}
async function genDraft(env) {
  const d = new Date();
  const stem = `DRF-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const r = await env.DB.prepare('SELECT COUNT(*) as c FROM drafts WHERE draft_number LIKE ?')
    .bind(`${stem}%`).first();
  return `${stem}-${String((r?.c || 0) + 1).padStart(4, '0')}`;
}

class Router {
  constructor() { this.routes = []; }
  add(m, p, h) { this.routes.push({ method: m, pattern: p, handler: h }); }
  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
  put(p, h) { this.add('PUT', p, h); }
  delete(p, h) { this.add('DELETE', p, h); }
  match(pattern, path) {
    const a = pattern.split('/').filter(Boolean);
    const b = path.split('/').filter(Boolean);
    if (a.length !== b.length) return null;
    const params = {};
    for (let i = 0; i < a.length; i++) {
      if (a[i].startsWith(':')) params[a[i].slice(1)] = b[i];
      else if (a[i] !== b[i]) return null;
    }
    return { params };
  }
  async handle(request, env) {
    const url = new URL(request.url);
    for (const r of this.routes) {
      if (r.method !== request.method) continue;
      const m = this.match(r.pattern, url.pathname);
      if (m) {
        try { return await r.handler(request, env, m.params, url); }
        catch (e) { console.error('handler error:', e); return err(e.message || 'Internal error', 500); }
      }
    }
    return err('Not found', 404);
  }
}
const router = new Router();

// ==================== AUTH ====================

router.post('/api/auth/bootstrap', async (request, env) => {
  const count = await env.DB.prepare('SELECT COUNT(*) as c FROM users').first();
  if (count.c > 0) return err('System already bootstrapped', 400);
  const hash = await hashPassword('admin123', env);
  await env.DB.prepare(
    'INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)'
  ).bind('admin', hash, 'Administrator', 'admin').run();
  return ok({ message: 'Admin created. Username: admin, Password: admin123 — change it now!' });
});

router.post('/api/auth/login', async (request, env) => {
  let body;
  try { body = await request.json(); } catch { return err('Invalid request body'); }
  const { username, password } = body;
  if (!username || !password) return err('Username and password required');
  const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  if (!user) return err('Invalid credentials', 401);
  if (!user.is_active) return err('Account deactivated', 403);
  const valid = await verifyPassword(password, user.password_hash, env);
  if (!valid) return err('Invalid credentials', 401);
  await env.DB.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').bind(user.id).run();
  const token = await signJWT({ userId: user.id }, env);
  return ok({
    token,
    user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role }
  });
});

router.get('/api/auth/me', async (request, env) => {
  const { user, response } = await requireAuth(request, env); if (response) return response;
  return ok({ user });
});

router.post('/api/auth/change-password', async (request, env) => {
  const { user, response } = await requireAuth(request, env); if (response) return response;
  const { current_password, new_password } = await request.json();
  if (!current_password || !new_password) return err('Both passwords required');
  if (new_password.length < 6) return err('New password must be at least 6 characters');
  const full = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first();
  if (!(await verifyPassword(current_password, full.password_hash, env))) {
    return err('Current password is incorrect', 401);
  }
  const newHash = await hashPassword(new_password, env);
  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(newHash, user.id).run();
  return ok({ message: 'Password updated' });
});

// ==================== PRODUCTS ====================

router.get('/api/products', async (request, env) => {
  const { response } = await requireAuth(request, env); if (response) return response;
  const rows = await env.DB.prepare(
    `SELECT p.*, COALESCE(s.quantity, 0) as stock, COALESCE(s.reserved_quantity, 0) as reserved_quantity
     FROM products p LEFT JOIN stock s ON s.product_id = p.id
     WHERE p.is_deleted = 0 ORDER BY p.name`
  ).all();
  return ok({ products: rows.results });
});

router.get('/api/products/:id', async (request, env, params) => {
  const { response } = await requireAuth(request, env); if (response) return response;
  const p = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(params.id).first();
  if (!p) return err('Product not found', 404);
  return ok({ product: p });
});

router.post('/api/products', async (request, env) => {
  const { user, response } = await requireAdmin(request, env); if (response) return response;
  const b = await request.json();
  if (!b.name || b.price == null) return err('Name and price are required');
  const r = await env.DB.prepare(
    `INSERT INTO products (name, description, unit, price, cost_price, stock_threshold, category)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(b.name, b.description || null, b.unit || 'piece', b.price,
    b.cost_price || 0, b.stock_threshold ?? 10, b.category || 'timber').run();
  await audit(env, user.id, 'create', 'product', r.meta.last_row_id, null, { name: b.name }, request);
  return ok({ id: r.meta.last_row_id });
});

router.put('/api/products/:id', async (request, env, params) => {
  const { user, response } = await requireAdmin(request, env); if (response) return response;
  const b = await request.json();
  const old = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(params.id).first();
  if (!old) return err('Product not found', 404);
  await env.DB.prepare(
    `UPDATE products SET name=?, description=?, unit=?, price=?, cost_price=?, stock_threshold=?, category=?, is_active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`
  ).bind(b.name, b.description || null, b.unit, b.price, b.cost_price || 0,
    b.stock_threshold ?? 10, b.category || 'timber', b.is_active ?? 1, params.id).run();
  await audit(env, user.id, 'update', 'product', params.id, old, b, request);
  return ok();
});

router.delete('/api/products/:id', async (request, env, params) => {
  const { user, response } = await requireAdmin(request, env); if (response) return response;
  const old = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(params.id).first();
  if (!old) return err('Product not found', 404);
  await env.DB.prepare('UPDATE products SET is_deleted=1, is_active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .bind(params.id).run();
  await audit(env, user.id, 'soft_delete', 'product', params.id, old, null, request);
  return ok();
});

// ==================== SERVICES ====================

router.get('/api/services', async (request, env) => {
  const { response } = await requireAuth(request, env); if (response) return response;
  const rows = await env.DB.prepare('SELECT * FROM services WHERE is_deleted = 0 ORDER BY name').all();
  return ok({ services: rows.results });
});

router.get('/api/services/:id', async (request, env, params) => {
  const { response } = await requireAuth(request, env); if (response) return response;
  const s = await env.DB.prepare('SELECT * FROM services WHERE id = ?').bind(params.id).first();
  if (!s) return err('Service not found', 404);
  return ok({ service: s });
});

router.post('/api/services', async (request, env) => {
  const { user, response } = await requireAdmin(request, env); if (response) return response;
  const b = await request.json();
  if (!b.name || b.price == null) return err('Name and price are required');
  const r = await env.DB.prepare('INSERT INTO services (name, description, price) VALUES (?, ?, ?)')
    .bind(b.name, b.description || null, b.price).run();
  await audit(env, user.id, 'create', 'service', r.meta.last_row_id, null, b, request);
  return ok({ id: r.meta.last_row_id });
});

router.put('/api/services/:id', async (request, env, params) => {
  const { user, response } = await requireAdmin(request, env); if (response) return response;
  const b = await request.json();
  const old = await env.DB.prepare('SELECT * FROM services WHERE id = ?').bind(params.id).first();
  if (!old) return err('Service not found', 404);
  await env.DB.prepare('UPDATE services SET name=?, description=?, price=?, is_active=? WHERE id=?')
    .bind(b.name, b.description || null, b.price, b.is_active ?? 1, params.id).run();
  await audit(env, user.id, 'update', 'service', params.id, old, b, request);
  return ok();
});

router.delete('/api/services/:id', async (request, env, params) => {
  const { user, response } = await requireAdmin(request, env); if (response) return response;
  await env.DB.prepare('UPDATE services SET is_deleted=1, is_active=0 WHERE id=?').bind(params.id).run();
  await audit(env, user.id, 'soft_delete', 'service', params.id, null, null, request);
  return ok();
});

// ==================== INVENTORY ====================

router.get('/api/inventory', async (request, env) => {
  const { response } = await requireAuth(request, env); if (response) return response;
  const rows = await env.DB.prepare(
    `SELECT p.id as product_id, p.name as product_name, p.unit, p.price, p.stock_threshold,
            COALESCE(s.quantity, 0) as quantity, COALESCE(s.reserved_quantity, 0) as reserved_quantity
     FROM products p LEFT JOIN stock s ON s.product_id = p.id
     WHERE p.is_deleted = 0 ORDER BY p.name`
  ).all();
  return ok({ inventory: rows.results });
});

router.post('/api/inventory/receive', async (request, env) => {
  const { user, response } = await requireAdmin(request, env); if (response) return response;
  const b = await request.json();
  const productId = parseInt(b.product_id);
  const qty = parseFloat(b.quantity);
  const costPrice = parseFloat(b.cost_price) || 0;
  if (!productId || !(qty > 0)) return err('Valid product and positive quantity required');

  const existing = await env.DB.prepare('SELECT * FROM stock WHERE product_id = ?').bind(productId).first();
  const prevQty = existing ? existing.quantity : 0;
  const newQty = prevQty + qty;

  if (existing) {
    await env.DB.prepare('UPDATE stock SET quantity=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .bind(newQty, existing.id).run();
  } else {
    await env.DB.prepare('INSERT INTO stock (product_id, quantity) VALUES (?, ?)').bind(productId, newQty).run();
  }

  await env.DB.prepare(
    `INSERT INTO stock_movements
       (product_id, type, quantity, unit_price, total_amount,
        previous_quantity, new_quantity, reference_type, notes, created_by)
     VALUES (?, 'in', ?, ?, ?, ?, ?, 'inventory', ?, ?)`
  ).bind(productId, qty, costPrice, qty * costPrice, prevQty, newQty, b.notes || null, user.id).run();

  await audit(env, user.id, 'receive_stock', 'stock', productId,
    { quantity: prevQty }, { quantity: newQty }, request);
  return ok({ new_quantity: newQty });
});

router.get('/api/inventory/movements', async (request, env) => {
  const { response } = await requireAuth(request, env); if (response) return response;
  const rows = await env.DB.prepare(
    `SELECT sm.*, p.name as product_name, u.full_name as created_by_name
     FROM stock_movements sm
     JOIN products p ON sm.product_id = p.id
     LEFT JOIN users u ON sm.created_by = u.id
     ORDER BY sm.created_at DESC LIMIT 100`
  ).all();
  return ok({ movements: rows.results });
});

// ==================== ACTIVITY LOG ====================

router.get('/api/activity-log', async (request, env, _p, url) => {
  const { response } = await requireAuth(request, env); if (response) return response;
  const range = url.searchParams.get('range') || 'today';
  const dateFrom = url.searchParams.get('date_from');
  const dateTo = url.searchParams.get('date_to');
  const typeFilter = url.searchParams.get('type');
  const limit = Math.min(parseInt(url.searchParams.get('limit')) || 300, 1000);

  const clauses = ['1=1'];
  const binds = [];
  if (range === 'today') clauses.push('DATE(sm.created_at) = DATE("now","localtime")');
  else if (range === 'week') clauses.push('DATE(sm.created_at) >= DATE("now","-6 days")');
  else if (range === 'month') clauses.push('strftime("%Y-%m", sm.created_at) = strftime("%Y-%m","now")');
  else if (range === 'custom' && dateFrom && dateTo) {
    clauses.push('DATE(sm.created_at) BETWEEN ? AND ?');
    binds.push(dateFrom, dateTo);
  }
  if (typeFilter === 'sold') clauses.push("sm.type = 'out'");
  else if (typeFilter === 'received') clauses.push("sm.type = 'in'");

  const rows = await env.DB.prepare(`
    SELECT sm.id, sm.created_at, sm.type, sm.quantity, sm.unit_price, sm.total_amount,
           sm.previous_quantity, sm.new_quantity AS balance, sm.reference_type, sm.reference_id,
           sm.notes, p.name AS product_name, p.unit, u.full_name AS user_name
    FROM stock_movements sm
    JOIN products p ON sm.product_id = p.id
    LEFT JOIN users u ON sm.created_by = u.id
    WHERE ${clauses.join(' AND ')}
    ORDER BY sm.created_at DESC LIMIT ?
  `).bind(...binds, limit).all();

  const sClauses = ['1=1'];
  const sBinds = [];
  if (range === 'today') sClauses.push('DATE(sm.created_at) = DATE("now","localtime")');
  else if (range === 'week') sClauses.push('DATE(sm.created_at) >= DATE("now","-6 days")');
  else if (range === 'month') sClauses.push('strftime("%Y-%m", sm.created_at) = strftime("%Y-%m","now")');
  else if (range === 'custom' && dateFrom && dateTo) {
    sClauses.push('DATE(sm.created_at) BETWEEN ? AND ?');
    sBinds.push(dateFrom, dateTo);
  }

  const summary = await env.DB.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN sm.type='out' THEN sm.quantity     ELSE 0 END),0) AS sold_qty,
      COALESCE(SUM(CASE WHEN sm.type='out' THEN sm.total_amount ELSE 0 END),0) AS sold_amount,
      COALESCE(SUM(CASE WHEN sm.type='in'  THEN sm.quantity     ELSE 0 END),0) AS recv_qty,
      COALESCE(SUM(CASE WHEN sm.type='in'  THEN sm.total_amount ELSE 0 END),0) AS recv_amount,
      COUNT(*) AS txns
    FROM stock_movements sm WHERE ${sClauses.join(' AND ')}
  `).bind(...sBinds).first();

  return ok({
    logs: rows.results,
    summary: {
      sold_qty: summary.sold_qty,
      sold_amount: summary.sold_amount,
      received_qty: summary.recv_qty,
      received_amount: summary.recv_amount,
      net_qty: summary.recv_qty - summary.sold_qty,
      transactions: summary.txns,
    }
  });
});

// ==================== SALES ====================

router.get('/api/sales', async (request, env, _p, url) => {
  const { response } = await requireAuth(request, env); if (response) return response;
  const limit = Math.min(parseInt(url.searchParams.get('limit')) || 50, 200);
  const offset = Math.max(parseInt(url.searchParams.get('offset')) || 0, 0);
  const status = url.searchParams.get('status');
  const dateFrom = url.searchParams.get('date_from');
  const dateTo = url.searchParams.get('date_to');

  const clauses = ['1=1'];
  const binds = [];
  if (status) { clauses.push('s.status = ?'); binds.push(status); }
  if (dateFrom) { clauses.push('DATE(s.created_at) >= ?'); binds.push(dateFrom); }
  if (dateTo) { clauses.push('DATE(s.created_at) <= ?'); binds.push(dateTo); }

  const rows = await env.DB.prepare(
    `SELECT s.*, u.full_name as user_name FROM sales s
     LEFT JOIN users u ON s.user_id = u.id
     WHERE ${clauses.join(' AND ')}
     ORDER BY s.created_at DESC LIMIT ? OFFSET ?`
  ).bind(...binds, limit, offset).all();

  for (const sale of rows.results) {
    const items = await env.DB.prepare('SELECT * FROM sale_items WHERE sale_id = ?').bind(sale.id).all();
    sale.items = items.results;
  }
  return ok({ sales: rows.results });
});

router.get('/api/sales/:id', async (request, env, params) => {
  const { response } = await requireAuth(request, env); if (response) return response;
  const sale = await env.DB.prepare(
    `SELECT s.*, u.full_name as user_name FROM sales s LEFT JOIN users u ON s.user_id = u.id WHERE s.id = ?`
  ).bind(params.id).first();
  if (!sale) return err('Sale not found', 404);
  const items = await env.DB.prepare('SELECT * FROM sale_items WHERE sale_id = ?').bind(params.id).all();
  sale.items = items.results;
  return ok({ sale });
});

router.post('/api/sales', async (request, env) => {
  const { user, response } = await requireAuth(request, env); if (response) return response;
  const b = await request.json();
  const items = Array.isArray(b.items) ? b.items : [];
  if (items.length === 0) return err('No items in sale');

  for (const it of items) {
    if (it.item_type === 'product' && it.product_id) {
      const s = await env.DB.prepare('SELECT quantity FROM stock WHERE product_id = ?').bind(it.product_id).first();
      const avail = s ? s.quantity : 0;
      if (avail < it.quantity) return err(`Not enough stock for "${it.name}". Available: ${avail}`);
    }
  }

  const subtotal = items.reduce((sum, i) => sum + (i.quantity * i.unit_price), 0);
  const invoice = await genInvoice(env);
  const createdAt = b.sale_date || new Date().toISOString();

  const insertSale = await env.DB.prepare(
    `INSERT INTO sales (invoice_number, customer_name, user_id, subtotal, total_amount, payment_method, status, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?)`
  ).bind(invoice, b.customer_name || null, user.id, subtotal, subtotal,
    b.payment_method || 'cash', b.notes || null, createdAt).run();

  const saleId = insertSale.meta.last_row_id;

  for (const it of items) {
    await env.DB.prepare(
      `INSERT INTO sale_items (sale_id, product_id, service_id, item_type, name, quantity, unit_price, total_price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(saleId, it.product_id || null, it.service_id || null, it.item_type,
      it.name, it.quantity, it.unit_price, it.quantity * it.unit_price).run();

    if (it.item_type === 'product' && it.product_id) {
      const s = await env.DB.prepare('SELECT * FROM stock WHERE product_id = ?').bind(it.product_id).first();
      const prev = s ? s.quantity : 0;
      const next = prev - it.quantity;
      if (s) {
        await env.DB.prepare('UPDATE stock SET quantity=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
          .bind(next, s.id).run();
      } else {
        await env.DB.prepare('INSERT INTO stock (product_id, quantity) VALUES (?, ?)').bind(it.product_id, next).run();
      }
      await env.DB.prepare(
        `INSERT INTO stock_movements
           (product_id, type, quantity, unit_price, total_amount,
            previous_quantity, new_quantity, reference_type, reference_id, created_by)
         VALUES (?, 'out', ?, ?, ?, ?, ?, 'sale', ?, ?)`
      ).bind(it.product_id, it.quantity, it.unit_price, it.quantity * it.unit_price,
        prev, next, saleId, user.id).run();
    }
  }

  await audit(env, user.id, 'create', 'sale', saleId, null, { invoice, total: subtotal }, request);

  try {
    const admins = await env.DB.prepare("SELECT id FROM users WHERE role = 'admin' AND is_active = 1").all();
    for (const a of admins.results) {
      await env.DB.prepare(
        'INSERT INTO notifications (user_id, type, title, message, data) VALUES (?, ?, ?, ?, ?)'
      ).bind(a.id, 'sale', 'New Sale', `Sale ${invoice} — GHS ${subtotal.toFixed(2)}`,
        JSON.stringify({ sale_id: saleId })).run();
    }
  } catch (e) { console.error('notify failed', e); }

  return ok({ sale_id: saleId, invoice_number: invoice, total_amount: subtotal, created_at: createdAt });
});

router.put('/api/sales/:id/cancel', async (request, env, params) => {
  const { user, response } = await requireAdmin(request, env); if (response) return response;
  const sale = await env.DB.prepare('SELECT * FROM sales WHERE id = ?').bind(params.id).first();
  if (!sale) return err('Sale not found', 404);
  if (sale.status === 'cancelled') return err('Already cancelled');

  await env.DB.prepare("UPDATE sales SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .bind(params.id).run();

  const items = await env.DB.prepare("SELECT * FROM sale_items WHERE sale_id=? AND item_type='product'")
    .bind(params.id).all();
  for (const it of items.results) {
    const s = await env.DB.prepare('SELECT * FROM stock WHERE product_id=?').bind(it.product_id).first();
    if (s) {
      await env.DB.prepare('UPDATE stock SET quantity=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .bind(s.quantity + it.quantity, s.id).run();
    }
  }
  await audit(env, user.id, 'cancel', 'sale', params.id, sale, { status: 'cancelled' }, request);
  return ok();
});

// ==================== SALES LOG (Customer + Product views) ====================

router.get('/api/sales-log', async (request, env, _p, url) => {
  const { response } = await requireAuth(request, env); if (response) return response;
  const range = url.searchParams.get('range') || 'today';
  const dateFrom = url.searchParams.get('date_from');
  const dateTo = url.searchParams.get('date_to');
  const customerFilter = url.searchParams.get('customer');
  const groupBy = url.searchParams.get('group_by') || 'customer';

  const clauses = ["s.status = 'completed'"];
  const binds = [];
  if (range === 'today') clauses.push('DATE(s.created_at) = DATE("now","localtime")');
  else if (range === 'week') clauses.push('DATE(s.created_at) >= DATE("now","-6 days")');
  else if (range === 'month') clauses.push('strftime("%Y-%m", s.created_at) = strftime("%Y-%m","now")');
  else if (range === 'custom' && dateFrom && dateTo) {
    clauses.push('DATE(s.created_at) BETWEEN ? AND ?');
    binds.push(dateFrom, dateTo);
  }
  if (customerFilter) {
    clauses.push('s.customer_name LIKE ?');
    binds.push(`%${customerFilter}%`);
  }

  const sales = await env.DB.prepare(`
    SELECT s.id, s.invoice_number, s.customer_name, s.total_amount, s.payment_method,
           s.notes, s.created_at, u.full_name as user_name
    FROM sales s LEFT JOIN users u ON s.user_id = u.id
    WHERE ${clauses.join(' AND ')}
    ORDER BY s.created_at DESC LIMIT 500
  `).bind(...binds).all();

  for (const sale of sales.results) {
    const items = await env.DB.prepare(
      'SELECT name, item_type, quantity, unit_price, total_price FROM sale_items WHERE sale_id = ?'
    ).bind(sale.id).all();
    sale.items = items.results;
  }

  const grandTotal = sales.results.reduce((s, x) => s + x.total_amount, 0);
  const totalSales = sales.results.length;

  // --- Group by PRODUCT ---
  if (groupBy === 'product') {
    const products = {};
    for (const sale of sales.results) {
      for (const item of sale.items) {
        const key = `${item.item_type}::${item.name}`;
        if (!products[key]) {
          products[key] = {
            name: item.name, type: item.item_type,
            total_qty: 0, total_revenue: 0,
            customers: {},
            sales: []
          };
        }
        products[key].total_qty += item.quantity;
        products[key].total_revenue += item.total_price;
        const cust = sale.customer_name || 'Walk-in Customer';
        products[key].customers[cust] = (products[key].customers[cust] || 0) + item.quantity;
        products[key].sales.push({
          invoice: sale.invoice_number,
          customer: cust,
          date: sale.created_at,
          qty: item.quantity,
          unit_price: item.unit_price,
          total: item.total_price,
          user: sale.user_name,
          notes: sale.notes
        });
      }
    }

    const result = Object.values(products).map(p => ({
      ...p,
      customers: Object.entries(p.customers).map(([name, qty]) => ({ name, qty }))
        .sort((a, b) => b.qty - a.qty)
    })).sort((a, b) => b.total_revenue - a.total_revenue);

    return ok({
      products: result,
      summary: { grand_total: grandTotal, total_sales: totalSales, product_count: result.length, customer_count: 0 }
    });
  }

  // --- Group by CUSTOMER ---
  const customers = {};
  for (const sale of sales.results) {
    const key = sale.customer_name || 'Walk-in Customer';
    if (!customers[key]) customers[key] = { name: key, total_spent: 0, sales_count: 0, items: {}, sales: [] };
    customers[key].total_spent += sale.total_amount;
    customers[key].sales_count += 1;
    customers[key].sales.push(sale);
    for (const item of sale.items) {
      const k = `${item.item_type}::${item.name}`;
      if (!customers[key].items[k]) customers[key].items[k] = { name: item.name, type: item.item_type, qty: 0, total: 0 };
      customers[key].items[k].qty += item.quantity;
      customers[key].items[k].total += item.total_price;
    }
  }

  const result = Object.values(customers).map(c => ({ ...c, items: Object.values(c.items) }))
    .sort((a, b) => b.total_spent - a.total_spent);

  return ok({
    customers: result,
    summary: { grand_total: grandTotal, total_sales: totalSales, customer_count: result.length, product_count: 0 }
  });
});

// ==================== TODAY ====================

router.get('/api/today', async (request, env) => {
  const { response } = await requireAuth(request, env); if (response) return response;

  const sales = await env.DB.prepare(`
    SELECT s.id, s.invoice_number, s.customer_name, s.total_amount, s.payment_method,
           s.notes, s.created_at, u.full_name as user_name
    FROM sales s LEFT JOIN users u ON s.user_id = u.id
    WHERE DATE(s.created_at) = DATE("now","localtime") AND s.status = 'completed'
    ORDER BY s.created_at DESC
  `).all();

  for (const sale of sales.results) {
    const items = await env.DB.prepare(
      'SELECT name, quantity, unit_price, total_price, item_type FROM sale_items WHERE sale_id = ?'
    ).bind(sale.id).all();
    sale.items = items.results;
  }

  const expenses = await env.DB.prepare(`
    SELECT e.*, u.full_name as created_by_name
    FROM expenses e LEFT JOIN users u ON e.created_by = u.id
    WHERE DATE(e.date) = DATE("now","localtime")
    ORDER BY e.created_at DESC
  `).all();

  const salesTotal = sales.results.reduce((s, x) => s + x.total_amount, 0);
  const expTotal = expenses.results.reduce((s, x) => s + x.amount, 0);

  return ok({
    date: new Date().toISOString().split('T')[0],
    sales: sales.results,
    expenses: expenses.results,
    totals: {
      sales_total: salesTotal,
      sales_count: sales.results.length,
      expenses_total: expTotal,
      expenses_count: expenses.results.length,
      net: salesTotal - expTotal
    }
  });
});

// ==================== DRAFTS ====================

router.get('/api/drafts', async (request, env) => {
  const { user, response } = await requireAuth(request, env); if (response) return response;
  const rows = await env.DB.prepare(
    'SELECT * FROM drafts WHERE user_id = ? ORDER BY updated_at DESC'
  ).bind(user.id).all();
  return ok({ drafts: rows.results });
});

router.post('/api/drafts', async (request, env) => {
  const { user, response } = await requireAuth(request, env); if (response) return response;
  const b = await request.json();
  const items = Array.isArray(b.items) ? b.items : [];
  if (items.length === 0) return err('No items in draft');
  const subtotal = items.reduce((s, i) => s + i.quantity * i.unit_price, 0);
  const number = await genDraft(env);
  const r = await env.DB.prepare(
    `INSERT INTO drafts (draft_number, customer_name, user_id, items, subtotal, total_amount, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(number, b.customer_name || null, user.id, JSON.stringify(items),
    subtotal, subtotal, b.notes || null).run();
  return ok({ draft_id: r.meta.last_row_id, draft_number: number });
});

router.delete('/api/drafts/:id', async (request, env, params) => {
  const { user, response } = await requireAuth(request, env); if (response) return response;
  const d = await env.DB.prepare('SELECT * FROM drafts WHERE id = ?').bind(params.id).first();
  if (!d) return err('Draft not found', 404);
  if (d.user_id !== user.id && user.role !== 'admin') return err('Not allowed', 403);
  await env.DB.prepare('DELETE FROM drafts WHERE id = ?').bind(params.id).run();
  return ok();
});

// ==================== ORDERS ====================

router.get('/api/orders', async (request, env, _p, url) => {
  const { response } = await requireAuth(request, env); if (response) return response;
  const status = url.searchParams.get('status');
  const clauses = ['1=1'];
  const binds = [];
  if (status) { clauses.push('o.status = ?'); binds.push(status); }
  const rows = await env.DB.prepare(
    `SELECT o.*, u.full_name as user_name FROM orders o
     LEFT JOIN users u ON o.user_id = u.id
     WHERE ${clauses.join(' AND ')} ORDER BY o.created_at DESC`
  ).bind(...binds).all();
  for (const o of rows.results) {
    const items = await env.DB.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(o.id).all();
    o.items = items.results;
  }
  return ok({ orders: rows.results });
});

router.post('/api/orders', async (request, env) => {
  const { user, response } = await requireAuth(request, env); if (response) return response;
  const b = await request.json();
  const items = Array.isArray(b.items) ? b.items : [];
  if (items.length === 0) return err('No items in order');
  const subtotal = items.reduce((s, i) => s + i.quantity * i.unit_price, 0);
  const number = await genOrder(env);
  const r = await env.DB.prepare(
    `INSERT INTO orders (order_number, customer_name, user_id, subtotal, total_amount, payment_method, expected_delivery_date, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).bind(number, b.customer_name || null, user.id, subtotal, subtotal,
    b.payment_method || 'cash', b.expected_delivery_date || null, b.notes || null).run();
  const orderId = r.meta.last_row_id;
  for (const it of items) {
    await env.DB.prepare(
      `INSERT INTO order_items (order_id, product_id, name, quantity, unit_price, total_price)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(orderId, it.product_id || null, it.name, it.quantity, it.unit_price, it.quantity * it.unit_price).run();
    if (it.product_id) {
      const s = await env.DB.prepare('SELECT * FROM stock WHERE product_id = ?').bind(it.product_id).first();
      if (s) {
        await env.DB.prepare('UPDATE stock SET reserved_quantity = ?, updated_at=CURRENT_TIMESTAMP WHERE id = ?')
          .bind(s.reserved_quantity + it.quantity, s.id).run();
      }
    }
  }
  await audit(env, user.id, 'create', 'order', orderId, null, { number }, request);
  return ok({ order_id: orderId, order_number: number });
});

router.put('/api/orders/:id/status', async (request, env, params) => {
  const { user, response } = await requireAuth(request, env); if (response) return response;
  const { status } = await request.json();
  const valid = ['pending', 'paid', 'ready', 'delivered', 'cancelled'];
  if (!valid.includes(status)) return err('Invalid status');
  const o = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(params.id).first();
  if (!o) return err('Order not found', 404);
  if (o.status === status) return ok();
  await env.DB.prepare('UPDATE orders SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .bind(status, params.id).run();
  const items = await env.DB.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(params.id).all();
  if (status === 'delivered' && o.status !== 'delivered') {
    for (const it of items.results) {
      if (!it.product_id) continue;
      const s = await env.DB.prepare('SELECT * FROM stock WHERE product_id = ?').bind(it.product_id).first();
      if (!s) continue;
      await env.DB.prepare('UPDATE stock SET quantity=?, reserved_quantity=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .bind(s.quantity - it.quantity, Math.max(0, s.reserved_quantity - it.quantity), s.id).run();
      await env.DB.prepare(
        `INSERT INTO stock_movements
           (product_id, type, quantity, unit_price, total_amount,
            previous_quantity, new_quantity, reference_type, reference_id, created_by)
         VALUES (?, 'out', ?, ?, ?, ?, ?, 'order', ?, ?)`
      ).bind(it.product_id, it.quantity, it.unit_price, it.total_price,
        s.quantity, s.quantity - it.quantity, params.id, user.id).run();
    }
  }
  if (status === 'cancelled' && o.status !== 'cancelled') {
    for (const it of items.results) {
      if (!it.product_id) continue;
      const s = await env.DB.prepare('SELECT * FROM stock WHERE product_id = ?').bind(it.product_id).first();
      if (!s) continue;
      await env.DB.prepare('UPDATE stock SET reserved_quantity=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .bind(Math.max(0, s.reserved_quantity - it.quantity), s.id).run();
    }
  }
  await audit(env, user.id, 'status_change', 'order', params.id, { status: o.status }, { status }, request);
  return ok();
});

// ==================== EXPENSES ====================

router.get('/api/expenses', async (request, env, _p, url) => {
  const { response } = await requireAuth(request, env); if (response) return response;
  const from = url.searchParams.get('date_from');
  const to = url.searchParams.get('date_to');
  const clauses = ['1=1'];
  const binds = [];
  if (from) { clauses.push('DATE(e.date) >= ?'); binds.push(from); }
  if (to) { clauses.push('DATE(e.date) <= ?'); binds.push(to); }
  const rows = await env.DB.prepare(
    `SELECT e.*, u.full_name as created_by_name FROM expenses e
     LEFT JOIN users u ON e.created_by = u.id
     WHERE ${clauses.join(' AND ')} ORDER BY e.date DESC, e.created_at DESC`
  ).bind(...binds).all();
  return ok({ expenses: rows.results });
});

router.post('/api/expenses', async (request, env) => {
  const { user, response } = await requireAuth(request, env); if (response) return response;
  const b = await request.json();
  if (!b.category || !(b.amount > 0)) return err('Category and positive amount required');
  const r = await env.DB.prepare(
    `INSERT INTO expenses (category, amount, description, date, receipt_number, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(b.category, b.amount, b.description || null,
    b.date || new Date().toISOString().split('T')[0], b.receipt_number || null, user.id).run();
  await audit(env, user.id, 'create', 'expense', r.meta.last_row_id, null, b, request);
  return ok({ id: r.meta.last_row_id });
});

router.delete('/api/expenses/:id', async (request, env, params) => {
  const { user, response } = await requireAdmin(request, env); if (response) return response;
  await env.DB.prepare('DELETE FROM expenses WHERE id = ?').bind(params.id).run();
  await audit(env, user.id, 'delete', 'expense', params.id, null, null, request);
  return ok();
});

// ==================== DASHBOARD ====================

router.get('/api/analytics/dashboard', async (request, env) => {
  const { response } = await requireAuth(request, env); if (response) return response;
  const today = new Date().toISOString().split('T')[0];
  const month = today.substring(0, 7);

  const todaySales = await env.DB.prepare(
    "SELECT COALESCE(SUM(total_amount),0) as total, COUNT(*) as count FROM sales WHERE DATE(created_at)=? AND status='completed'"
  ).bind(today).first();
  const monthSales = await env.DB.prepare(
    "SELECT COALESCE(SUM(total_amount),0) as total FROM sales WHERE strftime('%Y-%m', created_at)=? AND status='completed'"
  ).bind(month).first();
  const monthExpenses = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount),0) as total FROM expenses WHERE strftime('%Y-%m', date)=?"
  ).bind(month).first();
  const lowStock = await env.DB.prepare(
    `SELECT p.id, p.name as product_name, p.stock_threshold, COALESCE(s.quantity,0) as quantity, p.unit
     FROM products p LEFT JOIN stock s ON s.product_id = p.id
     WHERE p.is_active = 1 AND p.is_deleted = 0 AND COALESCE(s.quantity,0) <= p.stock_threshold
     ORDER BY quantity ASC`
  ).all();
  const pendingOrders = await env.DB.prepare(
    "SELECT COUNT(*) as c FROM orders WHERE status IN ('pending','paid','ready')"
  ).first();
  const chart = await env.DB.prepare(
    `SELECT DATE(created_at) as date, COALESCE(SUM(total_amount),0) as total, COUNT(*) as count
     FROM sales WHERE created_at >= date('now','-7 days') AND status='completed'
     GROUP BY DATE(created_at) ORDER BY date`
  ).all();
  const payments = await env.DB.prepare(
    `SELECT payment_method, COALESCE(SUM(total_amount),0) as total, COUNT(*) as count
     FROM sales WHERE strftime('%Y-%m', created_at)=? AND status='completed'
     GROUP BY payment_method`
  ).bind(month).all();
  const topProducts = await env.DB.prepare(
    `SELECT si.name, SUM(si.quantity) as total_qty, SUM(si.total_price) as total_revenue
     FROM sale_items si JOIN sales s ON si.sale_id = s.id
     WHERE strftime('%Y-%m', s.created_at)=? AND s.status='completed' AND si.item_type='product'
     GROUP BY si.name ORDER BY total_revenue DESC LIMIT 10`
  ).bind(month).all();

  return ok({
    dashboard: {
      today_sales: todaySales,
      month_sales: monthSales,
      month_expenses: monthExpenses,
      low_stock_count: lowStock.results.length,
      low_stock_items: lowStock.results,
      pending_orders: pendingOrders.c,
      sales_chart: chart.results,
      payment_breakdown: payments.results,
      top_products: topProducts.results,
    }
  });
});

// ==================== REPORTS ====================

router.get('/api/reports/sales', async (request, env, _p, url) => {
  const { response } = await requireAuth(request, env); if (response) return response;
  const from = url.searchParams.get('date_from');
  const to = url.searchParams.get('date_to');
  const format = url.searchParams.get('format') || 'json';
  const clauses = ["s.status = 'completed'"];
  const binds = [];
  if (from) { clauses.push('DATE(s.created_at) >= ?'); binds.push(from); }
  if (to) { clauses.push('DATE(s.created_at) <= ?'); binds.push(to); }

  const rows = await env.DB.prepare(
    `SELECT s.invoice_number, s.created_at, s.customer_name, s.total_amount, s.payment_method,
            s.status, s.notes, u.full_name as user_name
     FROM sales s LEFT JOIN users u ON s.user_id = u.id
     WHERE ${clauses.join(' AND ')} ORDER BY s.created_at DESC`
  ).bind(...binds).all();

  if (format === 'csv') {
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    let csv = 'Invoice,Date,Customer,Amount,Payment,Status,Cashier,Notes\n';
    for (const s of rows.results) {
      csv += [s.invoice_number, s.created_at, s.customer_name || 'Walk-in',
        s.total_amount, s.payment_method, s.status, s.user_name || '', s.notes || '']
        .map(esc).join(',') + '\n';
    }
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="sales-report.csv"',
        ...CORS
      }
    });
  }
  return ok({ sales: rows.results });
});

router.get('/api/reports/inventory', async (request, env, _p, url) => {
  const { response } = await requireAuth(request, env); if (response) return response;
  const format = url.searchParams.get('format') || 'json';
  const rows = await env.DB.prepare(
    `SELECT p.name, p.unit, p.price, p.stock_threshold,
            COALESCE(s.quantity,0) as quantity, COALESCE(s.reserved_quantity,0) as reserved
     FROM products p LEFT JOIN stock s ON s.product_id = p.id
     WHERE p.is_deleted = 0 ORDER BY p.name`
  ).all();
  if (format === 'csv') {
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    let csv = 'Product,Unit,Price,Stock,Reserved,Available,Threshold\n';
    for (const r of rows.results) {
      csv += [r.name, r.unit, r.price, r.quantity, r.reserved, r.quantity - r.reserved, r.stock_threshold]
        .map(esc).join(',') + '\n';
    }
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="inventory-report.csv"',
        ...CORS
      }
    });
  }
  return ok({ inventory: rows.results });
});

router.get('/api/reports/activity', async (request, env, _p, url) => {
  const { response } = await requireAuth(request, env); if (response) return response;
  const range = url.searchParams.get('range') || 'today';
  const dateFrom = url.searchParams.get('date_from');
  const dateTo = url.searchParams.get('date_to');
  const typeFilter = url.searchParams.get('type');

  const clauses = ['1=1'];
  const binds = [];
  if (range === 'today') clauses.push('DATE(sm.created_at) = DATE("now","localtime")');
  else if (range === 'week') clauses.push('DATE(sm.created_at) >= DATE("now","-6 days")');
  else if (range === 'month') clauses.push('strftime("%Y-%m", sm.created_at) = strftime("%Y-%m","now")');
  else if (range === 'custom' && dateFrom && dateTo) {
    clauses.push('DATE(sm.created_at) BETWEEN ? AND ?');
    binds.push(dateFrom, dateTo);
  }
  if (typeFilter === 'sold') clauses.push("sm.type='out'");
  else if (typeFilter === 'received') clauses.push("sm.type='in'");

  const rows = await env.DB.prepare(`
    SELECT sm.created_at, sm.type, p.name AS product_name, p.unit,
           sm.quantity, sm.unit_price, sm.total_amount,
           sm.new_quantity AS balance, sm.notes, u.full_name AS user_name
    FROM stock_movements sm
    JOIN products p ON sm.product_id = p.id
    LEFT JOIN users u ON sm.created_by = u.id
    WHERE ${clauses.join(' AND ')}
    ORDER BY sm.created_at DESC
  `).bind(...binds).all();

  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  let csv = 'Date,Type,Product,Unit,Qty,Unit Price,Total,Balance,User,Notes\n';
  for (const r of rows.results) {
    csv += [r.created_at, r.type === 'out' ? 'Sold' : 'Received', r.product_name, r.unit,
      r.quantity, r.unit_price, r.total_amount, r.balance, r.user_name || '', r.notes || '']
      .map(esc).join(',') + '\n';
  }
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="activity-${range}.csv"`,
      ...CORS
    }
  });
});

// ==================== NOTIFICATIONS ====================

router.get('/api/notifications', async (request, env) => {
  const { user, response } = await requireAuth(request, env); if (response) return response;
  const rows = await env.DB.prepare(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
  ).bind(user.id).all();
  return ok({ notifications: rows.results });
});

router.get('/api/notifications/unread-count', async (request, env) => {
  const { user, response } = await requireAuth(request, env); if (response) return response;
  const r = await env.DB.prepare(
    'SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND is_read = 0'
  ).bind(user.id).first();
  return ok({ count: r.c });
});

router.put('/api/notifications/:id/read', async (request, env, params) => {
  const { user, response } = await requireAuth(request, env); if (response) return response;
  await env.DB.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?')
    .bind(params.id, user.id).run();
  return ok();
});

router.put('/api/notifications/read-all', async (request, env) => {
  const { user, response } = await requireAuth(request, env); if (response) return response;
  await env.DB.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0')
    .bind(user.id).run();
  return ok();
});

// ==================== AUDIT LOGS ====================

router.get('/api/audit-logs', async (request, env, _p, url) => {
  const { response } = await requireAdmin(request, env); if (response) return response;
  const limit = Math.min(parseInt(url.searchParams.get('limit')) || 100, 500);
  const rows = await env.DB.prepare(
    `SELECT al.*, u.full_name as user_name FROM audit_logs al
     LEFT JOIN users u ON al.user_id = u.id
     ORDER BY al.created_at DESC LIMIT ?`
  ).bind(limit).all();
  return ok({ logs: rows.results });
});

// ==================== MAIN ====================

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    return router.handle(request, env);
  }
};
