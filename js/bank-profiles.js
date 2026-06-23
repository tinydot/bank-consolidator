// §10. BANK PROFILES
// ═══════════════════════════════════════════════════════════════════════════

async function loadBankProfiles() {
    try {
        const result = db.exec('SELECT id, name, has_header, skip_rows, date_column, description_column, amount_column, credit_column, debit_column, date_format FROM banks ORDER BY name');
        if (result.length > 0 && result[0].values.length > 0) {
            bankProfiles = result[0].values.map(row => ({
                id:                row[0],
                name:              row[1],
                hasHeader:         row[2] === 1,
                skipRows:          row[3],
                dateColumn:        row[4],
                descriptionColumn: row[5],
                amountColumn:      row[6] || '',
                creditColumn:      row[7] || '',
                debitColumn:       row[8] || '',
                dateFormat:        row[9] || 'auto'
            }));
        } else {
            createDefaultProfiles();
        }
    } catch (e) {
        createDefaultProfiles();
    }

    // Migrate from localStorage if present and DB is empty.
    // Wrap parse in try/catch — a hand-edited or partially-written legacy
    // value would otherwise throw and stall app initialization.
    const saved = localStorage.getItem('bankProfiles');
    if (saved && bankProfiles.length === 0) {
        let oldProfiles;
        try {
            oldProfiles = JSON.parse(saved);
        } catch (e) {
            localStorage.removeItem('bankProfiles');
            oldProfiles = null;
        }
        if (Array.isArray(oldProfiles) && oldProfiles.length > 0) {
            oldProfiles.forEach(profile => saveBankProfileToDB(profile));
            localStorage.removeItem('bankProfiles');
            loadBankProfiles();
            return;
        }
    }

    renderBankProfiles();
}

function createDefaultProfiles() {
    const defaults = [
        {
            name: 'Chase',
            hasHeader: true,
            skipRows: 0,
            dateColumn: 'Transaction Date',
            descriptionColumn: 'Description',
            amountColumn: 'Amount',
            creditColumn: '',
            debitColumn: ''
        },
        {
            name: 'Bank of America',
            hasHeader: true,
            skipRows: 0,
            dateColumn: 'Date',
            descriptionColumn: 'Description',
            amountColumn: 'Amount',
            creditColumn: '',
            debitColumn: ''
        },
        {
            name: 'Wells Fargo',
            hasHeader: true,
            skipRows: 0,
            dateColumn: 'Date',
            descriptionColumn: 'Description',
            amountColumn: 'Amount',
            creditColumn: '',
            debitColumn: ''
        },
        {
            name: 'Citibank (No Header)',
            hasHeader: false,
            skipRows: 0,
            dateColumn: '0',
            descriptionColumn: '2',
            amountColumn: '3',
            creditColumn: '',
            debitColumn: ''
        }
    ];

    defaults.forEach(profile => saveBankProfileToDB(profile));
    loadBankProfiles(); // Reload from DB
}

