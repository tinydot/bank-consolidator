// §4. IMPORT SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────
// §4.0. Minimal CSV Parser (RFC 4180 subset — replaces PapaParse)
// ─────────────────────────────────────────────────────────────────────────

// Parses `text` into rows, honoring quoted fields (with embedded commas,
// newlines, and "" escaped quotes) and both CRLF/LF line endings.
// With `header: true`, each row becomes an object keyed by the first row's
// values (matching the shape bank-profile lookups expect); otherwise rows
// stay as arrays. `skipEmptyLines` drops blank lines (no header, one empty
// field), mirroring the two PapaParse options this app actually used.
// `skipRows` drops the first N parsed rows (bank-statement preamble) before
// anything else — parsing first (rather than splitting the raw text on \n)
// keeps a quoted embedded newline in the preamble from shifting the slice.
function parseCSV(text, { header = true, skipEmptyLines = true, skipRows = 0 } = {}) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip UTF-8 BOM

    let rows = [];
    let row = [], field = '', inQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else {
                field += ch;
            }
            continue;
        }
        if (ch === '"') { inQuotes = true; }
        else if (ch === ',') { row.push(field); field = ''; }
        else if (ch === '\r') { /* skip; \n below closes the row */ }
        else if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
        else { field += ch; }
    }
    if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }

    if (skipRows > 0) rows = rows.slice(skipRows);

    const dataRows = skipEmptyLines
        ? rows.filter(r => !(r.length === 1 && r[0] === ''))
        : rows;

    if (!header) return { data: dataRows };
    if (dataRows.length === 0) return { data: [] };

    // Trim header names — "Date, Description" style headers (space after the
    // comma) are common and would otherwise break every column lookup.
    const headers = dataRows[0].map(h => h.trim());
    const data = dataRows.slice(1).map(r => {
        const obj = {};
        headers.forEach((h, idx) => { obj[h] = r[idx] !== undefined ? r[idx] : ''; });
        return obj;
    });
    return { data };
}

// ─────────────────────────────────────────────────────────────────────────
// §4.1. File Upload & Selection
// ─────────────────────────────────────────────────────────────────────────

function setupEventListeners() {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');

    // Drag and drop handlers
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('drag-over');
        if (e.dataTransfer && e.dataTransfer.files) {
            handleFiles(e.dataTransfer.files);
        }
    });

    // File input change handler
    fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
            handleFiles(e.target.files);
        }
    });

    // Database import handler
    const dbImportInput = document.getElementById('dbImportInput');
    if (dbImportInput) {
        dbImportInput.addEventListener('change', handleDatabaseImport);
    }

}

async function handleFiles(files) {
    uploadedFiles = Array.from(files).filter(f => f.name.toLowerCase().endsWith('.csv'));

    if (uploadedFiles.length === 0) {
        showMessage('error', 'Please select valid CSV files');
        return;
    }

    const oversized = uploadedFiles.filter(f => f.size > CONFIG.MAX_FILE_SIZE);
    if (oversized.length > 0) {
        showMessage('error', `File too large: ${escapeHtml(oversized[0].name)} (max ${CONFIG.MAX_FILE_SIZE / 1024 / 1024}MB)`);
        return;
    }

    document.getElementById('dropZone').style.display = 'none';

    populateBankProfileSelector();

    const detected = await autoDetectBankAccount(uploadedFiles[0]);
    if (!detected) {
        // Not fatal: fall back to manual selection instead of dead-ending.
        showMessage('error', `Could not auto-detect bank from "${uploadedFiles[0].name}" — check the bank/account selection, or set an account keyword in Settings → Banks & Accounts.`);
    }

    // Show the bank/account/date-format selectors so a wrong auto-detection
    // (or a failed one) can be corrected before importing.
    document.getElementById('bankProfileSelector').style.display = '';

    updateImportPreview(true);
}

function readFirstLine(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve((e.target.result || '').split('\n')[0]);
        reader.onerror = () => resolve('');
        reader.readAsText(file.slice(0, 2048));
    });
}

async function autoDetectBankAccount(file) {
    try {
        const firstLine = await readFirstLine(file);
        if (!firstLine) return false;

        const result = db.exec(`
            SELECT a.id, a.keyword, a.bank_id
            FROM accounts a
            WHERE a.keyword IS NOT NULL AND a.keyword != ''
        `);
        if (!result.length) return false;

        const lowerLine = firstLine.toLowerCase();
        for (const [accountId, keyword, bankId] of result[0].values) {
            if (lowerLine.includes(keyword.toLowerCase())) {
                const profileIdx = bankProfiles.findIndex(p => p.id === bankId);
                if (profileIdx === -1) continue;

                const bankSelect = document.getElementById('bankProfileSelect');
                bankSelect.value = profileIdx;
                updateAccountOptions();
                syncDateFormatDropdown();
                document.getElementById('accountSelect').value = accountId;
                return true;
            }
        }
        return false;
    } catch (e) {
        return false;
    }
}

