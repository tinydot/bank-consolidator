// §7. TRANSACTION OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────
// §7.1. CRUD Operations
// ─────────────────────────────────────────────────────────────────────────

function insertTransaction(transaction) {
    try {
        // Apply transaction rules (defaults to Uncategorized if no category)
        const ruleResult = applyTransactionRules(transaction.description, transaction.category);

        // Resolve category_id (fallback to Uncategorized)
        const categoryName = ruleResult.category || 'Uncategorized';
        let categoryId = dbHelpers.queryValue('SELECT id FROM categories WHERE name = ?', [categoryName]);
        let resolvedFromRule = true;
        if (!categoryId) {
            categoryId = dbHelpers.queryValue('SELECT id FROM categories WHERE name = ?', ['Uncategorized']);
            resolvedFromRule = false;
        }

        // Only carry the rule's subcategory when the rule's category actually resolved,
        // so the subcategory never ends up paired with the wrong (fallback) category.
        const subcategoryId = (ruleResult.categorized && resolvedFromRule) ? ruleResult.subcategoryId : null;

        dbHelpers.safeRun(`
            INSERT INTO transactions (import_id, date, description, amount, category_id, subcategory_id, ignored, auto_ignored)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0)
        `, [
            transaction.import_id,
            transaction.date,
            transaction.description,
            transaction.amount,
            categoryId,
            subcategoryId,
            ruleResult.shouldIgnore ? 1 : 0
        ], 'Insert transaction');
    } catch (e) {
        console.error('Error inserting transaction:', e);
    }
}

function applyTransactionRules(description, defaultCategory) {
    // Default to Uncategorized if no category is provided
    const fallbackCategory = defaultCategory || 'Uncategorized';

    if (!description) {
        return { shouldIgnore: false, category: fallbackCategory, subcategoryId: null, categorized: false, ruleId: null, ignoreRuleId: null };
    }

    try {
        // Get all enabled rules ordered by priority (higher first)
        const rulesResult = db.exec(`
            SELECT tr.keyword, tr.action, c.name as category_name, tr.case_sensitive, tr.subcategory_value, tr.id
            FROM transaction_rules tr
            LEFT JOIN categories c ON tr.category_value = c.id
            WHERE tr.enabled = 1
            ORDER BY tr.priority DESC, tr.id ASC
        `);

        if (!rulesResult.length || !rulesResult[0].values.length) {
            return { shouldIgnore: false, category: fallbackCategory, subcategoryId: null, categorized: false, ruleId: null, ignoreRuleId: null };
        }

        let shouldIgnore = false;
        let category = fallbackCategory;
        let subcategoryId = null;
        let ruleId = null;          // id of the categorize rule that won
        let ignoreRuleId = null;    // id of the ignore rule that won

        // Apply rules in priority order (first match wins for each action type)
        let ignoreRuleMatched = false;
        let categoryRuleMatched = false;

        for (const rule of rulesResult[0].values) {
            const keyword = rule[0];
            const action = rule[1];
            const categoryValue = rule[2];
            const caseSensitive = rule[3];
            const subcategoryValue = rule[4];
            const id = rule[5];

            // Word-boundary match: keyword must not be a substring of a larger word/phrase
            // Uses explicit boundary check instead of lookbehind for Safari < 16.4 compatibility
            const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const flags = caseSensitive ? '' : 'i';
            const pattern = new RegExp(`(^|[^\\w])${escapedKeyword}([^\\w]|$)`, flags);

            if (pattern.test(description)) {
                if (action === 'ignore' && !ignoreRuleMatched) {
                    shouldIgnore = true;
                    ignoreRuleMatched = true;
                    ignoreRuleId = id;
                } else if (action === 'categorize' && !categoryRuleMatched && categoryValue) {
                    category = categoryValue;
                    // The matched rule may also assign a subcategory (id of a row that
                    // belongs to the same category — the two are set together in the form).
                    subcategoryId = subcategoryValue != null ? subcategoryValue : null;
                    categoryRuleMatched = true;
                    ruleId = id;
                }

                // If both types of rules matched, we can stop
                if (ignoreRuleMatched && categoryRuleMatched) {
                    break;
                }
            }
        }

        return { shouldIgnore, category, subcategoryId, categorized: categoryRuleMatched, ruleId, ignoreRuleId };
    } catch (e) {
        console.error('Error applying rules:', e);
        return { shouldIgnore: false, category: fallbackCategory, subcategoryId: null, categorized: false, ruleId: null, ignoreRuleId: null };
    }
}

