// §17. PRODUCT TITLE EXTRACTION (Anthropic API)
// ═══════════════════════════════════════════════════════════════════════════
//
// Parses marketplace titles into {brand, item, pack size, category} so that
// products can be identified across the many names one product is sold under,
// and so unit prices become comparable across pack sizes.
//
// This is the second feature that sends transaction *contents* off-device
// (after Ask AI), and it follows the same rules: the user's own API key from
// localStorage, an explicit button press, the exact count shown before
// anything is sent, and nothing automatic on import. See CLAUDE.md.
//
// Reuses Ask AI's key and endpoint constants rather than introducing a second
// credential or a second place to configure one.
//
// ─────────────────────────────────────────────────────────────────────────
// §17.1. Extraction contract
// ─────────────────────────────────────────────────────────────────────────

const EXTRACT_MODEL = 'claude-sonnet-5';
const EXTRACT_BATCH_SIZE = 40;

// Base units everything is normalised to. kg/l are accepted from the model
// and converted here — the model reports what it sees, code does the maths.
const EXTRACT_UNITS = ['g', 'kg', 'ml', 'l', 'pcs', 'sheets', 'none'];
const EXTRACT_UNIT_BASE = { g: 'g', kg: 'g', ml: 'ml', l: 'ml', pcs: 'pcs', sheets: 'sheets' };
const EXTRACT_UNIT_FACTOR = { g: 1, kg: 1000, ml: 1, l: 1000, pcs: 1, sheets: 1 };

// The model picks a category from the user's own list (built at call time), so
// it cannot invent one that doesn't exist in their Categories tab.
function extractCategoryNames() {
    return dbHelpers.queryAll('SELECT name FROM categories ORDER BY name').map(r => r[0]);
}

function extractSchema(categoryNames) {
    return {
        type: 'object',
        properties: {
            products: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        index: { type: 'integer' },
                        brand: { type: 'string' },
                        item: { type: 'string' },
                        size_value: { type: 'number' },
                        size_unit: { type: 'string', enum: EXTRACT_UNITS },
                        size_multiplier: { type: 'integer' },
                        category: { type: 'string', enum: [...categoryNames, ''] }
                    },
                    required: ['index', 'brand', 'item', 'size_value', 'size_unit', 'size_multiplier', 'category'],
                    additionalProperties: false
                }
            }
        },
        required: ['products'],
        additionalProperties: false
    };
}

const EXTRACT_SYSTEM = [
    'You normalise online-marketplace product titles into structured records.',
    'Marketplace titles are keyword soup: they repeat the product name, stack',
    'search terms, and mix languages. Extract the underlying product.',
    '',
    'For each numbered title return one record with the same index:',
    '',
    'brand  — the manufacturer or brand ("RedMan", "Merries", "Bob\'s Red Mill").',
    '         Empty string if the title has no real brand (generic goods,',
    '         unbranded accessories). The seller/shop name is a hint, not the',
    '         brand: resellers like "MillionParcel" or "Shopee Supermarket"',
    '         sell other brands, so do not use them as the brand.',
    'item   — the product itself, in plain lowercase words, with marketing',
    '         terms, sizes, and search keywords stripped: "bread flour",',
    '         "facial tissue", "tape diapers". Keep the words that distinguish',
    '         genuinely different products from the same brand, and drop the',
    '         ones that do not. Two titles for the same product must give the',
    '         same item text.',
    '',
    'size_value / size_unit / size_multiplier — pack size, the amount in ONE',
    '         purchased unit. size_unit is one of: g, kg, ml, l, pcs, sheets,',
    '         or "none". For a multipack, put the per-piece amount in',
    '         size_value and the count in size_multiplier: "24x200ml" is',
    '         value 200, unit ml, multiplier 24. Otherwise multiplier is 1.',
    '',
    '         Use "none" whenever the title carries no pack size. Most titles',
    '         do not have one — a phone grip, a screen protector, or a wall',
    '         hook has no meaningful size. "none" is a correct answer and is',
    '         much better than a guess. When unit is "none", set size_value 0',
    '         and size_multiplier 1.',
    '',
    'category — the single best fit from the provided list, or empty string if',
    '         none clearly applies. Do not invent categories.',
    '',
    'Return a record for every title given, and no others.'
].join('\n');

