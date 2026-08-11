// §16. PURCHASES (itemised marketplace orders)
// ═══════════════════════════════════════════════════════════════════════════
//
// Imports an itemised order export (Shopee today) into purchase_orders /
// purchase_items. This data is descriptive, never monetary: the spend itself
// already lives in `transactions` as one bank charge per order, so nothing
// here is ever summed into analytics, budget, or the planner. See the schema
// comments in js/database.js.
//
// ─────────────────────────────────────────────────────────────────────────
// §16.1. Source definitions
// ─────────────────────────────────────────────────────────────────────────

// Column mapping per marketplace, so a second source (Lazada, Amazon) is a
// new entry here rather than a fork of the parser.
//   orderId/date/… : CSV column names
//   statusCancelled: statuses whose money never reached the bank
const PURCHASE_SOURCES = {
    shopee: {
        label: 'Shopee',
        orderId: 'order_id',
        date: 'order_date',
        // Shopee's payment_date equals order_date on every order that has both,
        // so order_date is the single date used for matching and analysis.
        fallbackDate: 'payment_date',
        shop: 'shop',
        status: 'status',
        total: 'order_total',
        itemName: 'item_name',
        variation: 'variation',
        qty: 'qty',
        unitPricePaid: 'unit_price_paid',
        unitPriceOriginal: 'unit_price_original',
        url: 'order_url',
        statusCancelled: ['CANCELLED']
    }
};

// Statuses that represent money actually spent. Everything else is recorded
// but excluded from totals so a cancelled order never inflates a figure.
function purchaseIsSpend(status) {
    const s = (status || '').toUpperCase();
    return s !== 'CANCELLED';
}

let purchasePreview = null;   // parsed file awaiting confirmation
let purchasePage = 0;
let purchaseExpanded = new Set(); // order ids with their items expanded

// ─────────────────────────────────────────────────────────────────────────
// §16.2. Product identity
// ─────────────────────────────────────────────────────────────────────────

// Seed key for a line item. Deliberately conservative — it lowercases and
// strips punctuation/bracketed segments but does NOT try to merge different
// titles for the same product. Marketplace titles are SEO keyword soup: the
// same nappy appears under 7 names across 27 variations here, while unrelated
// products share long prefixes. Any normalisation aggressive enough to merge
// the first would wrongly merge the second, so merging is a curation step
// (product_catalog) rather than a guess made at import time.
// toCents('') is 0, which would record a $0.00 list price for every item whose
// original price the export left blank (most of them). Keep the distinction
// between "no list price exported" (null) and a genuine zero.
function toCentsOrNull(val) {
    if (val === null || val === undefined || String(val).trim() === '') return null;
    return toCents(val);
}

function purchaseProductKey(name, variation) {
    const clean = (s) => String(s || '')
        .toLowerCase()
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\([^)]*\)/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const n = clean(name);
    const v = clean(variation);
    if (!n && !v) return null;
    return v ? `${n}|${v}` : n;
}

// ─────────────────────────────────────────────────────────────────────────
// §16.3. Parsing
// ─────────────────────────────────────────────────────────────────────────

// Apportion an order's post-voucher total across its line items by gross
// value. Item prices are pre-voucher and pre-shipping, so they do not sum to
// what was paid (in the reference export, 726 of 1003 orders differ). The
// returned allocations sum exactly to `totalCents`: the rounding drift is
// absorbed by the largest item rather than left to float.
function allocateOrderTotal(items, totalCents) {
    const gross = items.map(it => Math.max(0, it.unit_price) * Math.max(1, it.qty));
    const grossSum = gross.reduce((a, b) => a + b, 0);

    if (!grossSum) {
        // No usable item prices — split evenly so the order still reconciles.
        const each = Math.floor(totalCents / items.length);
        const alloc = items.map(() => each);
        alloc[0] += totalCents - each * items.length;
        return alloc;
    }

    const alloc = gross.map(g => Math.round(totalCents * g / grossSum));
    const drift = totalCents - alloc.reduce((a, b) => a + b, 0);
    if (drift !== 0) {
        let biggest = 0;
        for (let i = 1; i < gross.length; i++) if (gross[i] > gross[biggest]) biggest = i;
        alloc[biggest] += drift;
    }
    return alloc;
}