// ─────────────────────────────────────────────────────────────────────────
// §7.2. Query & Display
// ─────────────────────────────────────────────────────────────────────────

// Debounced version for search input
const debouncedLoadTransactions = debounce(loadTransactions, CONFIG.DEBOUNCE_MS);

// Column list + joins shared by the normal transaction list and the
// duplicate-review view, so both render through displayTransactions().
const TRANSACTION_SELECT = `
    SELECT
        t.id, t.import_id, b.name as bank, a.account_name, t.date, t.description,
        t.amount, c.name as category_name, sc.name as subcategory_name, t.ignored, t.category_id, t.subcategory_id, t.note
`;
const TRANSACTION_FROM = `
    FROM transactions t
    JOIN imports i ON t.import_id = i.id
    JOIN accounts a ON i.account_id = a.id
    JOIN banks b ON a.bank_id = b.id
    LEFT JOIN categories c ON t.category_id = c.id
    LEFT JOIN subcategories sc ON t.subcategory_id = sc.id
`;

// Builds the WHERE clause (+ params) for the current filter bar. Returned
// separately from the SELECT so the duplicate view can reuse the exact same
// filtered set both for grouping and for fetching the rows in each group.
function buildTransactionFilter() {
    const bank = document.getElementById('filterBank').value;
    const account = document.getElementById('filterAccount').value;
    const categoryId = document.getElementById('filterCategory').value;
    const subcategoryId = document.getElementById('filterSubcategory').value;
    const dateFrom = document.getElementById('filterDateFrom').value;
    const dateTo = document.getElementById('filterDateTo').value;
    const search = document.getElementById('filterSearch').value;
    const showIgnored = document.getElementById('filterShowIgnored')?.value || 'active';

    let where = ' WHERE 1=1';
    const params = [];

    // Filter by status
    if (showIgnored === 'active') {
        where += ' AND t.ignored = 0';
    } else if (showIgnored === 'ignored') {
        where += ' AND t.ignored = 1';
    }
    // 'all' — no filter

    if (bank) {
        where += ' AND b.name = ?';
        params.push(bank);
    }
    if (account) {
        where += ' AND a.id = ?';
        params.push(account);
    }
    if (categoryId) {
        where += ' AND t.category_id = ?';
        params.push(categoryId);
    }
    if (subcategoryId) {
        where += ' AND t.subcategory_id = ?';
        params.push(subcategoryId);
    }
    if (dateFrom) {
        where += ' AND t.date >= ?';
        params.push(dateFrom);
    }
    if (dateTo) {
        where += ' AND t.date <= ?';
        params.push(dateTo);
    }
    if (search) {
        where += ' AND (t.description LIKE ? OR t.note LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
    }

    return { where, params };
}

async function loadTransactions(page = 0) {
    currentPage = page;

    if (document.getElementById('filterDuplicatesOnly')?.checked) {
        return loadDuplicateTransactions(page);
    }

    const { where, params } = buildTransactionFilter();

    const totalCount = dbHelpers.queryValue(`SELECT COUNT(*) ${TRANSACTION_FROM}${where}`, params) || 0;

    const query = `${TRANSACTION_SELECT}${TRANSACTION_FROM}${where}
        ORDER BY t.date DESC, ABS(t.amount) DESC, t.description ASC
        LIMIT ${CONFIG.PAGE_SIZE} OFFSET ${page * CONFIG.PAGE_SIZE}`;

    const result = db.exec(query, params);
    displayTransactions(result, totalCount, page);
}