function resetFileSelection() {
    uploadedFiles = [];
    previewTransactions = [];
    _showDuplicates = false;
    document.getElementById('fileInput').value = '';
    document.getElementById('dropZone').style.display = '';
    document.getElementById('bankProfileSelector').style.display = 'none';
    document.getElementById('importPreview').innerHTML = '';
}

function renderImportError(text) {
    document.getElementById('importPreview').innerHTML = `
        <div class="import-preview-box">
            <div class="import-preview-summary" style="color:#e74c3c;">${escapeHtml(text)}</div>
            <div class="import-preview-actions">
                <button class="secondary-btn" onclick="cancelUpload()">Cancel</button>
            </div>
        </div>
    `;
}

// ─────────────────────────────────────────────────────────────────────────
// §4.2. CSV Processing & Account Management
// ─────────────────────────────────────────────────────────────────────────

function populateBankProfileSelector() {
    const select = document.getElementById('bankProfileSelect');
    select.innerHTML = bankProfiles.map((profile, idx) =>
        `<option value="${idx}">${escapeHtml(profile.name)}</option>`
    ).join('');
    updateAccountOptions();
    syncDateFormatDropdown();
}

function syncDateFormatDropdown() {
    const profileIdx = document.getElementById('bankProfileSelect').value;
    const profile = bankProfiles[profileIdx];
    if (!profile) return;
    const dropdown = document.getElementById('importDateFormat');
    if (dropdown) dropdown.value = profile.dateFormat || 'auto';
}

async function updateImportPreview(syncFormat) {
    if (syncFormat) syncDateFormatDropdown();
    const container = document.getElementById('importPreview');
    if (!container || !uploadedFiles.length) return;

    // The onchange handlers can re-enter this async function while a previous
    // run is awaiting file.text(); the token lets the stale run bail out
    // instead of appending its rows to the newer run's previewTransactions.
    const token = ++_importPreviewToken;

    const profileIdx = document.getElementById('bankProfileSelect').value;
    const profile = bankProfiles[profileIdx];
    if (!profile) {
        renderImportError('No bank profile selected. Create one in Settings → Banks & Accounts.');
        return;
    }
    const dateFormat = document.getElementById('importDateFormat').value;
    const accountId = document.getElementById('accountSelect').value;
    const effectiveDateFormat = dateFormat || profile.dateFormat || 'auto';

    // Parse all rows from all uploaded files
    previewTransactions = [];
    _showDuplicates = false;

    const hasHeader = profile.hasHeader !== false;
    const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';
    // Column lookup for either mode: by (trimmed) header name, or by index.
    const cell = (row, colSpec) => hasHeader
        ? row[String(colSpec).trim()]
        : row[parseInt(colSpec, 10)];

    for (let fileIdx = 0; fileIdx < uploadedFiles.length; fileIdx++) {
        const file = uploadedFiles[fileIdx];
        const text = await file.text();
        if (token !== _importPreviewToken) return;

        const result = parseCSV(text, {
            header: hasHeader,
            skipEmptyLines: true,
            skipRows: profile.skipRows || 0
        });

        for (const row of result.data) {
            const rawDate = cell(row, profile.dateColumn) || '';
            const descSpec = String(profile.descriptionColumn);
            const description = descSpec.includes(',')
                ? descSpec.split(',').map(c => cell(row, c)).filter(Boolean).join(' ')
                : cell(row, descSpec) || '';

            // Amount: null + amountError=true means the cell(s) existed but
            // could not be parsed — surfaced in the preview instead of
            // silently importing $0.00.
            let amount = null;
            let amountError = false;
            if (profile.creditColumn && profile.debitColumn) {
                const creditRaw = cell(row, profile.creditColumn);
                const debitRaw = cell(row, profile.debitColumn);
                // Both blank (balance lines, section headers): not a transaction.
                if (isBlank(creditRaw) && isBlank(debitRaw)) continue;
                const credit = isBlank(creditRaw) ? 0 : parseAmount(creditRaw);
                const debit = isBlank(debitRaw) ? 0 : parseAmount(debitRaw);
                if (credit === null || debit === null) amountError = true;
                else amount = credit - debit;
            } else {
                const raw = cell(row, profile.amountColumn);
                if (isBlank(raw)) continue;
                amount = parseAmount(raw);
                if (amount === null) amountError = true;
            }

            if (!rawDate) continue;

            const parsedDate = normalizeDate(rawDate, effectiveDateFormat);

            // isDuplicate and checked are resolved in the dedup pass below
            previewTransactions.push({
                fileIdx,
                fileName: file.name,
                rawDate,
                parsedDate: parsedDate || '',
                description: description || '',
                amount,
                amountError,
                isDuplicate: false,
                checked: true
            });
        }
    }

    // ── Duplicate detection: exact (date, description, amount) matching ─────
    // One aggregate pre-fetch of everything stored for this account, then a
    // per-key counting pass: N identical rows in the file are only flagged
    // duplicate up to the count already in the DB. Rows the DB doesn't have —
    // including ones older than the latest stored date (backfilling old
    // statements) — are never flagged, and manual entries only match when
    // date, description, AND amount all coincide.
    if (accountId) {
        const dbCounts = new Map();
        dbHelpers.queryAll(`
            SELECT t.date, t.description, t.amount, COUNT(*)
            FROM transactions t
            JOIN imports i ON t.import_id = i.id
            WHERE i.account_id = ?
            GROUP BY t.date, t.description, t.amount
        `, [accountId]).forEach(([date, description, amount, n]) => {
            dbCounts.set(`${date}\x00${description}\x00${amount}`, n);
        });

        const importSeenCount = new Map(); // fingerprint → occurrences so far
        for (const tx of previewTransactions) {
            if (!tx.parsedDate || tx.amountError) continue;
            const key = `${tx.parsedDate}\x00${tx.description}\x00${tx.amount}`;
            const seenSoFar = (importSeenCount.get(key) || 0) + 1;
            importSeenCount.set(key, seenSoFar);
            tx.isDuplicate = seenSoFar <= (dbCounts.get(key) || 0);
        }
    }
    // ─────────────────────────────────────────────────────────────────────────

    renderPreviewTable();
}