// Parse an itemised export into orders with nested items. Rows that cannot
// yield an order id are reported rather than dropped silently, matching the
// bank import's "surface the problem" stance on unparseable dates/amounts.
function parsePurchaseCsv(text, sourceKey) {
    const src = PURCHASE_SOURCES[sourceKey];
    const { data } = parseCSV(text, { header: true });

    const missing = [src.orderId, src.itemName, src.total]
        .filter(col => data.length && !(col in data[0]));
    if (missing.length) {
        return { error: `This file is missing the column(s): ${missing.join(', ')}. Expected a ${src.label} order export.` };
    }

    const byId = new Map();
    const skipped = [];

    data.forEach((row, idx) => {
        const externalId = (row[src.orderId] || '').trim();
        if (!externalId) {
            skipped.push({ line: idx + 2, reason: 'no order id' });
            return;
        }

        if (!byId.has(externalId)) {
            byId.set(externalId, {
                external_id: externalId,
                order_date: (row[src.date] || row[src.fallbackDate] || '').trim() || null,
                shop: (row[src.shop] || '').trim(),
                status: (row[src.status] || '').trim(),
                total: toCents(row[src.total]) || 0,
                url: (row[src.url] || '').trim(),
                items: []
            });
        }

        const qtyRaw = parseInt(row[src.qty], 10);
        byId.get(externalId).items.push({
            name: (row[src.itemName] || '').trim(),
            variation: (row[src.variation] || '').trim(),
            qty: Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1,
            unit_price: toCents(row[src.unitPricePaid]) || 0,
            unit_price_original: toCentsOrNull(row[src.unitPriceOriginal]),
            product_key: purchaseProductKey(row[src.itemName], row[src.variation])
        });
    });

    const orders = [...byId.values()];
    orders.forEach(o => {
        const alloc = allocateOrderTotal(o.items, o.total);
        o.items.forEach((it, i) => { it.allocated_amount = alloc[i]; });
    });

    return { orders, skipped };
}

// ─────────────────────────────────────────────────────────────────────────
// §16.4. Import
// ─────────────────────────────────────────────────────────────────────────

async function handlePurchaseFile(input) {
    const file = input.files && input.files[0];
    if (!file) return;

    if (file.size > CONFIG.MAX_FILE_SIZE) {
        showMessage('error', 'File is too large (max 50MB)');
        input.value = '';
        return;
    }

    const sourceKey = document.getElementById('purchaseSource').value;

    try {
        const text = await file.text();
        const parsed = parsePurchaseCsv(text, sourceKey);

        if (parsed.error) {
            showMessage('error', parsed.error);
            input.value = '';
            return;
        }
        if (!parsed.orders.length) {
            showMessage('error', 'No orders found in this file');
            input.value = '';
            return;
        }

        purchasePreview = { ...parsed, filename: file.name, source: sourceKey };
        renderPurchasePreview();
    } catch (e) {
        showMessage('error', 'Could not read file: ' + e.message);
    }
    input.value = '';
}

function renderPurchasePreview() {
    const el = document.getElementById('purchasePreview');
    if (!el) return;

    if (!purchasePreview) {
        el.innerHTML = '';
        return;
    }

    const { orders, skipped, filename, source } = purchasePreview;

    // Which orders are already stored, so the user sees what this file will
    // actually change before committing to it.
    const existing = new Set(dbHelpers
        .queryAll('SELECT external_id FROM purchase_orders WHERE source = ?', [source])
        .map(r => String(r[0])));

    const fresh = orders.filter(o => !existing.has(o.external_id));
    const repeat = orders.length - fresh.length;
    const items = orders.reduce((n, o) => n + o.items.length, 0);
    const cancelled = orders.filter(o => !purchaseIsSpend(o.status)).length;
    const spend = orders.filter(o => purchaseIsSpend(o.status)).reduce((n, o) => n + o.total, 0);
    const dated = orders.map(o => o.order_date).filter(Boolean).sort();
    const undated = orders.length - dated.length;

    el.innerHTML = `
        <div class="purchase-preview-card">
            <h4>📦 ${escapeHtml(filename)}</h4>
            <div class="purchase-preview-grid">
                <div><span class="pp-num">${orders.length}</span><span class="pp-lbl">orders</span></div>
                <div><span class="pp-num">${items}</span><span class="pp-lbl">line items</span></div>
                <div><span class="pp-num">${fresh.length}</span><span class="pp-lbl">new</span></div>
                <div><span class="pp-num">${repeat}</span><span class="pp-lbl">already stored</span></div>
                <div><span class="pp-num">$${fmtMoney(spend)}</span><span class="pp-lbl">spend (excl. cancelled)</span></div>
                <div><span class="pp-num">${cancelled}</span><span class="pp-lbl">cancelled</span></div>
            </div>
            <p class="purchase-note">
                ${dated.length ? `${escapeHtml(dated[0])} → ${escapeHtml(dated[dated.length - 1])}` : 'no dates found'}${undated ? ` · ${undated} order(s) without a date` : ''}${skipped.length ? ` · ${skipped.length} row(s) skipped (no order id)` : ''}
            </p>
            <p class="purchase-note">
                Orders already stored are refreshed in place, not duplicated — the ${escapeHtml(PURCHASE_SOURCES[source].label)} order id is the key.
                Nothing here is added to your transactions or any spending total.
            </p>
            <div class="purchase-preview-actions">
                <button onclick="processPurchaseImport()">Import ${orders.length} order(s)</button>
                <button onclick="cancelPurchaseImport()" class="secondary-btn">Cancel</button>
            </div>
        </div>
    `;
}