// ─────────────────────────────────────────────────────────────────────────
// §7.2.1. Duplicate review
// ─────────────────────────────────────────────────────────────────────────
//
// Advisory only — nothing is ever removed automatically (see the
// "No silent duplicate-transaction deduplication" note in CLAUDE.md). This
// view just re-uses the transaction table to surface every transaction that
// shares its (date, amount) with at least one other transaction in the
// current filter set, grouped so the user can eyeball each cluster and press
// Ignore on the rows they consider duplicates.
//
// Pagination here counts *groups*, not rows, so a cluster is never split
// across two pages.
async function loadDuplicateTransactions(page = 0) {
    const { where, params } = buildTransactionFilter();
    const groupSize = CONFIG.DUPLICATE_GROUP_PAGE_SIZE;

    const groupQuery = `SELECT t.date, t.amount ${TRANSACTION_FROM}${where}
        GROUP BY t.date, t.amount HAVING COUNT(*) > 1`;

    const totalGroups = dbHelpers.queryValue(`SELECT COUNT(*) FROM (${groupQuery})`, params) || 0;

    const options = {
        groupMode: true,
        pageSize: groupSize,
        unitLabel: 'duplicate group',
        emptyMessage: 'No transactions share the same date and amount in this view.'
    };

    if (totalGroups === 0) {
        displayTransactions([], 0, 0, options);
        return;
    }

    // Ignoring rows shrinks the group list, so the current page can fall off
    // the end — step back to the last page that still exists.
    const totalPages = Math.ceil(totalGroups / groupSize);
    if (page > totalPages - 1) {
        return loadDuplicateTransactions(totalPages - 1);
    }

    const groups = dbHelpers.queryAll(
        `${groupQuery} ORDER BY t.date DESC, t.amount ASC LIMIT ${groupSize} OFFSET ${page * groupSize}`,
        params
    );

    // Match on the (date, amount) pair rather than a concatenated key so the
    // comparison stays typed (amounts are integer cents).
    const groupWhere = groups.map(() => '(t.date = ? AND t.amount = ?)').join(' OR ');
    const groupParams = groups.reduce((acc, g) => acc.concat([g[0], g[1]]), []);

    const result = db.exec(
        `${TRANSACTION_SELECT}${TRANSACTION_FROM}${where} AND (${groupWhere})
         ORDER BY t.date DESC, t.amount ASC, t.id ASC`,
        params.concat(groupParams)
    );

    displayTransactions(result, totalGroups, page, options);
}

function refreshFilters() {
    updateBankFilter();
    updateAccountFilter();
    updateCategoryFilter();
}

function updateBankFilter() {
    const result = db.exec('SELECT name FROM banks ORDER BY name');
    const select = document.getElementById('filterBank');
    const currentValue = select.value;

    select.innerHTML = '<option value="">All Banks</option>';

    if (result.length > 0) {
        result[0].values.forEach(row => {
            const name = escapeHtml(row[0]);
            select.innerHTML += `<option value="${name}">${name}</option>`;
        });
    }

    select.value = currentValue;
}

function updateAccountFilter() {
    const bankName = document.getElementById('filterBank').value;
    const select = document.getElementById('filterAccount');
    const currentValue = select.value;

    select.innerHTML = '<option value="">All Accounts</option>';

    let result;
    if (bankName) {
        result = db.exec(`
            SELECT DISTINCT a.id, b.name, a.account_name, a.account_number
            FROM accounts a
            JOIN banks b ON a.bank_id = b.id
            WHERE b.name = ?
            ORDER BY a.account_name
        `, [bankName]);
    } else {
        result = db.exec(`
            SELECT DISTINCT a.id, b.name, a.account_name, a.account_number
            FROM accounts a
            JOIN banks b ON a.bank_id = b.id
            ORDER BY b.name, a.account_name
        `);
    }

    if (result.length > 0) {
        result[0].values.forEach(row => {
            const accountId = row[0];
            const bank = row[1];
            const accountName = row[2];
            const accountNumber = row[3];
            const displayName = bankName
                ? (accountNumber ? `${accountName} (...${accountNumber})` : accountName)
                : (accountNumber ? `${bank} - ${accountName} (...${accountNumber})` : `${bank} - ${accountName}`);
            select.innerHTML += `<option value="${accountId}">${escapeHtml(displayName)}</option>`;
        });
    }

    // Keep current selection only if it's still valid for the new bank
    const optionExists = Array.from(select.options).some(opt => opt.value === currentValue);
    select.value = optionExists ? currentValue : '';
}

