// §4. IMPORT SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

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

    // Submit manual transaction on Enter in description field
    document.getElementById('manualDescription').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addManualTransaction();
    });
}

async function handleFiles(files) {
    uploadedFiles = Array.from(files).filter(f => f.name.endsWith('.csv'));

    if (uploadedFiles.length === 0) {
        showMessage('error', 'Please select valid CSV files');
        return;
    }

    const oversized = uploadedFiles.filter(f => f.size > CONFIG.MAX_FILE_SIZE);
    if (oversized.length > 0) {
        showMessage('error', `File too large: ${escapeHtml(oversized[0].name)} (max ${CONFIG.MAX_FILE_SIZE / 1024 / 1024}MB)`);
        return;
    }

    // Hide drop zone and show file list
    document.getElementById('dropZone').style.display = 'none';

    // Display selected files
    const fileListHtml = `
        <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
            <h3 style="margin-bottom: 15px;">📄 Selected Files (${uploadedFiles.length})</h3>
            <ul style="list-style: none; padding: 0;">
                ${uploadedFiles.map(f => `
                    <li style="padding: 8px; background: white; margin-bottom: 8px; border-radius: 4px; display: flex; justify-content: space-between; align-items: center;">
                        <span style="font-family: monospace;">${escapeHtml(f.name)}</span>
                        <span style="color: #7f8c8d; font-size: 12px;">${(f.size / 1024).toFixed(1)} KB</span>
                    </li>
                `).join('')}
            </ul>
            <button onclick="resetFileSelection()" class="secondary-btn" style="margin-top: 10px;">
                ← Change Files
            </button>
        </div>
    `;

    document.getElementById('dropZone').insertAdjacentHTML('afterend', fileListHtml);

    // Show bank profile selector
    populateBankProfileSelector();
    document.getElementById('bankProfileSelector').style.display = 'block';

    // Auto-detect bank/account from first line of first file
    await autoDetectBankAccount(uploadedFiles[0]);

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
        if (!firstLine) return;

        const result = db.exec(`
            SELECT a.id, a.keyword, a.bank_id
            FROM accounts a
            WHERE a.keyword IS NOT NULL AND a.keyword != ''
        `);
        if (!result.length) return;

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
                showMessage('success', `Auto-detected: ${escapeHtml(bankProfiles[profileIdx].name)}`);
                return;
            }
        }
    } catch (e) {
        // Silent fail — user can select manually
    }
}