function cancelPurchaseImport() {
    purchasePreview = null;
    renderPurchasePreview();
}

async function processPurchaseImport() {
    if (!purchasePreview) return;

    const { orders, filename, source } = purchasePreview;
    showLoading(`Importing ${orders.length} order(s)...`);

    try {
        const logId = createPurchaseImportRecord(source, filename);
        let created = 0;
        let updated = 0;
        let itemCount = 0;

        for (const o of orders) {
            const existingId = dbHelpers.queryValue(
                'SELECT id FROM purchase_orders WHERE source = ? AND external_id = ?',
                [source, o.external_id]
            );

            let orderId;
            if (existingId) {
                // Refresh in place: a later export carries newer status/dates
                // for an order already stored. The reconciled transaction_id
                // and the original provenance are deliberately left alone.
                dbHelpers.safeRun(`
                    UPDATE purchase_orders
                    SET order_date = ?, shop = ?, status = ?, total = ?, url = ?
                    WHERE id = ?
                `, [o.order_date, o.shop, o.status, o.total, o.url, existingId], 'Update purchase order');
                dbHelpers.safeRun('DELETE FROM purchase_items WHERE order_id = ?', [existingId], 'Replace purchase items');
                orderId = existingId;
                updated++;
            } else {
                dbHelpers.safeRun(`
                    INSERT INTO purchase_orders
                        (source, external_id, order_date, shop, status, total, url, purchase_import_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `, [source, o.external_id, o.order_date, o.shop, o.status, o.total, o.url, logId], 'Insert purchase order');
                orderId = dbHelpers.queryValue('SELECT last_insert_rowid()');
                created++;
            }

            for (const it of o.items) {
                dbHelpers.safeRun(`
                    INSERT INTO purchase_items
                        (order_id, name, variation, qty, unit_price, unit_price_original, allocated_amount, product_key)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `, [orderId, it.name, it.variation, it.qty, it.unit_price,
                    it.unit_price_original, it.allocated_amount, it.product_key], 'Insert purchase item');
                itemCount++;
            }
        }

        dbHelpers.safeRun(`
            UPDATE purchase_imports SET orders_new = ?, orders_updated = ?, item_count = ? WHERE id = ?
        `, [created, updated, itemCount, logId], 'Update purchase import log');

        markDirty();
        purchasePreview = null;
        purchasePage = 0;
        renderPurchasePreview();
        loadPurchases();

        hideLoading();
        showMessage('success', `Imported ${created} new order(s), refreshed ${updated}, ${itemCount} line item(s)`);
    } catch (e) {
        hideLoading();
        showMessage('error', 'Error importing purchases: ' + e.message);
        console.error('Purchase import error:', e);
    }
}

function createPurchaseImportRecord(source, filename) {
    dbHelpers.safeRun(`
        INSERT INTO purchase_imports (source, filename, import_date) VALUES (?, ?, ?)
    `, [source, filename, new Date().toISOString()], 'Create purchase import record');
    return dbHelpers.queryValue('SELECT last_insert_rowid()');
}

// ─────────────────────────────────────────────────────────────────────────
// §16.5. Display
// ─────────────────────────────────────────────────────────────────────────

// Single source of the Purchases filter-bar WHERE clause, mirroring
// buildTransactionFilter() so the summary and the list can never disagree.
function buildPurchaseFilter() {
    const search = (document.getElementById('purchaseSearch')?.value || '').trim();
    const status = document.getElementById('purchaseStatus')?.value || '';
    const from = document.getElementById('purchaseDateFrom')?.value || '';
    const to = document.getElementById('purchaseDateTo')?.value || '';

    let where = ' WHERE 1=1';
    const params = [];

    if (search) {
        where += ` AND (po.shop LIKE ? OR EXISTS (
                      SELECT 1 FROM purchase_items pi WHERE pi.order_id = po.id AND pi.name LIKE ?))`;
        params.push(`%${search}%`, `%${search}%`);
    }
    if (status === 'spend') {
        where += ` AND UPPER(COALESCE(po.status, '')) <> 'CANCELLED'`;
    } else if (status === 'cancelled') {
        where += ` AND UPPER(COALESCE(po.status, '')) = 'CANCELLED'`;
    }
    if (from) { where += ' AND po.order_date >= ?'; params.push(from); }
    if (to)   { where += ' AND po.order_date <= ?'; params.push(to); }

    return { where, params };
}