function updateCategoryFilter() {
    const result = db.exec(`
        SELECT DISTINCT c.id, c.name
        FROM categories c
        JOIN transactions t ON t.category_id = c.id
        ORDER BY c.name
    `);
    const select = document.getElementById('filterCategory');
    const currentValue = select.value;

    select.innerHTML = '<option value="">All Categories</option>';

    if (result.length > 0) {
        result[0].values.forEach(row => {
            const categoryId = row[0];
            const categoryName = row[1];
            select.innerHTML += `<option value="${categoryId}">${escapeHtml(categoryName)}</option>`;
        });
    }

    select.value = currentValue;
}

function updateSubcategoryFilter() {
    const categoryId = document.getElementById('filterCategory').value;
    const select = document.getElementById('filterSubcategory');

    select.innerHTML = '<option value="">All Subcategories</option>';

    if (!categoryId) {
        select.disabled = true;
        return;
    }

    select.disabled = false;

    const result = db.exec(`
        SELECT DISTINCT sc.id, sc.name
        FROM subcategories sc
        WHERE sc.category_id = ?
        ORDER BY sc.sort_order, sc.name
    `, [categoryId]);

    if (result.length > 0) {
        result[0].values.forEach(row => {
            const subId = row[0];
            const subName = row[1];
            select.innerHTML += `<option value="${subId}">${escapeHtml(subName)}</option>`;
        });
    }
}