function resetFileSelection() {
    uploadedFiles = [];
    previewTransactions = [];
    _showDuplicates = false;
    document.getElementById('fileInput').value = '';
    document.getElementById('dropZone').style.display = 'block';

    // Remove file list
    const fileList = document.querySelector('#dropZone').nextElementSibling;
    if (fileList && fileList.querySelector('h3')?.textContent.includes('Selected Files')) {
        fileList.remove();
    }

    // Hide bank profile selector
    document.getElementById('bankProfileSelector').style.display = 'none';
    document.getElementById('addAccountForm').style.display = 'none';
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

    const profileIdx = document.getElementById('bankProfileSelect').value;
    const profile = bankProfiles[profileIdx];
    const dateFormat = document.getElementById('importDateFormat').value;
    const accountId = document.getElementById('accountSelect').value;
    const effectiveDateFormat = dateFormat || profile.dateFormat || 'auto';

    // Get latest stored transaction date for this account (for duplicate detection)
    let latestStoredDate = null;
    if (accountId) {
        latestStoredDate = dbHelpers.queryValue(`
            SELECT MAX(t.date) FROM transactions t
            JOIN imports i ON t.import_id = i.id
            WHERE i.account_id = ?
        `, [accountId]);
    }

    // Parse all rows from all uploaded files
    previewTransactions = [];
    _showDuplicates = false;
    let parseErrors = 0;

    for (let fileIdx = 0; fileIdx < uploadedFiles.length; fileIdx++) {
        const file = uploadedFiles[fileIdx];
        const text = await file.text();
        let processedText = text;
        if (profile.skipRows && profile.skipRows > 0) {
            const lines = text.split('\n');
            processedText = lines.slice(profile.skipRows).join('\n');
        }

        const result = Papa.parse(processedText, {
            header: profile.hasHeader !== false,
            skipEmptyLines: true
        });

        for (const row of result.data) {
            let rawDate, description, amount;

            if (profile.hasHeader !== false) {
                rawDate = row[profile.dateColumn] || '';
                description = profile.descriptionColumn.includes(',')
                    ? profile.descriptionColumn.split(',').map(c => row[c.trim()]).filter(Boolean).join(' ')
                    : row[profile.descriptionColumn] || '';
                if (profile.creditColumn && profile.debitColumn) {
                    amount = parseAmount(row[profile.creditColumn]) - parseAmount(row[profile.debitColumn]);
                } else {
                    const raw = row[profile.amountColumn];
                    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
                    amount = parseAmount(raw);
                }
            } else {
                rawDate = row[parseInt(profile.dateColumn)] || '';
                description = profile.descriptionColumn.includes(',')
                    ? profile.descriptionColumn.split(',').map(c => row[parseInt(c.trim())]).filter(Boolean).join(' ')
                    : row[parseInt(profile.descriptionColumn)] || '';
                if (profile.creditColumn && profile.debitColumn) {
                    amount = parseAmount(row[parseInt(profile.creditColumn)]) - parseAmount(row[parseInt(profile.debitColumn)]);
                } else {
                    const raw = row[parseInt(profile.amountColumn)];
                    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
                    amount = parseAmount(raw);
                }
            }

            if (!rawDate) continue;

            const parsedDate = normalizeDate(rawDate, effectiveDateFormat);
            if (!parsedDate) parseErrors++;

            // isDuplicate and checked are resolved in the multi-stage pass below
            previewTransactions.push({
                fileIdx,
                fileName: file.name,
                rawDate,
                parsedDate: parsedDate || '',
                description: description || '',
                amount,
                isDuplicate: false,
                checked: true
            });
        }
    }

    // ── Multi-stage duplicate detection ──────────────────────────────────────
    if (accountId && latestStoredDate) {
        // Stage 1: count how many transactions the DB already has on the boundary
        // date, and how many the import contains on that same date.
        const dbCountOnBoundary = dbHelpers.queryValue(`
            SELECT COUNT(*) FROM transactions t
            JOIN imports i ON t.import_id = i.id
            WHERE t.date = ? AND i.account_id = ?
        `, [latestStoredDate, accountId]) || 0;

        const importCountOnBoundary = previewTransactions
            .filter(t => t.parsedDate === latestStoredDate).length;

        // Stage 3 is only needed when the import has MORE transactions on the
        // boundary date than the DB — meaning at least one of them is genuinely new.
        const boundaryNeedsExactMatch = dbCountOnBoundary < importCountOnBoundary;

        // Caches for stage 3 so we don't re-query the same key twice.
        const dbCountCache   = new Map(); // fingerprint → db count
        const importSeenCount = new Map(); // fingerprint → how many times seen so far

        for (const tx of previewTransactions) {
            if (!tx.parsedDate) continue;

            if (tx.parsedDate < latestStoredDate) {
                // Stage 1 — strictly older than the latest stored date: always a duplicate.
                tx.isDuplicate = true;

            } else if (tx.parsedDate === latestStoredDate) {
                if (!boundaryNeedsExactMatch) {
                    // Stage 2 — DB already has at least as many transactions on this
                    // date as the import does, so every boundary row is already stored.
                    tx.isDuplicate = true;
                } else {
                    // Stage 3 — exact-match with per-key counting so that N identical
                    // transactions are only flagged duplicate up to the count already in DB.
                    const key = `${tx.parsedDate}\x00${tx.description}\x00${tx.amount}`;

                    if (!dbCountCache.has(key)) {
                        const n = dbHelpers.queryValue(`
                            SELECT COUNT(*) FROM transactions t
                            JOIN imports i ON t.import_id = i.id
                            WHERE t.date = ? AND t.description = ? AND t.amount = ?
                              AND i.account_id = ?
                        `, [tx.parsedDate, tx.description, tx.amount, accountId]) || 0;
                        dbCountCache.set(key, n);
                    }

                    const seenSoFar = (importSeenCount.get(key) || 0) + 1;
                    importSeenCount.set(key, seenSoFar);

                    // Duplicate only if the DB already contains this many occurrences.
                    tx.isDuplicate = seenSoFar <= dbCountCache.get(key);
                }

            } else {
                // date > latestStoredDate: definitely new.
                tx.isDuplicate = false;
            }

            tx.checked = !tx.isDuplicate;
        }
    }
    // ─────────────────────────────────────────────────────────────────────────

    renderPreviewTable(latestStoredDate, parseErrors);
}