function renderPreviewTable() {
    const container = document.getElementById('importPreview');
    const total = previewTransactions.length;
    const dateErrors = previewTransactions.filter(t => !t.parsedDate).length;
    const amountErrors = previewTransactions.filter(t => t.parsedDate && t.amountError).length;
    const duplicateCount = previewTransactions.filter(t => t.parsedDate && !t.amountError && t.isDuplicate).length;
    const newCount = total - dateErrors - amountErrors - duplicateCount;
    // What the Import button will actually insert: unparseable rows never
    // import; duplicates only when the user opts in via the checkbox.
    const importCount = _showDuplicates ? newCount + duplicateCount : newCount;

    previewTransactions.forEach(tx => {
        tx.checked = !!tx.parsedDate && !tx.amountError && (_showDuplicates || !tx.isDuplicate);
    });

    if (total === 0) {
        document.getElementById('dropZone').style.display = '';
        renderImportError('No rows found in the selected file(s).');
        return;
    }

    const profileIdx = document.getElementById('bankProfileSelect').value;
    const profile = bankProfiles[profileIdx];
    const accountSelect = document.getElementById('accountSelect');
    const accountName = accountSelect.options[accountSelect.selectedIndex]?.text || 'account';
    const target = `${profile ? profile.name : ''} — ${accountName}`.trim();

    if (importCount === 0) {
        document.getElementById('dropZone').style.display = '';
    }

    const dupNote = duplicateCount > 0 ? `
        <label class="skip-count" style="cursor:pointer;">
            <input type="checkbox" ${_showDuplicates ? 'checked' : ''} onchange="toggleImportDuplicates(this.checked)">
            ${duplicateCount} already imported — tick to import anyway
        </label>` : '';
    const dateErrNote = dateErrors > 0 ? `<span class="skip-count" style="color:#e74c3c;">${dateErrors} unparseable date${dateErrors !== 1 ? 's' : ''} (skipped)</span>` : '';
    const amountErrNote = amountErrors > 0 ? `<span class="skip-count" style="color:#e74c3c;">${amountErrors} unparseable amount${amountErrors !== 1 ? 's' : ''} (skipped)</span>` : '';

    container.innerHTML = `
        <div class="import-preview-box">
            <div class="import-preview-summary">
                <span class="new-count">${newCount}</span> new transaction${newCount !== 1 ? 's' : ''}
                <span style="color:#7f8c8d;">→ ${escapeHtml(target)}</span>
                ${dupNote}
                ${dateErrNote}
                ${amountErrNote}
            </div>
            <div class="import-preview-actions">
                <button onclick="processUploadedFiles()"${importCount === 0 ? ' disabled' : ''}>Import ${importCount > 0 ? importCount + ' ' : ''}Transaction${importCount !== 1 ? 's' : ''}</button>
                <button class="secondary-btn" onclick="cancelUpload()">Cancel</button>
            </div>
        </div>
    `;
}