function displayTransactions(result, totalCount = 0, page = 0, options = {}) {
    const container = document.getElementById('transactionsContainer');
    const groupMode = !!options.groupMode;
    const pageSize = options.pageSize || CONFIG.PAGE_SIZE;
    const unitLabel = options.unitLabel || 'transaction';

    if (!result.length || !result[0].values.length) {
        container.innerHTML = `<div class="loading">${escapeHtml(options.emptyMessage || 'No transactions found')}</div>`;
        return;
    }

    const rows = result[0].values;
    const totalPages = Math.ceil(totalCount / pageSize);
    const frag = document.createDocumentFragment();

    // Duplicate review: group the rows by (date, amount) so each cluster is
    // rendered under one header. Counts are taken from the rows themselves —
    // the query already returns whole groups, never a partial one.
    const groupKey = row => `${row[4]}|${row[6]}`;
    const groupCounts = new Map();
    if (groupMode) {
        rows.forEach(row => {
            const key = groupKey(row);
            groupCounts.set(key, (groupCounts.get(key) || 0) + 1);
        });

        const hint = document.createElement('div');
        hint.style.cssText = 'margin-bottom:15px; padding:10px 15px; background:#fff8e6; border:1px solid #f0d99b; border-radius:4px; font-size:13px; color:#6b5a2a;';
        hint.innerHTML = `<strong>Duplicate review.</strong> Every transaction below shares its date and amount with at least one other
            transaction in the current filters. Nothing is removed automatically — press <em>Ignore</em> on the rows you consider duplicates
            (or tick them and use <em>Ignore Selected</em>). With the status filter on <em>Active only</em>, a group disappears once enough
            rows are ignored for it to no longer look duplicated.`;
        frag.appendChild(hint);
    }

    // Pagination bar (rendered both above and below the table)
    const makePaginationBar = (position) => {
        const start = page * pageSize + 1;
        const end = Math.min((page + 1) * pageSize, totalCount);
        const bar = document.createElement('div');
        const marginRule = position === 'top' ? 'margin-bottom:15px;' : 'margin-top:15px;';
        bar.style.cssText = `display:flex; justify-content:space-between; align-items:center; ${marginRule} padding:10px; background:#f8f9fa; border-radius:4px;`;
        bar.innerHTML = `<div>Showing ${start}-${end} of ${totalCount} ${unitLabel}${totalCount === 1 ? '' : 's'}</div>
            <div style="display:flex; gap:10px;">
                <button data-prev ${page === 0 ? 'disabled' : ''} style="padding:5px 15px;">← Previous</button>
                <span style="padding:5px 15px;">Page ${page + 1} of ${totalPages}</span>
                <button data-next ${page >= totalPages - 1 ? 'disabled' : ''} style="padding:5px 15px;">Next →</button>
            </div>`;
        bar.querySelector('[data-prev]').addEventListener('click', () => loadTransactions(page - 1));
        bar.querySelector('[data-next]').addEventListener('click', () => loadTransactions(page + 1));
        return bar;
    };
    if (totalCount > pageSize) {
        frag.appendChild(makePaginationBar('top'));
    }

    // Bulk action bar — shown when any rows are selected
    const bulkBar = document.createElement('div');
    bulkBar.id = 'transactionBulkBar';
    bulkBar.style.cssText = 'display:none; justify-content:space-between; align-items:center; margin-bottom:10px; padding:10px 15px; background:#e8f4fd; border:1px solid #b3d9f2; border-radius:4px;';
    bulkBar.innerHTML = `
        <div><strong id="bulkSelectionCount">0</strong> selected</div>
        <div style="display:flex; gap:10px; flex-wrap:wrap;">
            <button id="bulkSetCategoryBtn">Set Category…</button>
            <button id="bulkIgnoreBtn">Ignore Selected</button>
            <button class="secondary-btn" id="bulkUnignoreBtn">Unignore Selected</button>
            <button class="secondary-btn" id="bulkClearSelectionBtn">Clear Selection</button>
        </div>
    `;
    frag.appendChild(bulkBar);

    const pageIds = rows.map(r => r[0]);
    // key → the <tr> elements of that duplicate group, wired up after the loop
    const groupTrs = new Map();

    const table = document.createElement('table');
    table.innerHTML = `<thead><tr>
        <th style="width:32px;"><input type="checkbox" id="bulkSelectAll" title="Select all on this page"></th>
        ${['Account','Date','Description','Amount','Category','Actions'].map(c => `<th>${c}</th>`).join('')}
    </tr></thead>`;
    const tbody = document.createElement('tbody');

    let lastGroupKey = null;
    rows.forEach(row => {
        const id            = row[0];
        const bank          = row[2];
        const account       = row[3];
        const date          = row[4];
        const description   = row[5];
        const amount        = row[6];
        const categoryName  = row[7] || '-';
        const subcatName    = row[8] || '-';
        const ignored       = row[9];
        const categoryId    = row[10] ?? null;
        const subcategoryId = row[11] ?? null;
        const note          = row[12] || '';

        const amountClass = amount >= 0 ? 'transaction-positive' : 'transaction-negative';
        const amountStr   = fmtMoneySigned(amount);

        // Combine bank + account
        const accountDisplay = `${escapeHtml(bank)} • ${escapeHtml(account)}`;

        // Combine category + subcategory
        const categoryDisplay = categoryName === '-'
            ? '<span style="color:#6c7a89;">Uncategorized</span>'
            : (subcatName && subcatName !== '-'
                ? `${escapeHtml(categoryName)} › ${escapeHtml(subcatName)}`
                : escapeHtml(categoryName));

        // Duplicate review: emit a header row whenever a new (date, amount)
        // cluster starts.
        if (groupMode) {
            const key = groupKey(row);
            if (key !== lastGroupKey) {
                lastGroupKey = key;
                groupTrs.set(key, []);
                const count = groupCounts.get(key) || 0;
                const headerTr = document.createElement('tr');
                headerTr.dataset.groupKey = key;
                headerTr.innerHTML = `
                    <td colspan="7" style="background:#eef3f7; border-top:2px solid #c8d6e0; padding:8px 10px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
                            <div><strong>${date}</strong> • <span class="${amountClass}">${amountStr}</span>
                                <span style="color:#6c7a89;"> — ${count} transactions with the same date &amp; amount</span></div>
                            <button data-select-extras style="padding:4px 10px; font-size:12px;">Select all but first</button>
                        </div>
                    </td>`;
                tbody.appendChild(headerTr);
            }
            groupTrs.get(key).push(id);
        }

        const isSelected = selectedTransactionIds.has(id);
        const tr = document.createElement('tr');
        tr.dataset.txId = id;
        tr.dataset.categoryId = categoryId ?? '';
        tr.dataset.subcategoryId = subcategoryId ?? '';
        // Description and note are kept on the row too: the patch helpers below
        // rewrite them in place without a re-render, so the click handlers must
        // read the live value rather than close over the one rendered here.
        tr.dataset.description = description;
        tr.dataset.note = note;
        tr.dataset.ignored = ignored ? '1' : '0';
        if (ignored) tr.style.opacity = '0.5';
        if (isSelected) tr.style.background = '#fff8d6';

        tr.innerHTML = `
            <td><input type="checkbox" data-select-row ${isSelected ? 'checked' : ''}></td>
            <td>${accountDisplay}</td>
            <td>${date}</td>
            <td data-desc style="cursor:pointer;" title="${escapeHtml(transactionDescTooltip(description, note))}">${transactionDescCellHtml(description, note)}</td>
            <td class="${amountClass}">${amountStr}</td>
            <td data-cat style="cursor:pointer;text-decoration:underline;" title="Click to edit">${categoryDisplay}</td>
            <td><button data-toggle style="padding:5px 10px;font-size:12px;">${ignored ? 'Unignore' : 'Ignore'}</button></td>
        `;
        tr.querySelector('[data-cat]').addEventListener('click', () => {
            const liveCategoryId = tr.dataset.categoryId ? Number(tr.dataset.categoryId) : null;
            const liveSubcategoryId = tr.dataset.subcategoryId ? Number(tr.dataset.subcategoryId) : null;
            showEditCategory(id, liveCategoryId, liveSubcategoryId);
        });
        tr.querySelector('[data-desc]').addEventListener('click', () => showEditNote(id, tr.dataset.description, tr.dataset.note));
        tr.querySelector('[data-toggle]').addEventListener('click', () => toggleIgnore(id, tr.dataset.ignored === '1' ? 0 : 1));
        tr.querySelector('[data-select-row]').addEventListener('change', e => {
            if (e.target.checked) selectedTransactionIds.add(id);
            else selectedTransactionIds.delete(id);
            tr.style.background = e.target.checked ? '#fff8d6' : '';
            updateBulkBar(pageIds);
        });
        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    frag.appendChild(table);

    if (totalCount > CONFIG.PAGE_SIZE) {
        frag.appendChild(makePaginationBar('bottom'));
    }

    container.innerHTML = '';
    container.appendChild(frag);

    // Reflects a selection change on an already-rendered row without re-querying
    const paintRowSelection = (id, selected) => {
        const tr = tbody.querySelector(`tr[data-tx-id="${id}"]`);
        if (!tr) return;
        const cb = tr.querySelector('[data-select-row]');
        if (cb) cb.checked = selected;
        tr.style.background = selected ? '#fff8d6' : '';
    };

    // Wire up header select-all + bulk action buttons
    const selectAll = document.getElementById('bulkSelectAll');
    selectAll.addEventListener('change', e => {
        const checked = e.target.checked;
        pageIds.forEach(id => {
            if (checked) selectedTransactionIds.add(id);
            else selectedTransactionIds.delete(id);
            paintRowSelection(id, checked);
        });
        updateBulkBar(pageIds);
    });
    document.getElementById('bulkSetCategoryBtn').addEventListener('click', showBulkEditCategory);
    document.getElementById('bulkIgnoreBtn').addEventListener('click', () => setIgnoredForSelection(1));
    document.getElementById('bulkUnignoreBtn').addEventListener('click', () => setIgnoredForSelection(0));
    document.getElementById('bulkClearSelectionBtn').addEventListener('click', clearTransactionSelection);

    // Duplicate review: "Select all but first" ticks every row of the group
    // except the earliest one, so the originals stay untouched.
    tbody.querySelectorAll('[data-select-extras]').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.closest('tr').dataset.groupKey;
            (groupTrs.get(key) || []).slice(1).forEach(id => {
                selectedTransactionIds.add(id);
                paintRowSelection(id, true);
            });
            updateBulkBar(pageIds);
        });
    });

    updateBulkBar(pageIds);
}