function loadPurchases() {
    renderPurchaseSummary();
    renderPurchaseOrders();
}

function renderPurchaseSummary() {
    const el = document.getElementById('purchaseSummary');
    if (!el) return;

    const { where, params } = buildPurchaseFilter();
    const row = dbHelpers.queryFirst(`
        SELECT COUNT(*),
               SUM(CASE WHEN UPPER(COALESCE(po.status,'')) <> 'CANCELLED' THEN po.total ELSE 0 END),
               SUM(CASE WHEN UPPER(COALESCE(po.status,'')) =  'CANCELLED' THEN po.total ELSE 0 END),
               MIN(po.order_date), MAX(po.order_date),
               COUNT(po.transaction_id)
        FROM purchase_orders po${where}
    `, params);

    if (!row || !row[0]) {
        el.innerHTML = `<p class="purchase-empty">No purchases imported yet. Import an order export above to itemise what's behind your marketplace charges.</p>`;
        return;
    }

    const [count, spend, cancelled, minDate, maxDate, matched] = row;
    const items = dbHelpers.queryValue(`
        SELECT COUNT(*) FROM purchase_items pi
        WHERE pi.order_id IN (SELECT po.id FROM purchase_orders po${where})
    `, params) || 0;

    el.innerHTML = `
        <div class="purchase-summary-grid">
            <div class="purchase-stat"><div class="ps-num">${count}</div><div class="ps-lbl">orders</div></div>
            <div class="purchase-stat"><div class="ps-num">${items}</div><div class="ps-lbl">line items</div></div>
            <div class="purchase-stat"><div class="ps-num">$${fmtMoney(spend || 0)}</div><div class="ps-lbl">spent</div></div>
            <div class="purchase-stat"><div class="ps-num">$${fmtMoney(cancelled || 0)}</div><div class="ps-lbl">cancelled (excluded)</div></div>
            <div class="purchase-stat"><div class="ps-num">${matched || 0}</div><div class="ps-lbl">matched to a bank row</div></div>
            <div class="purchase-stat"><div class="ps-num">${minDate ? escapeHtml(minDate.slice(0, 7)) : '—'} → ${maxDate ? escapeHtml(maxDate.slice(0, 7)) : '—'}</div><div class="ps-lbl">range</div></div>
        </div>
    `;
}

function renderPurchaseOrders() {
    const el = document.getElementById('purchaseList');
    if (!el) return;

    const { where, params } = buildPurchaseFilter();
    const total = dbHelpers.queryValue(`SELECT COUNT(*) FROM purchase_orders po${where}`, params) || 0;

    if (!total) {
        el.innerHTML = `<p class="purchase-empty">No orders match these filters.</p>`;
        renderPurchasePagination(0);
        return;
    }

    const rows = dbHelpers.queryAll(`
        SELECT po.id, po.order_date, po.shop, po.status, po.total, po.url, po.transaction_id,
               (SELECT COUNT(*) FROM purchase_items pi WHERE pi.order_id = po.id)
        FROM purchase_orders po${where}
        ORDER BY po.order_date DESC, po.id DESC
        LIMIT ? OFFSET ?
    `, [...params, CONFIG.PAGE_SIZE, purchasePage * CONFIG.PAGE_SIZE]);

    el.innerHTML = `
        <table class="purchase-table">
            <thead>
                <tr><th>Date</th><th>Shop</th><th>Items</th><th class="num">Total</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
                ${rows.map(r => renderPurchaseRow(r)).join('')}
            </tbody>
        </table>
    `;

    renderPurchasePagination(total);
}