// ─────────────────────────────────────────────────────────────────────────
// §17.2. API call
// ─────────────────────────────────────────────────────────────────────────

async function extractCallApi(titles, categoryNames) {
    const numbered = titles.map((t, i) => `${i}. ${t}`).join('\n');

    const resp = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-key': askAiStoredKey(),
            'anthropic-version': ANTHROPIC_VERSION,
            // Required to call the API directly from a browser page.
            'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
            model: EXTRACT_MODEL,
            max_tokens: 8000,
            // Structured extraction of short strings — no reasoning needed, and
            // the schema already constrains the output shape. Raise effort (or
            // drop `thinking`) if titles start coming back mis-parsed.
            thinking: { type: 'disabled' },
            output_config: {
                effort: 'low',
                format: { type: 'json_schema', schema: extractSchema(categoryNames) }
            },
            system: EXTRACT_SYSTEM,
            messages: [{ role: 'user', content: numbered }]
        })
    });

    if (!resp.ok) {
        let detail = '';
        try { detail = (await resp.json()).error.message; } catch (e) { /* ignore */ }
        throw new Error(`Anthropic API ${resp.status}${detail ? ': ' + detail : ''}`);
    }

    const data = await resp.json();
    if (data.stop_reason === 'refusal') {
        throw new Error('The model declined to process this batch.');
    }

    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        throw new Error('Could not parse the model response as JSON');
    }
    return parsed.products || [];
}

// Convert the model's reported size into a base unit with the multiplier
// resolved. Returns {value, unit} or null. Kept out of the model's hands so a
// pack size is arithmetic, not a judgement call.
function normalizeSize(rec) {
    const unit = rec.size_unit;
    if (!unit || unit === 'none') return null;

    const base = EXTRACT_UNIT_BASE[unit];
    const factor = EXTRACT_UNIT_FACTOR[unit];
    if (!base) return null;

    const value = Number(rec.size_value);
    const mult = Number(rec.size_multiplier);
    if (!isFinite(value) || value <= 0) return null;

    const total = value * factor * (isFinite(mult) && mult > 0 ? mult : 1);
    if (!isFinite(total) || total <= 0) return null;

    return { value: Math.round(total * 1000) / 1000, unit: base };
}

// ─────────────────────────────────────────────────────────────────────────
// §17.3. Run
// ─────────────────────────────────────────────────────────────────────────

let extractBusy = false;

// Titles with no extraction yet. Re-running only ever costs what is new,
// because the cache is keyed by the title itself.
function extractPendingTitles() {
    return dbHelpers.queryAll(`
        SELECT DISTINCT pi.name
        FROM purchase_items pi
        WHERE pi.name <> ''
          AND pi.name NOT IN (SELECT title FROM title_extractions)
        ORDER BY pi.name
    `).map(r => r[0]);
}