// Description column: show the note as primary when present, original as
// subtitle. Shared by the row render above and patchTransactionRowNote below
// so an edited row is byte-for-byte what a re-render would have produced.
function transactionDescCellHtml(description, note) {
    return note
        ? `<div style="font-weight:500;">${escapeHtml(note)} <span style="color:#3498db;font-size:11px;">✎</span></div>
               <div style="color:#95a5a6;font-size:11px;margin-top:2px;">${escapeHtml(description)}</div>`
        : `<span>${escapeHtml(description)}</span>`;
}

function transactionDescTooltip(description, note) {
    return note
        ? `Remark: ${note}\nOriginal: ${description}\n\nClick to edit remark`
        : `${description}\n\nClick to add a personal remark`;
}

// Optimistically reflect a category edit in the already-rendered row so the
// UI updates instantly, ahead of the full loadTransactions() re-query that
// still follows in the background. Returns false if the row isn't on the
// current page (e.g. a different page or filter), a no-op in that case.
function patchTransactionRowCategory(transactionId, categoryId, subcategoryId, categoryName, subcategoryName) {
    const tr = document.querySelector(`#transactionsContainer tr[data-tx-id="${transactionId}"]`);
    if (!tr) return false;

    const cell = tr.querySelector('[data-cat]');
    if (!cell) return false;

    cell.innerHTML = !categoryId
        ? '<span style="color:#6c7a89;">Uncategorized</span>'
        : (subcategoryId && subcategoryName
            ? `${escapeHtml(categoryName)} › ${escapeHtml(subcategoryName)}`
            : escapeHtml(categoryName));

    tr.dataset.categoryId = categoryId ?? '';
    tr.dataset.subcategoryId = subcategoryId ?? '';
    return true;
}