function renderPreviewTable(latestStoredDate, parseErrors) {
    const container = document.getElementById('importPreview');
    const total = previewTransactions.length;
    const duplicateCount = previewTransactions.filter(t => t.isDuplicate).length;
    const newCount = total - duplicateCount;

    if (total === 0) {
        container.innerHTML = '<p style="color:#7f8c8d;">No rows found in file(s).</p>';
        updateImportButtonLabel();
        return;
    }

    const accountId = document.getElementById('accountSelect').value;

    let html = `
        <div style="margin-bottom: 10px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
            <strong>Import Preview</strong>
            <span style="color:#27ae60; font-size:13px;">${newCount} new</span>
            ${duplicateCount > 0 ? `<span style="color:#e67e22; font-size:13px;">${duplicateCount} earlier than last import (hidden)</span>` : ''}
            ${!accountId ? `<span style="color:#7f8c8d; font-size:13px;">(select an account above to detect earlier transactions)</span>` : ''}
        </div>
        <div style="margin-bottom: 10px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
            <button class="secondary-btn" style="padding:4px 10px; font-size:12px;" onclick="selectAllPreview(true)">Select All</button>
            <button class="secondary-btn" style="padding:4px 10px; font-size:12px;" onclick="selectAllPreview(false)">Deselect All</button>
            ${duplicateCount > 0 ? `<button class="secondary-btn" style="padding:4px 10px; font-size:12px;" id="toggleDuplicatesBtn" onclick="togglePreviewDuplicates()">Show Earlier (${duplicateCount})</button>` : ''}
        </div>
        <div style="max-height:420px; overflow-y:auto; border:1px solid #e0e0e0; border-radius:6px;">
        <table style="width:100%; border-collapse:collapse;">
            <thead style="position:sticky; top:0; background:#f8f9fa; z-index:1;">
                <tr>
                    <th style="padding:8px; text-align:center; width:32px; font-weight:600; border-bottom:1px solid #dee2e6;">✓</th>
                    <th style="padding:8px; text-align:left; font-weight:600; border-bottom:1px solid #dee2e6;">Date</th>
                    <th style="padding:8px; text-align:left; font-weight:600; border-bottom:1px solid #dee2e6;">Description</th>
                    <th style="padding:8px; text-align:right; font-weight:600; border-bottom:1px solid #dee2e6;">Amount</th>
                </tr>
            </thead>
            <tbody>
    `;

    previewTransactions.forEach((tx, idx) => {
        const hidden = tx.isDuplicate && !_showDuplicates;
        const rowStyle = hidden ? 'display:none;' : (tx.isDuplicate ? 'opacity:0.5;' : '');
        const amtClass = tx.amount >= 0 ? 'transaction-positive' : 'transaction-negative';
        const amtStr = fmtMoneySigned(tx.amount);
        const dateInputStyle = tx.parsedDate ? '' : 'border-color:#e74c3c;';

        html += `
            <tr id="preview-row-${idx}" style="${rowStyle}" data-is-duplicate="${tx.isDuplicate ? 1 : 0}">
                <td style="padding:6px 8px; text-align:center; border-bottom:1px solid #f0f0f0;">
                    <input type="checkbox" id="preview-check-${idx}" ${tx.checked ? 'checked' : ''} onchange="updatePreviewCheck(${idx})">
                </td>
                <td style="padding:6px 8px; border-bottom:1px solid #f0f0f0;">
                    <input type="date" id="preview-date-${idx}" value="${escapeHtml(tx.parsedDate)}"
                        style="font-family:monospace; font-size:12px; width:135px; ${dateInputStyle}"
                        onchange="updatePreviewDate(${idx}, this.value)">
                </td>
                <td style="padding:6px 8px; font-size:13px; border-bottom:1px solid #f0f0f0;">${escapeHtml(tx.description)}</td>
                <td class="${amtClass}" style="padding:6px 8px; text-align:right; font-size:13px; border-bottom:1px solid #f0f0f0;">${amtStr}</td>
            </tr>
        `;
    });

    html += `</tbody></table></div>`;

    if (parseErrors > 0) {
        html += `<p style="color:#e74c3c; margin-top:8px; font-size:13px;">⚠ ${parseErrors} row(s) have unparseable dates — adjust the date format above.</p>`;
    }
    if (latestStoredDate) {
        html += `<p style="color:#7f8c8d; margin-top:6px; font-size:12px;">Latest stored transaction for this account: ${latestStoredDate}. Transactions on or before this date are hidden by default.</p>`;
    }

    container.innerHTML = html;
    updateImportButtonLabel();
}