function renderExtractStatus() {
    const el = document.getElementById('extractStatus');
    if (!el) return;

    const pending = extractPendingTitles().length;
    const done = dbHelpers.queryValue('SELECT COUNT(*) FROM title_extractions') || 0;
    const edited = dbHelpers.queryValue('SELECT COUNT(*) FROM title_extractions WHERE edited = 1') || 0;
    const configured = typeof askAiIsConfigured === 'function' && askAiIsConfigured();

    el.innerHTML = `
        <p class="purchase-note" style="margin:0 0 10px;">
            ${done} title(s) parsed${edited ? ` · ${edited} corrected by hand` : ''} · <strong>${pending}</strong> not yet parsed.
            ${pending ? `Parsing sends those ${pending} product title(s) — and nothing else — to Anthropic's API using your Ask AI key.` : 'Everything is parsed.'}
        </p>
        <div style="display:flex; gap:10px; flex-wrap:wrap;">
            <button onclick="extractRun()" ${!pending || !configured || extractBusy ? 'disabled' : ''}>
                🔍 Parse ${pending} title(s) with ${escapeHtml(EXTRACT_MODEL)}
            </button>
            <button onclick="extractApply()" class="secondary-btn" ${!done || extractBusy ? 'disabled' : ''}>Apply to products</button>
        </div>
        ${!configured ? '<p class="ai-note" style="margin-top:10px;">Add your Anthropic API key in the Ask AI tab first — this reuses the same key.</p>' : ''}
        <div id="extractProgress"></div>
    `;
}

async function extractRun() {
    if (extractBusy) return;

    const titles = extractPendingTitles();
    if (!titles.length) return;

    if (!confirm(`Send ${titles.length} product title(s) to Anthropic for parsing?\n\n` +
                 `Only the product titles are sent — no prices, dates, shops, or bank data.\n` +
                 `Results are cached, so each title is only ever sent once.`)) return;

    extractBusy = true;
    renderExtractStatus();

    const progress = document.getElementById('extractProgress');
    const categoryNames = extractCategoryNames();
    const batches = Math.ceil(titles.length / EXTRACT_BATCH_SIZE);
    let stored = 0;
    let failed = 0;

    try {
        for (let b = 0; b < batches; b++) {
            const slice = titles.slice(b * EXTRACT_BATCH_SIZE, (b + 1) * EXTRACT_BATCH_SIZE);
            if (progress) {
                progress.innerHTML = `<p class="purchase-note">Batch ${b + 1} of ${batches} — ${stored} parsed so far…</p>`;
            }

            let records;
            try {
                records = await extractCallApi(slice, categoryNames);
            } catch (e) {
                // One bad batch shouldn't discard the ones already stored.
                console.error('Extraction batch failed:', e);
                failed += slice.length;
                continue;
            }

            for (const rec of records) {
                const title = slice[rec.index];
                if (!title || !rec.item) continue;

                const size = normalizeSize(rec);
                dbHelpers.safeRun(`
                    INSERT INTO title_extractions
                        (title, brand, item, size_value, size_unit, category, edited, model, extracted_at)
                    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
                    ON CONFLICT(title) DO UPDATE SET
                        brand = excluded.brand, item = excluded.item,
                        size_value = excluded.size_value, size_unit = excluded.size_unit,
                        category = excluded.category, model = excluded.model,
                        extracted_at = excluded.extracted_at
                    WHERE title_extractions.edited = 0
                `, [title, (rec.brand || '').trim() || null, rec.item.trim(),
                    size ? size.value : null, size ? size.unit : null,
                    (rec.category || '').trim() || null, EXTRACT_MODEL, new Date().toISOString()],
                    'Store title extraction');
                stored++;
            }

            markDirty();
        }

        showMessage(failed ? 'error' : 'success',
            `Parsed ${stored} title(s)${failed ? `; ${failed} failed and can be retried` : ''}. Review below, then Apply.`);
    } finally {
        extractBusy = false;
        renderExtractStatus();
        loadExtractions();
    }
}

// ─────────────────────────────────────────────────────────────────────────
// §17.4. Apply
// ─────────────────────────────────────────────────────────────────────────

// Re-point every item at the product its title resolves to, and write the
// catalog rows. Separate from extraction so parsing can be reviewed — and
// corrected — before it touches any product grouping.
async function extractApply() {
    if (!confirm('Apply parsed titles to products?\n\nThis regroups items by brand + item and fills in pack sizes and categories.\nHand-made merges and edits are kept.')) return;

    showLoading('Applying parsed titles...');
    try {
        // A merge made before extraction points its members at a *seed* key.
        // Left alone, those members keep the seed key while everything else
        // moves to the extracted key, splitting one product into two groups.
        // Re-point each merge at the extracted identity of its own target
        // first, so hand-merges and extraction agree instead of competing.
        for (const [target] of dbHelpers.queryAll('SELECT DISTINCT product_key FROM product_aliases')) {
            const title = dbHelpers.queryValue(
                'SELECT name FROM purchase_items WHERE source_key = ? LIMIT 1', [target]);
            if (!title) continue;

            const ext = dbHelpers.queryFirst(
                'SELECT brand, item FROM title_extractions WHERE title = ?', [title]);
            if (!ext || !ext[1]) continue;

            const key = extractionProductKey(ext[0], ext[1]);
            if (key && key !== target) {
                dbHelpers.safeRun('UPDATE product_aliases SET product_key = ? WHERE product_key = ?',
                    [key, target], 'Re-point merge at extracted identity');
            }
        }

        const items = dbHelpers.queryAll('SELECT id, source_key, name FROM purchase_items');
        for (const [id, sourceKey, name] of items) {
            dbHelpers.safeRun('UPDATE purchase_items SET product_key = ? WHERE id = ?',
                [resolveProductKey(sourceKey, name), id], 'Re-key purchase item');
        }

        // One catalog row per product the extractions produced. Existing rows
        // keep any pack size or category already set by hand.
        const groups = dbHelpers.queryAll(`
            SELECT DISTINCT pi.product_key, te.brand, te.item, te.size_value, te.size_unit, te.category
            FROM purchase_items pi
            JOIN title_extractions te ON te.title = pi.name
            WHERE pi.product_key IS NOT NULL
        `);

        let written = 0;
        for (const [key, brand, item, sizeValue, sizeUnit, category] of groups) {
            const displayName = [brand, item].filter(Boolean).join(' ') || item;
            const categoryId = category
                ? dbHelpers.queryValue('SELECT id FROM categories WHERE name = ?', [category])
                : null;

            dbHelpers.safeRun(`
                INSERT INTO product_catalog
                    (product_key, display_name, category_id, subcategory_id, is_consumable, pack_size, unit)
                VALUES (?, ?, ?, NULL, 0, ?, ?)
                ON CONFLICT(product_key) DO UPDATE SET
                    display_name = excluded.display_name,
                    category_id  = COALESCE(product_catalog.category_id, excluded.category_id),
                    pack_size    = COALESCE(product_catalog.pack_size, excluded.pack_size),
                    unit         = COALESCE(product_catalog.unit, excluded.unit)
            `, [key, displayName, categoryId, sizeValue, sizeUnit], 'Write product catalog row');
            written++;
        }

        // Re-keying can strand catalog rows whose product no item points at
        // any more (the seed-key row a re-pointed merge just left behind).
        dbHelpers.safeRun(`DELETE FROM product_catalog
            WHERE product_key NOT IN (SELECT product_key FROM purchase_items WHERE product_key IS NOT NULL)`,
            [], 'Prune stranded catalog rows');

        markDirty();
        hideLoading();
        showMessage('success', `Applied — ${written} product(s) updated`);
        if (typeof loadPurchaseProducts === 'function') loadPurchaseProducts();
        renderExtractStatus();
    } catch (e) {
        hideLoading();
        showMessage('error', 'Error applying extractions: ' + e.message);
        console.error('Apply error:', e);
    }
}

// ─────────────────────────────────────────────────────────────────────────
// §17.5. Review & correction
// ─────────────────────────────────────────────────────────────────────────

function loadExtractions() {
    const el = document.getElementById('extractList');
    if (!el) return;

    const search = (document.getElementById('extractSearch')?.value || '').trim();
    const onlyNoSize = document.getElementById('extractOnlyNoSize')?.checked;

    let where = ' WHERE 1=1';
    const params = [];
    if (search) {
        where += ' AND (title LIKE ? OR brand LIKE ? OR item LIKE ?)';
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (onlyNoSize) where += ' AND size_unit IS NULL';

    const rows = dbHelpers.queryAll(`
        SELECT title, brand, item, size_value, size_unit, category, edited
        FROM title_extractions${where}
        ORDER BY brand IS NULL, brand, item
        LIMIT 300
    `, params);

    if (!rows.length) {
        el.innerHTML = `<p class="purchase-empty">Nothing parsed yet.</p>`;
        return;
    }

    el.innerHTML = `
        <table class="purchase-table">
            <thead><tr><th>Brand</th><th>Item</th><th>Pack size</th><th>Category</th><th>Original title</th><th></th></tr></thead>
            <tbody>
                ${rows.map(r => `
                    <tr>
                        <td>${escapeHtml(r[1] || '—')}</td>
                        <td>${escapeHtml(r[2])}${r[6] ? ' <span class="product-tag">edited</span>' : ''}</td>
                        <td>${r[3] ? `${escapeHtml(String(r[3]))} ${escapeHtml(r[4])}` : '—'}</td>
                        <td>${escapeHtml(r[5] || '—')}</td>
                        <td class="extract-title">${escapeHtml(r[0])}</td>
                        <td><button class="link-btn" onclick='editExtraction(${JSON.stringify(r[0])})'>edit</button></td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

function editExtraction(title) {
    const r = dbHelpers.queryFirst(
        'SELECT brand, item, size_value, size_unit, category FROM title_extractions WHERE title = ?', [title]);
    if (!r) return;

    let categoryOptions = '<option value="">-- None --</option>';
    extractCategoryNames().forEach(n => {
        categoryOptions += `<option value="${escapeHtml(n)}" ${n === r[4] ? 'selected' : ''}>${escapeHtml(n)}</option>`;
    });

    let unitOptions = '<option value="">none</option>';
    ['g', 'ml', 'pcs', 'sheets'].forEach(u => {
        unitOptions += `<option value="${u}" ${u === r[3] ? 'selected' : ''}>${u}</option>`;
    });

    document.body.insertAdjacentHTML('beforeend', `
        <div id="editExtractionModal" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000;">
            <div style="background: white; padding: 30px; border-radius: 8px; max-width: 520px; width: 90%; max-height: 85vh; overflow-y: auto;">
                <h3 style="margin-top: 0;">Correct parsed title</h3>
                <p class="purchase-note" style="margin-top:0;">${escapeHtml(title)}</p>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                    <div class="form-group">
                        <label>Brand</label>
                        <input type="text" id="extBrand" value="${escapeHtml(r[0] || '')}">
                    </div>
                    <div class="form-group">
                        <label>Item</label>
                        <input type="text" id="extItem" value="${escapeHtml(r[1] || '')}">
                    </div>
                    <div class="form-group">
                        <label>Pack size</label>
                        <input type="number" id="extSizeValue" step="any" min="0" value="${r[2] != null ? escapeHtml(String(r[2])) : ''}">
                    </div>
                    <div class="form-group">
                        <label>Unit</label>
                        <select id="extSizeUnit">${unitOptions}</select>
                    </div>
                </div>
                <div class="form-group">
                    <label>Category</label>
                    <select id="extCategory">${categoryOptions}</select>
                </div>
                <p class="purchase-note" style="margin-top:0;">
                    Brand + item decide which product this groups into. Corrections are kept and never overwritten by a re-run.
                </p>
                <div style="display: flex; gap: 10px; margin-top: 20px; flex-wrap: wrap;">
                    <button onclick='saveExtraction(${JSON.stringify(title)})'>Save</button>
                    <button class="secondary-btn" onclick="closeExtractionModal()">Cancel</button>
                </div>
            </div>
        </div>
    `);
}

function closeExtractionModal() {
    const modal = document.getElementById('editExtractionModal');
    if (modal) modal.remove();
}

function saveExtraction(title) {
    const item = document.getElementById('extItem').value.trim();
    if (!item) { showMessage('error', 'Item is required'); return; }

    const rawSize = document.getElementById('extSizeValue').value.trim();
    const unit = document.getElementById('extSizeUnit').value || null;
    const sizeValue = rawSize === '' ? null : parseFloat(rawSize);
    if (sizeValue !== null && (!isFinite(sizeValue) || sizeValue <= 0)) {
        showMessage('error', 'Pack size must be a positive number');
        return;
    }

    dbHelpers.safeRun(`
        UPDATE title_extractions
        SET brand = ?, item = ?, size_value = ?, size_unit = ?, category = ?, edited = 1
        WHERE title = ?
    `, [document.getElementById('extBrand').value.trim() || null, item,
        unit ? sizeValue : null, sizeValue !== null ? unit : null,
        document.getElementById('extCategory').value || null, title], 'Save extraction');

    markDirty();
    closeExtractionModal();
    loadExtractions();
    showMessage('success', 'Saved — press "Apply to products" to regroup');
}

const debouncedLoadExtractions = debounce(loadExtractions, CONFIG.DEBOUNCE_MS);