// Same idea for a personal remark: rewrite the description cell in place.
function patchTransactionRowNote(transactionId, note) {
    const tr = document.querySelector(`#transactionsContainer tr[data-tx-id="${transactionId}"]`);
    if (!tr) return false;

    const cell = tr.querySelector('[data-desc]');
    if (!cell) return false;

    const description = tr.dataset.description;
    cell.innerHTML = transactionDescCellHtml(description, note);
    cell.title = transactionDescTooltip(description, note);
    tr.dataset.note = note || '';
    return true;
}

// …and for the ignore toggle: dim the row and flip the button label.
function patchTransactionRowIgnored(transactionId, ignored) {
    const tr = document.querySelector(`#transactionsContainer tr[data-tx-id="${transactionId}"]`);
    if (!tr) return false;

    const btn = tr.querySelector('[data-toggle]');
    if (!btn) return false;

    btn.textContent = ignored ? 'Unignore' : 'Ignore';
    tr.style.opacity = ignored ? '0.5' : '';
    tr.dataset.ignored = ignored ? '1' : '0';
    return true;
}

function updateBulkBar(pageIds) {
    const bar = document.getElementById('transactionBulkBar');
    const countEl = document.getElementById('bulkSelectionCount');
    const selectAll = document.getElementById('bulkSelectAll');
    if (!bar) return;
    const count = selectedTransactionIds.size;
    bar.style.display = count > 0 ? 'flex' : 'none';
    if (countEl) countEl.textContent = count;
    if (selectAll && pageIds && pageIds.length) {
        const allOnPageSelected = pageIds.every(id => selectedTransactionIds.has(id));
        const someOnPageSelected = pageIds.some(id => selectedTransactionIds.has(id));
        selectAll.checked = allOnPageSelected;
        selectAll.indeterminate = !allOnPageSelected && someOnPageSelected;
    }
}

function clearTransactionSelection() {
    selectedTransactionIds.clear();
    loadTransactions(currentPage);
}