function saveBankProfileToDB(profile) {
    try {
        if (profile.id) {
            // UPDATE existing bank row — keeps bank_id intact so accounts stay linked
            dbHelpers.safeRun(`
                UPDATE banks SET
                    name = ?, has_header = ?, skip_rows = ?,
                    date_column = ?, description_column = ?,
                    amount_column = ?, credit_column = ?, debit_column = ?,
                    date_format = ?
                WHERE id = ?
            `, [
                profile.name,
                profile.hasHeader ? 1 : 0,
                profile.skipRows || 0,
                profile.dateColumn,
                profile.descriptionColumn,
                profile.amountColumn  || '',
                profile.creditColumn  || '',
                profile.debitColumn   || '',
                profile.dateFormat    || 'auto',
                profile.id
            ], 'Save bank profile');
        } else {
            // INSERT new bank row
            dbHelpers.safeRun(`
                INSERT INTO banks (name, has_header, skip_rows, date_column, description_column, amount_column, credit_column, debit_column, date_format)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                profile.name,
                profile.hasHeader ? 1 : 0,
                profile.skipRows || 0,
                profile.dateColumn,
                profile.descriptionColumn,
                profile.amountColumn  || '',
                profile.creditColumn  || '',
                profile.debitColumn   || '',
                profile.dateFormat    || 'auto'
            ], 'Insert bank profile');
        }
    } catch (e) {
        console.error('Error saving bank profile:', e);
    }
}

function renderBankProfiles() {
    const container = document.getElementById('bankProfilesList');
    container.innerHTML = '';

    bankProfiles.forEach((profile, idx) => {
        const div = document.createElement('div');
        div.className = 'bank-profile';
        const hasHeader = profile.hasHeader !== false;
        const skipRows = profile.skipRows || 0;
        const hasCreditDebit = profile.creditColumn && profile.debitColumn;

        div.innerHTML = `
            <h3>${escapeHtml(profile.name)}</h3>
            <div class="form-group">
                <label>Bank Name</label>
                <input type="text" value="${profile.name}" onchange="updateProfile(${idx}, 'name', this.value)">
            </div>
            <div class="form-group">
                <label>
                    <input type="checkbox" ${hasHeader ? 'checked' : ''} onchange="updateProfile(${idx}, 'hasHeader', this.checked)">
                    CSV has header row
                </label>
                <p style="font-size: 12px; color: #7f8c8d; margin-top: 5px;">
                    ${hasHeader ? 'Use column names (e.g., "Date", "Description")' : 'Use column numbers (e.g., 0, 1, 2 for first, second, third column)'}
                </p>
            </div>
            <div class="form-group">
                <label>Skip Rows (before header/data)</label>
                <input type="number" min="0" value="${skipRows}" onchange="updateProfile(${idx}, 'skipRows', parseInt(this.value))">
                <p style="font-size: 12px; color: #7f8c8d; margin-top: 5px;">
                    Number of rows to skip at the beginning (e.g., account details)
                </p>
            </div>
            <div class="form-group">
                <label>Date Column ${hasHeader ? '(Name)' : '(Index)'}</label>
                <input type="text" value="${profile.dateColumn}" onchange="updateProfile(${idx}, 'dateColumn', this.value)">
            </div>
            <div class="form-group">
                <label>Date Format</label>
                <select onchange="updateProfile(${idx}, 'dateFormat', this.value)">
                    <option value="auto"     ${(profile.dateFormat || 'auto') === 'auto'     ? 'selected' : ''}>Auto-detect</option>
                    <option value="YYYY-MM-DD" ${profile.dateFormat === 'YYYY-MM-DD' ? 'selected' : ''}>YYYY-MM-DD (e.g. 2025-01-31)</option>
                    <option value="DD/MM/YYYY" ${profile.dateFormat === 'DD/MM/YYYY' ? 'selected' : ''}>DD/MM/YYYY (e.g. 31/01/2025)</option>
                    <option value="MM/DD/YYYY" ${profile.dateFormat === 'MM/DD/YYYY' ? 'selected' : ''}>MM/DD/YYYY (e.g. 01/31/2025)</option>
                    <option value="DD-MM-YYYY" ${profile.dateFormat === 'DD-MM-YYYY' ? 'selected' : ''}>DD-MM-YYYY (e.g. 31-01-2025)</option>
                    <option value="MM-DD-YYYY" ${profile.dateFormat === 'MM-DD-YYYY' ? 'selected' : ''}>MM-DD-YYYY (e.g. 01-31-2025)</option>
                    <option value="DD/MM/YY"   ${profile.dateFormat === 'DD/MM/YY'   ? 'selected' : ''}>DD/MM/YY (e.g. 31/01/25)</option>
                    <option value="MM/DD/YY"   ${profile.dateFormat === 'MM/DD/YY'   ? 'selected' : ''}>MM/DD/YY (e.g. 01/31/25)</option>
                    <option value="DD-Mon-YY"  ${profile.dateFormat === 'DD-Mon-YY'  ? 'selected' : ''}>DD-Mon-YY (e.g. 16-Feb-26)</option>
                    <option value="DD-Mon-YYYY" ${profile.dateFormat === 'DD-Mon-YYYY' ? 'selected' : ''}>DD-Mon-YYYY (e.g. 16-Feb-2026)</option>
                </select>
            </div>
            <div class="form-group">
                <label>Description Column(s) ${hasHeader ? '(Names)' : '(Indices)'}</label>
                <input type="text" value="${profile.descriptionColumn}" onchange="updateProfile(${idx}, 'descriptionColumn', this.value)">
                <p style="font-size: 12px; color: #7f8c8d; margin-top: 5px;">
                    For multiple columns, separate with commas (e.g., "Merchant, Category" or "2, 3, 4")
                </p>
            </div>
            <div class="form-group">
                <label style="font-weight: bold; margin-bottom: 10px;">Amount Configuration</label>
                <div style="background: #f8f9fa; padding: 15px; border-radius: 6px;">
                    <div style="margin-bottom: 15px;">
                        <label>Single Amount Column ${hasHeader ? '(Name)' : '(Index)'}</label>
                        <input type="text" value="${profile.amountColumn || ''}" onchange="updateProfile(${idx}, 'amountColumn', this.value)" ${hasCreditDebit ? 'disabled' : ''}>
                        <p style="font-size: 12px; color: #7f8c8d; margin-top: 5px;">
                            Use this if amounts are in one column (positive for credit, negative for debit)
                        </p>
                    </div>
                    <div style="text-align: center; margin: 10px 0; color: #95a5a6; font-weight: bold;">OR</div>
                    <div style="margin-bottom: 10px;">
                        <label>Credit Column ${hasHeader ? '(Name)' : '(Index)'}</label>
                        <input type="text" value="${profile.creditColumn || ''}" onchange="updateProfile(${idx}, 'creditColumn', this.value)">
                    </div>
                    <div>
                        <label>Debit Column ${hasHeader ? '(Name)' : '(Index)'}</label>
                        <input type="text" value="${profile.debitColumn || ''}" onchange="updateProfile(${idx}, 'debitColumn', this.value)">
                    </div>
                    <p style="font-size: 12px; color: #7f8c8d; margin-top: 10px;">
                        Use these if credits and debits are in separate columns
                    </p>
                </div>
            </div>
            ${renderAccountsForProfile(profile.id, idx)}
            <button class="danger-btn" data-delete-profile>Delete Profile</button>
        `;
        div.querySelector('[data-delete-profile]').addEventListener('click', () => deleteProfile(idx));
        container.appendChild(div);
    });
}

function renderAccountsForProfile(bankId, profileIdx) {
    if (!bankId) return '';
    const result = db.exec(`
        SELECT id, account_name, account_number, keyword
        FROM accounts WHERE bank_id = ? ORDER BY account_name
    `, [bankId]);

    const rows = result.length ? result[0].values : [];
    const accountRows = rows.map(([id, name, number, keyword]) => {
        const display = escapeHtml(name) + (number ? ` (...${escapeHtml(number)})` : '');
        const kw = escapeHtml(keyword || '');
        return `
            <div style="display:flex; gap:8px; align-items:center; margin-bottom:6px; padding:8px; background:white; border-radius:4px; border:1px solid #ecf0f1;">
                <span style="flex:1; font-size:13px;">${display}</span>
                <input type="text" value="${kw}" placeholder="CSV keyword for auto-detect"
                       style="flex:1; font-size:13px;"
                       onchange="updateAccountKeyword(${id}, this.value)"
                       title="Keyword found in first CSV line to auto-select this account">
                <button class="danger-btn" style="padding:4px 10px; font-size:12px;"
                        onclick="deleteAccountFromSettings(${id}, ${profileIdx})">Delete</button>
            </div>`;
    }).join('');

    return `
        <div class="form-group" style="margin-top:20px; border-top:1px solid #ecf0f1; padding-top:16px;">
            <label style="font-weight:bold; display:block; margin-bottom:10px;">Accounts</label>
            <p style="font-size:12px; color:#7f8c8d; margin-bottom:10px;">
                Set a keyword to auto-select this account when that text appears in the first line of a dropped CSV file.
            </p>
            ${accountRows || '<p style="font-size:13px; color:#95a5a6;">No accounts yet.</p>'}
            <div style="display:flex; gap:8px; align-items:flex-end; margin-top:10px; flex-wrap:wrap;">
                <div class="form-group" style="margin:0; flex:1; min-width:120px;">
                    <label style="font-size:12px;">Name</label>
                    <input type="text" id="new-acct-name-${bankId}" placeholder="e.g., Checking">
                </div>
                <div class="form-group" style="margin:0; width:100px;">
                    <label style="font-size:12px;">Last 4 digits</label>
                    <input type="text" id="new-acct-number-${bankId}" placeholder="optional">
                </div>
                <div class="form-group" style="margin:0; flex:1; min-width:120px;">
                    <label style="font-size:12px;">CSV Keyword</label>
                    <input type="text" id="new-acct-keyword-${bankId}" placeholder="e.g., Chase Bank">
                </div>
                <button onclick="addAccountFromSettings(${bankId}, ${profileIdx})" style="white-space:nowrap;">+ Add Account</button>
            </div>
        </div>`;
}

function updateAccountKeyword(accountId, keyword) {
    dbHelpers.safeRun(
        "UPDATE accounts SET keyword = ? WHERE id = ?",
        [keyword, accountId],
        'Update account keyword'
    );
    markDirty();
}

function deleteAccountFromSettings(accountId, profileIdx) {
    if (confirm('Delete this account? Existing transactions will be unaffected.')) {
        dbHelpers.safeRun('DELETE FROM accounts WHERE id = ?', [accountId], 'Delete account');
        markDirty();
        renderBankProfiles();
    }
}

function addAccountFromSettings(bankId, profileIdx) {
    const nameInput    = document.getElementById(`new-acct-name-${bankId}`);
    const numberInput  = document.getElementById(`new-acct-number-${bankId}`);
    const keywordInput = document.getElementById(`new-acct-keyword-${bankId}`);

    const accountName   = nameInput.value.trim();
    const accountNumber = numberInput.value.trim();
    const keyword       = keywordInput.value.trim();

    const validationError = validators.accountName(accountName);
    if (validationError) { showMessage('error', validationError); return; }

    const result = dbHelpers.safeRun(`
        INSERT INTO accounts (bank_id, account_name, account_number, keyword)
        VALUES (?, ?, ?, ?)
    `, [bankId, accountName, accountNumber || null, keyword || ''], 'Add account from settings');

    if (result.success) {
        markDirty();
        renderBankProfiles();
        showMessage('success', `Account "${accountName}" added`);
    }
}

function updateProfile(idx, field, value) {
    bankProfiles[idx][field] = value;
    saveBankProfileToDB(bankProfiles[idx]);
    markDirty();
}

function deleteProfile(idx) {
    if (confirm('Delete this bank profile? Existing accounts and transactions will be unaffected.')) {
        const profile = bankProfiles[idx];
        if (profile.id) {
            dbHelpers.safeRun('DELETE FROM banks WHERE id = ?', [profile.id], 'Delete bank profile');
        }
        bankProfiles.splice(idx, 1);
        markDirty();
        renderBankProfiles();
    }
}

function addBankProfile() {
    const newProfile = {
        name: 'New Bank',
        hasHeader: true,
        skipRows: 0,
        dateColumn: 'Date',
        descriptionColumn: 'Description',
        amountColumn: 'Amount',
        creditColumn: '',
        debitColumn: '',
        dateFormat: 'auto'
    };
    saveBankProfileToDB(newProfile);
    // Reload so the new profile gets its id from the DB
    markDirty();
    loadBankProfiles();
}

async function clearDatabase() {
    if (confirm('Are you sure? This will delete ALL transactions, imports, and accounts!\n\nCategories, subcategories, bank profiles, and rules will be preserved.')) {
        db.run('DELETE FROM transactions');
        db.run('DELETE FROM imports');
        db.run('DELETE FROM accounts');
        markDirty();
        await loadTransactions();
        await loadImportHistory();
        await updateAnalytics();
        showMessage('success', 'Database cleared (transactions, imports, and accounts deleted). Categories and settings preserved.');
    }
}

function importDatabase() {
    document.getElementById('dbImportInput').click();
}

async function handleDatabaseImport(e) {
    const file = e.target.files[0];
    if (!file) return;

    const arrayBuffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    try {
        db = new SQL.Database(uint8Array);
        await saveDatabaseToIndexedDB();
        await loadBankProfiles();
        await loadCategories();
        await loadRules();
        await loadTransactions();
        refreshFilters();
        await loadImportHistory();
        await updateAnalytics();
        await loadBudget();
        await loadPlanner();
        showMessage('success', 'Database imported successfully (including bank profiles, rules, budget, and planner)');
    } catch (error) {
        showMessage('error', 'Failed to import database: ' + error.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────
// §10.1. UI Helpers & Navigation
// ─────────────────────────────────────────────────────────────────────────

function switchTab(tab) {
    document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

    const activeBtn = document.querySelector(`[onclick="switchTab('${tab}')"]`);
    activeBtn.classList.add('active');
    activeBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    document.getElementById(`${tab}-tab`).classList.add('active');

    if (tab === 'overview') {
        loadOverview();
    }

    if (tab === 'planner') {
        loadPlanner();
    }

    if (tab === 'budget') {
        budgetMonth = new Date().toISOString().slice(0, 7);
        loadBudget();
    }

    if (tab === 'settings') {
        loadMonthlyIncomeSettings();
    }

    if (tab === 'transactions') {
        populateManualAccountSelect();
    }
}

function toggleSettingsSection(headerBtn) {
    headerBtn.closest('.settings-section').classList.toggle('collapsed');
}

function cancelUpload() {
    resetFileSelection();
}

function showMessage(type, text) {
    // Render into a fixed, tab-independent toast layer. Previously this wrote
    // into #import-message inside the Transactions tab, so feedback from actions
    // on Settings/Budget/Planner was rendered in a hidden tab and never seen.
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    const className = type === 'error' ? 'error-message' : 'success-message';
    const div = document.createElement('div');
    div.className = className;
    div.textContent = text;
    container.appendChild(div);
    setTimeout(() => div.remove(), 5000);
}

// ═══════════════════════════════════════════════════════════════════════════
