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

async function loadTransactions(page = 0) {
    currentPage = page;
    const bank = document.getElementById('filterBank').value;
    const account = document.getElementById('filterAccount').value;
    const categoryId = document.getElementById('filterCategory').value;
    const subcategoryId = document.getElementById('filterSubcategory').value;
    const dateFrom = document.getElementById('filterDateFrom').value;
    const dateTo = document.getElementById('filterDateTo').value;
    const search = document.getElementById('filterSearch').value;
    const showIgnored = document.getElementById('filterShowIgnored')?.value || 'active';

    let query = `
        SELECT
            t.id, t.import_id, b.name as bank, a.account_name, t.date, t.description,
            t.amount, c.name as category_name, sc.name as subcategory_name, t.ignored, t.category_id, t.subcategory_id, t.note
        FROM transactions t
        JOIN imports i ON t.import_id = i.id
        JOIN accounts a ON i.account_id = a.id
        JOIN banks b ON a.bank_id = b.id
        LEFT JOIN categories c ON t.category_id = c.id
        LEFT JOIN subcategories sc ON t.subcategory_id = sc.id
        WHERE 1=1
    `;
    const params = [];

    // Filter by status
    if (showIgnored === 'active') {
        query += ' AND t.ignored = 0';
    } else if (showIgnored === 'ignored') {
        query += ' AND t.ignored = 1';
    }
    // 'all' — no filter

    if (bank) {
        query += ' AND b.name = ?';
        params.push(bank);
    }
    if (account) {
        query += ' AND a.id = ?';
        params.push(account);
    }
    if (categoryId) {
        query += ' AND t.category_id = ?';
        params.push(categoryId);
    }
    if (subcategoryId) {
        query += ' AND t.subcategory_id = ?';
        params.push(subcategoryId);
    }
    if (dateFrom) {
        query += ' AND t.date >= ?';
        params.push(dateFrom);
    }
    if (dateTo) {
        query += ' AND t.date <= ?';
        params.push(dateTo);
    }
    if (search) {
        query += ' AND (t.description LIKE ? OR t.note LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
    }

    // Get total count
    const countQuery = query.replace(/SELECT[\s\S]*?FROM/, 'SELECT COUNT(*) FROM');
    const totalCount = dbHelpers.queryValue(countQuery, params) || 0;

    query += ` ORDER BY t.date DESC, ABS(t.amount) DESC, t.description ASC LIMIT ${CONFIG.PAGE_SIZE} OFFSET ${page * CONFIG.PAGE_SIZE}`;

    const result = db.exec(query, params);
    displayTransactions(result, totalCount, page);
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

function displayTransactions(result, totalCount = 0, page = 0) {
    const container = document.getElementById('transactionsContainer');

    if (!result.length || !result[0].values.length) {
        container.innerHTML = '<div class="loading">No transactions found</div>';
        return;
    }

    const rows = result[0].values;
    const totalPages = Math.ceil(totalCount / CONFIG.PAGE_SIZE);
    const frag = document.createDocumentFragment();

    // Pagination bar (rendered both above and below the table)
    const makePaginationBar = (position) => {
        const start = page * CONFIG.PAGE_SIZE + 1;
        const end = Math.min((page + 1) * CONFIG.PAGE_SIZE, totalCount);
        const bar = document.createElement('div');
        const marginRule = position === 'top' ? 'margin-bottom:15px;' : 'margin-top:15px;';
        bar.style.cssText = `display:flex; justify-content:space-between; align-items:center; ${marginRule} padding:10px; background:#f8f9fa; border-radius:4px;`;
        bar.innerHTML = `<div>Showing ${start}-${end} of ${totalCount} transactions</div>
            <div style="display:flex; gap:10px;">
                <button data-prev ${page === 0 ? 'disabled' : ''} style="padding:5px 15px;">← Previous</button>
                <span style="padding:5px 15px;">Page ${page + 1} of ${totalPages}</span>
                <button data-next ${page >= totalPages - 1 ? 'disabled' : ''} style="padding:5px 15px;">Next →</button>
            </div>`;
        bar.querySelector('[data-prev]').addEventListener('click', () => loadTransactions(page - 1));
        bar.querySelector('[data-next]').addEventListener('click', () => loadTransactions(page + 1));
        return bar;
    };
    if (totalCount > CONFIG.PAGE_SIZE) {
        frag.appendChild(makePaginationBar('top'));
    }

    // Bulk action bar — shown when any rows are selected
    const bulkBar = document.createElement('div');
    bulkBar.id = 'transactionBulkBar';
    bulkBar.style.cssText = 'display:none; justify-content:space-between; align-items:center; margin-bottom:10px; padding:10px 15px; background:#e8f4fd; border:1px solid #b3d9f2; border-radius:4px;';
    bulkBar.innerHTML = `
        <div><strong id="bulkSelectionCount">0</strong> selected</div>
        <div style="display:flex; gap:10px;">
            <button id="bulkSetCategoryBtn">Set Category…</button>
            <button class="secondary-btn" id="bulkClearSelectionBtn">Clear Selection</button>
        </div>
    `;
    frag.appendChild(bulkBar);

    const pageIds = rows.map(r => r[0]);

    const table = document.createElement('table');
    table.innerHTML = `<thead><tr>
        <th style="width:32px;"><input type="checkbox" id="bulkSelectAll" title="Select all on this page"></th>
        ${['Account','Date','Description','Amount','Category','Actions'].map(c => `<th>${c}</th>`).join('')}
    </tr></thead>`;
    const tbody = document.createElement('tbody');

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

        const isSelected = selectedTransactionIds.has(id);
        const tr = document.createElement('tr');
        if (ignored) tr.style.opacity = '0.5';
        if (isSelected) tr.style.background = '#fff8d6';

        // Description column: show note as primary when present, original as subtitle
        const descTooltip = note
            ? `Remark: ${note}\nOriginal: ${description}\n\nClick to edit remark`
            : `${description}\n\nClick to add a personal remark`;
        const descCell = note
            ? `<div style="font-weight:500;">${escapeHtml(note)} <span style="color:#3498db;font-size:11px;">✎</span></div>
               <div style="color:#95a5a6;font-size:11px;margin-top:2px;">${escapeHtml(description)}</div>`
            : `<span>${escapeHtml(description)}</span>`;

        tr.innerHTML = `
            <td><input type="checkbox" data-select-row ${isSelected ? 'checked' : ''}></td>
            <td>${accountDisplay}</td>
            <td>${date}</td>
            <td data-desc style="cursor:pointer;" title="${escapeHtml(descTooltip)}">${descCell}</td>
            <td class="${amountClass}">${amountStr}</td>
            <td data-cat style="cursor:pointer;text-decoration:underline;" title="Click to edit">${categoryDisplay}</td>
            <td><button data-toggle style="padding:5px 10px;font-size:12px;">${ignored ? 'Unignore' : 'Ignore'}</button></td>
        `;
        tr.querySelector('[data-cat]').addEventListener('click', () => showEditCategory(id, categoryId, subcategoryId));
        tr.querySelector('[data-desc]').addEventListener('click', () => showEditNote(id, description, note));
        tr.querySelector('[data-toggle]').addEventListener('click', () => toggleIgnore(id, ignored ? 0 : 1));
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

    // Wire up header select-all + bulk action buttons
    const selectAll = document.getElementById('bulkSelectAll');
    selectAll.addEventListener('change', e => {
        const checked = e.target.checked;
        pageIds.forEach(id => {
            if (checked) selectedTransactionIds.add(id);
            else selectedTransactionIds.delete(id);
        });
        // Re-render row visual state without re-querying the DB
        tbody.querySelectorAll('tr').forEach((tr, i) => {
            const cb = tr.querySelector('[data-select-row]');
            if (cb) cb.checked = checked;
            tr.style.background = checked ? '#fff8d6' : '';
        });
        updateBulkBar(pageIds);
    });
    document.getElementById('bulkSetCategoryBtn').addEventListener('click', showBulkEditCategory);
    document.getElementById('bulkClearSelectionBtn').addEventListener('click', clearTransactionSelection);

    updateBulkBar(pageIds);
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

async function saveTransactionNote(transactionId, clear = false) {
    let note = null;
    if (!clear) {
        const raw = document.getElementById('editNoteInput').value.trim();
        note = raw === '' ? null : raw;
    }
    db.run('UPDATE transactions SET note = ? WHERE id = ?', [note, transactionId]);
    markDirty();
    closeEditNoteModal();
    await loadTransactions(currentPage);
    showMessage('success', clear || note === null ? 'Remark cleared' : 'Remark saved');
}

// ═══════════════════════════════════════════════════════════════════════════