function renderPurchaseRow(r) {
    const [id, date, shop, status, totalCents, url, txnId, itemCount] = r;
    const cancelled = !purchaseIsSpend(status);
    const open = purchaseExpanded.has(id);

    const main = `
        <tr class="purchase-row${cancelled ? ' cancelled' : ''}">
            <td>${escapeHtml(date || '—')}</td>
            <td>
                <button class="link-btn" onclick="togglePurchaseItems(${id})">${open ? '▾' : '▸'} ${escapeHtml(shop || 'Unknown shop')}</button>
                ${txnId ? '<span class="purchase-badge" title="Matched to a bank transaction">🔗</span>' : ''}
            </td>
            <td>${itemCount}</td>
            <td class="num">$${fmtMoney(totalCents)}</td>
            <td><span class="purchase-status${cancelled ? ' cancelled' : ''}">${escapeHtml(status || '—')}</span></td>
            <td>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">open</a>` : ''}</td>
        </tr>
    `;

    if (!open) return main;

    const items = dbHelpers.queryAll(`
        SELECT name, variation, qty, unit_price, allocated_amount
        FROM purchase_items WHERE order_id = ? ORDER BY id
    `, [id]);

    return main + `
        <tr class="purchase-items-row">
            <td colspan="6">
                <table class="purchase-items">
                    <thead><tr><th>Item</th><th>Variation</th><th class="num">Qty</th><th class="num">Unit paid</th><th class="num">Share of total</th></tr></thead>
                    <tbody>
                        ${items.map(it => `
                            <tr>
                                <td>${escapeHtml(it[0])}</td>
                                <td>${escapeHtml(it[1] || '—')}</td>
                                <td class="num">${it[2]}</td>
                                <td class="num">$${fmtMoney(it[3])}</td>
                                <td class="num">$${fmtMoney(it[4])}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
                <p class="purchase-note">
                    "Share of total" apportions what you actually paid across the items — item prices are pre-voucher and pre-shipping, so they rarely sum to the order total.
                </p>
            </td>
        </tr>
    `;
}

function togglePurchaseItems(orderId) {
    if (purchaseExpanded.has(orderId)) purchaseExpanded.delete(orderId);
    else purchaseExpanded.add(orderId);
    renderPurchaseOrders();
}

function renderPurchasePagination(total) {
    const el = document.getElementById('purchasePagination');
    if (!el) return;

    const pages = Math.ceil(total / CONFIG.PAGE_SIZE);
    if (pages <= 1) { el.innerHTML = ''; return; }

    const start = purchasePage * CONFIG.PAGE_SIZE + 1;
    const end = Math.min((purchasePage + 1) * CONFIG.PAGE_SIZE, total);

    // Matches the transaction list's pagination bar.
    el.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:15px; padding:10px; background:#f8f9fa; border-radius:4px;">
            <div>Showing ${start}-${end} of ${total} order${total === 1 ? '' : 's'}</div>
            <div style="display:flex; gap:10px;">
                <button onclick="changePurchasePage(-1)" ${purchasePage === 0 ? 'disabled' : ''} style="padding:5px 15px;">← Previous</button>
                <span style="padding:5px 15px;">Page ${purchasePage + 1} of ${pages}</span>
                <button onclick="changePurchasePage(1)" ${purchasePage >= pages - 1 ? 'disabled' : ''} style="padding:5px 15px;">Next →</button>
            </div>
        </div>
    `;
}

function changePurchasePage(delta) {
    purchasePage = Math.max(0, purchasePage + delta);
    renderPurchaseOrders();
}

const debouncedLoadPurchases = debounce(loadPurchases, CONFIG.DEBOUNCE_MS);

function resetPurchaseFilters() {
    ['purchaseSearch', 'purchaseDateFrom', 'purchaseDateTo'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const status = document.getElementById('purchaseStatus');
    if (status) status.value = '';
    purchasePage = 0;
    loadPurchases();
}

function onPurchaseFilterChange() {
    purchasePage = 0;
    loadPurchases();
}

// ─────────────────────────────────────────────────────────────────────────
// §16.6. Bulk removal
// ─────────────────────────────────────────────────────────────────────────

// Per-source wipe rather than per-file undo: imports are idempotent and real
// exports overlap, so one order is typically carried by several files and
// "undo that file" has no well-defined meaning.
async function clearPurchaseSource() {
    const source = document.getElementById('purchaseSource').value;
    const label = PURCHASE_SOURCES[source].label;
    const count = dbHelpers.queryValue('SELECT COUNT(*) FROM purchase_orders WHERE source = ?', [source]) || 0;

    if (!count) {
        showMessage('error', `No ${label} purchases to remove`);
        return;
    }
    if (!confirm(`Permanently delete all ${count} ${label} order(s) and their items?\n\nYour bank transactions are not affected.`)) return;

    dbHelpers.safeRun('DELETE FROM purchase_orders WHERE source = ?', [source], 'Clear purchase source');
    dbHelpers.safeRun('DELETE FROM purchase_imports WHERE source = ?', [source], 'Clear purchase import log');
    markDirty();
    purchasePage = 0;
    purchaseExpanded.clear();
    loadPurchases();
    showMessage('success', `Removed ${count} ${label} order(s)`);
}