function updatePreviewCheck(idx) {
    const cb = document.getElementById('preview-check-' + idx);
    if (previewTransactions[idx]) previewTransactions[idx].checked = cb ? cb.checked : false;
    updateImportButtonLabel();
}

function updatePreviewDate(idx, value) {
    if (previewTransactions[idx]) previewTransactions[idx].parsedDate = value;
}

function selectAllPreview(select) {
    previewTransactions.forEach((tx, idx) => {
        tx.checked = select;
        const cb = document.getElementById('preview-check-' + idx);
        if (cb) cb.checked = select;
    });
    updateImportButtonLabel();
}

function togglePreviewDuplicates() {
    _showDuplicates = !_showDuplicates;
    previewTransactions.forEach((tx, idx) => {
        if (!tx.isDuplicate) return;
        const row = document.getElementById('preview-row-' + idx);
        if (row) {
            row.style.display = _showDuplicates ? '' : 'none';
            if (_showDuplicates) row.style.opacity = '0.5';
        }
    });
    const btn = document.getElementById('toggleDuplicatesBtn');
    if (btn) {
        const dupCount = previewTransactions.filter(t => t.isDuplicate).length;
        btn.textContent = _showDuplicates ? `Hide Earlier (${dupCount})` : `Show Earlier (${dupCount})`;
    }
}