function toggleImportDuplicates(checked) {
    _showDuplicates = checked;
    renderPreviewTable();
}

function updateAccountOptions() {
    const profileIdx = document.getElementById('bankProfileSelect').value;
    const profile = bankProfiles[profileIdx];
    const select = document.getElementById('accountSelect');

    // banks and bank_profiles are now merged — use profile.id directly
    const bankId = profile.id;
    if (!bankId) return;

    // Load accounts for this bank
    const accountsResult = db.exec(`
        SELECT id, account_name, account_number 
        FROM accounts 
        WHERE bank_id = ? 
        ORDER BY account_name
    `, [bankId]);

    select.innerHTML = '<option value="">Select account...</option>';

    if (accountsResult.length > 0) {
        accountsResult[0].values.forEach(row => {
            const accountId = row[0];
            const accountName = row[1];
            const accountNumber = row[2];
            const displayName = accountNumber ? `${accountName} (...${accountNumber})` : accountName;
            select.innerHTML += `<option value="${accountId}">${escapeHtml(displayName)}</option>`;
        });
        // Auto-select the first account
        select.value = accountsResult[0].values[0][0];
    }
}

async function processUploadedFiles() {
    const accountId = document.getElementById('accountSelect').value;

    if (!accountId) {
        showMessage('error', 'Please select an account');
        return;
    }

    const selected = previewTransactions.filter(t => t.checked && t.parsedDate && !t.amountError);

    if (selected.length === 0) {
        showMessage('error', 'No transactions selected. Check at least one row to import.');
        return;
    }

    showLoading(`Importing ${selected.length} transaction(s)...`);

    try {
        // Group by file so each file gets its own import record
        const byFile = new Map();
        for (const tx of selected) {
            if (!byFile.has(tx.fileIdx)) byFile.set(tx.fileIdx, []);
            byFile.get(tx.fileIdx).push(tx);
        }

        let totalImported = 0;
        let fileNum = 0;

        for (const [fileIdx, transactions] of byFile) {
            fileNum++;
            const fileName = uploadedFiles[fileIdx]?.name || `file-${fileIdx}`;
            showLoading(`Saving ${fileNum}/${byFile.size}: ${fileName}`);

            const importId = createImportRecord(fileName, accountId);

            for (const tx of transactions) {
                insertTransaction({
                    import_id: importId,
                    date: tx.parsedDate,
                    description: tx.description,
                    amount: tx.amount,
                    category: categorizeTransaction(tx.description)
                });
                totalImported++;
            }

            updateImportCount(importId, transactions.length);
        }

        showLoading('Saving to database...');
        markDirty();
        await loadTransactions();
        refreshFilters();
        await loadImportHistory();
        await updateAnalytics();

        hideLoading();
        showMessage('success', `Imported ${totalImported} transaction${totalImported !== 1 ? 's' : ''} from ${byFile.size} file${byFile.size !== 1 ? 's' : ''}`);

        cancelUpload();
    } catch (e) {
        hideLoading();
        showMessage('error', 'Error importing files: ' + e.message);
        console.error('Import error:', e);
    }
}

function createImportRecord(filename, accountId) {
    const now = new Date().toISOString();

    db.run(`
        INSERT INTO imports (filename, import_date, account_id, transaction_count)
        VALUES (?, ?, ?, 0)
    `, [filename, now, accountId]);

    const result = db.exec('SELECT last_insert_rowid()');
    return result[0].values[0][0];
}

function updateImportCount(importId, count) {
    db.run(`
        UPDATE imports SET transaction_count = ? WHERE id = ?
    `, [count, importId]);
}

async function toggleIgnore(transactionId, ignoredValue) {
    db.run('UPDATE transactions SET ignored = ? WHERE id = ?', [ignoredValue, transactionId]);
    markDirty();
    await loadTransactions(currentPage);
    refreshFilters();
    await updateAnalytics();
}