// Bulk counterpart of toggleIgnore — the lever for the duplicate review, where
// a whole cluster is judged at once. Reversible: re-select and Unignore.
async function setIgnoredForSelection(ignoredValue) {
    const ids = Array.from(selectedTransactionIds);
    if (ids.length === 0) return;

    const placeholders = ids.map(() => '?').join(',');
    const { success } = dbHelpers.safeRun(
        `UPDATE transactions SET ignored = ? WHERE id IN (${placeholders})`,
        [ignoredValue, ...ids],
        'Bulk ignore update'
    );
    if (!success) return;

    selectedTransactionIds.clear();
    markDirty();
    await loadTransactions(currentPage);
    refreshFilters();
    await updateAnalytics();
    showMessage('success', `${ids.length} transaction${ids.length === 1 ? '' : 's'} ${ignoredValue ? 'ignored' : 'unignored'}`);
}

// ─────────────────────────────────────────────────────────────────────────
// §7.3. Personal Remarks (Notes)
// ─────────────────────────────────────────────────────────────────────────

function showEditNote(transactionId, originalDescription, currentNote) {
    closeEditNoteModal();
    const modalHtml = `
        <div id="editNoteModal" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000;">
            <div style="background:white;padding:30px;border-radius:8px;max-width:480px;width:90%;">
                <h3 style="margin-top:0;">Personal Remark</h3>
                <div style="background:#f8f9fa;border-left:3px solid #bdc3c7;padding:8px 12px;margin-bottom:15px;font-size:13px;color:#555;">
                    <div style="color:#95a5a6;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;">Original description</div>
                    ${escapeHtml(originalDescription)}
                </div>
                <div class="form-group">
                    <label for="editNoteInput">Your remark (shown instead of the original)</label>
                    <textarea id="editNoteInput" rows="3" style="width:100%;padding:8px;font-family:inherit;font-size:14px;" placeholder="e.g. Birthday gift for mom">${escapeHtml(currentNote || '')}</textarea>
                </div>
                <div style="display:flex;gap:10px;margin-top:20px;flex-wrap:wrap;">
                    <button id="saveNoteBtn">Save</button>
                    ${currentNote ? '<button class="secondary-btn" id="clearNoteBtn">Clear Remark</button>' : ''}
                    <button class="secondary-btn" id="cancelNoteBtn">Cancel</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    const input = document.getElementById('editNoteInput');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    document.getElementById('saveNoteBtn').addEventListener('click', () => saveTransactionNote(transactionId));
    document.getElementById('cancelNoteBtn').addEventListener('click', closeEditNoteModal);
    const clearBtn = document.getElementById('clearNoteBtn');
    if (clearBtn) clearBtn.addEventListener('click', () => saveTransactionNote(transactionId, true));

    // Close on overlay click; Cmd/Ctrl+Enter to save; Esc to cancel
    document.getElementById('editNoteModal').addEventListener('click', e => {
        if (e.target.id === 'editNoteModal') closeEditNoteModal();
    });
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            saveTransactionNote(transactionId);
        } else if (e.key === 'Escape') {
            closeEditNoteModal();
        }
    });
}

function closeEditNoteModal() {
    const modal = document.getElementById('editNoteModal');
    if (modal) modal.remove();
}

function saveTransactionNote(transactionId, clear = false) {
    let note = null;
    if (!clear) {
        const raw = document.getElementById('editNoteInput').value.trim();
        note = raw === '' ? null : raw;
    }
    db.run('UPDATE transactions SET note = ? WHERE id = ?', [note, transactionId]);
    markDirty();

    // Close and repaint the row now; reconcile after the browser has painted.
    closeEditNoteModal();
    const patched = patchTransactionRowNote(transactionId, note);
    showMessage('success', clear || note === null ? 'Remark cleared' : 'Remark saved');

    // The search filter matches on description OR note, so an edited note can
    // change which rows match and how many there are. Nothing else in the
    // transactions query reads the note, so without a search the patched row is
    // already the final state.
    const searchActive = !!document.getElementById('filterSearch').value;

    afterNextPaint(async () => {
        try {
            if (!patched || searchActive) await loadTransactions(currentPage);
        } catch (e) {
            console.error('Background refresh after remark edit failed:', e);
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════