function updateImportButtonLabel() {
    const selectedCount = previewTransactions.filter(t => t.checked).length;
    const btn = document.querySelector('button[onclick="processUploadedFiles()"]');
    if (btn) {
        btn.textContent = selectedCount > 0
            ? `Import ${selectedCount} Transaction${selectedCount !== 1 ? 's' : ''}`
            : 'Import Transactions';
    }
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

function showAddAccount() {
    document.getElementById('addAccountForm').style.display = 'block';
}

function cancelAddAccount() {
    document.getElementById('addAccountForm').style.display = 'none';
    document.getElementById('newAccountName').value = '';
    document.getElementById('newAccountNumber').value = '';
}

async function addAccount() {
    const accountName = document.getElementById('newAccountName').value.trim();
    const accountNumber = document.getElementById('newAccountNumber').value.trim();
    const profileIdx = document.getElementById('bankProfileSelect').value;
    const profile = bankProfiles[profileIdx];

    // Validate input
    const validationError = validators.accountName(accountName);
    if (validationError) {
        showMessage('error', validationError);
        return;
    }

    // Use profile.id directly — banks and bank_profiles are now the same table
    const bankId = profile.id;
    if (!bankId) {
        showMessage('error', 'Bank profile has no ID — please save the profile first');
        return;
    }

    showLoading('Creating account...');

    try {
        const result = dbHelpers.safeRun(`
            INSERT INTO accounts (bank_id, account_name, account_number)
            VALUES (?, ?, ?)
        `, [bankId, accountName, accountNumber || null], 'Add account');

        if (!result.success) {
            hideLoading();
            return;
        }

        markDirty();
        updateAccountOptions();
        cancelAddAccount();

        // Auto-select the new account
        const newAccountId = dbHelpers.queryValue('SELECT last_insert_rowid()');
        document.getElementById('accountSelect').value = newAccountId;

        hideLoading();
        showMessage('success', `Account "${accountName}" added successfully`);
    } catch (e) {
        hideLoading();
        if (e.message.includes('UNIQUE constraint')) {
            showMessage('error', 'An account with this name already exists for this bank');
        } else {
            showMessage('error', 'Error adding account: ' + e.message);
        }
    }
}

async function processUploadedFiles() {
    const accountId = document.getElementById('accountSelect').value;

    if (!accountId) {
        showMessage('error', 'Please select an account');
        return;
    }

    const selected = previewTransactions.filter(t => t.checked && t.parsedDate);

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

// ─────────────────────────────────────────────────────────────────────────
// §4.3. Transaction Mapping
// ─────────────────────────────────────────────────────────────────────────

function mapTransaction(row, profile, importId, dateFormat) {
    // Handle both header-based (object) and headerless (array) CSVs
    let date, description, amount;

    if (profile.hasHeader !== false) {
        // Header-based: row is an object like {Date: "2024-01-15", Description: "...", ...}
        date = row[profile.dateColumn];

        // Handle multiple description columns (comma-separated)
        if (profile.descriptionColumn.includes(',')) {
            const columns = profile.descriptionColumn.split(',').map(c => c.trim());
            description = columns
                .map(col => row[col])
                .filter(val => val && val.trim())
                .join(' ');
        } else {
            description = row[profile.descriptionColumn];
        }

        // Handle credit/debit columns or single amount column
        if (profile.creditColumn && profile.debitColumn) {
            const credit = parseAmount(row[profile.creditColumn]);
            const debit = parseAmount(row[profile.debitColumn]);
            amount = credit - debit; // credit is positive, debit is negative
        } else {
            const raw = row[profile.amountColumn];
            if (raw === undefined || raw === null || String(raw).trim() === '') return null;
            amount = parseAmount(raw);
        }
    } else {
        // Headerless: row is an array like ["2024-01-15", "...", "...", "-50.00"]
        date = row[parseInt(profile.dateColumn)];

        // Handle multiple description columns (comma-separated indices)
        if (profile.descriptionColumn.includes(',')) {
            const indices = profile.descriptionColumn.split(',').map(c => parseInt(c.trim()));
            description = indices
                .map(idx => row[idx])
                .filter(val => val && val.trim())
                .join(' ');
        } else {
            description = row[parseInt(profile.descriptionColumn)];
        }

        // Handle credit/debit columns or single amount column
        if (profile.creditColumn && profile.debitColumn) {
            const credit = parseAmount(row[parseInt(profile.creditColumn)]);
            const debit = parseAmount(row[parseInt(profile.debitColumn)]);
            amount = credit - debit;
        } else {
            const raw = row[parseInt(profile.amountColumn)];
            if (raw === undefined || raw === null || String(raw).trim() === '') return null;
            amount = parseAmount(raw);
        }
    }

    if (!date) return null;

    return {
        import_id: importId,
        date: normalizeDate(date, dateFormat || profile.dateFormat),
        description: description || '',
        amount: amount,
        category: categorizeTransaction(description)
    };
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
    document.getElementById('convertToRuleBtn').addEventListener('click', () => convertToRule(description));
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

function convertToRule(description) {
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
    document.getElementById('newRuleName').focus();
}

async function saveTransactionCategory(transactionId) {
    const categoryId = document.getElementById('editCategorySelect').value || null;
    const subcategoryId = document.getElementById('editSubcategorySelect').value || null;

    db.run('UPDATE transactions SET category_id = ?, subcategory_id = ?, manual_category = 1 WHERE id = ?',
        [categoryId, subcategoryId, transactionId]);

    markDirty();
    await loadTransactions(currentPage);
    refreshFilters();
    await updateAnalytics();
    closeEditCategoryModal();
    showMessage('success', 'Category updated (manual override set)');
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
    selectedTransactionIds.clear();
    markDirty();
    await loadTransactions(currentPage);
    refreshFilters();
    await updateAnalytics();
    closeBulkEditCategoryModal();
    showMessage('success', `Category updated for ${count} transaction${count === 1 ? '' : 's'} (manual override set)`);
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

// ═══════════════════════════════════════════════════════════════════════════