function showEditCategory(transactionId, currentCategoryId, currentSubcategoryId) {
    // Get transaction description for "Convert to Rule"
    const descResult = db.exec('SELECT description FROM transactions WHERE id = ?', [transactionId]);
    const description = descResult.length > 0 ? descResult[0].values[0][0] : '';

    // Get all categories
    const categoriesResult = db.exec('SELECT id, name FROM categories ORDER BY sort_order, name');
    let categoriesOptions = '<option value="">-- Select Category --</option>';
    if (categoriesResult.length > 0) {
        categoriesResult[0].values.forEach(row => {
            const id = row[0];
            const name = row[1];
            const selected = id === currentCategoryId ? 'selected' : '';
            categoriesOptions += `<option value="${id}" ${selected}>${escapeHtml(name)}</option>`;
        });
    }

    // Get subcategories for current category
    let subcategoriesOptions = '<option value="">-- None --</option>';
    if (currentCategoryId) {
        const subcategoriesResult = db.exec('SELECT id, name FROM subcategories WHERE category_id = ? ORDER BY sort_order, name', [currentCategoryId]);
        if (subcategoriesResult.length > 0) {
            subcategoriesResult[0].values.forEach(row => {
                const id = row[0];
                const name = row[1];
                const selected = id === currentSubcategoryId ? 'selected' : '';
                subcategoriesOptions += `<option value="${id}" ${selected}>${escapeHtml(name)}</option>`;
            });
        }
    }

    const modalHtml = `
        <div id="editCategoryModal" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000;">
            <div style="background: white; padding: 30px; border-radius: 8px; max-width: 400px; width: 90%;">
                <h3 style="margin-top: 0;">Edit Category</h3>
                <div class="form-group">
                    <label>Category</label>
                    <select id="editCategorySelect" onchange="updateEditSubcategoryOptions(${transactionId})">
                        ${categoriesOptions}
                    </select>
                </div>
                <div class="form-group">
                    <label>Subcategory</label>
                    <select id="editSubcategorySelect">
                        ${subcategoriesOptions}
                    </select>
                </div>
                <div style="display: flex; gap: 10px; margin-top: 20px; flex-wrap: wrap;">
                    <button onclick="saveTransactionCategory(${transactionId})">Save</button>
                    <button class="secondary-btn" id="convertToRuleBtn">⚡ Convert to Rule</button>
                    <button class="secondary-btn" onclick="closeEditCategoryModal()">Cancel</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    // Attach description via JS to avoid any HTML/quote escaping issues
    document.getElementById('convertToRuleBtn').addEventListener('click', () => {
        const categoryId = document.getElementById('editCategorySelect').value || null;
        const subcategoryId = document.getElementById('editSubcategorySelect').value || null;
        convertToRule(description, categoryId, subcategoryId);
    });
}

function updateEditSubcategoryOptions(transactionId) {
    const categoryId = document.getElementById('editCategorySelect').value;
    const select = document.getElementById('editSubcategorySelect');

    select.innerHTML = '<option value="">-- None --</option>';

    if (!categoryId) return;

    const result = db.exec('SELECT id, name FROM subcategories WHERE category_id = ? ORDER BY sort_order, name', [categoryId]);
    if (result.length > 0) {
        result[0].values.forEach(row => {
            const id = row[0];
            const name = row[1];
            select.innerHTML += `<option value="${id}">${escapeHtml(name)}</option>`;
        });
    }
}

function closeEditCategoryModal() {
    const modal = document.getElementById('editCategoryModal');
    if (modal) modal.remove();
}

function convertToRule(description, categoryId, subcategoryId) {
    closeEditCategoryModal();
    switchTab('settings');
    const rulesSection = document.getElementById('rulesSettingsSection');
    if (rulesSection) {
        rulesSection.classList.remove('collapsed');
        rulesSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    showAddRuleForm();
    document.getElementById('newRuleName').value = description;
    document.getElementById('newRuleKeyword').value = description;
    document.getElementById('newRuleAction').value = 'categorize';
    toggleCategoryField();
    if (categoryId) {
        const catSelect = document.getElementById('newRuleCategory');
        catSelect.value = String(categoryId);
        updateRuleSubcategoryOptions();
        if (subcategoryId) {
            document.getElementById('newRuleSubcategory').value = String(subcategoryId);
        }
    }
    document.getElementById('newRuleName').focus();
}

function saveTransactionCategory(transactionId) {
    const categorySelect = document.getElementById('editCategorySelect');
    const subcategorySelect = document.getElementById('editSubcategorySelect');
    const categoryId = categorySelect.value || null;
    const subcategoryId = subcategorySelect.value || null;
    const categoryName = categorySelect.selectedOptions[0]?.textContent || '';
    const subcategoryName = subcategorySelect.selectedOptions[0]?.textContent || '';

    db.run('UPDATE transactions SET category_id = ?, subcategory_id = ?, manual_category = 1 WHERE id = ?',
        [categoryId, subcategoryId, transactionId]);
    markDirty();

    // Give instant feedback — close the modal and patch the row in place —
    // before running the filter/analytics reconciliation below.
    closeEditCategoryModal();
    const patched = patchTransactionRowCategory(transactionId, categoryId, subcategoryId, categoryName, subcategoryName);
    showMessage('success', 'Category updated (manual override set)');

    // A re-query only changes what's on screen when a category/subcategory
    // filter is active (the edited row may no longer match). Without one the
    // patched row is already the final state — the row set, its order and the
    // total count are all unaffected by a category change.
    const categoryFilterActive = !!(document.getElementById('filterCategory').value ||
                                    document.getElementById('filterSubcategory').value);

    // Reconcile filters/analytics in the background so the click itself doesn't
    // wait on them. rAF-then-timeout, not a bare timeout: a 0 ms task can be
    // picked up before the browser paints, which would hide the modal close and
    // the row patch behind the very work they were meant to front-run.
    afterNextPaint(async () => {
        try {
            if (!patched || categoryFilterActive) await loadTransactions(currentPage);
            refreshFilters();
            await updateAnalyticsIfVisible();
        } catch (e) {
            console.error('Background refresh after category edit failed:', e);
        }
    });
}

function showBulkEditCategory() {
    if (selectedTransactionIds.size === 0) return;
    const count = selectedTransactionIds.size;

    const categoriesResult = db.exec('SELECT id, name FROM categories ORDER BY sort_order, name');
    let categoriesOptions = '<option value="">-- Uncategorized --</option>';
    if (categoriesResult.length > 0) {
        categoriesResult[0].values.forEach(row => {
            categoriesOptions += `<option value="${row[0]}">${escapeHtml(row[1])}</option>`;
        });
    }

    const modalHtml = `
        <div id="bulkEditCategoryModal" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000;">
            <div style="background: white; padding: 30px; border-radius: 8px; max-width: 420px; width: 90%;">
                <h3 style="margin-top: 0;">Set Category for ${count} Transaction${count === 1 ? '' : 's'}</h3>
                <p style="color:#666; font-size:14px; margin-top:0;">This will overwrite the category on all selected rows and mark them as manually categorized.</p>
                <div class="form-group">
                    <label>Category</label>
                    <select id="bulkEditCategorySelect" onchange="updateBulkEditSubcategoryOptions()">
                        ${categoriesOptions}
                    </select>
                </div>
                <div class="form-group">
                    <label>Subcategory</label>
                    <select id="bulkEditSubcategorySelect">
                        <option value="">-- None --</option>
                    </select>
                </div>
                <div style="display: flex; gap: 10px; margin-top: 20px;">
                    <button onclick="saveBulkTransactionCategory()">Apply to ${count} row${count === 1 ? '' : 's'}</button>
                    <button class="secondary-btn" onclick="closeBulkEditCategoryModal()">Cancel</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

function updateBulkEditSubcategoryOptions() {
    const categoryId = document.getElementById('bulkEditCategorySelect').value;
    const select = document.getElementById('bulkEditSubcategorySelect');
    select.innerHTML = '<option value="">-- None --</option>';
    if (!categoryId) return;
    const result = db.exec('SELECT id, name FROM subcategories WHERE category_id = ? ORDER BY sort_order, name', [categoryId]);
    if (result.length > 0) {
        result[0].values.forEach(row => {
            select.innerHTML += `<option value="${row[0]}">${escapeHtml(row[1])}</option>`;
        });
    }
}

function closeBulkEditCategoryModal() {
    const modal = document.getElementById('bulkEditCategoryModal');
    if (modal) modal.remove();
}

async function saveBulkTransactionCategory() {
    const categoryId = document.getElementById('bulkEditCategorySelect').value || null;
    const subcategoryId = document.getElementById('bulkEditSubcategorySelect').value || null;
    const ids = Array.from(selectedTransactionIds);
    if (ids.length === 0) {
        closeBulkEditCategoryModal();
        return;
    }

    const placeholders = ids.map(() => '?').join(',');
    try {
        db.run(
            `UPDATE transactions SET category_id = ?, subcategory_id = ?, manual_category = 1 WHERE id IN (${placeholders})`,
            [categoryId, subcategoryId, ...ids]
        );
    } catch (e) {
        console.error('Bulk category update failed:', e);
        showMessage('error', `Failed to update categories: ${e.message}`);
        return;
    }

    const count = ids.length;
    const categoryName = document.getElementById('bulkEditCategorySelect').selectedOptions[0]?.textContent || '';
    const subcategoryName = document.getElementById('bulkEditSubcategorySelect').selectedOptions[0]?.textContent || '';
    selectedTransactionIds.clear();
    markDirty();

    // Same instant-feedback shape as the single-row edit: close the modal and
    // patch the affected rows now, reconcile after the browser has painted.
    closeBulkEditCategoryModal();
    ids.forEach(id => patchTransactionRowCategory(id, categoryId, subcategoryId, categoryName, subcategoryName));
    showMessage('success', `Category updated for ${count} transaction${count === 1 ? '' : 's'} (manual override set)`);

    afterNextPaint(async () => {
        try {
            // The reload is unconditional here even when every row was patched:
            // clearing the selection has to redraw the row highlights and the
            // bulk bar, which the category patch alone does not touch.
            await loadTransactions(currentPage);
            refreshFilters();
            await updateAnalyticsIfVisible();
        } catch (e) {
            console.error('Background refresh after bulk category edit failed:', e);
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// §5. IMPORT HISTORY
// ═══════════════════════════════════════════════════════════════════════════

async function loadImportHistory() {
    const result = db.exec(`
        SELECT 
            i.id,
            i.filename,
            i.import_date,
            b.name as bank_name,
            a.account_name,
            i.transaction_count,
            COUNT(t.id) as total_in_db,
            COUNT(CASE WHEN t.ignored = 1 THEN 1 END) as ignored_count
        FROM imports i
        JOIN accounts a ON i.account_id = a.id
        JOIN banks b ON a.bank_id = b.id
        LEFT JOIN transactions t ON t.import_id = i.id
        GROUP BY i.id
        ORDER BY i.import_date DESC
    `);

    displayImportHistory(result);
}

function displayImportHistory(result) {
    const container = document.getElementById('importHistoryContainer');
    if (!container) return;

    if (!result.length || !result[0].values.length) {
        container.innerHTML = '<div class="loading">No import history</div>';
        return;
    }

    const table = document.createElement('table');
    table.innerHTML = `<thead><tr>${
        ['File', 'Imported On', 'Bank', 'Account', 'Transactions', 'Status', 'Actions']
            .map(c => `<th>${c}</th>`).join('')
    }</tr></thead>`;
    const tbody = document.createElement('tbody');

    result[0].values.forEach(row => {
        const id           = row[0];
        const rawFilename  = row[1];
        const importDate   = new Date(row[2]).toLocaleString();
        const bankName     = row[3];
        const accountName  = row[4];
        const txCount      = row[5];
        const totalInDb    = row[6];
        const ignoredCount = row[7];
        const activeCount  = totalInDb - ignoredCount;

        let statusBadge;
        if (totalInDb === 0) {
            statusBadge = '<span style="color:#e74c3c;">🗑️ Deleted</span>';
        } else if (ignoredCount === totalInDb) {
            statusBadge = '<span style="color:#e67e22;">⏸️ Ignored</span>';
        } else if (ignoredCount > 0) {
            statusBadge = `<span style="color:#f39c12;">⚠️ ${activeCount} active, ${ignoredCount} ignored</span>`;
        } else {
            statusBadge = `<span style="color:#27ae60;">✅ ${activeCount} active</span>`;
        }

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="font-family:monospace;font-size:13px;">${escapeHtml(rawFilename)}</td>
            <td>${importDate}</td>
            <td>${escapeHtml(bankName)}</td>
            <td>${escapeHtml(accountName)}</td>
            <td>${txCount}</td>
            <td>${statusBadge}</td>
            <td style="white-space:nowrap;" data-actions></td>
        `;

        const actionsCell = tr.querySelector('[data-actions]');
        if (totalInDb === 0) {
            const btn = document.createElement('button');
            btn.className = 'danger-btn';
            btn.style.cssText = 'padding:5px 10px;font-size:12px;';
            btn.textContent = 'Remove Record';
            btn.addEventListener('click', () => deleteImportRecord(id));
            actionsCell.appendChild(btn);
        } else if (ignoredCount === totalInDb) {
            const restore = document.createElement('button');
            restore.className = 'secondary-btn';
            restore.style.cssText = 'padding:5px 10px;font-size:12px;margin-right:5px;';
            restore.textContent = '↩ Restore';
            restore.addEventListener('click', () => reactivateImport(id));
            const del = document.createElement('button');
            del.className = 'danger-btn';
            del.style.cssText = 'padding:5px 10px;font-size:12px;';
            del.textContent = '🗑️ Delete';
            del.addEventListener('click', () => deleteImport(id, rawFilename));
            actionsCell.append(restore, del);
        } else {
            const ignore = document.createElement('button');
            ignore.style.cssText = 'padding:5px 10px;font-size:12px;margin-right:5px;';
            ignore.textContent = '⏸ Ignore All';
            ignore.addEventListener('click', () => undoImport(id));
            const del = document.createElement('button');
            del.className = 'danger-btn';
            del.style.cssText = 'padding:5px 10px;font-size:12px;';
            del.textContent = '🗑️ Delete';
            del.addEventListener('click', () => deleteImport(id, rawFilename));
            actionsCell.append(ignore, del);
        }

        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    container.innerHTML = '';
    container.appendChild(table);
}

async function undoImport(importId) {
    if (!confirm('Mark all transactions from this import as ignored?\n\nYou can restore them later.')) return;

    dbHelpers.safeRun('UPDATE transactions SET ignored = 1 WHERE import_id = ?', [importId], 'Ignore import');
    markDirty();
    await loadTransactions();
    await loadImportHistory();
    await updateAnalytics();
    showMessage('success', 'Import ignored — transactions hidden from view');
}

async function reactivateImport(importId) {
    if (!confirm('Restore all transactions from this import?')) return;

    dbHelpers.safeRun('UPDATE transactions SET ignored = 0 WHERE import_id = ?', [importId], 'Reactivate import');
    markDirty();
    await loadTransactions();
    await loadImportHistory();
    await updateAnalytics();
    showMessage('success', 'Import restored');
}

async function deleteImport(importId, filename) {
    if (!confirm(`Permanently delete all transactions from:\n"${filename}"\n\nThis cannot be undone.`)) return;

    showLoading('Deleting import...');
    dbHelpers.safeRun('DELETE FROM transactions WHERE import_id = ?', [importId], 'Delete import transactions');
    dbHelpers.safeRun('DELETE FROM imports WHERE id = ?', [importId], 'Delete import record');
    markDirty();
    await loadTransactions();
    await loadImportHistory();
    await updateAnalytics();
    hideLoading();
    showMessage('success', `Import "${filename}" permanently deleted`);
}

async function deleteImportRecord(importId) {
    if (!confirm('Remove this import record? (Transactions were already deleted)')) return;

    dbHelpers.safeRun('DELETE FROM imports WHERE id = ?', [importId], 'Delete import record');
    markDirty();
    await loadImportHistory();
    showMessage('success', 'Import record removed');
}

// ─────────────────────────────────────────────────────────────────────────
// §4.6. Manual Transaction Entry (for banks w/o CSV export)
// ─────────────────────────────────────────────────────────────────────────

function populateManualAccountSelect() {
    const select = document.getElementById('manualAccountSelect');
    if (!select) return;

    const dateInput = document.getElementById('manualDate');
    if (dateInput && !dateInput.value) {
        const d = new Date();
        dateInput.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    const result = db.exec(`
        SELECT a.id, a.account_name, a.account_number, b.name
        FROM accounts a
        JOIN banks b ON a.bank_id = b.id
        ORDER BY b.name, a.account_name
    `);

    const prev = select.value;
    select.innerHTML = '<option value="">Select account...</option>';

    if (!result.length) {
        select.innerHTML += '<option value="" disabled>(no accounts yet — create one by importing a CSV first)</option>';
        return;
    }

    result[0].values.forEach(([accountId, accountName, accountNumber, bankName]) => {
        const acctLabel = accountNumber ? `${accountName} (...${accountNumber})` : accountName;
        select.innerHTML += `<option value="${accountId}">${escapeHtml(bankName)} — ${escapeHtml(acctLabel)}</option>`;
    });

    if (prev) select.value = prev;
}

async function addManualTransaction() {
    const accountId = document.getElementById('manualAccountSelect').value;
    const date = document.getElementById('manualDate').value;
    const description = document.getElementById('manualDescription').value.trim();
    const type = document.getElementById('manualType').value;
    const rawAmount = document.getElementById('manualAmount').value;

    if (!accountId) {
        showMessage('error', 'Please select an account');
        return;
    }
    if (!date) {
        showMessage('error', 'Please enter a date');
        return;
    }
    if (!description) {
        showMessage('error', 'Please enter a description');
        return;
    }
    const cents = toCents(rawAmount);
    if (rawAmount === '' || cents <= 0) {
        showMessage('error', 'Please enter an amount greater than zero');
        return;
    }

    // Group all manual entries for an account under one import record so
    // they appear together in Import History (and can be deleted as a set).
    let importId = dbHelpers.queryValue(
        "SELECT id FROM imports WHERE filename = 'Manual entries' AND account_id = ?",
        [accountId]
    );
    if (!importId) {
        importId = createImportRecord('Manual entries', accountId);
    }

    insertTransaction({
        import_id: importId,
        date: date,
        description: description,
        amount: type === 'expense' ? -cents : cents
    });
    dbHelpers.safeRun(
        'UPDATE imports SET transaction_count = transaction_count + 1 WHERE id = ?',
        [importId], 'Update manual import count'
    );

    markDirty();
    document.getElementById('manualDescription').value = '';
    document.getElementById('manualAmount').value = '';

    await loadTransactions();
    refreshFilters();
    await loadImportHistory();
    await updateAnalytics();
    showMessage('success', `Added ${type === 'expense' ? '-' : '+'}$${fmtMoney(cents)} — ${description}`);
}

// ═══════════════════════════════════════════════════════════════════════════
