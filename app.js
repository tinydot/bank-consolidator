/*
═══════════════════════════════════════════════════════════════════════════════
  BANK STATEMENT CONSOLIDATOR
  A self-contained SQLite-powered transaction management system
═══════════════════════════════════════════════════════════════════════════════

  TABLE OF CONTENTS
───────────────────────────────────────────────────────────────────────────────
  §1.  GLOBAL STATE
       1.1. Constants
       1.2. Database Helper Functions
       1.3. Validation Functions
       1.4. Utility Functions
  §2.  INITIALIZATION & LIFECYCLE
  §3.  DATABASE LAYER
       3.1. Schema
       3.2. Database Persistence (IndexedDB)  [code located after §8]
  §4.  IMPORT SYSTEM
       4.1. File Upload & Selection
       4.2. CSV Processing & Account Management
       4.3. Transaction Mapping
  §5.  IMPORT HISTORY
  §6.  UTILITIES
       6.1. Date & Hash Functions
  §7.  TRANSACTION OPERATIONS
       7.1. CRUD Operations
       7.2. Query & Display
  §8.  ANALYTICS & REPORTING
       8.1. Statistics Calculation
       8.2. Charts (Monthly Trend, Categories)
       8.3. Export Functions
       8.4. Report Generator (static HTML)
  §9.  CATEGORIES
  §10. BANK PROFILES
       10.1. UI Helpers & Navigation
  §11. MANUAL TRANSACTIONS
  §12. TRANSACTION RULES
  §13. BUDGET
  §14. PLANNER (Emergency Fund)
═══════════════════════════════════════════════════════════════════════════════
*/

// ═══════════════════════════════════════════════════════════════════════════
// §1. GLOBAL STATE
// ═══════════════════════════════════════════════════════════════════════════

let db = null;
let SQL = null;
let uploadedFiles = [];
let bankProfiles = [];
let categoryChart = null;
let currentPage = 0;
let budgetMonth = new Date().toISOString().slice(0, 7); // YYYY-MM, current month

// ─────────────────────────────────────────────────────────────────────────
// §1.1. Constants
// ─────────────────────────────────────────────────────────────────────────

const CONFIG = {
    PAGE_SIZE: 100,
    DEBOUNCE_MS: 300,
    MAX_FILE_SIZE: 50 * 1024 * 1024, // 50MB
    MAX_CATEGORY_NAME_LENGTH: 50,
    MAX_RULE_NAME_LENGTH: 100
};

// ─────────────────────────────────────────────────────────────────────────
// §1.2. Database Helper Functions
// ─────────────────────────────────────────────────────────────────────────

const dbHelpers = {
    /**
     * Safely execute a database query with error handling
     */
    safeRun(sql, params = [], context = 'Database operation') {
        try {
            db.run(sql, params);
            return { success: true };
        } catch (e) {
            console.error(`${context} failed:`, e);
            showMessage('error', `Database error: ${e.message}`);
            return { success: false, error: e };
        }
    },

    /**
     * Execute query and return all rows
     */
    queryAll(sql, params = []) {
        try {
            const result = db.exec(sql, params);
            return result.length > 0 ? result[0].values : [];
        } catch (e) {
            console.error('Query failed:', e);
            return [];
        }
    },

    /**
     * Execute query and return first row
     */
    queryFirst(sql, params = []) {
        const rows = this.queryAll(sql, params);
        return rows.length > 0 ? rows[0] : null;
    },

    /**
     * Execute query and call callback for each row
     */
    queryForEach(sql, params = [], callback) {
        const rows = this.queryAll(sql, params);
        rows.forEach(callback);
    },

    /**
     * Get single value from query
     */
    queryValue(sql, params = []) {
        const row = this.queryFirst(sql, params);
        return row ? row[0] : null;
    }
};

// ─────────────────────────────────────────────────────────────────────────
// §1.3. Validation Functions
// ─────────────────────────────────────────────────────────────────────────

const validators = {
    categoryName(name) {
        if (!name || name.trim().length === 0) {
            return 'Category name is required';
        }
        if (name.length > CONFIG.MAX_CATEGORY_NAME_LENGTH) {
            return `Category name too long (max ${CONFIG.MAX_CATEGORY_NAME_LENGTH} chars)`;
        }
        if (!/^[\w\s\-&.']+$/u.test(name)) {
            return 'Category name contains invalid characters';
        }
        return null;
    },

    ruleName(name) {
        if (!name || name.trim().length === 0) {
            return 'Rule name is required';
        }
        if (name.length > CONFIG.MAX_RULE_NAME_LENGTH) {
            return `Rule name too long (max ${CONFIG.MAX_RULE_NAME_LENGTH} chars)`;
        }
        return null;
    },

    keyword(keyword) {
        if (!keyword || keyword.trim().length === 0) {
            return 'Keyword is required';
        }
        if (keyword.length > 100) {
            return 'Keyword too long (max 100 chars)';
        }
        return null;
    },

    accountName(name) {
        if (!name || name.trim().length === 0) {
            return 'Account name is required';
        }
        if (name.length > 100) {
            return 'Account name too long (max 100 chars)';
        }
        return null;
    },

    bankProfileName(name) {
        if (!name || name.trim().length === 0) {
            return 'Bank name is required';
        }
        if (name.length > 100) {
            return 'Bank name too long (max 100 chars)';
        }
        return null;
    }
};

// ─────────────────────────────────────────────────────────────────────────
// §1.4. Utility Functions
// ─────────────────────────────────────────────────────────────────────────

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showLoading(message = 'Loading...') {
    let overlay = document.getElementById('loadingOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'loadingOverlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.7);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 9999;
        `;
        overlay.innerHTML = `
            <div style="background: white; padding: 30px; border-radius: 8px; text-align: center;">
                <div style="font-size: 40px; margin-bottom: 15px;">⏳</div>
                <div id="loadingMessage" style="font-size: 18px; color: #2c3e50;">${message}</div>
            </div>
        `;
        document.body.appendChild(overlay);
    } else {
        document.getElementById('loadingMessage').textContent = message;
        overlay.style.display = 'flex';
    }
}

function hideLoading() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
        overlay.style.display = 'none';
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// §2. INITIALIZATION & LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════

// Initialize
async function init() {
    await initSQLite();
    await loadBankProfiles();
    await loadCategories();
    await loadTransactions();
    refreshFilters();
    await loadImportHistory();
    await loadRules();
    await updateAnalytics();
    await loadBudget();
    await loadPlanner();
    setupEventListeners();
}

// ═══════════════════════════════════════════════════════════════════════════
// §3. DATABASE LAYER
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────
// §3.1. Schema
// ─────────────────────────────────────────────────────────────────────────

async function initSQLite() {
    SQL = await initSqlJs();
    const savedDb = await loadDatabaseFromIndexedDB();

    // Check for a synchronous backup written to localStorage during the last
    // page unload. This backup captures any changes that hadn't been flushed
    // to IndexedDB yet (e.g. the user refreshed within the 1s debounce window).
    let localBackup = null;
    try {
        const raw = localStorage.getItem('bankConsolidator_backup');
        if (raw) {
            const binaryString = atob(raw);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            localBackup = bytes;
        }
    } catch (e) {
        // Corrupt or missing backup — ignore
    }

    if (localBackup) {
        // The localStorage backup is always at least as recent as IndexedDB,
        // so prefer it. Clear it immediately and flush to IndexedDB.
        localStorage.removeItem('bankConsolidator_backup');
        db = new SQL.Database(localBackup);
        createTables();
        await saveDatabaseToIndexedDB();
    } else {
        db = savedDb ? new SQL.Database(new Uint8Array(savedDb)) : new SQL.Database();
        createTables();
    }
}

function createTables() {
    db.run(`
        CREATE TABLE IF NOT EXISTS banks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            has_header INTEGER DEFAULT 1,
            skip_rows INTEGER DEFAULT 0,
            date_column TEXT NOT NULL DEFAULT 'Date',
            description_column TEXT NOT NULL DEFAULT 'Description',
            amount_column TEXT DEFAULT '',
            credit_column TEXT DEFAULT '',
            debit_column TEXT DEFAULT '',
            date_format TEXT DEFAULT 'auto'
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            color TEXT,
            icon TEXT,
            sort_order INTEGER DEFAULT 0
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS subcategories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            sort_order INTEGER DEFAULT 0,
            FOREIGN KEY (category_id) REFERENCES categories(id),
            UNIQUE(category_id, name)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bank_id INTEGER NOT NULL,
            account_name TEXT NOT NULL,
            account_number TEXT,
            FOREIGN KEY (bank_id) REFERENCES banks(id),
            UNIQUE(bank_id, account_name)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS transaction_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            keyword TEXT NOT NULL,
            action TEXT NOT NULL,
            category_value INTEGER,
            subcategory_value INTEGER,
            case_sensitive INTEGER DEFAULT 0,
            enabled INTEGER DEFAULT 1,
            priority INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (category_value) REFERENCES categories(id),
            FOREIGN KEY (subcategory_value) REFERENCES subcategories(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS imports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL,
            import_date TEXT NOT NULL,
            account_id INTEGER NOT NULL,
            transaction_count INTEGER DEFAULT 0,
            FOREIGN KEY (account_id) REFERENCES accounts(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            import_id INTEGER NOT NULL,
            date TEXT NOT NULL,
            description TEXT,
            amount REAL NOT NULL,
            category_id INTEGER,
            subcategory_id INTEGER,
            ignored INTEGER DEFAULT 0,
            auto_ignored INTEGER DEFAULT 0,
            manual_category INTEGER DEFAULT 0,
            FOREIGN KEY (import_id) REFERENCES imports(id),
            FOREIGN KEY (category_id) REFERENCES categories(id),
            FOREIGN KEY (subcategory_id) REFERENCES subcategories(id)
        )
    `);

    db.run(`
        CREATE INDEX IF NOT EXISTS idx_date ON transactions(date);
        CREATE INDEX IF NOT EXISTS idx_import ON transactions(import_id);
        CREATE INDEX IF NOT EXISTS idx_ignored ON transactions(ignored);
        CREATE INDEX IF NOT EXISTS idx_category ON transactions(category_id);
        CREATE INDEX IF NOT EXISTS idx_subcategory ON transactions(subcategory_id);
    `);

    // Add manual_category column to existing databases
    try { db.run('ALTER TABLE transactions ADD COLUMN manual_category INTEGER DEFAULT 0'); } catch(e) {}

    db.run(`
        CREATE TABLE IF NOT EXISTS manual_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            description TEXT NOT NULL,
            amount REAL NOT NULL,
            category_id INTEGER,
            subcategory_id INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (category_id) REFERENCES categories(id),
            FOREIGN KEY (subcategory_id) REFERENCES subcategories(id)
        )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_manual_date ON manual_transactions(date)`);

    // Add category columns to existing manual_transactions tables
    try { db.run('ALTER TABLE manual_transactions ADD COLUMN category_id INTEGER'); } catch(e) {}
    try { db.run('ALTER TABLE manual_transactions ADD COLUMN subcategory_id INTEGER'); } catch(e) {}

    db.run(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS budget (
            category_id INTEGER PRIMARY KEY,
            monthly_limit REAL NOT NULL,
            FOREIGN KEY (category_id) REFERENCES categories(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS expense_commitments (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            description   TEXT NOT NULL,
            amount        REAL NOT NULL,
            type          TEXT NOT NULL DEFAULT 'monthly',
            category_id   INTEGER,
            subcategory_id INTEGER,
            day_of_month  INTEGER,
            payment_dates TEXT,
            active_months TEXT,
            notes         TEXT,
            enabled       INTEGER DEFAULT 1,
            FOREIGN KEY (category_id)    REFERENCES categories(id),
            FOREIGN KEY (subcategory_id) REFERENCES subcategories(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS planner_settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS planned_activities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            type TEXT NOT NULL CHECK(type IN ('domestic', 'overseas')),
            status TEXT NOT NULL DEFAULT 'unscheduled' CHECK(status IN ('unscheduled', 'scheduled', 'completed', 'cancelled')),
            scheduled_month TEXT,
            notes TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS activity_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            activity_id INTEGER NOT NULL,
            category_id INTEGER,
            description TEXT NOT NULL,
            estimated_cost REAL NOT NULL,
            actual_cost REAL,
            FOREIGN KEY (activity_id) REFERENCES planned_activities(id) ON DELETE CASCADE,
            FOREIGN KEY (category_id) REFERENCES categories(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS bank_balances (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_name TEXT NOT NULL,
            balance REAL NOT NULL,
            as_of_date TEXT NOT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_activity_items_activity ON activity_items(activity_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_planned_activities_month ON planned_activities(scheduled_month)`);

    // Add category columns to expense_commitments if upgrading from earlier version
    try { db.run('ALTER TABLE expense_commitments ADD COLUMN category_id INTEGER'); } catch(e) {}
    try { db.run('ALTER TABLE expense_commitments ADD COLUMN subcategory_id INTEGER'); } catch(e) {}
}

// ═══════════════════════════════════════════════════════════════════════════
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

function handleFiles(files) {
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
    updateImportPreview(true);
}

function resetFileSelection() {
    uploadedFiles = [];
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
        `<option value="${idx}">${profile.name}</option>`
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

    // Parse first file only for preview
    const file = uploadedFiles[0];
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

    const rows = result.data.slice(0, 5);
    if (!rows.length) {
        container.innerHTML = '<p style="color:#7f8c8d;">No rows found in file.</p>';
        return;
    }

    let badDates = 0;
    let html = `
        <div style="margin-bottom: 10px;">
            <strong>Preview</strong>
            <span style="color:#7f8c8d; font-size:13px; margin-left:8px;">First ${rows.length} row(s) of ${uploadedFiles[0].name}</span>
        </div>
        <table>
            <thead><tr>
                <th>Raw Date</th>
                <th>Parsed Date</th>
                <th>Description</th>
                <th style="text-align:right;">Amount</th>
            </tr></thead>
            <tbody>
    `;

    rows.forEach(row => {
        let rawDate, description, amount;

        if (profile.hasHeader !== false) {
            rawDate = row[profile.dateColumn] || '';
            description = profile.descriptionColumn.includes(',')
                ? profile.descriptionColumn.split(',').map(c => row[c.trim()]).filter(Boolean).join(' ')
                : row[profile.descriptionColumn] || '';
            if (profile.creditColumn && profile.debitColumn) {
                amount = parseAmount(row[profile.creditColumn]) - parseAmount(row[profile.debitColumn]);
            } else {
                amount = parseAmount(row[profile.amountColumn]);
            }
        } else {
            rawDate = row[parseInt(profile.dateColumn)] || '';
            description = profile.descriptionColumn.includes(',')
                ? profile.descriptionColumn.split(',').map(c => row[parseInt(c.trim())]).filter(Boolean).join(' ')
                : row[parseInt(profile.descriptionColumn)] || '';
            if (profile.creditColumn && profile.debitColumn) {
                amount = parseAmount(row[parseInt(profile.creditColumn)]) - parseAmount(row[parseInt(profile.debitColumn)]);
            } else {
                amount = parseAmount(row[parseInt(profile.amountColumn)]);
            }
        }

        const parsed = normalizeDate(rawDate, dateFormat);
        const dateOk = parsed && parsed !== rawDate;
        const dateStyle = parsed ? 'color:#27ae60;' : 'color:#e74c3c; font-weight:bold;';
        const dateDisplay = parsed || '⚠ Invalid';
        if (!parsed) badDates++;

        const amtClass = amount >= 0 ? 'transaction-positive' : 'transaction-negative';
        const amtStr = amount >= 0 ? `+$${amount.toFixed(2)}` : `-$${Math.abs(amount).toFixed(2)}`;

        html += `<tr>
            <td style="font-family:monospace; font-size:13px;">${escapeHtml(rawDate)}</td>
            <td style="${dateStyle} font-family:monospace; font-size:13px;">${dateDisplay}</td>
            <td style="font-size:13px;">${escapeHtml(description)}</td>
            <td class="${amtClass}" style="text-align:right;">${amtStr}</td>
        </tr>`;
    });

    html += '</tbody></table>';

    if (badDates > 0) {
        html += `<p style="color:#e74c3c; margin-top:10px; font-size:13px;">⚠ ${badDates} row(s) have unparseable dates — select the correct date format above.</p>`;
    } else {
        html += `<p style="color:#27ae60; margin-top:10px; font-size:13px;">✓ All dates parsed successfully.</p>`;
    }

    container.innerHTML = html;
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
            select.innerHTML += `<option value="${accountId}">${displayName}</option>`;
        });
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
    const profileIdx = document.getElementById('bankProfileSelect').value;
    const profile = bankProfiles[profileIdx];
    const accountId = document.getElementById('accountSelect').value;
    const dateFormat = document.getElementById('importDateFormat').value;

    // Use the dropdown's date format, falling back to the profile's saved format
    const effectiveDateFormat = dateFormat || profile.dateFormat || 'auto';

    if (!accountId) {
        showMessage('error', 'Please select an account');
        return;
    }

    showLoading(`Importing ${uploadedFiles.length} file(s)...`);

    let totalImported = 0;

    try {
        for (let i = 0; i < uploadedFiles.length; i++) {
            const file = uploadedFiles[i];
            showLoading(`Processing ${i + 1}/${uploadedFiles.length}: ${file.name}`);

            // Create import record
            const importId = createImportRecord(file.name, accountId);

            const text = await file.text();

            // Handle skipRows - remove lines before parsing
            let processedText = text;
            if (profile.skipRows && profile.skipRows > 0) {
                const lines = text.split('\n');
                processedText = lines.slice(profile.skipRows).join('\n');
            }

            const result = Papa.parse(processedText, {
                header: profile.hasHeader !== false,
                skipEmptyLines: true
            });

            let fileImported = 0;
            for (const row of result.data) {
                const transaction = mapTransaction(row, profile, importId, effectiveDateFormat);
                if (transaction) {
                    insertTransaction(transaction);
                    totalImported++;
                    fileImported++;
                }
            }

            // Update import record with count
            updateImportCount(importId, fileImported);
        }

        showLoading('Saving to database...');
        markDirty();
        await loadTransactions();
        refreshFilters();
        await loadImportHistory();
        await updateAnalytics();

        hideLoading();
        showMessage('success', `Imported ${totalImported} transactions from ${uploadedFiles.length} file(s)`);

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
    await loadTransactions();
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
            categoriesOptions += `<option value="${id}" ${selected}>${name}</option>`;
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
                subcategoriesOptions += `<option value="${id}" ${selected}>${name}</option>`;
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
            select.innerHTML += `<option value="${id}">${name}</option>`;
        });
    }
}

function closeEditCategoryModal() {
    const modal = document.getElementById('editCategoryModal');
    if (modal) modal.remove();
}

function convertToRule(description) {
    closeEditCategoryModal();
    switchTab('rules');
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
    await loadTransactions();
    refreshFilters();
    await updateAnalytics();
    closeEditCategoryModal();
    showMessage('success', 'Category updated (manual override set)');
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
// §6. UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────
// §6.1. Date & Hash Functions
// ─────────────────────────────────────────────────────────────────────────

function normalizeDate(dateStr, format) {
    if (!dateStr) return null;
    const s = dateStr.trim();

    const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };

    // Parse according to explicit format
    if (format && format !== 'auto') {

        // DD-Mon-YY or DD-Mon-YYYY (e.g. 16-Feb-26 or 16-Feb-2026)
        if (format === 'DD-Mon-YY' || format === 'DD-Mon-YYYY') {
            const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
            if (!m) return null;
            const day   = parseInt(m[1], 10);
            const month = MONTHS[m[2].toLowerCase()];
            let   year  = parseInt(m[3], 10);
            if (!month) return null;
            if (year < 100) year = year < 50 ? 2000 + year : 1900 + year;
            return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        }

        let day, month, year;
        const sep = format.includes('/') ? '/' : '-';
        const parts = s.split(sep);
        if (parts.length !== 3) return null;

        const fmt = format.split(sep);
        fmt.forEach((token, i) => {
            const val = parseInt(parts[i], 10);
            if (token === 'DD')   day   = val;
            else if (token === 'MM')   month = val;
            else if (token === 'YYYY') year  = val;
            else if (token === 'YY')   year  = val < 50 ? 2000 + val : 1900 + val;
        });

        if (!day || !month || !year) return null;
        const mm = String(month).padStart(2, '0');
        const dd = String(day).padStart(2, '0');
        return `${year}-${mm}-${dd}`;
    }

    // Auto-detect: try ISO YYYY-MM-DD first (safe, no timezone shift)
    const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

    // Auto-detect: DD-Mon-YY / DD-Mon-YYYY (e.g. 16-Feb-26)
    const monMatch = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
    if (monMatch) {
        const day   = parseInt(monMatch[1], 10);
        const month = MONTHS[monMatch[2].toLowerCase()];
        let   year  = parseInt(monMatch[3], 10);
        if (month) {
            if (year < 100) year = year < 50 ? 2000 + year : 1900 + year;
            return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        }
    }

    // Fall back to browser parsing but extract parts to avoid UTC shift
    const d = new Date(s);
    if (!isNaN(d)) {
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${d.getFullYear()}-${mm}-${dd}`;
    }
    return null;
}

// Strip thousand-separator commas before parsing (e.g. "3,142.50" → 3142.50)
// PapaParse has already split on CSV delimiters so commas in cell values are safe to remove
function parseAmount(val) {
    if (val === null || val === undefined) return 0;
    const cleaned = String(val).replace(/,/g, '');
    return parseFloat(cleaned) || 0;
}

function categorizeTransaction(description) {
    // No longer auto-categorizing with hardcoded rules
    // Use Transaction Rules (Rules tab) to set up auto-categorization
    // This ensures all categorization logic is in one place and user-controlled
    // Default to "Uncategorized" so users can see what needs manual review
    return 'Uncategorized';
}


// ═══════════════════════════════════════════════════════════════════════════
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
        if (!categoryId) {
            categoryId = dbHelpers.queryValue('SELECT id FROM categories WHERE name = ?', ['Uncategorized']);
        }

        dbHelpers.safeRun(`
            INSERT INTO transactions (import_id, date, description, amount, category_id, ignored, auto_ignored)
            VALUES (?, ?, ?, ?, ?, ?, 0)
        `, [
            transaction.import_id,
            transaction.date,
            transaction.description,
            transaction.amount,
            categoryId,
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
        return { shouldIgnore: false, category: fallbackCategory };
    }

    try {
        // Get all enabled rules ordered by priority (higher first)
        const rulesResult = db.exec(`
            SELECT tr.keyword, tr.action, c.name as category_name, tr.case_sensitive 
            FROM transaction_rules tr
            LEFT JOIN categories c ON tr.category_value = c.id
            WHERE tr.enabled = 1
            ORDER BY tr.priority DESC, tr.id ASC
        `);

        if (!rulesResult.length || !rulesResult[0].values.length) {
            return { shouldIgnore: false, category: fallbackCategory };
        }

        let shouldIgnore = false;
        let category = fallbackCategory;

        // Apply rules in priority order (first match wins for each action type)
        let ignoreRuleMatched = false;
        let categoryRuleMatched = false;

        for (const rule of rulesResult[0].values) {
            const keyword = rule[0];
            const action = rule[1];
            const categoryValue = rule[2];
            const caseSensitive = rule[3];

            // Word-boundary match: keyword must not be a substring of a larger word/phrase
            // Uses explicit boundary check instead of lookbehind for Safari < 16.4 compatibility
            const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const flags = caseSensitive ? '' : 'i';
            const pattern = new RegExp(`(^|[^\\w])${escapedKeyword}([^\\w]|$)`, flags);

            if (pattern.test(description)) {
                if (action === 'ignore' && !ignoreRuleMatched) {
                    shouldIgnore = true;
                    ignoreRuleMatched = true;
                } else if (action === 'categorize' && !categoryRuleMatched && categoryValue) {
                    category = categoryValue;
                    categoryRuleMatched = true;
                }

                // If both types of rules matched, we can stop
                if (ignoreRuleMatched && categoryRuleMatched) {
                    break;
                }
            }
        }

        return { shouldIgnore, category };
    } catch (e) {
        console.error('Error applying rules:', e);
        return { shouldIgnore: false, category: fallbackCategory };
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
            t.amount, c.name as category_name, sc.name as subcategory_name, t.ignored, t.category_id, t.subcategory_id
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
        query += ' AND t.description LIKE ?';
        params.push(`%${search}%`);
    }

    // Get total count
    const countQuery = query.replace(/SELECT[\s\S]*?FROM/, 'SELECT COUNT(*) FROM');
    const totalCount = dbHelpers.queryValue(countQuery, params) || 0;

    query += ` ORDER BY t.date DESC LIMIT ${CONFIG.PAGE_SIZE} OFFSET ${page * CONFIG.PAGE_SIZE}`;

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
            select.innerHTML += `<option value="${row[0]}">${row[0]}</option>`;
        });
    }

    select.value = currentValue;
}

function updateAccountFilter() {
    const result = db.exec(`
        SELECT DISTINCT a.id, b.name, a.account_name, a.account_number
        FROM accounts a
        JOIN banks b ON a.bank_id = b.id
        ORDER BY b.name, a.account_name
    `);
    const select = document.getElementById('filterAccount');
    const currentValue = select.value;

    select.innerHTML = '<option value="">All Accounts</option>';

    if (result.length > 0) {
        result[0].values.forEach(row => {
            const accountId = row[0];
            const bankName = row[1];
            const accountName = row[2];
            const accountNumber = row[3];
            const displayName = accountNumber 
                ? `${bankName} - ${accountName} (...${accountNumber})`
                : `${bankName} - ${accountName}`;
            select.innerHTML += `<option value="${accountId}">${displayName}</option>`;
        });
    }

    select.value = currentValue;
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
            select.innerHTML += `<option value="${categoryId}">${categoryName}</option>`;
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
            select.innerHTML += `<option value="${subId}">${subName}</option>`;
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

    // Pagination bar
    if (totalCount > CONFIG.PAGE_SIZE) {
        const start = page * CONFIG.PAGE_SIZE + 1;
        const end = Math.min((page + 1) * CONFIG.PAGE_SIZE, totalCount);
        const bar = document.createElement('div');
        bar.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:15px; padding:10px; background:#f8f9fa; border-radius:4px;';
        bar.innerHTML = `<div>Showing ${start}-${end} of ${totalCount} transactions</div>
            <div style="display:flex; gap:10px;">
                <button data-prev ${page === 0 ? 'disabled' : ''} style="padding:5px 15px;">← Previous</button>
                <span style="padding:5px 15px;">Page ${page + 1} of ${totalPages}</span>
                <button data-next ${page >= totalPages - 1 ? 'disabled' : ''} style="padding:5px 15px;">Next →</button>
            </div>`;
        bar.querySelector('[data-prev]').addEventListener('click', () => loadTransactions(page - 1));
        bar.querySelector('[data-next]').addEventListener('click', () => loadTransactions(page + 1));
        frag.appendChild(bar);
    }

    const table = document.createElement('table');
    table.innerHTML = `<thead><tr>${
        ['Account','Date','Description','Amount','Category','Actions']
            .map(c => `<th>${c}</th>`).join('')
    }</tr></thead>`;
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

        const amountClass = amount >= 0 ? 'transaction-positive' : 'transaction-negative';
        const amountStr   = amount >= 0 ? `+$${amount.toFixed(2)}` : `-$${Math.abs(amount).toFixed(2)}`;

        // Combine bank + account
        const accountDisplay = `${escapeHtml(bank)} • ${escapeHtml(account)}`;

        // Combine category + subcategory
        const categoryDisplay = categoryName === '-' 
            ? '<span style="color:#95a5a6;">Uncategorized</span>' 
            : (subcatName && subcatName !== '-' 
                ? `${escapeHtml(categoryName)} › ${escapeHtml(subcatName)}`
                : escapeHtml(categoryName));

        const tr = document.createElement('tr');
        if (ignored) tr.style.opacity = '0.5';
        tr.innerHTML = `
            <td>${accountDisplay}</td>
            <td>${date}</td>
            <td>${escapeHtml(description)}</td>
            <td class="${amountClass}">${amountStr}</td>
            <td data-cat style="cursor:pointer;text-decoration:underline;" title="Click to edit">${categoryDisplay}</td>
            <td><button data-toggle style="padding:5px 10px;font-size:12px;">${ignored ? 'Unignore' : 'Ignore'}</button></td>
        `;
        tr.querySelector('[data-cat]').addEventListener('click', () => showEditCategory(id, categoryId, subcategoryId));
        tr.querySelector('[data-toggle]').addEventListener('click', () => toggleIgnore(id, ignored ? 0 : 1));
        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    frag.appendChild(table);
    container.innerHTML = '';
    container.appendChild(frag);
}

// ═══════════════════════════════════════════════════════════════════════════
// §8. ANALYTICS & REPORTING
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────
// §8.1. Statistics Calculation
// ─────────────────────────────────────────────────────────────────────────

async function updateAnalytics() {
    // Check if manual transactions should be included
    const includeManual = dbHelpers.queryValue("SELECT value FROM settings WHERE key = 'include_manual_in_analytics'") === '1';
    const startDate = includeManual ? dbHelpers.queryValue("SELECT value FROM settings WHERE key = 'manual_analytics_start_date'") : null;

    // Monthly breakdown — last 6 months
    let monthlyQuery = `
        SELECT
            strftime('%Y-%m', date) as month,
            SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as income,
            SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as expenses,
            SUM(amount) as net
        FROM transactions
        WHERE ignored = 0
          AND date >= date('now', '-6 months', 'start of month')
        GROUP BY month
    `;

    let monthlyParams = [];
    if (includeManual && startDate) {
        monthlyQuery = `
            SELECT
                strftime('%Y-%m', date) as month,
                SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as income,
                SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as expenses,
                SUM(amount) as net
            FROM (
                SELECT date, amount FROM transactions WHERE ignored = 0
                UNION ALL
                SELECT date, amount FROM manual_transactions WHERE date >= ?
            )
            WHERE date >= date('now', '-6 months', 'start of month')
            GROUP BY month
        `;
        monthlyParams = [startDate];
    }

    monthlyQuery += ' ORDER BY month DESC';
    const monthlyResult = db.exec(monthlyQuery, monthlyParams);

    updateMonthlyTable(monthlyResult);

    // Category breakdown by month — last 6 months, expenses only
    let categoryQuery = `
        SELECT
            strftime('%Y-%m', t.date) as month,
            COALESCE(c.name, 'Uncategorized') as category_name,
            SUM(ABS(t.amount)) as total
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.amount < 0 AND t.ignored = 0
          AND t.date >= date('now', '-6 months', 'start of month')
        GROUP BY month, t.category_id
        ORDER BY month ASC, total DESC
    `;

    let categoryParams = [];
    if (includeManual && startDate) {
        categoryQuery = `
            SELECT
                month, category_name, SUM(total) as total
            FROM (
                SELECT
                    strftime('%Y-%m', t.date) as month,
                    COALESCE(c.name, 'Uncategorized') as category_name,
                    ABS(t.amount) as total,
                    t.category_id
                FROM transactions t
                LEFT JOIN categories c ON t.category_id = c.id
                WHERE t.amount < 0 AND t.ignored = 0
                  AND t.date >= date('now', '-6 months', 'start of month')
                UNION ALL
                SELECT
                    strftime('%Y-%m', mt.date) as month,
                    COALESCE(c.name, 'Uncategorized') as category_name,
                    ABS(mt.amount) as total,
                    mt.category_id
                FROM manual_transactions mt
                LEFT JOIN categories c ON mt.category_id = c.id
                WHERE mt.amount < 0 AND mt.date >= ?
                  AND mt.date >= date('now', '-6 months', 'start of month')
            )
            GROUP BY month, category_id
            ORDER BY month ASC, total DESC
        `;
        categoryParams = [startDate];
    }

    const categoryResult = db.exec(categoryQuery, categoryParams);

    updateCategoryChart(categoryResult);

    // Last transaction date per account (no change - manual transactions don't have accounts)
    const lastTxResult = db.exec(`
        SELECT
            b.name        as bank_name,
            a.account_name,
            a.account_number,
            MAX(t.date)   as last_date,
            COUNT(t.id)   as tx_count
        FROM accounts a
        JOIN banks b ON a.bank_id = b.id
        LEFT JOIN imports i ON i.account_id = a.id
        LEFT JOIN transactions t ON t.import_id = i.id AND t.ignored = 0
        GROUP BY a.id
        ORDER BY last_date ASC, b.name, a.account_name
    `);

    updateLastTransactionTable(lastTxResult);

    // Initialize and load category detail tags view
    if (!tagViewMonth) {
        tagViewMonth = new Date().toISOString().slice(0, 7);
    }
    updateTagViewMonthLabel();
    renderCategoryDetailTags();
}


function extractShortLabel(description, ruleKeyword = null) {
    // If matched a rule, use the rule keyword
    if (ruleKeyword) return ruleKeyword.slice(0, 20).toUpperCase();

    // Strip common prefixes
    let cleaned = description.toUpperCase().trim();
    const prefixes = ['PAYMENT TO ', 'PAYMENT ', 'PURCHASE AT ', 'PURCHASE ', 'TRANSFER FROM ', 'TRANSFER TO ', 'TRANSFER ', 'DEBIT ', 'CREDIT '];
    for (const prefix of prefixes) {
        if (cleaned.startsWith(prefix)) {
            cleaned = cleaned.substring(prefix.length);
            break;
        }
    }

    // Remove common connectors at start
    cleaned = cleaned.replace(/^(TO|AT|FROM)\s+/i, '');

    // Split into words
    const words = cleaned.split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) return description.slice(0, 20).toUpperCase();

    // Remove common trailing words (country codes, generic terms)
    const trailingJunk = ['SINGAPORE', 'SGP', 'SG', 'CARD', 'ONLINE', 'INTERNET', 'PAYMENT'];
    while (words.length > 1 && trailingJunk.includes(words[words.length - 1])) {
        words.pop();
    }

    // Take first 1-2 meaningful words
    let label;
    if (words.length === 1) {
        label = words[0];
    } else {
        // If first word is very short (<4 chars) or looks like a prefix (e.g., "SISTIC*"), include second word
        const firstWord = words[0];
        if (firstWord.length < 4 || firstWord.includes('*') || firstWord.includes('.')) {
            label = words.slice(0, 2).join(' ');
        } else {
            label = firstWord;
        }
    }

    return label.slice(0, 20);
}

function expandTagToTransactions(bodyContainer, label, group, categoryColor) {
    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    // Create modal content
    const modalContent = document.createElement('div');
    modalContent.className = 'modal-content';

    // Modal header
    const header = document.createElement('div');
    header.className = 'modal-header';
    header.innerHTML = `
        <div>
            <h3 style="margin: 0; color: #2c3e50;">${escapeHtml(label)}</h3>
            <div style="font-size: 13px; color: #7f8c8d; margin-top: 4px;">
                ${group.count} transaction${group.count !== 1 ? 's' : ''} • 
                Total: <strong style="color: #e74c3c;">$${group.total.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</strong>
            </div>
        </div>
        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button>
    `;

    // Modal body with transaction table
    const body = document.createElement('div');
    body.className = 'modal-body';

    const table = document.createElement('table');
    table.style.width = '100%';
    table.innerHTML = `
        <thead>
            <tr style="border-bottom: 2px solid #ecf0f1;">
                <th style="text-align:left; padding:10px 8px; font-size:11px; color:#7f8c8d; font-weight:600; text-transform:uppercase;">Date</th>
                <th style="text-align:left; padding:10px 8px; font-size:11px; color:#7f8c8d; font-weight:600; text-transform:uppercase;">Description</th>
                <th style="text-align:right; padding:10px 8px; font-size:11px; color:#7f8c8d; font-weight:600; text-transform:uppercase;">Amount</th>
            </tr>
        </thead>
    `;

    const tbody = document.createElement('tbody');
    group.transactions.forEach(tx => {
        const tr = document.createElement('tr');
        tr.style.cssText = 'border-bottom:1px solid #f8f9fa;';
        tr.innerHTML = `
            <td style="padding:10px 8px; font-size:12px; color:#7f8c8d; white-space:nowrap;">${tx.date}</td>
            <td style="padding:10px 8px; font-size:13px; color:#2c3e50;">${escapeHtml(tx.desc)}</td>
            <td style="padding:10px 8px; text-align:right; font-weight:600; color:#e74c3c; white-space:nowrap;">$${Math.abs(tx.amount).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
        `;
        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    body.appendChild(table);

    // Assemble modal
    modalContent.appendChild(header);
    modalContent.appendChild(body);
    overlay.appendChild(modalContent);

    // Close on overlay click (but not on modal content click)
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            overlay.remove();
        }
    });

    // Close on Escape key
    const escapeHandler = (e) => {
        if (e.key === 'Escape') {
            overlay.remove();
            document.removeEventListener('keydown', escapeHandler);
        }
    };
    document.addEventListener('keydown', escapeHandler);

    // Add to page
    document.body.appendChild(overlay);
}

let tagViewMonth = null; // Will be initialized on first analytics load

function changeTagMonth(offset) {
    const [y, m] = tagViewMonth.split('-').map(Number);
    const date = new Date(y, m - 1 + offset, 1);
    // Use local date to avoid timezone issues
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    tagViewMonth = `${year}-${month}`;
    renderCategoryDetailTags();
    updateTagViewMonthLabel();
}

function updateTagViewMonthLabel() {
    const [y, m] = tagViewMonth.split('-');
    const label = new Date(+y, +m - 1).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
    document.getElementById('tagViewMonthLabel').textContent = label;

    const currentMonth = new Date().toISOString().slice(0, 7);
    const isCurrentMonth = tagViewMonth === currentMonth;
    const nextBtn = document.getElementById('tagViewNextBtn');
    if (nextBtn) {
        nextBtn.disabled = isCurrentMonth;
    }
}

function renderCategoryDetailTags() {
    const container = document.getElementById('categoryDetailTags');

    // Check if manual transactions should be included
    const includeManual = dbHelpers.queryValue("SELECT value FROM settings WHERE key = 'include_manual_in_analytics'") === '1';
    const startDate = includeManual ? dbHelpers.queryValue("SELECT value FROM settings WHERE key = 'manual_analytics_start_date'") : null;

    // Query transactions for selected month only
    let query = `
        SELECT
            COALESCE(c.name, 'Uncategorized') as category_name,
            c.icon as category_icon,
            c.color as category_color,
            c.id as category_id,
            t.id,
            t.description,
            t.amount,
            t.date
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.amount < 0 AND t.ignored = 0
          AND strftime('%Y-%m', t.date) = ?
        ORDER BY category_name, t.date DESC
    `;

    const params = [tagViewMonth];

    if (includeManual && startDate) {
        query = `
            SELECT
                category_name, category_icon, category_color, category_id, id, description, amount, date
            FROM (
                SELECT
                    COALESCE(c.name, 'Uncategorized') as category_name,
                    c.icon as category_icon,
                    c.color as category_color,
                    c.id as category_id,
                    t.id,
                    t.description,
                    t.amount,
                    t.date
                FROM transactions t
                LEFT JOIN categories c ON t.category_id = c.id
                WHERE t.amount < 0 AND t.ignored = 0
                  AND strftime('%Y-%m', t.date) = ?
                UNION ALL
                SELECT
                    COALESCE(c.name, 'Uncategorized') as category_name,
                    COALESCE(c.icon, '📦') as category_icon,
                    COALESCE(c.color, '#95a5a6') as category_color,
                    c.id as category_id,
                    mt.id,
                    mt.description,
                    mt.amount,
                    mt.date
                FROM manual_transactions mt
                LEFT JOIN categories c ON mt.category_id = c.id
                WHERE mt.amount < 0 AND strftime('%Y-%m', mt.date) = ?
                  AND mt.date >= ?
            )
            ORDER BY category_name, date DESC
        `;
        params.push(tagViewMonth, startDate); // Second and third parameters for manual_transactions query
    }

    const result = db.exec(query, params);

    if (!result.length || !result[0].values.length) {
        container.innerHTML = '<div class="loading">No expense transactions found for this month</div>';
        return;
    }

    // Fetch budget limits for all categories
    const budgetData = {};
    const budgetResult = dbHelpers.queryAll(`
        SELECT c.name, b.monthly_limit
        FROM categories c
        LEFT JOIN budget b ON b.category_id = c.id
        WHERE b.monthly_limit IS NOT NULL AND b.monthly_limit > 0
    `);
    budgetResult.forEach(row => {
        budgetData[row[0]] = row[1];
    });

    // Get all rules for label matching
    const rules = dbHelpers.queryAll('SELECT keyword FROM transaction_rules WHERE enabled = 1');
    const ruleKeywords = new Set(rules.map(r => r[0].toLowerCase()));

    // Calculate monthly totals (income, expenses, budget)
    let totalIncome = 0;
    let totalExpenses = 0;
    let totalBudget = 0;

    result[0].values.forEach(row => {
        const amount = row[6]; // amount is at index 6
        if (amount < 0) {
            totalExpenses += Math.abs(amount);
        }
    });

    // Get income for this month
    let incomeQuery = `
        SELECT SUM(amount) FROM transactions 
        WHERE amount > 0 AND ignored = 0 AND strftime('%Y-%m', date) = ?
    `;
    if (includeManual && startDate) {
        incomeQuery = `
            SELECT SUM(amount) FROM (
                SELECT amount FROM transactions WHERE amount > 0 AND ignored = 0 AND strftime('%Y-%m', date) = ?
                UNION ALL
                SELECT amount FROM manual_transactions WHERE amount > 0 AND strftime('%Y-%m', date) = ? AND date >= ?
            )
        `;
    }
    const incomeParams = includeManual && startDate ? [tagViewMonth, tagViewMonth, startDate] : [tagViewMonth];
    const incomeResult = db.exec(incomeQuery, incomeParams);
    if (incomeResult.length && incomeResult[0].values[0][0]) {
        totalIncome = incomeResult[0].values[0][0];
    }

    // Calculate total budget (sum of all category budgets)
    Object.values(budgetData).forEach(limit => {
        totalBudget += limit;
    });

    // Group transactions by category
    const categoryGroups = {};
    result[0].values.forEach(row => {
        const [catName, catIcon, catColor, catId, txId, desc, amount, date] = row;
        if (!categoryGroups[catName]) {
            categoryGroups[catName] = {
                icon: catIcon || '📦',
                color: catColor || '#95a5a6',
                budget: budgetData[catName] || null,
                transactions: []
            };
        }
        categoryGroups[catName].transactions.push({ txId, desc, amount, date });
    });

    const frag = document.createDocumentFragment();

    // Add monthly summary header
    const summaryHeader = document.createElement('div');
    summaryHeader.style.cssText = 'background:#f8f9fa; border:1px solid #dee2e6; border-radius:8px; padding:16px 20px; margin-bottom:20px; display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:20px;';

    const netAmount = totalIncome - totalExpenses;
    const netColor = netAmount >= 0 ? '#27ae60' : '#e74c3c';
    const budgetColor = totalExpenses > totalBudget ? '#e74c3c' : '#27ae60';

    summaryHeader.innerHTML = `
        <div>
            <div style="font-size:11px; color:#7f8c8d; font-weight:600; margin-bottom:6px; text-transform:uppercase;">Total Income</div>
            <div style="font-size:20px; font-weight:700; color:#27ae60;">$${totalIncome.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
        </div>
        <div>
            <div style="font-size:11px; color:#7f8c8d; font-weight:600; margin-bottom:6px; text-transform:uppercase;">Total Expenses</div>
            <div style="font-size:20px; font-weight:700; color:#e74c3c;">$${totalExpenses.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
        </div>
        <div>
            <div style="font-size:11px; color:#7f8c8d; font-weight:600; margin-bottom:6px; text-transform:uppercase;">Total Budget</div>
            <div style="font-size:20px; font-weight:700; color:${budgetColor};">$${totalBudget.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
        </div>
        <div>
            <div style="font-size:11px; color:#7f8c8d; font-weight:600; margin-bottom:6px; text-transform:uppercase;">Net</div>
            <div style="font-size:20px; font-weight:700; color:${netColor};">${netAmount >= 0 ? '+' : ''}$${Math.abs(netAmount).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
        </div>
    `;
    frag.appendChild(summaryHeader);

    Object.keys(categoryGroups).sort().forEach(catName => {
        const cat = categoryGroups[catName];
        const total = cat.transactions.reduce((sum, tx) => sum + Math.abs(tx.amount), 0);

        // Aggregate transactions by label
        const labelGroups = {}; // labelGroups[label] = { count, total, descriptions[] }

        cat.transactions.forEach(tx => {
            // Check if description matches any rule keyword (word-boundary, same as applyTransactionRules)
            let matchedKeyword = null;
            for (const keyword of ruleKeywords) {
                const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const pattern = new RegExp(`(^|[^\\w])${escapedKeyword}([^\\w]|$)`, 'i');
                if (pattern.test(tx.desc)) {
                    matchedKeyword = keyword;
                    break;
                }
            }

            const label = extractShortLabel(tx.desc, matchedKeyword);

            if (!labelGroups[label]) {
                labelGroups[label] = { count: 0, total: 0, transactions: [] };
            }
            labelGroups[label].count++;
            labelGroups[label].total += Math.abs(tx.amount);
            labelGroups[label].transactions.push(tx);
        });

        const section = document.createElement('div');
        section.style.cssText = 'border:1px solid #ecf0f1; border-radius:8px; margin-bottom:12px; overflow:hidden;';

        const header = document.createElement('div');
        header.style.cssText = `display:flex; align-items:center; justify-content:space-between; padding:12px 16px; background:${cat.color}15; cursor:pointer; user-select:none;`;

        let amountDisplay = `<div style="font-weight:600; color:${cat.color};">$${total.toFixed(2)}</div>`;
        if (cat.budget) {
            const budgetColor = total > cat.budget ? '#e74c3c' : '#27ae60';
            amountDisplay = `
                <div style="text-align:right;">
                    <div style="font-weight:600; color:${cat.color};">$${total.toFixed(2)}</div>
                    <div style="font-size:11px; color:${budgetColor};">Budget: $${cat.budget.toFixed(2)}</div>
                </div>
            `;
        }

        header.innerHTML = `
            <div style="display:flex; align-items:center; gap:10px;">
                <span data-arrow style="color:${cat.color}; font-size:12px; transition:transform .2s;">▶</span>
                <span style="font-size:18px;">${cat.icon}</span>
                <span style="font-weight:600; font-size:14px;">${escapeHtml(catName)}</span>
                <span style="color:#95a5a6; font-size:12px;">${Object.keys(labelGroups).length} unique · ${cat.transactions.length} total</span>
            </div>
            ${amountDisplay}
        `;

        const body = document.createElement('div');
        body.style.cssText = 'display:none; padding:12px; flex-wrap:wrap; gap:6px;';

        // Sort labels by total amount descending
        const sortedLabels = Object.entries(labelGroups).sort((a, b) => b[1].total - a[1].total);

        sortedLabels.forEach(([label, group]) => {
            const tag = document.createElement('div');
            tag.style.cssText = 'display:inline-flex; align-items:center; gap:6px; background:white; border:1px solid #dee2e6; border-radius:12px; padding:4px 10px; font-size:12px; cursor:pointer; transition:all .15s;';
            tag.title = 'Click to view transactions';
            tag.innerHTML = `
                <span style="font-weight:500; color:#2c3e50;">${escapeHtml(label)}</span>
                ${group.count > 1 ? `<span style="font-size:10px; color:#95a5a6; background:#f8f9fa; padding:1px 5px; border-radius:8px;">x${group.count}</span>` : ''}
                <span style="color:#e74c3c; font-weight:600;">$${group.total.toFixed(2)}</span>
            `;
            tag.onmouseenter = () => tag.style.boxShadow = '0 2px 6px rgba(0,0,0,0.1)';
            tag.onmouseleave = () => tag.style.boxShadow = 'none';
            tag.onclick = (e) => {
                e.stopPropagation();
                expandTagToTransactions(body, label, group, cat.color);
            };
            body.appendChild(tag);
        });

        section.appendChild(header);
        section.appendChild(body);

        header.addEventListener('click', () => {
            const isOpen = body.style.display === 'flex';
            body.style.display = isOpen ? 'none' : 'flex';
            header.querySelector('[data-arrow]').textContent = isOpen ? '▶' : '▼';
        });

        frag.appendChild(section);
    });

    container.innerHTML = '';
    container.appendChild(frag);
}

// ─────────────────────────────────────────────────────────────────────────
// §8.2. Charts (Monthly Trend, Categories)
// ─────────────────────────────────────────────────────────────────────────

function updateMonthlyTable(result) {
    const container = document.getElementById('monthlyBreakdownTable');

    if (!result.length || !result[0].values.length) {
        container.innerHTML = '<div class="loading">No data</div>';
        return;
    }

    const table = document.createElement('table');
    table.innerHTML = `
        <thead><tr>
            <th style="width:40%">Month</th>
            <th style="text-align:right;">Income</th>
            <th style="text-align:right;">Expenses</th>
            <th style="text-align:right;">Net</th>
        </tr></thead>
    `;
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);

    result[0].values.forEach(row => {
        const [month, income, expenses, net] = row;
        if (!month) return;
        const [year, m] = month.split('-');
        const label = new Date(+year, m - 1).toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
        const netClass = net >= 0 ? 'transaction-positive' : 'transaction-negative';
        const netSign = net >= 0 ? '+' : '-';

        const monthRow = document.createElement('tr');
        monthRow.style.cursor = 'pointer';
        monthRow.style.userSelect = 'none';
        monthRow.innerHTML = `
            <td><span style="margin-right:6px; font-size:11px;">▶</span><strong>${label}</strong></td>
            <td class="transaction-positive" style="text-align:right;">$${income.toFixed(2)}</td>
            <td class="transaction-negative" style="text-align:right;">$${expenses.toFixed(2)}</td>
            <td class="${netClass}" style="text-align:right;">${netSign}$${Math.abs(net).toFixed(2)}</td>
        `;
        tbody.appendChild(monthRow);

        // Placeholder row for category subtotals (inserted after monthRow)
        let catGroupRow = null;

        monthRow.addEventListener('click', () => {
            const arrow = monthRow.querySelector('span');
            if (catGroupRow) {
                // Collapse
                catGroupRow.remove();
                catGroupRow = null;
                arrow.textContent = '▶';
            } else {
                // Expand categories
                arrow.textContent = '▼';
                catGroupRow = document.createElement('tr');
                const td = document.createElement('td');
                td.colSpan = 4;
                td.style.padding = '0';
                td.appendChild(buildCategorySubtable(month));
                catGroupRow.appendChild(td);
                monthRow.insertAdjacentElement('afterend', catGroupRow);
            }
        });
    });

    container.innerHTML = '';
    container.appendChild(table);
}

function buildCategorySubtable(month) {
    const rows = dbHelpers.queryAll(`
        SELECT
            COALESCE(c.name, 'Uncategorized') as category,
            SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) as income,
            SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END) as expenses,
            SUM(t.amount) as net,
            t.category_id
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.ignored = 0
          AND strftime('%Y-%m', t.date) = ?
        GROUP BY t.category_id
        ORDER BY expenses DESC, income DESC
    `, [month]);

    const wrap = document.createElement('div');
    wrap.style.cssText = 'background:#f8f9fa; border-left:3px solid #3498db; margin:2px 0;';

    const inner = document.createElement('table');
    inner.style.cssText = 'width:100%; font-size:13px;';
    inner.innerHTML = `<thead><tr style="background:#eaf4fb;">
        <th style="padding:6px 8px 6px 32px; width:40%; font-weight:600; color:#2980b9;">Category</th>
        <th style="text-align:right; padding:6px 8px; font-weight:600; color:#2980b9;">Income</th>
        <th style="text-align:right; padding:6px 8px; font-weight:600; color:#2980b9;">Expenses</th>
        <th style="text-align:right; padding:6px 8px; font-weight:600; color:#2980b9;">Net</th>
    </tr></thead>`;
    const catBody = document.createElement('tbody');
    inner.appendChild(catBody);
    wrap.appendChild(inner);

    rows.forEach(row => {
        const [category, income, expenses, net, categoryId] = row;
        const netClass = net >= 0 ? 'transaction-positive' : 'transaction-negative';
        const netSign = net >= 0 ? '+' : '-';

        const catRow = document.createElement('tr');
        catRow.style.cursor = 'pointer';
        catRow.style.userSelect = 'none';
        catRow.innerHTML = `
            <td style="padding:5px 8px 5px 32px;">
                <span style="margin-right:6px; font-size:10px;">▶</span>${escapeHtml(category)}
            </td>
            <td class="transaction-positive" style="text-align:right; padding:5px 8px;">
                ${income > 0 ? '$' + income.toFixed(2) : '—'}
            </td>
            <td class="transaction-negative" style="text-align:right; padding:5px 8px;">
                ${expenses > 0 ? '$' + expenses.toFixed(2) : '—'}
            </td>
            <td class="${netClass}" style="text-align:right; padding:5px 8px;">
                ${netSign}$${Math.abs(net).toFixed(2)}
            </td>
        `;
        catBody.appendChild(catRow);

        let txGroupRow = null;

        catRow.addEventListener('click', e => {
            e.stopPropagation();
            const arrow = catRow.querySelector('span');
            if (txGroupRow) {
                txGroupRow.remove();
                txGroupRow = null;
                arrow.textContent = '▶';
            } else {
                arrow.textContent = '▼';
                txGroupRow = document.createElement('tr');
                const td = document.createElement('td');
                td.colSpan = 4;
                td.style.padding = '0';
                td.appendChild(buildTransactionSubtable(month, categoryId));
                txGroupRow.appendChild(td);
                catRow.insertAdjacentElement('afterend', txGroupRow);
            }
        });
    });

    return wrap;
}

function buildTransactionSubtable(month, categoryId) {
    const params = categoryId === null
        ? [month]
        : [month, categoryId];
    const categoryFilter = categoryId === null
        ? 'AND t.category_id IS NULL'
        : 'AND t.category_id = ?';

    const rows = dbHelpers.queryAll(`
        SELECT t.date, t.description, t.amount, b.name, a.account_name
        FROM transactions t
        JOIN imports i ON t.import_id = i.id
        JOIN accounts a ON i.account_id = a.id
        JOIN banks b ON a.bank_id = b.id
        WHERE t.ignored = 0
          AND strftime('%Y-%m', t.date) = ?
          ${categoryFilter}
        ORDER BY t.date DESC, t.amount ASC
    `, params);

    const wrap = document.createElement('div');
    wrap.style.cssText = 'background:#fff; border-left:3px solid #27ae60; margin:0;';

    if (!rows.length) {
        wrap.innerHTML = '<div style="padding:8px 16px 8px 56px; color:#95a5a6; font-size:12px;">No transactions</div>';
        return wrap;
    }

    const inner = document.createElement('table');
    inner.style.cssText = 'width:100%; font-size:12px;';
    inner.innerHTML = `<thead><tr style="background:#eafaf1;">
        <th style="padding:5px 8px 5px 56px; width:10%; font-weight:600; color:#27ae60;">Date</th>
        <th style="padding:5px 8px; font-weight:600; color:#27ae60;">Description</th>
        <th style="padding:5px 8px; font-weight:600; color:#27ae60;">Account</th>
        <th style="text-align:right; padding:5px 8px; font-weight:600; color:#27ae60;">Amount</th>
    </tr></thead>`;
    const txBody = document.createElement('tbody');
    inner.appendChild(txBody);

    rows.forEach(row => {
        const [date, description, amount, bank, account] = row;
        const amtClass = amount >= 0 ? 'transaction-positive' : 'transaction-negative';
        const amtStr = amount >= 0 ? `+$${amount.toFixed(2)}` : `-$${Math.abs(amount).toFixed(2)}`;

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="padding:4px 8px 4px 56px; white-space:nowrap;">${date}</td>
            <td style="padding:4px 8px;">${escapeHtml(description || '')}</td>
            <td style="padding:4px 8px; color:#7f8c8d;">${escapeHtml(bank)} · ${escapeHtml(account)}</td>
            <td class="${amtClass}" style="text-align:right; padding:4px 8px;">${amtStr}</td>
        `;
        txBody.appendChild(tr);
    });

    wrap.appendChild(inner);
    return wrap;
}


function updateLastTransactionTable(result) {
    const container = document.getElementById('lastTransactionTable');
    if (!container) return;

    if (!result.length || !result[0].values.length) {
        container.innerHTML = '<div class="loading">No accounts found</div>';
        return;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let html = `
        <table>
            <thead><tr>
                <th>Bank</th>
                <th>Account</th>
                <th style="text-align:right;">Transactions</th>
                <th style="text-align:right;">Last Transaction</th>
                <th style="text-align:right;">Days Ago</th>
            </tr></thead>
            <tbody>
    `;

    result[0].values.forEach(row => {
        const [bankName, accountName, accountNumber, lastDate, txCount] = row;
        const displayName = accountNumber ? `${accountName} (···${accountNumber})` : accountName;

        let lastDateDisplay, daysAgo, rowStyle = '', daysStyle = '';

        if (lastDate) {
            const [y, m, d] = lastDate.split('-').map(Number);
            const last = new Date(y, m - 1, d);
            const days = Math.round((today - last) / 86400000);
            lastDateDisplay = last.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
            daysAgo = days;

            if (days > 60)       { daysStyle = 'color:#e74c3c; font-weight:bold;'; }
            else if (days > 30)  { daysStyle = 'color:#f39c12; font-weight:bold;'; }
            else                 { daysStyle = 'color:#27ae60;'; }
        } else {
            lastDateDisplay = '—';
            daysAgo = '—';
            rowStyle = 'opacity:0.55;';
            daysStyle = 'color:#95a5a6;';
        }

        html += `<tr style="${rowStyle}">
            <td>${escapeHtml(bankName)}</td>
            <td>${escapeHtml(displayName)}</td>
            <td style="text-align:right;">${txCount || 0}</td>
            <td style="text-align:right;">${lastDateDisplay}</td>
            <td style="text-align:right; ${daysStyle}">${daysAgo !== '—' ? daysAgo + 'd' : '—'}</td>
        </tr>`;
    });

    html += '</tbody></table>';
    container.innerHTML = html;
}

function updateCategoryChart(result) {
    const ctx = document.getElementById('categoryChart');

    if (categoryChart) {
        categoryChart.destroy();
    }

    if (!result.length || !result[0].values.length) return;

    const COLORS = [
        '#3498db', '#e74c3c', '#2ecc71', '#f39c12', '#9b59b6',
        '#1abc9c', '#34495e', '#e67e22', '#95a5a6', '#16a085',
        '#d35400', '#8e44ad', '#27ae60', '#2980b9', '#c0392b'
    ];

    // Collect all months and categories from the result rows
    const monthSet = new Set();
    const categorySet = new Set();
    const dataMap = {};  // dataMap[month][category] = total

    result[0].values.forEach(row => {
        const [month, category, total] = row;
        if (!month) return;
        monthSet.add(month);
        categorySet.add(category);
        if (!dataMap[month]) dataMap[month] = {};
        dataMap[month][category] = total;
    });

    const months = [...monthSet].sort();
    const categories = [...categorySet];

    // Format month labels as "Jan 2025"
    const labels = months.map(m => {
        const [year, mo] = m.split('-');
        return new Date(year, mo - 1).toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
    });

    // One dataset per category
    const datasets = categories.map((cat, i) => ({
        label: cat,
        data: months.map(m => dataMap[m]?.[cat] || 0),
        backgroundColor: COLORS[i % COLORS.length],
    }));

    categoryChart = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets },
        options: {
            responsive: true,
            scales: {
                x: { stacked: true },
                y: {
                    stacked: true,
                    beginAtZero: true,
                    ticks: {
                        callback: val => '$' + val.toLocaleString()
                    }
                }
            },
            plugins: {
                legend: { position: 'bottom' },
                tooltip: {
                    callbacks: {
                        label: ctx => ` ${ctx.dataset.label}: $${ctx.parsed.y.toFixed(2)}`
                    }
                }
            }
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────
// §8.3. Export Functions
// ─────────────────────────────────────────────────────────────────────────

function exportToCSV() {
    const result = db.exec('SELECT * FROM transactions WHERE ignored = 0 ORDER BY date DESC');

    if (!result.length) {
        alert('No transactions to export');
        return;
    }

    const columns = result[0].columns;
    const rows = result[0].values;

    let csv = columns.join(',') + '\n';
    rows.forEach(row => {
        csv += row.map(cell => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',') + '\n';
    });

    downloadFile(csv, 'transactions.csv', 'text/csv');
}

function downloadDatabase() {
    const data = db.export();
    const blob = new Blob([data], { type: 'application/x-sqlite3' });
    downloadFile(blob, 'bank_statements.db', 'application/x-sqlite3');
}

function downloadFile(content, filename, type) {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────────────────────────────────
// §8.4. Report Generator (static HTML, no JS — for sharing via email)
// ─────────────────────────────────────────────────────────────────────────

function exportReport() {
    const html = buildReportHTML();
    const date = new Date().toISOString().slice(0, 10);
    downloadFile(html, `financial-report-${date}.html`, 'text/html');
    showMessage('success', 'Report downloaded — email it as an attachment. Opens in Quick Look on iPhone with no app needed.');
}

function buildReportHTML() {
    const generated = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    const currentMonth = new Date().toISOString().slice(0, 7);

    // ── Query all data ────────────────────────────────────────────────────

    // Overall stats
    const statsRows = dbHelpers.queryAll(`
        SELECT COUNT(*), 
            COALESCE(SUM(CASE WHEN amount>0 THEN amount ELSE 0 END),0),
            COALESCE(SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END),0),
            COALESCE(SUM(amount),0)
        FROM transactions WHERE ignored=0`);
    const [txCount, totalIncome, totalExpenses, totalNet] = statsRows[0] || [0,0,0,0];

    // Monthly trend — last 6 months
    const monthlyRows = dbHelpers.queryAll(`
        SELECT strftime('%Y-%m', date) as mo,
            SUM(CASE WHEN amount>0 THEN amount ELSE 0 END),
            SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END),
            SUM(amount)
        FROM transactions WHERE ignored=0
          AND date >= date('now','-6 months','start of month')
        GROUP BY mo ORDER BY mo ASC`);

    // Category spend — last 6 months expenses
    const catRows = dbHelpers.queryAll(`
        SELECT COALESCE(c.name,'Uncategorized') as cat,
            COALESCE(c.icon,'📦') as icon,
            COALESCE(c.color,'#95a5a6') as color,
            strftime('%Y-%m', t.date) as mo,
            SUM(ABS(t.amount)) as total
        FROM transactions t
        LEFT JOIN categories c ON t.category_id=c.id
        WHERE t.amount<0 AND t.ignored=0
          AND t.date >= date('now','-6 months','start of month')
        GROUP BY cat, mo ORDER BY cat, mo`);

    // Budget — current month
    const budgetRows = dbHelpers.queryAll(`
        SELECT c.name, c.icon, c.color,
            COALESCE(b.monthly_limit,0) as lim,
            COALESCE((SELECT ABS(SUM(t.amount)) FROM transactions t
                WHERE t.category_id=c.id AND t.ignored=0 AND t.amount<0
                AND strftime('%Y-%m',t.date)=?),0) as spent
        FROM categories c
        LEFT JOIN budget b ON b.category_id=c.id
        WHERE COALESCE(b.monthly_limit,0)>0
        ORDER BY c.sort_order, c.name`, [currentMonth]);

    // Planner
    const plannerRows = dbHelpers.queryAll(`
        SELECT ec.description, ec.amount, ec.type, ec.payment_dates, ec.active_months,
            COALESCE(c.name,'Uncategorised') as cat, COALESCE(c.icon,'📦') as icon,
            COALESCE(c.color,'#95a5a6') as color
        FROM expense_commitments ec
        LEFT JOIN categories c ON ec.category_id=c.id
        WHERE ec.enabled=1
        ORDER BY c.sort_order, c.name, ec.type DESC, ec.description`);

    const varRow = dbHelpers.queryAll(`SELECT value FROM planner_settings WHERE key='variable_spend'`);
    const variableSpend = varRow.length ? parseFloat(varRow[0][0]) : 0;

    // ── Build report months list ──────────────────────────────────────────
    const months = plannerMonths(); // reuse existing helper

    // ── Render sections ───────────────────────────────────────────────────
    const analyticsHTML  = rpt_analytics(statsRows[0], monthlyRows, catRows);
    const budgetHTML     = rpt_budget(budgetRows, currentMonth);
    const plannerHTML    = rpt_planner(plannerRows, variableSpend, months);

    // ── Shell ─────────────────────────────────────────────────────────────
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Financial Report — ${generated}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f2f5;color:#2c3e50;font-size:14px;line-height:1.5;}
.shell{max-width:900px;margin:0 auto;padding:24px 16px;}
h1{font-size:22px;font-weight:800;color:#2c3e50;margin-bottom:4px;}
h2{font-size:15px;font-weight:700;color:#2c3e50;margin:28px 0 12px;padding-bottom:6px;border-bottom:2px solid #ecf0f1;}
.meta{font-size:12px;color:#95a5a6;margin-bottom:28px;}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px;}
.card{background:white;border:1px solid #ecf0f1;border-radius:8px;padding:14px 16px;}
.card-label{font-size:11px;color:#7f8c8d;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;}
.card-value{font-size:20px;font-weight:700;}
.card-sub{font-size:11px;color:#95a5a6;margin-top:3px;}
table{width:100%;border-collapse:collapse;background:white;border-radius:8px;overflow:hidden;margin-bottom:20px;border:1px solid #ecf0f1;}
th{background:#f8f9fa;padding:9px 12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#7f8c8d;text-align:left;border-bottom:2px solid #dee2e6;}
th.r,td.r{text-align:right;}
td{padding:9px 12px;border-bottom:1px solid #f5f5f5;font-size:13px;}
tr:last-child td{border-bottom:none;}
.bar-wrap{background:#f0f0f0;border-radius:3px;height:6px;margin-top:4px;overflow:hidden;}
.bar{height:6px;border-radius:3px;}
.pos{color:#27ae60;font-weight:600;}
.neg{color:#e74c3c;font-weight:600;}
.neutral{color:#7f8c8d;}
details{background:white;border:1px solid #ecf0f1;border-radius:8px;margin-bottom:10px;overflow:hidden;}
details summary{padding:12px 16px;cursor:pointer;font-weight:700;font-size:13px;list-style:none;display:flex;align-items:center;gap:8px;user-select:none;}
details summary::-webkit-details-marker{display:none;}
details summary::after{content:'▶';margin-left:auto;font-size:11px;color:#95a5a6;}
details[open] summary::after{content:'▼';}
.det-body{padding:0 0 4px;}
.section-meta{font-size:12px;color:#95a5a6;margin-left:auto;margin-right:8px;font-weight:400;}
.fund-card{background:white;border:2px solid #27ae60;border-radius:10px;padding:18px 22px;display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;}
.fund-label{font-size:12px;color:#7f8c8d;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;}
.fund-value{font-size:28px;font-weight:800;color:#27ae60;}
.fund-avg{font-size:12px;color:#95a5a6;margin-top:2px;}
.svg-wrap{background:white;border:1px solid #ecf0f1;border-radius:8px;padding:16px;margin-bottom:20px;overflow-x:auto;}
footer{text-align:center;font-size:11px;color:#bdc3c7;margin-top:32px;padding-top:16px;border-top:1px solid #ecf0f1;}
</style>
</head>
<body>
<div class="shell">
  <h1>💳 Financial Report</h1>
  <div class="meta">Generated ${generated} · Read-only summary</div>

  ${analyticsHTML}
  ${budgetHTML}
  ${plannerHTML}

  <footer>Generated by Bank Statement Consolidator · ${generated}</footer>
</div>
</body>
</html>`;
}

// ── Section renderers (pure string → no DOM, no JS in output) ────────────

function rpt_fmt(n) { return `S$${Math.abs(n).toFixed(2)}`; }
function rpt_esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function rpt_analytics(stats, monthlyRows, catRows) {
    // Monthly trend table + SVG bar chart
    if (!monthlyRows.length) return `<h2>📊 Analytics — Last 6 Months</h2><p class="neutral">No transaction data.</p>`;

    const maxExp = Math.max(...monthlyRows.map(r => r[2]), 1);
    const maxInc = Math.max(...monthlyRows.map(r => r[1]), 1);
    const BAR_MAX = 220, BAR_H = 28, GAP = 8;
    const chartW = monthlyRows.length * (BAR_H * 2 + GAP + 10) + 60;
    const chartH = BAR_MAX + 50;

    let bars = '', xLabels = '';
    monthlyRows.forEach((r, i) => {
        const [mo, inc, exp] = r;
        const x = 40 + i * (BAR_H * 2 + GAP + 10);
        const incH = Math.round((inc / maxInc) * BAR_MAX);
        const expH = Math.round((exp / maxExp) * BAR_MAX);
        const label = new Date(mo + '-02').toLocaleDateString(undefined, { month: 'short' });
        bars += `<rect x="${x}" y="${BAR_MAX - incH + 10}" width="${BAR_H}" height="${incH}" fill="#2ecc7180" rx="3"/>`;
        bars += `<rect x="${x + BAR_H + 4}" y="${BAR_MAX - expH + 10}" width="${BAR_H}" height="${expH}" fill="#e74c3c80" rx="3"/>`;
        xLabels += `<text x="${x + BAR_H}" y="${BAR_MAX + 26}" text-anchor="middle" font-size="11" fill="#7f8c8d">${rpt_esc(label)}</text>`;
        xLabels += `<text x="${x + BAR_H}" y="${BAR_MAX + 38}" text-anchor="middle" font-size="10" fill="#bdc3c7">${mo.slice(0,4)}</text>`;
    });

    const svg = `<div class="svg-wrap">
  <div style="font-size:12px;color:#7f8c8d;margin-bottom:8px;display:flex;gap:16px;">
    <span><span style="display:inline-block;width:10px;height:10px;background:#2ecc71;border-radius:2px;margin-right:4px;"></span>Income</span>
    <span><span style="display:inline-block;width:10px;height:10px;background:#e74c3c;border-radius:2px;margin-right:4px;"></span>Expenses</span>
  </div>
  <svg width="100%" viewBox="0 0 ${chartW} ${chartH}" style="min-width:${Math.min(chartW,600)}px;">
    ${bars}${xLabels}
  </svg>
</div>`;

    // Monthly table
    let monthRows = monthlyRows.slice().reverse().map(r => {
        const [mo, inc, exp, net] = r;
        const label = new Date(mo + '-02').toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
        const nc = net >= 0 ? 'pos' : 'neg';
        return `<tr>
            <td>${rpt_esc(label)}</td>
            <td class="r pos">${rpt_fmt(inc)}</td>
            <td class="r neg">${rpt_fmt(exp)}</td>
            <td class="r ${nc}">${net>=0?'+':'−'}${rpt_fmt(net)}</td>
        </tr>`;
    }).join('');

    const monthTable = `<table>
<thead><tr><th>Month</th><th class="r">Income</th><th class="r">Expenses</th><th class="r">Net</th></tr></thead>
<tbody>${monthRows}</tbody>
</table>`;

    // Category breakdown — pivot months as columns
    const allMonths = [...new Set(catRows.map(r => r[3]))].sort();
    const allCats   = [...new Map(catRows.map(r => [r[0], {icon:r[1], color:r[2]}]))];
    const catData   = {};
    catRows.forEach(r => { catData[`${r[0]}||${r[3]}`] = r[4]; });

    const mHeaders = allMonths.map(m => {
        const label = new Date(m + '-02').toLocaleDateString(undefined, { month: 'short' });
        return `<th class="r">${rpt_esc(label)}</th>`;
    }).join('');

    const catTableRows = allCats.map(([cat, {icon, color}]) => {
        const cells = allMonths.map(m => {
            const v = catData[`${cat}||${m}`] || 0;
            return `<td class="r">${v > 0 ? `<span style="color:${rpt_esc(color)};font-weight:600;">${rpt_fmt(v)}</span>` : '<span style="color:#e0e0e0;">—</span>'}</td>`;
        }).join('');
        const rowTotal = allMonths.reduce((s, m) => s + (catData[`${cat}||${m}`] || 0), 0);
        return `<tr>
            <td><span style="margin-right:5px;">${rpt_esc(icon)}</span>${rpt_esc(cat)}</td>
            ${cells}
            <td class="r neutral" style="font-weight:600;">${rpt_fmt(rowTotal)}</td>
        </tr>`;
    }).join('');

    const catTable = allCats.length ? `<table>
<thead><tr><th>Category</th>${mHeaders}<th class="r">Total</th></tr></thead>
<tbody>${catTableRows}</tbody>
</table>` : '';

    return `<h2>📊 Analytics — Last 6 Months</h2>
${svg}${monthTable}
<h2>🏷️ Spending by Category</h2>
${catTable}`;
}

function rpt_budget(budgetRows, currentMonth) {
    if (!budgetRows.length) return `<h2>💰 Budget — ${new Date(currentMonth+'-02').toLocaleDateString(undefined,{month:'long',year:'numeric'})}</h2><p class="neutral" style="margin-bottom:20px;">No budget limits set.</p>`;

    const monthLabel = new Date(currentMonth + '-02').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    let totalBudget = 0, totalSpent = 0;
    budgetRows.forEach(r => { totalBudget += r[3]; totalSpent += r[4]; });
    const remaining = totalBudget - totalSpent;
    const overallPct = totalBudget > 0 ? Math.round(totalSpent / totalBudget * 100) : 0;
    const summaryColor = totalSpent > totalBudget ? '#e74c3c' : overallPct > 80 ? '#f39c12' : '#27ae60';

    const summaryCards = `<div class="cards">
  <div class="card"><div class="card-label">Budget</div><div class="card-value">${rpt_fmt(totalBudget)}</div></div>
  <div class="card"><div class="card-label">Spent</div><div class="card-value neg">${rpt_fmt(totalSpent)}</div></div>
  <div class="card"><div class="card-label">${remaining>=0?'Remaining':'Over'}</div><div class="card-value" style="color:${remaining>=0?'#27ae60':'#e74c3c'};">${remaining>=0?'':'-'}${rpt_fmt(remaining)}</div></div>
  <div class="card"><div class="card-label">Usage</div><div class="card-value" style="color:${summaryColor};">${overallPct}%</div>
    <div class="bar-wrap"><div class="bar" style="width:${Math.min(overallPct,100)}%;background:${summaryColor};"></div></div>
  </div>
</div>`;

    const tableRows = budgetRows.map(r => {
        const [name, icon, color, lim, spent] = r;
        const pct = lim > 0 ? Math.round(spent / lim * 100) : 0;
        const barColor = spent > lim ? '#e74c3c' : pct > 80 ? '#f39c12' : '#2ecc71';
        const rem = lim - spent;
        return `<tr>
            <td><span style="margin-right:5px;">${rpt_esc(icon)}</span>${rpt_esc(name)}</td>
            <td class="r">${rpt_fmt(lim)}</td>
            <td class="r neg">${rpt_fmt(spent)}</td>
            <td class="r" style="color:${rem>=0?'#27ae60':'#e74c3c'};font-weight:600;">${rem>=0?'':'-'}${rpt_fmt(rem)}</td>
            <td style="min-width:100px;">
                <div style="font-size:11px;color:${barColor};font-weight:600;margin-bottom:2px;">${pct}%</div>
                <div class="bar-wrap"><div class="bar" style="width:${Math.min(pct,100)}%;background:${rpt_esc(barColor)};"></div></div>
            </td>
        </tr>`;
    }).join('');

    return `<h2>💰 Budget — ${rpt_esc(monthLabel)}</h2>
${summaryCards}
<table>
<thead><tr><th>Category</th><th class="r">Limit</th><th class="r">Spent</th><th class="r">Remaining</th><th>Usage</th></tr></thead>
<tbody>${tableRows}</tbody>
</table>`;
}

function rpt_planner(plannerRows, variableSpend, months) {
    // Group by category
    const catMap = {};
    plannerRows.forEach(r => {
        const [desc, amount, type, payDates, activeMonths, cat, icon, color] = r;
        if (!catMap[cat]) catMap[cat] = { icon, color, items: [] };
        catMap[cat].items.push({ desc, amount, type, payDates, activeMonths });
    });

    // Compute amounts per item per month (reuse app logic inline)
    function amtForMonth(item, year, month) {
        const key = `${year}-${String(month).padStart(2,'0')}`;
        if (item.type === 'monthly') {
            if (item.activeMonths) {
                const allowed = item.activeMonths.split(',').map(m => parseInt(m.trim()));
                if (!allowed.includes(month)) return 0;
            }
            return item.amount;
        }
        if (item.type === 'term' && item.payDates) {
            return item.payDates.split(',').map(d=>d.trim()).some(d=>d.startsWith(key)) ? item.amount : 0;
        }
        return 0;
    }

    const mHeaders = months.map(m => `<th class="r">${rpt_esc(m.label)}</th>`).join('');
    let grandTotal = 0;
    let monthGrandTotals = months.map(() => 0);

    const catSections = Object.entries(catMap).map(([cat, {icon, color, items}]) => {
        let catMonthTotals = months.map(() => 0);
        let catTotal = 0;

        const itemRows = items.map(item => {
            const cells = months.map((m, i) => {
                const amt = amtForMonth(item, m.year, m.month);
                catMonthTotals[i] += amt;
                monthGrandTotals[i] += amt;
                catTotal += amt;
                grandTotal += amt;
                return `<td class="r">${amt > 0 ? `<span style="font-weight:600;color:#2c3e50;">${rpt_fmt(amt)}</span>` : '<span style="color:#e0e0e0;">—</span>'}</td>`;
            }).join('');
            const typeTag = item.type === 'term' ? ' <span style="font-size:10px;background:#9b59b620;color:#9b59b6;padding:1px 5px;border-radius:3px;">term</span>' : '';
            const rowTotal = months.reduce((s, m) => s + amtForMonth(item, m.year, m.month), 0);
            return `<tr>
                <td style="padding-left:24px;">${rpt_esc(item.desc)}${typeTag}</td>
                ${cells}
                <td class="r neutral" style="font-weight:600;">${rowTotal>0?rpt_fmt(rowTotal):'—'}</td>
            </tr>`;
        }).join('');

        const subtotalCells = catMonthTotals.map(t =>
            `<td class="r" style="font-weight:700;color:${rpt_esc(color)};">${t>0?rpt_fmt(t):'—'}</td>`
        ).join('');

        return `<details>
  <summary style="background:${rpt_esc(color)}15;">
    <span>${rpt_esc(icon)}</span>
    <span>${rpt_esc(cat)}</span>
    <span class="section-meta">${items.length} item${items.length!==1?'s':''} · ${rpt_fmt(catTotal)} / 6 mo</span>
  </summary>
  <div class="det-body">
    <table style="margin-bottom:0;border-radius:0;border:none;">
      <thead><tr><th>Expense</th>${mHeaders}<th class="r">6-mo Total</th></tr></thead>
      <tbody>
${itemRows}
<tr style="background:#fafafa;">
  <td style="font-size:11px;color:#95a5a6;font-style:italic;padding-left:24px;">${items.length} item${items.length!==1?'s':''}</td>
  ${subtotalCells}
  <td class="r" style="font-weight:700;color:${rpt_esc(color)};">${rpt_fmt(catTotal)}</td>
</tr>
      </tbody>
    </table>
  </div>
</details>`;
    }).join('');

    // Variable spend row
    let varHTML = '';
    if (variableSpend > 0) {
        months.forEach((_, i) => { monthGrandTotals[i] += variableSpend; });
        const varTotal = variableSpend * 6;
        grandTotal += varTotal;
        const varCells = months.map(() =>
            `<td class="r" style="color:#e67e22;font-weight:600;">${rpt_fmt(variableSpend)}</td>`
        ).join('');
        varHTML = `<table style="margin-bottom:10px;">
<tbody><tr>
  <td><span style="margin-right:6px;">🛒</span>Variable spend estimate <span style="font-size:11px;color:#95a5a6;">(food, transport, etc.)</span></td>
  ${varCells}
  <td class="r" style="color:#e67e22;font-weight:700;">${rpt_fmt(varTotal)}</td>
</tr></tbody></table>`;
    }

    // Grand total row
    const grandCells = monthGrandTotals.map(t =>
        `<td class="r" style="color:white;font-weight:700;">${rpt_fmt(t)}</td>`
    ).join('');

    const grandRow = `<table style="margin-bottom:16px;">
<tfoot><tr style="background:#2c3e50;color:white;font-weight:700;">
  <td>Monthly total</td>${grandCells}
  <td></td>
</tr></tfoot>
</table>`;

    const fundCard = `<div class="fund-card">
  <div>
    <div class="fund-label">6-Month Emergency Fund Target</div>
    <div class="fund-avg">Fixed commitments + variable spend over 6 months</div>
  </div>
  <div style="text-align:right;">
    <div class="fund-value">${rpt_fmt(grandTotal)}</div>
    <div class="fund-avg">≈ ${rpt_fmt(grandTotal/6)} / month average</div>
  </div>
</div>`;

    if (!plannerRows.length && !variableSpend) {
        return `<h2>📋 Emergency Fund Planner</h2><p class="neutral" style="margin-bottom:20px;">No expense commitments entered yet.</p>`;
    }

    return `<h2>📋 Emergency Fund Planner — Next 6 Months</h2>
${catSections}
${varHTML}${grandRow}${fundCard}`;
}

// ─────────────────────────────────────────────────────────────────────────
// §3.2. Database Persistence (IndexedDB)
// ─────────────────────────────────────────────────────────────────────────

// Dirty-flag auto-save: call markDirty() after any write.
// Saves immediately if tab is hidden (user switching away), otherwise
// debounces to avoid hammering IndexedDB on rapid bulk writes.
let _dirtyTimer = null;
let _isDirty = false;

function markDirty() {
    _isDirty = true;
    if (_dirtyTimer) clearTimeout(_dirtyTimer);
    _dirtyTimer = setTimeout(flushSave, 1000); // 1s debounce
}

async function flushSave() {
    if (!_isDirty) return;
    _isDirty = false;
    if (_dirtyTimer) { clearTimeout(_dirtyTimer); _dirtyTimer = null; }
    await saveDatabaseToIndexedDB();
}

// Flush immediately when user leaves the tab or the page
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
});
window.addEventListener('beforeunload', () => {
    // IndexedDB writes are async and won't complete before page unload.
    // Synchronously back up the current in-memory database to localStorage
    // so the next page load can restore any unsaved changes.
    try {
        if (db) {
            const data = db.export();
            let binary = '';
            for (let i = 0; i < data.length; i++) {
                binary += String.fromCharCode(data[i]);
            }
            localStorage.setItem('bankConsolidator_backup', btoa(binary));
        }
    } catch (e) {
        // localStorage may be full or unavailable — fail silently
    }
    flushSave();
});

        async function saveDatabaseToIndexedDB() {
    const data = db.export();
    const request = indexedDB.open('BankConsolidator', 1);

    return new Promise((resolve, reject) => {
        request.onerror = () => reject(request.error);

        request.onsuccess = () => {
            const db = request.result;
            const transaction = db.transaction(['database'], 'readwrite');
            const store = transaction.objectStore('database');
            store.put({ id: 1, data: data });
            transaction.oncomplete = () => resolve();
        };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('database')) {
                db.createObjectStore('database', { keyPath: 'id' });
            }
        };
    });
}

async function loadDatabaseFromIndexedDB() {
    const request = indexedDB.open('BankConsolidator', 1);

    return new Promise((resolve, reject) => {
        request.onerror = () => reject(request.error);

        request.onsuccess = () => {
            const db = request.result;

            if (!db.objectStoreNames.contains('database')) {
                resolve(null);
                return;
            }

            const transaction = db.transaction(['database'], 'readonly');
            const store = transaction.objectStore('database');
            const getRequest = store.get(1);

            getRequest.onsuccess = () => {
                resolve(getRequest.result ? getRequest.result.data : null);
            };
            getRequest.onerror = () => resolve(null);
        };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('database')) {
                db.createObjectStore('database', { keyPath: 'id' });
            }
        };
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// §9. CATEGORIES
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// §16. SETTINGS - Manual Analytics Integration
// ═══════════════════════════════════════════════════════════════════════════

function loadManualAnalyticsSettings() {
    const includeManual = dbHelpers.queryValue("SELECT value FROM settings WHERE key = 'include_manual_in_analytics'") === '1';
    const startDate = dbHelpers.queryValue("SELECT value FROM settings WHERE key = 'manual_analytics_start_date'") || '';

    document.getElementById('includeManualInAnalytics').checked = includeManual;
    document.getElementById('manualAnalyticsStartDate').value = startDate;
    document.getElementById('manualAnalyticsStartDate').disabled = !includeManual;
}

function toggleManualAnalytics() {
    const checked = document.getElementById('includeManualInAnalytics').checked;
    document.getElementById('manualAnalyticsStartDate').disabled = !checked;
}

async function saveManualAnalyticsSettings() {
    const includeManual = document.getElementById('includeManualInAnalytics').checked;
    const startDate = document.getElementById('manualAnalyticsStartDate').value;

    if (includeManual && !startDate) {
        alert('Please set a start date for manual transactions');
        return;
    }

    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('include_manual_in_analytics', ?)", [includeManual ? '1' : '0']);
    if (startDate) {
        db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('manual_analytics_start_date', ?)", [startDate]);
    }

    markDirty();
    showMessage('success', 'Settings saved. Analytics will now ' + (includeManual ? 'include' : 'exclude') + ' manual transactions.');

    // Refresh analytics if on that tab
    if (document.getElementById('analytics-tab').classList.contains('active')) {
        await updateAnalytics();
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// §17. CATEGORIES
// ═══════════════════════════════════════════════════════════════════════════

async function loadCategories() {
    const result = db.exec('SELECT id, name, color, icon, sort_order FROM categories ORDER BY sort_order, name');
    displayCategories(result);
    populateCategoryDropdowns();
}

function displayCategories(result) {
    const container = document.getElementById('categoriesListContainer');
    if (!container) return;

    if (!result.length || !result[0].values.length) {
        container.innerHTML = '<div class="loading">No categories found</div>';
        return;
    }

    // Get all subcategories in one query to avoid N+1
    const allSubcategories = {};
    const subResult = dbHelpers.queryAll(`
        SELECT category_id, id, name, sort_order 
        FROM subcategories 
        ORDER BY category_id, sort_order, name
    `);

    subResult.forEach(row => {
        const categoryId = row[0];
        if (!allSubcategories[categoryId]) {
            allSubcategories[categoryId] = [];
        }
        allSubcategories[categoryId].push({
            id: row[1],
            name: row[2],
            sortOrder: row[3]
        });
    });

    const rows = result[0].values;
    const fragment = document.createDocumentFragment();

    rows.forEach(row => {
        const id = row[0];
        const name = row[1];
        const color = row[2] || '#95a5a6';
        const icon = row[3] || '📦';

        const subcategories = allSubcategories[id] || [];

        const div = document.createElement('div');
        div.style.cssText = 'background: white; border: 1px solid #ecf0f1; border-radius: 8px; padding: 20px; margin-bottom: 15px;';
        div.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                <div style="display: flex; align-items: center; gap: 15px;">
                    <span style="font-size: 32px;">${escapeHtml(icon)}</span>
                    <div>
                        <h4 style="margin: 0;">${escapeHtml(name)}</h4>
                        <span style="background: ${escapeHtml(color)}; color: white; padding: 2px 8px; border-radius: 4px; font-size: 12px;">${escapeHtml(color)}</span>
                    </div>
                </div>
                <div>
                    <button data-action="add-sub" style="padding: 5px 10px; font-size: 12px; margin-right: 5px;">+ Add Subcategory</button>
                    <button data-action="delete-cat" class="danger-btn" style="padding: 5px 10px; font-size: 12px;">Delete</button>
                </div>
            </div>
            <div style="margin-left: 50px;">
                <strong style="color: #7f8c8d; font-size: 12px;">SUBCATEGORIES:</strong>
                <div data-subcats style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px;"></div>
            </div>
        `;

        div.querySelector('[data-action="add-sub"]').addEventListener('click', () => showAddSubcategoryForm(id, name));
        div.querySelector('[data-action="delete-cat"]').addEventListener('click', () => deleteCategory(id, name));

        const subcatContainer = div.querySelector('[data-subcats]');
        if (subcategories.length > 0) {
            subcategories.forEach(sub => {
                const span = document.createElement('span');
                span.style.cssText = 'background: #f8f9fa; padding: 6px 12px; border-radius: 4px; font-size: 13px; display: flex; align-items: center; gap: 5px;';
                span.innerHTML = `${escapeHtml(sub.name)} <button data-del style="background: none; border: none; color: #e74c3c; cursor: pointer; padding: 0 4px; font-size: 16px;" title="Delete">×</button>`;
                span.querySelector('[data-del]').addEventListener('click', () => deleteSubcategory(sub.id, sub.name, name));
                subcatContainer.appendChild(span);
            });
        } else {
            subcatContainer.innerHTML = '<span style="color: #95a5a6; font-size: 13px;">No subcategories</span>';
        }

        fragment.appendChild(div);
    });

    container.innerHTML = '';
    container.appendChild(fragment);
}

function populateCategoryDropdowns() {
    const result = db.exec('SELECT id, name FROM categories ORDER BY sort_order, name');
    const options = result.length > 0 
        ? result[0].values.map(row => `<option value="${row[0]}">${row[1]}</option>`).join('')
        : '<option value="">Other</option>';

    // Update rule form category dropdown
    const ruleSelect = document.getElementById('newRuleCategory');
    if (ruleSelect) {
        ruleSelect.innerHTML = options;
    }
}

function updateRuleSubcategoryOptions() {
    const categoryId = document.getElementById('newRuleCategory').value;
    const select = document.getElementById('newRuleSubcategory');

    select.innerHTML = '<option value="">-- None --</option>';

    if (!categoryId) return;

    const result = db.exec('SELECT id, name FROM subcategories WHERE category_id = ? ORDER BY sort_order, name', [categoryId]);
    if (result.length > 0) {
        result[0].values.forEach(row => {
            const id = row[0];
            const name = row[1];
            select.innerHTML += `<option value="${id}">${name}</option>`;
        });
    }
}

function showAddCategoryForm() {
    document.getElementById('addCategoryForm').style.display = 'block';
}

function cancelAddCategory() {
    document.getElementById('addCategoryForm').style.display = 'none';
    document.getElementById('newCategoryName').value = '';
    document.getElementById('newCategoryIcon').value = '';
    document.getElementById('newCategoryColor').value = '#3498db';
}

async function addCategory() {
    const name = document.getElementById('newCategoryName').value.trim();
    const icon = document.getElementById('newCategoryIcon').value.trim();
    const color = document.getElementById('newCategoryColor').value;

    // Validate input
    const validationError = validators.categoryName(name);
    if (validationError) {
        showMessage('error', validationError);
        return;
    }

    showLoading('Creating category...');

    try {
        // Get max sort_order
        const maxOrder = dbHelpers.queryValue('SELECT MAX(sort_order) FROM categories') || 0;

        const result = dbHelpers.safeRun(`
            INSERT INTO categories (name, color, icon, sort_order)
            VALUES (?, ?, ?, ?)
        `, [name, color, icon || '📦', maxOrder + 1], 'Add category');

        if (!result.success) {
            hideLoading();
            return;
        }

        markDirty();
        await loadCategories();
        cancelAddCategory();
        hideLoading();
        showMessage('success', `Category "${name}" created successfully`);
    } catch (e) {
        hideLoading();
        if (e.message.includes('UNIQUE constraint')) {
            showMessage('error', 'A category with this name already exists');
        } else {
            showMessage('error', 'Error creating category: ' + e.message);
        }
    }
}

async function deleteCategory(categoryId, categoryName) {
    if (!confirm(`Delete category "${categoryName}"? This will also delete all its subcategories. Transactions using this category will keep it.`)) return;

    db.run('DELETE FROM subcategories WHERE category_id = ?', [categoryId]);
    db.run('DELETE FROM categories WHERE id = ?', [categoryId]);
    markDirty();
    await loadCategories();
    showMessage('success', 'Category deleted');
}

function showAddSubcategoryForm(categoryId, categoryName) {
    const formHtml = `
        <div id="addSubcategoryModal" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000;">
            <div style="background: white; padding: 30px; border-radius: 8px; max-width: 400px; width: 90%;">
                <h3 style="margin-top: 0;">Add Subcategory to ${categoryName}</h3>
                <div class="form-group">
                    <label>Subcategory Name</label>
                    <input type="text" id="newSubcategoryName" placeholder="e.g., Fast Casual">
                </div>
                <div style="display: flex; gap: 10px; margin-top: 20px;">
                    <button onclick="addSubcategory(${categoryId})">Create</button>
                    <button class="secondary-btn" onclick="closeSubcategoryModal()">Cancel</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', formHtml);
    document.getElementById('newSubcategoryName').focus();
}

function closeSubcategoryModal() {
    const modal = document.getElementById('addSubcategoryModal');
    if (modal) modal.remove();
}

async function addSubcategory(categoryId) {
    const name = document.getElementById('newSubcategoryName').value.trim();

    const validationError = validators.categoryName(name);
    if (validationError) {
        showMessage('error', validationError);
        return;
    }

    showLoading('Creating subcategory...');

    try {
        // Get max sort_order for this category
        const maxOrder = dbHelpers.queryValue(
            'SELECT MAX(sort_order) FROM subcategories WHERE category_id = ?', 
            [categoryId]
        ) || 0;

        const result = dbHelpers.safeRun(`
            INSERT INTO subcategories (category_id, name, sort_order)
            VALUES (?, ?, ?)
        `, [categoryId, name, maxOrder + 1], 'Add subcategory');

        if (!result.success) {
            hideLoading();
            return;
        }

        markDirty();
        await loadCategories();
        closeSubcategoryModal();
        hideLoading();
        showMessage('success', `Subcategory "${name}" created`);
    } catch (e) {
        hideLoading();
        if (e.message.includes('UNIQUE constraint')) {
            showMessage('error', 'A subcategory with this name already exists in this category');
        } else {
            showMessage('error', 'Error creating subcategory: ' + e.message);
        }
    }
}

async function deleteSubcategory(subcategoryId, subcategoryName, categoryName) {
    if (!confirm(`Delete subcategory "${subcategoryName}" from ${categoryName}?`)) return;

    db.run('DELETE FROM subcategories WHERE id = ?', [subcategoryId]);
    markDirty();
    await loadCategories();
    showMessage('success', 'Subcategory deleted');
}

// ═══════════════════════════════════════════════════════════════════════════
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

    // Migrate from localStorage if present and DB is empty
    const saved = localStorage.getItem('bankProfiles');
    if (saved && bankProfiles.length === 0) {
        const oldProfiles = JSON.parse(saved);
        oldProfiles.forEach(profile => saveBankProfileToDB(profile));
        localStorage.removeItem('bankProfiles');
        loadBankProfiles();
        return;
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
            <button class="danger-btn" data-delete-profile>Delete Profile</button>
        `;
        div.querySelector('[data-delete-profile]').addEventListener('click', () => deleteProfile(idx));
        container.appendChild(div);
    });
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

    if (tab === 'manual') {
        // Default date to today
        const dateInput = document.getElementById('manualDate');
        if (!dateInput.value) {
            dateInput.value = new Date().toISOString().split('T')[0];
        }
        // Default month filter to current month
        const monthInput = document.getElementById('manualFilterMonth');
        if (!monthInput.value) {
            monthInput.value = new Date().toISOString().slice(0, 7);
        }
        loadManualTransactions();
    }

    if (tab === 'planner') {
        loadPlanner();
    }

    if (tab === 'budget') {
        budgetMonth = new Date().toISOString().slice(0, 7);
        loadBudget();
    }

    if (tab === 'settings') {
        loadManualAnalyticsSettings();
    }
}

function cancelUpload() {
    resetFileSelection();
}

function showMessage(type, text) {
    const container = document.getElementById('import-message');
    const className = type === 'error' ? 'error-message' : 'success-message';
    const div = document.createElement('div');
    div.className = className;
    div.textContent = text;
    container.innerHTML = '';
    container.appendChild(div);
    setTimeout(() => container.innerHTML = '', 5000);
}

// ═══════════════════════════════════════════════════════════════════════════
// §11. MANUAL TRANSACTIONS
// ═══════════════════════════════════════════════════════════════════════════

async function addManualTransaction() {
    const date = document.getElementById('manualDate').value;
    const sign = document.getElementById('manualSign').value;
    const amountRaw = parseFloat(document.getElementById('manualAmount').value);
    const description = document.getElementById('manualDescription').value.trim();

    // Validate
    if (!date) {
        showManualMessage('error', 'Please enter a date');
        return;
    }
    if (!amountRaw || isNaN(amountRaw) || amountRaw <= 0) {
        showManualMessage('error', 'Please enter a valid amount');
        return;
    }
    if (!description) {
        showManualMessage('error', 'Please enter a description');
        return;
    }

    const amount = sign === '-' ? -Math.abs(amountRaw) : Math.abs(amountRaw);

    // Apply transaction rules to auto-categorize
    const ruleResult = applyTransactionRules(description, null);
    const categoryId = ruleResult.category ? dbHelpers.queryValue('SELECT id FROM categories WHERE name = ?', [ruleResult.category]) : null;

    const result = dbHelpers.safeRun(
        'INSERT INTO manual_transactions (date, description, amount, category_id) VALUES (?, ?, ?, ?)',
        [date, description, amount, categoryId],
        'Add manual transaction'
    );

    if (!result.success) return;

    markDirty();

    // Clear form (keep date for quick repeat entry)
    document.getElementById('manualAmount').value = '';
    document.getElementById('manualDescription').value = '';
    document.getElementById('manualDescription').focus();

    await loadManualTransactions();
    const categoryMsg = ruleResult.category ? ` (categorized as ${ruleResult.category})` : '';
    showManualMessage('success', `Transaction added${categoryMsg}`);
}

async function deleteManualTransaction(id) {
    if (!confirm('Delete this transaction?')) return;

    dbHelpers.safeRun('DELETE FROM manual_transactions WHERE id = ?', [id], 'Delete manual transaction');
    markDirty();
    await loadManualTransactions();
}

async function applyRulesToManualTransactions() {
    if (!confirm('Apply all enabled rules to manual transactions?\n\nThis will update categories based on current rules.')) return;

    const ruleCount = dbHelpers.queryValue('SELECT COUNT(*) FROM transaction_rules WHERE enabled = 1');
    if (!ruleCount) {
        alert('No enabled rules to apply');
        return;
    }

    let categorizedCount = 0;

    // Get all manual transactions
    const rows = dbHelpers.queryAll('SELECT id, description FROM manual_transactions');
    rows.forEach(row => {
        const [id, description] = row;
        const ruleResult = applyTransactionRules(description, null);

        if (ruleResult.category) {
            const categoryId = dbHelpers.queryValue('SELECT id FROM categories WHERE name = ?', [ruleResult.category]);
            if (categoryId) {
                db.run('UPDATE manual_transactions SET category_id = ? WHERE id = ?', [categoryId, id]);
                categorizedCount++;
            }
        }
    });

    markDirty();
    await loadManualTransactions();

    const message = categorizedCount > 0 
        ? `Applied rules: ${categorizedCount} transaction${categorizedCount !== 1 ? 's' : ''} categorized`
        : 'No transactions matched the rules';

    showManualMessage('success', message);
}

async function loadManualTransactions() {
    const monthFilter = document.getElementById('manualFilterMonth').value;

    let query = `SELECT mt.id, mt.date, mt.description, mt.amount, c.name as category_name, c.icon as category_icon 
                 FROM manual_transactions mt 
                 LEFT JOIN categories c ON mt.category_id = c.id`;
    const params = [];

    if (monthFilter) {
        query += ' WHERE strftime(\'%Y-%m\', mt.date) = ?';
        params.push(monthFilter);
    }

    query += ' ORDER BY mt.date DESC, mt.created_at DESC';

    const rows = dbHelpers.queryAll(query, params);
    displayManualTransactions(rows);
    updateManualSummary(rows);
}

function displayManualTransactions(rows) {
    const container = document.getElementById('manualTransactionsContainer');

    if (!rows.length) {
        container.innerHTML = '<div class="loading">No entries found</div>';
        return;
    }

    // Group rows by date
    const byDate = {};
    rows.forEach(row => {
        const date = row[1];
        if (!byDate[date]) byDate[date] = [];
        byDate[date].push(row);
    });

    // Sort dates descending
    const sortedDates = Object.keys(byDate).sort((a, b) => b.localeCompare(a));

    let html = '';

    sortedDates.forEach(date => {
        const dayRows = byDate[date];

        // Calculate daily subtotals
        let dayIncome = 0, dayExpenses = 0;
        dayRows.forEach(row => {
            const amount = row[3];
            if (amount >= 0) dayIncome += amount;
            else dayExpenses += Math.abs(amount);
        });
        const dayNet = dayIncome - dayExpenses;
        const dayNetClass = dayNet >= 0 ? 'transaction-positive' : 'transaction-negative';
        const dayNetStr = dayNet >= 0 ? `+$${dayNet.toFixed(2)}` : `-$${Math.abs(dayNet).toFixed(2)}`;

        // Format date nicely
        const dateObj = new Date(date + 'T00:00:00');
        const dateLabel = dateObj.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });

        // Day separator header
        html += `
            <div style="display:flex; justify-content:space-between; align-items:center;
                        background:#f0f4f8; border-left:4px solid #3498db;
                        padding:8px 14px; margin-top:18px; border-radius:0 4px 4px 0;">
                <strong style="color:#2c3e50;">${dateLabel}</strong>
                <div style="display:flex; gap:18px; font-size:13px;">
                    ${dayIncome  > 0 ? `<span class="transaction-positive">+$${dayIncome.toFixed(2)}</span>` : ''}
                    ${dayExpenses > 0 ? `<span class="transaction-negative">-$${dayExpenses.toFixed(2)}</span>` : ''}
                    <span style="color:#7f8c8d;">Net</span>
                    <strong class="${dayNetClass}">${dayNetStr}</strong>
                </div>
            </div>
            <table style="margin-top:0; border-radius:0; table-layout:fixed; width:100%;">
                <thead>
                    <tr style="background:#f8f9fa;">
                        <th style="width:30px;"></th>
                        <th style="width:40%; text-align:left; padding:6px 8px; font-size:11px; color:#7f8c8d; font-weight:600;">Description</th>
                        <th style="width:25%; text-align:left; padding:6px 8px; font-size:11px; color:#7f8c8d; font-weight:600;">Category</th>
                        <th style="width:15%; text-align:right; padding:6px 8px; font-size:11px; color:#7f8c8d; font-weight:600;">Amount</th>
                        <th style="width:80px;"></th>
                    </tr>
                </thead>
                <tbody>
        `;

        dayRows.forEach(row => {
            const [id, , description, amount, categoryName, categoryIcon] = row;
            const amountClass = amount >= 0 ? 'transaction-positive' : 'transaction-negative';
            const amountStr   = amount >= 0 ? `+$${amount.toFixed(2)}` : `-$${Math.abs(amount).toFixed(2)}`;
            const categoryDisplay = categoryName ? `${categoryIcon || ''} ${escapeHtml(categoryName)}` : '<span style="color:#95a5a6;">Uncategorized</span>';

            html += `<tr>
                <td style="color:#7f8c8d; white-space:nowrap; padding-left:18px;">—</td>
                <td style="word-break:break-word;">${escapeHtml(description)}</td>
                <td style="font-size:12px; color:#7f8c8d;">${categoryDisplay}</td>
                <td class="${amountClass}" style="text-align:right; white-space:nowrap;">${amountStr}</td>
                <td style="white-space:nowrap;" data-del-id="${id}"></td>
            </tr>`;
        });

        html += `</tbody></table>`;
    });

    container.innerHTML = html;
    container.querySelectorAll('[data-del-id]').forEach(td => {
        const id = parseInt(td.dataset.delId);
        const btn = document.createElement('button');
        btn.className = 'danger-btn';
        btn.style.cssText = 'padding:4px 10px; font-size:12px;';
        btn.textContent = 'Delete';
        btn.addEventListener('click', () => deleteManualTransaction(id));
        td.appendChild(btn);
    });
}

function updateManualSummary(rows) {
    let income = 0, expenses = 0;

    rows.forEach(row => {
        const amount = row[3];
        if (amount >= 0) income += amount;
        else expenses += Math.abs(amount);
    });

    const net = income - expenses;

    document.getElementById('manualCount').textContent = rows.length;
    document.getElementById('manualIncome').textContent = `+$${income.toFixed(2)}`;
    document.getElementById('manualExpenses').textContent = `-$${expenses.toFixed(2)}`;
    const netEl = document.getElementById('manualNet');
    netEl.textContent = net >= 0 ? `+$${net.toFixed(2)}` : `-$${Math.abs(net).toFixed(2)}`;
    netEl.className = net >= 0 ? 'transaction-positive' : 'transaction-negative';
}

function showManualMessage(type, text) {
    const el = document.getElementById('manual-message');
    el.innerHTML = `<div class="${type}-message" style="margin-bottom: 15px;">${text}</div>`;
    setTimeout(() => el.innerHTML = '', 3000);
}

// ═══════════════════════════════════════════════════════════════════════════
// §12. TRANSACTION RULES
// ═══════════════════════════════════════════════════════════════════════════

async function loadRules() {
    const result = db.exec(`
        SELECT tr.id, tr.name, tr.keyword, tr.action, c.name as category_name, tr.case_sensitive, tr.enabled, tr.priority
        FROM transaction_rules tr
        LEFT JOIN categories c ON tr.category_value = c.id
        ORDER BY tr.priority DESC, tr.name
    `);

    displayRules(result);
}

function displayRules(result) {
    const container = document.getElementById('rulesListContainer');
    if (!container) return;

    if (!result.length || !result[0].values.length) {
        container.innerHTML = '<div class="loading">No rules defined. Click "Add New Rule" to create one.</div>';
        return;
    }

    const rows = result[0].values;

    // Split into ignore group and per-category groups
    const ignoreRules = [];
    const categoryGroups = {}; // key: category_name → []

    rows.forEach(row => {
        const [id, name, keyword, action, categoryName, caseSensitive, enabled, priority] = row;
        const rule = { id, name, keyword, action, categoryName, caseSensitive, enabled, priority };
        if (action === 'ignore') {
            ignoreRules.push(rule);
        } else {
            const key = categoryName || 'Uncategorized';
            if (!categoryGroups[key]) categoryGroups[key] = [];
            categoryGroups[key].push(rule);
        }
    });

    const frag = document.createDocumentFragment();

    function makeRuleTag(rule) {
        const { id, name, keyword, caseSensitive, priority } = rule;
        const tag = document.createElement('div');
        tag.style.cssText = 'display:inline-flex; align-items:center; gap:6px; background:white; border:1px solid #dee2e6; border-radius:16px; padding:6px 10px 6px 12px; margin:4px 4px 4px 0; font-size:13px; transition:all .15s;';
        tag.onmouseenter = () => tag.style.boxShadow = '0 2px 6px rgba(0,0,0,0.1)';
        tag.onmouseleave = () => tag.style.boxShadow = 'none';

        const content = document.createElement('div');
        content.style.cssText = 'display:flex; align-items:center; gap:5px;';

        const keywordSpan = document.createElement('span');
        keywordSpan.style.cssText = 'font-family:monospace; color:#2c3e50; font-weight:500;';
        keywordSpan.textContent = keyword;
        content.appendChild(keywordSpan);

        if (caseSensitive) {
            const csTag = document.createElement('span');
            csTag.style.cssText = 'font-size:9px; background:#f39c12; color:white; padding:1px 4px; border-radius:2px; font-weight:600;';
            csTag.textContent = 'Aa';
            content.appendChild(csTag);
        }

        if (priority > 0) {
            const priTag = document.createElement('span');
            priTag.style.cssText = 'font-size:10px; color:#95a5a6; font-weight:600;';
            priTag.textContent = `p${priority}`;
            content.appendChild(priTag);
        }

        tag.appendChild(content);

        const delBtn = document.createElement('button');
        delBtn.style.cssText = 'background:none; border:none; color:#e74c3c; font-size:14px; cursor:pointer; padding:0; line-height:1; width:16px; height:16px; display:flex; align-items:center; justify-content:center; border-radius:50%; transition:background .15s;';
        delBtn.innerHTML = '×';
        delBtn.title = `Delete rule: ${keyword}`;
        delBtn.onmouseenter = () => delBtn.style.background = '#e74c3c20';
        delBtn.onmouseleave = () => delBtn.style.background = 'none';
        delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteRule(id);
        });
        tag.appendChild(delBtn);

        return tag;
    }

    function makeGroup(title, borderColor, rules, defaultOpen = false) {
        const section = document.createElement('div');
        section.style.cssText = `border:1px solid ${borderColor}20; border-radius:8px; margin-bottom:12px; overflow:hidden;`;

        const header = document.createElement('div');
        header.style.cssText = `display:flex; align-items:center; gap:10px; padding:10px 16px; background:${borderColor}10; cursor:pointer; user-select:none;`;
        header.innerHTML = `
            <span style="font-size:12px; color:${borderColor}; transition:transform .2s;" data-arrow>${defaultOpen ? '▼' : '▶'}</span>
            <span style="font-weight:600; font-size:13px;">${title}</span>
            <span style="background:${borderColor}; color:white; font-size:10px; font-weight:600; padding:2px 7px; border-radius:10px; margin-left:auto;">${rules.length}</span>
        `;

        const body = document.createElement('div');
        body.style.cssText = `padding:8px 12px; display:${defaultOpen ? 'flex' : 'none'}; flex-wrap:wrap;`;

        rules.forEach(rule => body.appendChild(makeRuleTag(rule)));
        section.appendChild(header);
        section.appendChild(body);

        header.addEventListener('click', () => {
            const open = body.style.display !== 'none';
            body.style.display = open ? 'none' : 'flex';
            header.querySelector('[data-arrow]').textContent = open ? '▶' : '▼';
        });

        return section;
    }

    // Auto-Ignore group
    if (ignoreRules.length) {
        frag.appendChild(makeGroup('🚫 Auto-Ignore', '#e74c3c', ignoreRules, false));
    }

    // Auto-Categorize groups — one per category, sorted by name
    const sortedCategories = Object.keys(categoryGroups).sort();
    sortedCategories.forEach(catName => {
        const rules = categoryGroups[catName];
        frag.appendChild(makeGroup(`🏷 ${catName}`, '#3498db', rules, false));
    });

    // Summary line
    const total = rows.length;
    const summary = document.createElement('div');
    summary.style.cssText = 'font-size:12px; color:#95a5a6; margin-top:8px; padding:0 4px;';
    summary.textContent = `${total} rule${total !== 1 ? 's' : ''} total`;
    frag.appendChild(summary);

    container.innerHTML = '';
    container.appendChild(frag);
}

function showAddRuleForm() {
    document.getElementById('addRuleForm').style.display = 'block';
}

function toggleCategoryField() {
    const action = document.getElementById('newRuleAction').value;
    const categoryField = document.getElementById('categoryFieldGroup');
    const subcategoryField = document.getElementById('subcategoryFieldGroup');
    const showFields = action === 'categorize';
    categoryField.style.display = showFields ? 'block' : 'none';
    subcategoryField.style.display = showFields ? 'block' : 'none';
}

function cancelAddRule() {
    document.getElementById('addRuleForm').style.display = 'none';
    document.getElementById('newRuleName').value = '';
    document.getElementById('newRuleKeyword').value = '';
    document.getElementById('newRuleAction').value = 'categorize';
    document.getElementById('newRuleCaseSensitive').checked = false;
    document.getElementById('newRulePriority').value = '10';
    document.getElementById('categoryFieldGroup').style.display = 'block';
    document.getElementById('subcategoryFieldGroup').style.display = 'block';
}

async function addRule() {
    const name = document.getElementById('newRuleName').value.trim();
    const keyword = document.getElementById('newRuleKeyword').value.trim();
    const action = document.getElementById('newRuleAction').value;
    const caseSensitive = document.getElementById('newRuleCaseSensitive').checked;
    const priority = parseInt(document.getElementById('newRulePriority').value) || 0;

    let categoryValue = null;
    if (action === 'categorize') {
        categoryValue = document.getElementById('newRuleCategory').value;
    }

    // Validate inputs
    const nameError = validators.ruleName(name);
    if (nameError) {
        showMessage('error', nameError);
        return;
    }

    const keywordError = validators.keyword(keyword);
    if (keywordError) {
        showMessage('error', keywordError);
        return;
    }

    if (action === 'categorize' && !categoryValue) {
        showMessage('error', 'Please select a category');
        return;
    }

    showLoading('Creating rule...');

    try {
        const result = dbHelpers.safeRun(`
            INSERT INTO transaction_rules (name, keyword, action, category_value, case_sensitive, enabled, priority)
            VALUES (?, ?, ?, ?, ?, 1, ?)
        `, [name, keyword, action, categoryValue, caseSensitive ? 1 : 0, priority], 'Add rule');

        if (!result.success) {
            hideLoading();
            return;
        }

        markDirty();
        await loadRules();
        cancelAddRule();
        hideLoading();
        showMessage('success', `Rule "${name}" created successfully`);
    } catch (e) {
        hideLoading();
        showMessage('error', 'Error creating rule: ' + e.message);
    }
}

async function deleteRule(ruleId) {
    if (!confirm('Delete this rule? This will not affect already ignored transactions.')) return;

    db.run('DELETE FROM transaction_rules WHERE id = ?', [ruleId]);
    markDirty();
    await loadRules();
    showMessage('success', 'Rule deleted');
}

async function applyRulesToExisting() {
    if (!confirm('Apply all enabled rules to existing transactions?\n\nThis will skip transactions with manual category overrides.')) return;

    // Check that there are enabled rules before proceeding
    const ruleCount = dbHelpers.queryValue('SELECT COUNT(*) FROM transaction_rules WHERE enabled = 1');
    if (!ruleCount) {
        alert('No enabled rules to apply');
        return;
    }

    let ignoredCount = 0;
    let categorizedCount = 0;
    let skippedManual = 0;

    // Get all transactions, excluding those with manual category overrides
    const transResult = db.exec(`
        SELECT t.id, t.description, t.category_id, c.name as category_name, t.manual_category
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
    `);
    if (transResult.length > 0) {
        transResult[0].values.forEach(row => {
            const transId = row[0];
            const description = row[1] || '';
            const currentCategoryName = row[3];
            const manualCategory = row[4];

            // Skip transactions with manual category overrides
            if (manualCategory === 1) {
                skippedManual++;
                return;
            }

            const ruleResult = applyTransactionRules(description, currentCategoryName);

            // Update if rules matched
            if (ruleResult.shouldIgnore) {
                db.run('UPDATE transactions SET ignored = 1 WHERE id = ?', [transId]);
                ignoredCount++;
            }

            if (ruleResult.category !== currentCategoryName) {
                const newCategoryId = dbHelpers.queryValue('SELECT id FROM categories WHERE name = ?', [ruleResult.category]);
                if (newCategoryId) {
                    db.run('UPDATE transactions SET category_id = ? WHERE id = ?', [newCategoryId, transId]);
                    categorizedCount++;
                }
            }
        });
    }

    markDirty();
    await loadTransactions();
    refreshFilters();
    await updateAnalytics();

    let message = 'Applied rules: ';
    const parts = [];
    if (ignoredCount > 0) parts.push(`${ignoredCount} ignored`);
    if (categorizedCount > 0) parts.push(`${categorizedCount} re-categorized`);
    if (skippedManual > 0) parts.push(`${skippedManual} skipped (manual override)`);

    if (parts.length > 0) {
        message += parts.join(', ');
    } else {
        message = 'No transactions matched the rules';
    }

    showMessage('success', message);
}

// ═══════════════════════════════════════════════════════════════════════════
// §13. BUDGET
// ═══════════════════════════════════════════════════════════════════════════

async function loadBudget() {
    const container = document.getElementById('budgetContainer');
    if (!container) return;

    // Update month navigator label
    const [y, m] = budgetMonth.split('-');
    const monthLabel = new Date(+y, +m - 1).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
    const isCurrentMonth = budgetMonth === new Date().toISOString().slice(0, 7);
    const el = document.getElementById('budgetMonthLabel');
    if (el) el.textContent = monthLabel;
    const nextBtn = document.getElementById('budgetNextBtn');
    if (nextBtn) nextBtn.disabled = isCurrentMonth;
    const subtitle = document.getElementById('budgetSubtitle');
    if (subtitle) subtitle.textContent = isCurrentMonth
        ? 'Set a monthly spending limit per category. Leave blank for no limit.'
        : `Showing actual spend for ${monthLabel} vs your current budget limits.`;

    // Fetch all categories with their saved budget limit and selected month spend
    const rows = dbHelpers.queryAll(`
        SELECT
            c.id,
            c.name,
            c.icon,
            c.color,
            COALESCE(b.monthly_limit, '') as monthly_limit,
            COALESCE(
                (SELECT ABS(SUM(t.amount))
                 FROM transactions t
                 WHERE t.category_id = c.id
                   AND t.ignored = 0
                   AND t.amount < 0
                   AND strftime('%Y-%m', t.date) = ?
                ), 0
            ) as spent
        FROM categories c
        LEFT JOIN budget b ON b.category_id = c.id
        ORDER BY c.sort_order, c.name
    `, [budgetMonth]);

    if (!rows.length) {
        container.innerHTML = '<div class="loading">No categories found. Add categories in Settings first.</div>';
        return;
    }

    const frag = document.createDocumentFragment();

    // Compute totals from the already-fetched rows
    let totalBudget = 0, totalSpent = 0, assignedCount = 0;
    rows.forEach(row => {
        const [id, name, icon, color, monthlyLimit, spent] = row;
        const hasLimit = monthlyLimit !== '' && monthlyLimit !== null;
        if (hasLimit) {
            totalBudget += parseFloat(monthlyLimit);
            assignedCount++;
        }
        totalSpent += spent;
    });
    const totalRemaining = totalBudget - totalSpent;
    const totalPct = totalBudget > 0 ? (totalSpent / totalBudget * 100) : 0;
    const totalBarWidth = Math.min(totalPct, 100);
    const summaryBarColor = totalSpent > totalBudget ? '#e74c3c' : totalPct > 80 ? '#f39c12' : '#2ecc71';

    const summary = document.createElement('div');
    summary.style.cssText = 'display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:12px; margin-bottom:20px;';
    summary.innerHTML = `
        <div style="background:white; border:1px solid #ecf0f1; border-radius:8px; padding:16px;">
            <div style="font-size:12px; color:#7f8c8d; text-transform:uppercase; letter-spacing:.5px; margin-bottom:6px;">Total Budget</div>
            <div style="font-size:22px; font-weight:700; color:#2c3e50;">$${totalBudget.toFixed(2)}</div>
            <div style="font-size:12px; color:#95a5a6; margin-top:4px;">${assignedCount} of ${rows.length} categories assigned</div>
        </div>
        <div style="background:white; border:1px solid #ecf0f1; border-radius:8px; padding:16px;">
            <div style="font-size:12px; color:#7f8c8d; text-transform:uppercase; letter-spacing:.5px; margin-bottom:6px;">Total Spent</div>
            <div style="font-size:22px; font-weight:700; color:#e74c3c;">$${totalSpent.toFixed(2)}</div>
            <div style="font-size:12px; color:#95a5a6; margin-top:4px;">this month</div>
        </div>
        <div style="background:white; border:1px solid #ecf0f1; border-radius:8px; padding:16px;">
            <div style="font-size:12px; color:#7f8c8d; text-transform:uppercase; letter-spacing:.5px; margin-bottom:6px;">${totalRemaining >= 0 ? 'Remaining' : 'Over Budget'}</div>
            <div style="font-size:22px; font-weight:700; color:${totalRemaining >= 0 ? '#27ae60' : '#e74c3c'};">
                ${totalRemaining >= 0 ? '' : '-'}$${Math.abs(totalRemaining).toFixed(2)}
            </div>
            <div style="font-size:12px; color:#95a5a6; margin-top:4px;">of assigned categories</div>
        </div>
        <div style="background:white; border:1px solid #ecf0f1; border-radius:8px; padding:16px;">
            <div style="font-size:12px; color:#7f8c8d; text-transform:uppercase; letter-spacing:.5px; margin-bottom:6px;">Overall Usage</div>
            <div style="font-size:22px; font-weight:700; color:${summaryBarColor};">${totalPct.toFixed(0)}%</div>
            <div style="background:#ecf0f1; border-radius:4px; height:6px; overflow:hidden; margin-top:8px;">
                <div style="width:${totalBarWidth.toFixed(1)}%; height:100%; background:${summaryBarColor};"></div>
            </div>
        </div>
    `;
    frag.appendChild(summary);

    // Header
    const header = document.createElement('div');
    header.style.cssText = `display:grid; grid-template-columns:2fr 1.2fr 1.2fr 1.5fr${isCurrentMonth ? ' 80px' : ''}; gap:8px; padding:8px 16px; background:#f8f9fa; border-radius:6px; margin-bottom:4px; font-size:12px; font-weight:600; color:#7f8c8d; text-transform:uppercase; letter-spacing:.5px;`;
    header.innerHTML = `<div>Category</div><div style="text-align:right;">Budget / mo</div><div style="text-align:right;">Spent</div><div>Progress</div>${isCurrentMonth ? '<div></div>' : ''}`;
    frag.appendChild(header);

    const gridCols = `2fr 1.2fr 1.2fr 1.5fr${isCurrentMonth ? ' 80px' : ''}`;

    rows.forEach(row => {
        const [id, name, icon, color, monthlyLimit, spent] = row;
        const hasLimit = monthlyLimit !== '' && monthlyLimit !== null;
        const limit = hasLimit ? parseFloat(monthlyLimit) : 0;
        const pct = hasLimit && limit > 0 ? (spent / limit * 100) : 0;
        const over = hasLimit && spent > limit;
        const barColor = over ? '#e74c3c' : pct > 80 ? '#f39c12' : '#2ecc71';
        const barWidth = Math.min(pct, 100); // bar capped at 100% visually
        const overAmount = over ? (spent - limit).toFixed(2) : null;

        const row_el = document.createElement('div');
        row_el.style.cssText = `display:grid; grid-template-columns:${gridCols}; gap:8px; align-items:center; padding:10px 16px; background:white; border:1px solid ${over ? '#fadbd8' : '#ecf0f1'}; border-radius:6px; margin-bottom:6px;`;
        row_el.dataset.categoryId = id;

        const statusLine = hasLimit
            ? (over
                ? `<span style="color:#e74c3c; font-weight:600;">▲ Over by $${overAmount}</span>`
                : `<span style="color:#27ae60;">$${(limit - spent).toFixed(2)} remaining</span>`)
            : '<span style="color:#bdc3c7;">No limit set</span>';

        const budgetCell = isCurrentMonth
            ? `<input type="number" min="0" step="0.01"
                    value="${hasLimit ? limit.toFixed(2) : ''}"
                    placeholder="—"
                    style="width:90px; text-align:right; border:1px solid #ddd; border-radius:4px; padding:4px 6px; font-size:14px;"
                    data-id="${id}">`
            : `<span style="font-weight:600; color:#2c3e50;">${hasLimit ? '$' + limit.toFixed(2) : '—'}</span>`;

        const saveCell = isCurrentMonth
            ? `<button data-save="${id}" style="padding:4px 10px; font-size:12px;">Save</button>`
            : '';

        row_el.innerHTML = `
            <div style="display:flex; align-items:center; gap:10px;">
                <span style="font-size:20px;">${escapeHtml(icon || '📦')}</span>
                <div>
                    <div style="font-weight:600;">${escapeHtml(name)}</div>
                    <div style="font-size:11px; margin-top:2px;">${statusLine}</div>
                </div>
            </div>
            <div style="text-align:right;">${budgetCell}</div>
            <div style="text-align:right; font-weight:600; color:${over ? '#e74c3c' : '#2c3e50'};">
                $${spent.toFixed(2)}
            </div>
            <div>
                ${hasLimit && limit > 0 ? `
                    <div style="background:#ecf0f1; border-radius:4px; height:8px; overflow:hidden;">
                        <div style="width:${barWidth.toFixed(1)}%; height:100%; background:${barColor};"></div>
                    </div>
                    <div style="font-size:11px; color:${over ? '#e74c3c' : '#7f8c8d'}; margin-top:2px; font-weight:${over ? '600' : 'normal'}">${pct.toFixed(0)}%${over ? ' ⚠' : ''}</div>
                ` : '<span style="color:#bdc3c7; font-size:12px;">—</span>'}
            </div>
            ${isCurrentMonth ? `<div>${saveCell}</div>` : ''}
        `;

        if (isCurrentMonth) {
            row_el.querySelector(`[data-save="${id}"]`).addEventListener('click', () => {
                const input = row_el.querySelector(`input[data-id="${id}"]`);
                saveBudgetEntry(id, input.value.trim());
            });
            row_el.querySelector(`input[data-id="${id}"]`).addEventListener('keydown', e => {
                if (e.key === 'Enter') saveBudgetEntry(id, e.target.value.trim());
            });
        }

        frag.appendChild(row_el);
    });

    // Save All button — only shown for current month
    if (isCurrentMonth) {
        const saveAll = document.createElement('div');
        saveAll.style.cssText = 'margin-top:16px; display:flex; gap:12px; align-items:center;';
        saveAll.innerHTML = '<button id="saveAllBudgetBtn" style="padding:8px 20px;">💾 Save All</button>';
        frag.appendChild(saveAll);
        container.innerHTML = '';
        container.appendChild(frag);
        document.getElementById('saveAllBudgetBtn').addEventListener('click', saveAllBudget);
    } else {
        container.innerHTML = '';
        container.appendChild(frag);
    }
}

function shiftBudgetMonth(delta) {
    const [y, m] = budgetMonth.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    const newMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const currentMonth = new Date().toISOString().slice(0, 7);
    if (newMonth > currentMonth) return; // never go into the future
    budgetMonth = newMonth;
    loadBudget();
}

async function saveBudgetEntry(categoryId, rawValue) {
    if (rawValue === '' || rawValue === null) {
        // Clear limit
        dbHelpers.safeRun('DELETE FROM budget WHERE category_id = ?', [categoryId], 'Clear budget');
    } else {
        const amount = parseFloat(rawValue);
        if (isNaN(amount) || amount < 0) {
            showMessage('error', 'Budget amount must be a positive number');
            return;
        }
        dbHelpers.safeRun(`
            INSERT INTO budget (category_id, monthly_limit) VALUES (?, ?)
            ON CONFLICT(category_id) DO UPDATE SET monthly_limit = excluded.monthly_limit
        `, [categoryId, amount], 'Save budget');
    }
    markDirty();
    await loadBudget();
    showMessage('success', 'Budget saved');
}

async function saveAllBudget() {
    const inputs = document.querySelectorAll('#budgetContainer input[data-id]');
    let hasError = false;

    inputs.forEach(input => {
        const categoryId = input.dataset.id;
        const raw = input.value.trim();
        if (raw === '') {
            dbHelpers.safeRun('DELETE FROM budget WHERE category_id = ?', [categoryId], 'Clear budget');
        } else {
            const amount = parseFloat(raw);
            if (isNaN(amount) || amount < 0) {
                hasError = true;
                return;
            }
            dbHelpers.safeRun(`
                INSERT INTO budget (category_id, monthly_limit) VALUES (?, ?)
                ON CONFLICT(category_id) DO UPDATE SET monthly_limit = excluded.monthly_limit
            `, [categoryId, amount], 'Save budget');
        }
    });

    if (hasError) {
        showMessage('error', 'Some amounts are invalid — fix and try again');
        return;
    }

    markDirty();
    await loadBudget();
    showMessage('success', 'All budgets saved');
}

// ═══════════════════════════════════════════════════════════════════════════
// §14. PLANNER (Emergency Fund)
// ═══════════════════════════════════════════════════════════════════════════

// ── Helpers ──────────────────────────────────────────────────────────────

function plannerMonths() {
    // Returns array of 6 {year, month (1-12), label} from current month
    const result = [];
    const now = new Date();
    for (let i = 0; i < 6; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
        result.push({
            year:  d.getFullYear(),
            month: d.getMonth() + 1,
            key:   `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
            label: d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
        });
    }
    return result;
}

function commitmentAmountForMonth(commitment, year, month) {
    // Returns the amount due in a given year/month, or 0
    if (!commitment.enabled) return 0;
    const monthKey = `${year}-${String(month).padStart(2, '0')}`;

    if (commitment.type === 'monthly') {
        // Check active_months filter
        if (commitment.active_months) {
            const allowed = commitment.active_months.split(',').map(m => parseInt(m.trim()));
            if (!allowed.includes(month)) return 0;
        }
        return commitment.amount;
    }

    if (commitment.type === 'term' && commitment.payment_dates) {
        // Check if any of the listed dates falls in this month
        const dates = commitment.payment_dates.split(',').map(d => d.trim());
        const hit = dates.some(d => d.startsWith(monthKey));
        return hit ? commitment.amount : 0;
    }

    return 0;
}

// ── Load & render ─────────────────────────────────────────────────────────

async function loadPlanner() {
    const varRow = dbHelpers.queryAll(`SELECT value FROM planner_settings WHERE key = 'variable_spend'`);
    const variableSpend = varRow.length ? parseFloat(varRow[0][0]) : 0;
    const varInput = document.getElementById('plannerVariableSpend');
    if (varInput) varInput.value = variableSpend || '';

    // Load commitments joined to category/subcategory names+colors
    const rows = dbHelpers.queryAll(`
        SELECT ec.id, ec.description, ec.amount, ec.type,
               ec.day_of_month, ec.payment_dates, ec.active_months,
               ec.notes, ec.enabled,
               ec.category_id, ec.subcategory_id,
               c.name  AS cat_name,  c.icon AS cat_icon, c.color AS cat_color,
               sc.name AS subcat_name
        FROM expense_commitments ec
        LEFT JOIN categories   c  ON ec.category_id    = c.id
        LEFT JOIN subcategories sc ON ec.subcategory_id = sc.id
        ORDER BY COALESCE(c.sort_order, 9999), c.name, ec.type DESC, ec.description
    `);

    const commitments = rows.map(r => ({
        id: r[0], description: r[1], amount: r[2], type: r[3],
        day_of_month: r[4], payment_dates: r[5], active_months: r[6],
        notes: r[7], enabled: r[8],
        category_id: r[9], subcategory_id: r[10],
        cat_name: r[11] || 'Uncategorised', cat_icon: r[12] || '📦',
        cat_color: r[13] || '#95a5a6', subcat_name: r[14]
    }));

    renderPlannerTable(commitments, variableSpend);
    loadFinancialHealth();
    loadActivities();
}

function renderPlannerTable(commitments, variableSpend) {
    const container = document.getElementById('plannerTable');
    if (!container) return;

    const months = plannerMonths();

    if (!commitments.length && !variableSpend) {
        container.innerHTML = '<div class="loading">No expense commitments yet. Click "+ Add Expense" to get started.</div>';
        return;
    }

    // Pre-compute per-commitment month amounts
    const matrix = {};
    commitments.forEach(c => {
        matrix[c.id] = {};
        months.forEach(m => { matrix[c.id][m.key] = commitmentAmountForMonth(c, m.year, m.month); });
    });

    // Grand totals per month (all commitments)
    const monthTotals = {};
    months.forEach(m => {
        monthTotals[m.key] = commitments.reduce((s, c) => s + (matrix[c.id][m.key] || 0), 0);
    });

    // Per-commitment 6-mo total and 3-mo total
    const commitmentTotals6mo = {};
    const commitmentTotals3mo = {};
    commitments.forEach(c => {
        commitmentTotals6mo[c.id] = months.reduce((s, m) => s + (matrix[c.id][m.key] || 0), 0);
        commitmentTotals3mo[c.id] = months.slice(0, 3).reduce((s, m) => s + (matrix[c.id][m.key] || 0), 0);
    });

    const grandTotal6mo = Object.values(monthTotals).reduce((a, b) => a + b, 0) + variableSpend * 6;
    const grandTotal3mo = months.slice(0, 3).reduce((s, m) => s + monthTotals[m.key], 0) + variableSpend * 3;

    // Group commitments by category
    const catMap = {};  // cat_name → {icon, color, items[]}
    commitments.forEach(c => {
        const key = c.cat_name;
        if (!catMap[key]) catMap[key] = { icon: c.cat_icon, color: c.cat_color, items: [] };
        catMap[key].items.push(c);
    });
    const catKeys = Object.keys(catMap);  // already sorted by query

    const frag = document.createDocumentFragment();
    const wrap = document.createElement('div');
    wrap.style.cssText = 'overflow-x:auto;';

    const colCount = months.length + 3; // name + 6 months + total + actions

    // ── Shared header ──────────────────────────────────────────────────────
    function makeHeaderRow(bgColor) {
        const tr = document.createElement('tr');
        const thName = document.createElement('th');
        thName.style.cssText = `text-align:left; min-width:200px; padding:8px 14px; background:${bgColor}; border-bottom:2px solid #dee2e6; color:#2c3e50;`;
        thName.textContent = 'Expense';
        tr.appendChild(thName);
        months.forEach(m => {
            const th = document.createElement('th');
            th.style.cssText = `text-align:right; min-width:95px; padding:8px 14px; background:${bgColor}; border-bottom:2px solid #dee2e6; white-space:nowrap; color:#2c3e50;`;
            th.textContent = m.label;
            tr.appendChild(th);
        });
        const th3mo = document.createElement('th');
        th3mo.style.cssText = `text-align:right; min-width:90px; padding:8px 14px; background:${bgColor}; border-bottom:2px solid #dee2e6; color:#7f8c8d;`;
        th3mo.textContent = '3-mo Total';
        tr.appendChild(th3mo);
        const thTot = document.createElement('th');
        thTot.style.cssText = `text-align:right; min-width:90px; padding:8px 14px; background:${bgColor}; border-bottom:2px solid #dee2e6; color:#7f8c8d;`;
        thTot.textContent = '6-mo Total';
        tr.appendChild(thTot);
        const thAct = document.createElement('th');
        thAct.style.cssText = `min-width:70px; padding:8px 14px; background:${bgColor}; border-bottom:2px solid #dee2e6;`;
        tr.appendChild(thAct);
        return tr;
    }

    // ── Commitment data row ────────────────────────────────────────────────
    function makeCommitmentRow(c) {
        const tr = document.createElement('tr');
        tr.style.opacity = c.enabled ? '1' : '0.45';

        const tdName = document.createElement('td');
        tdName.style.cssText = 'padding:8px 14px 8px 28px; border-bottom:1px solid #f0f0f0;';
        const typeTag = c.type === 'term'
            ? '<span style="font-size:10px; background:#9b59b620; color:#9b59b6; padding:1px 5px; border-radius:3px; margin-left:4px;">term</span>'
            : '';
        tdName.innerHTML = `
            <div style="font-weight:500; font-size:13px;">${escapeHtml(c.description)}${typeTag}</div>
            ${c.subcat_name ? `<div style="font-size:11px; color:#95a5a6;">${escapeHtml(c.subcat_name)}</div>` : ''}
            ${c.notes ? `<div style="font-size:11px; color:#bdc3c7; font-style:italic;">${escapeHtml(c.notes)}</div>` : ''}
        `;
        tr.appendChild(tdName);

        months.forEach(m => {
            const amt = matrix[c.id][m.key];
            const td = document.createElement('td');
            td.style.cssText = 'text-align:right; padding:8px 14px; border-bottom:1px solid #f0f0f0; font-size:13px;';
            td.innerHTML = amt > 0
                ? `<span style="font-weight:600; color:#2c3e50;">S$${amt.toFixed(2)}</span>`
                : `<span style="color:#e0e0e0;">—</span>`;
            tr.appendChild(td);
        });

        const td3mo = document.createElement('td');
        td3mo.style.cssText = 'text-align:right; padding:8px 14px; border-bottom:1px solid #f0f0f0; color:#7f8c8d; font-weight:600; font-size:13px;';
        td3mo.textContent = commitmentTotals3mo[c.id] > 0 ? `S$${commitmentTotals3mo[c.id].toFixed(2)}` : '—';
        tr.appendChild(td3mo);

        const tdTot = document.createElement('td');
        tdTot.style.cssText = 'text-align:right; padding:8px 14px; border-bottom:1px solid #f0f0f0; color:#7f8c8d; font-weight:600; font-size:13px;';
        tdTot.textContent = commitmentTotals6mo[c.id] > 0 ? `S$${commitmentTotals6mo[c.id].toFixed(2)}` : '—';
        tr.appendChild(tdTot);

        const tdAct = document.createElement('td');
        tdAct.style.cssText = 'padding:5px 10px; border-bottom:1px solid #f0f0f0; white-space:nowrap;';
        const editBtn = document.createElement('button');
        editBtn.className = 'secondary-btn';
        editBtn.style.cssText = 'padding:3px 8px; font-size:11px; margin-right:3px;';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', () => editCommitment(c));
        const delBtn = document.createElement('button');
        delBtn.className = 'danger-btn';
        delBtn.style.cssText = 'padding:3px 8px; font-size:11px;';
        delBtn.textContent = 'Del';
        delBtn.addEventListener('click', () => deleteCommitment(c.id));
        tdAct.append(editBtn, delBtn);
        tr.appendChild(tdAct);

        return tr;
    }

    // ── Category subtotal row ─────────────────────────────────────────────
    function makeCategorySubtotalRow(items, color) {
        const catMonthTotals = {};
        months.forEach(m => {
            catMonthTotals[m.key] = items.reduce((s, c) => s + (matrix[c.id][m.key] || 0), 0);
        });
        const catTotal = Object.values(catMonthTotals).reduce((a, b) => a + b, 0);

        const tr = document.createElement('tr');
        tr.style.cssText = `background:${color}08; font-size:12px;`;

        const tdLabel = document.createElement('td');
        tdLabel.style.cssText = 'padding:6px 14px 6px 28px; border-bottom:1px solid #e8e8e8; color:#7f8c8d; font-style:italic;';
        tdLabel.textContent = `${items.length} item${items.length !== 1 ? 's' : ''}`;
        tr.appendChild(tdLabel);

        months.forEach(m => {
            const td = document.createElement('td');
            td.style.cssText = `text-align:right; padding:6px 14px; border-bottom:1px solid #e8e8e8; font-weight:600; color:${catMonthTotals[m.key] > 0 ? color : '#e0e0e0'};`;
            td.textContent = catMonthTotals[m.key] > 0 ? `S$${catMonthTotals[m.key].toFixed(2)}` : '—';
            tr.appendChild(td);
        });

        const tdTot = document.createElement('td');
        tdTot.style.cssText = `text-align:right; padding:6px 14px; border-bottom:1px solid #e8e8e8; font-weight:700; color:${color};`;
        tdTot.textContent = catTotal > 0 ? `S$${catTotal.toFixed(2)}` : '—';
        tr.appendChild(tdTot);
        tr.appendChild(document.createElement('td'));
        return tr;
    }

    // ── Build one collapsible table per category ───────────────────────────
    catKeys.forEach(catKey => {
        const cat = catMap[catKey];
        const catTotal6mo = cat.items.reduce((s, c) => s + commitmentTotals6mo[c.id], 0);

        const section = document.createElement('div');
        section.style.cssText = 'margin-bottom:10px; border-radius:8px; overflow:hidden; border:1px solid #ecf0f1;';

        // Category header (clickable, collapsed by default)
        const header = document.createElement('div');
        header.style.cssText = `display:flex; align-items:center; gap:10px; padding:10px 16px; background:${cat.color}15; cursor:pointer; user-select:none; border-bottom:1px solid ${cat.color}30;`;
        header.innerHTML = `
            <span style="font-size:18px;">${cat.icon}</span>
            <span style="font-weight:700; font-size:14px; color:#2c3e50;">${escapeHtml(catKey)}</span>
            <span style="font-size:12px; color:#95a5a6;">${cat.items.length} item${cat.items.length !== 1 ? 's' : ''}</span>
            <span style="margin-left:auto; font-weight:700; color:${cat.color};">S$${catTotal6mo.toFixed(2)}</span>
            <span style="font-size:12px; color:#95a5a6;">/ 6 mo</span>
            <span data-arrow style="font-size:12px; color:${cat.color}; transition:transform .15s;">▶</span>
        `;

        // Body table (hidden by default)
        const bodyWrap = document.createElement('div');
        bodyWrap.style.display = 'none';
        const tbl = document.createElement('table');
        tbl.style.cssText = 'width:100%; border-collapse:collapse;';
        const thead = document.createElement('thead');
        thead.appendChild(makeHeaderRow('#fafafa'));
        tbl.appendChild(thead);
        const tbody = document.createElement('tbody');
        cat.items.forEach(c => tbody.appendChild(makeCommitmentRow(c)));
        tbody.appendChild(makeCategorySubtotalRow(cat.items, cat.color));
        tbl.appendChild(tbody);
        bodyWrap.appendChild(tbl);

        // Toggle
        header.addEventListener('click', () => {
            const open = bodyWrap.style.display !== 'none';
            bodyWrap.style.display = open ? 'none' : 'block';
            header.querySelector('[data-arrow]').textContent = open ? '▶' : '▼';
        });

        section.appendChild(header);
        section.appendChild(bodyWrap);
        wrap.appendChild(section);
    });

    // ── Variable spend row (always visible) ───────────────────────────────
    if (variableSpend > 0) {
        const varSection = document.createElement('div');
        varSection.style.cssText = 'margin-bottom:10px; border-radius:8px; overflow:hidden; border:1px solid #f39c1230;';
        const tbl = document.createElement('table');
        tbl.style.cssText = 'width:100%; border-collapse:collapse;';
        const tbody = document.createElement('tbody');
        const tr = document.createElement('tr');
        const tdName = document.createElement('td');
        tdName.style.cssText = 'padding:10px 14px; background:#fff8e1;';
        tdName.innerHTML = `<div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:16px;">🛒</span>
            <div>
                <div style="font-weight:600; font-size:13px;">Variable spend estimate</div>
                <div style="font-size:11px; color:#95a5a6;">Food, transport &amp; other essentials</div>
            </div>
        </div>`;
        tr.appendChild(tdName);
        months.forEach(() => {
            const td = document.createElement('td');
            td.style.cssText = 'text-align:right; padding:10px 14px; background:#fff8e1; font-weight:600; color:#e67e22; font-size:13px;';
            td.textContent = `S$${variableSpend.toFixed(2)}`;
            tr.appendChild(td);
        });
        const tdTot = document.createElement('td');
        tdTot.style.cssText = 'text-align:right; padding:10px 14px; background:#fff8e1; font-weight:700; color:#e67e22;';
        tdTot.textContent = `S$${(variableSpend * 6).toFixed(2)}`;
        tr.appendChild(tdTot);
        tr.appendChild(document.createElement('td'));
        tbody.appendChild(tr);
        tbl.appendChild(tbody);
        varSection.appendChild(tbl);
        wrap.appendChild(varSection);
    }

    // ── Grand total row ────────────────────────────────────────────────────
    const totalTable = document.createElement('table');
    totalTable.style.cssText = 'width:100%; border-collapse:collapse;';
    const tfoot = document.createElement('tfoot');
    const totalRow = document.createElement('tr');
    totalRow.style.cssText = 'background:#2c3e50; color:white; font-weight:700;';
    const tdLabel = document.createElement('td');
    tdLabel.style.cssText = 'padding:12px 14px; font-size:14px;';
    tdLabel.textContent = 'Monthly total';
    totalRow.appendChild(tdLabel);
    months.forEach(m => {
        const colTotal = monthTotals[m.key] + (variableSpend || 0);
        const td = document.createElement('td');
        td.style.cssText = 'text-align:right; padding:12px 14px; font-size:13px; min-width:95px;';
        td.textContent = `S$${colTotal.toFixed(2)}`;
        totalRow.appendChild(td);
    });
    const tdGrand = document.createElement('td');
    tdGrand.colSpan = 2;
    tfoot.appendChild(totalRow);
    totalTable.appendChild(tfoot);
    wrap.appendChild(totalTable);

    frag.appendChild(wrap);

    // ── Fund target cards ──────────────────────────────────────────────────
    const cardsContainer = document.createElement('div');
    cardsContainer.style.cssText = 'display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:20px;';

    const card3mo = document.createElement('div');
    card3mo.style.cssText = 'background:white; border:2px solid #3498db; border-radius:10px; padding:20px 24px; display:flex; align-items:center; justify-content:space-between;';
    card3mo.innerHTML = `
        <div>
            <div style="font-size:13px; color:#7f8c8d; text-transform:uppercase; letter-spacing:.5px; margin-bottom:4px;">3-Month Emergency Fund Target</div>
            <div style="font-size:13px; color:#95a5a6;">Fixed commitments + variable spend over 3 months</div>
        </div>
        <div style="text-align:right;">
            <div style="font-size:32px; font-weight:800; color:#3498db;">S$${grandTotal3mo.toLocaleString('en-SG', {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
            <div style="font-size:12px; color:#95a5a6; margin-top:2px;">≈ S$${(grandTotal3mo/3).toLocaleString('en-SG', {minimumFractionDigits:2, maximumFractionDigits:2})} / month average</div>
        </div>
    `;

    const card6mo = document.createElement('div');
    card6mo.style.cssText = 'background:white; border:2px solid #27ae60; border-radius:10px; padding:20px 24px; display:flex; align-items:center; justify-content:space-between;';
    card6mo.innerHTML = `
        <div>
            <div style="font-size:13px; color:#7f8c8d; text-transform:uppercase; letter-spacing:.5px; margin-bottom:4px;">6-Month Emergency Fund Target</div>
            <div style="font-size:13px; color:#95a5a6;">Fixed commitments + variable spend over 6 months</div>
        </div>
        <div style="text-align:right;">
            <div style="font-size:32px; font-weight:800; color:#27ae60;">S$${grandTotal6mo.toLocaleString('en-SG', {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
            <div style="font-size:12px; color:#95a5a6; margin-top:2px;">≈ S$${(grandTotal6mo/6).toLocaleString('en-SG', {minimumFractionDigits:2, maximumFractionDigits:2})} / month average</div>
        </div>
    `;

    cardsContainer.appendChild(card3mo);
    cardsContainer.appendChild(card6mo);
    frag.appendChild(cardsContainer);

    container.innerHTML = '';
    container.appendChild(frag);
}

// ── Form helpers ──────────────────────────────────────────────────────────

function showAddCommitmentForm() {
    document.getElementById('plannerEditId').value = '';
    document.getElementById('plannerFormTitle').textContent = 'Add Expense Commitment';
    document.getElementById('plannerDesc').value = '';
    document.getElementById('plannerAmount').value = '';
    document.getElementById('plannerType').value = 'monthly';
    document.getElementById('plannerActiveMonths').value = '';
    document.getElementById('plannerDates').value = '';
    document.getElementById('plannerNotes').value = '';
    populatePlannerCategoryDropdown(null, null);
    togglePlannerTypeFields();
    document.getElementById('plannerForm').style.display = 'block';
    document.getElementById('plannerDesc').focus();
}

function editCommitment(c) {
    document.getElementById('plannerEditId').value = c.id;
    document.getElementById('plannerFormTitle').textContent = 'Edit Expense Commitment';
    document.getElementById('plannerDesc').value = c.description;
    document.getElementById('plannerAmount').value = c.amount;
    document.getElementById('plannerType').value = c.type;
    document.getElementById('plannerActiveMonths').value = c.active_months || '';
    document.getElementById('plannerDates').value = c.payment_dates || '';
    document.getElementById('plannerNotes').value = c.notes || '';
    populatePlannerCategoryDropdown(c.category_id, c.subcategory_id);
    togglePlannerTypeFields();
    document.getElementById('plannerForm').style.display = 'block';
    document.getElementById('plannerDesc').focus();
}

function togglePlannerTypeFields() {
    const type = document.getElementById('plannerType').value;
    document.getElementById('plannerMonthsField').style.display = type === 'monthly' ? '' : 'none';
    document.getElementById('plannerDatesField').style.display  = type === 'term'    ? '' : 'none';
}

function populatePlannerCategoryDropdown(selectedCatId, selectedSubcatId) {
    const catSel = document.getElementById('plannerCategory');
    const subcatSel = document.getElementById('plannerSubcategory');
    if (!catSel) return;

    // Populate categories
    const cats = dbHelpers.queryAll(`SELECT id, name, icon FROM categories ORDER BY sort_order, name`);
    catSel.innerHTML = '<option value="">— None —</option>';
    cats.forEach(([id, name, icon]) => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = `${icon || ''} ${name}`.trim();
        if (id === selectedCatId) opt.selected = true;
        catSel.appendChild(opt);
    });

    // Populate subcategories for selected category
    updatePlannerSubcategoryOptions(selectedSubcatId);
}

function updatePlannerSubcategoryOptions(selectedSubcatId = null) {
    const catId = document.getElementById('plannerCategory').value;
    const subcatSel = document.getElementById('plannerSubcategory');
    subcatSel.innerHTML = '<option value="">— None —</option>';
    if (!catId) return;

    const subcats = dbHelpers.queryAll(
        `SELECT id, name FROM subcategories WHERE category_id = ? ORDER BY sort_order, name`,
        [catId]
    );
    subcats.forEach(([id, name]) => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = name;
        if (id === selectedSubcatId) opt.selected = true;
        subcatSel.appendChild(opt);
    });
}

function cancelPlannerForm() {
    document.getElementById('plannerForm').style.display = 'none';
}

async function saveCommitment() {
    const id           = document.getElementById('plannerEditId').value;
    const desc         = document.getElementById('plannerDesc').value.trim();
    const amount       = parseFloat(document.getElementById('plannerAmount').value);
    const type         = document.getElementById('plannerType').value;
    const activeMonths = document.getElementById('plannerActiveMonths').value.trim() || null;
    const dates        = document.getElementById('plannerDates').value.trim() || null;
    const notes        = document.getElementById('plannerNotes').value.trim() || null;
    const catVal       = document.getElementById('plannerCategory').value;
    const subcatVal    = document.getElementById('plannerSubcategory').value;
    const categoryId   = catVal    ? parseInt(catVal)    : null;
    const subcategoryId = subcatVal ? parseInt(subcatVal) : null;

    if (!desc) { showMessage('error', 'Description is required'); return; }
    if (isNaN(amount) || amount <= 0) { showMessage('error', 'Enter a valid amount'); return; }
    if (type === 'term' && !dates) { showMessage('error', 'Enter at least one payment date'); return; }

    if (type === 'term' && dates) {
        const invalid = dates.split(',').map(d => d.trim()).filter(d => !/^\d{4}-\d{2}-\d{2}$/.test(d));
        if (invalid.length) {
            showMessage('error', `Invalid date format: ${invalid.join(', ')} — use YYYY-MM-DD`);
            return;
        }
    }

    if (id) {
        dbHelpers.safeRun(`
            UPDATE expense_commitments
            SET description=?, amount=?, type=?, category_id=?, subcategory_id=?,
                active_months=?, payment_dates=?, notes=?
            WHERE id=?
        `, [desc, amount, type, categoryId, subcategoryId, activeMonths, dates, notes, id], 'Update commitment');
    } else {
        dbHelpers.safeRun(`
            INSERT INTO expense_commitments
                (description, amount, type, category_id, subcategory_id, active_months, payment_dates, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [desc, amount, type, categoryId, subcategoryId, activeMonths, dates, notes], 'Add commitment');
    }

    markDirty();
    cancelPlannerForm();
    await loadPlanner();
}

async function deleteCommitment(id) {
    if (!confirm('Remove this expense commitment?')) return;
    dbHelpers.safeRun('DELETE FROM expense_commitments WHERE id = ?', [id], 'Delete commitment');
    markDirty();
    await loadPlanner();
}

// ═══════════════════════════════════════════════════════════════════════════
// §15.5. Financial Health & Activities
// ═══════════════════════════════════════════════════════════════════════════

function loadFinancialHealth() {
    const latestBalance = dbHelpers.queryAll(`
        SELECT account_name, balance, as_of_date 
        FROM bank_balances 
        ORDER BY updated_at DESC 
        LIMIT 1
    `);

    const container = document.getElementById('balanceDisplay');
    if (!latestBalance.length) {
        container.innerHTML = '<div style="color:#7f8c8d; font-size:13px;">No bank balance recorded yet. Click "Update Balance" to add.</div>';
        return;
    }

    const [accountName, balance, asOfDate] = latestBalance[0];

    // Calculate emergency fund need (from planner)
    const varRow = dbHelpers.queryAll(`SELECT value FROM planner_settings WHERE key = 'variable_spend'`);
    const variableSpend = varRow.length ? parseFloat(varRow[0][0]) : 0;

    const commitmentRows = dbHelpers.queryAll(`SELECT amount, type, active_months, payment_dates FROM expense_commitments WHERE enabled = 1`);
    let monthlyCommitments = 0;
    commitmentRows.forEach(r => {
        const [amount, type] = r;
        if (type === 'monthly') monthlyCommitments += amount;
    });

    const monthlyBurn = monthlyCommitments + variableSpend;
    const emergencyFundTarget = monthlyBurn * 6;

    // Calculate scheduled activities impact
    const scheduledActivities = dbHelpers.queryAll(`
        SELECT SUM(ai.estimated_cost)
        FROM planned_activities pa
        JOIN activity_items ai ON ai.activity_id = pa.id
        WHERE pa.status = 'scheduled'
    `);
    const totalScheduled = scheduledActivities.length && scheduledActivities[0][0] ? scheduledActivities[0][0] : 0;

    const projectedBalance = balance - totalScheduled;
    const monthsCovered = projectedBalance / monthlyBurn;

    let statusIcon, statusText, statusColor;
    if (projectedBalance >= emergencyFundTarget) {
        statusIcon = '✅';
        statusText = 'Healthy';
        statusColor = '#27ae60';
    } else if (monthsCovered >= 3) {
        statusIcon = '⚠️';
        statusText = 'At Risk';
        statusColor = '#f39c12';
    } else {
        statusIcon = '🔴';
        statusText = 'Critical';
        statusColor = '#e74c3c';
    }

    container.innerHTML = `
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:20px; margin-bottom:12px;">
            <div>
                <div style="font-size:11px; color:#7f8c8d; margin-bottom:4px;">CURRENT BALANCE (${accountName})</div>
                <div style="font-size:24px; font-weight:700; color:#2c3e50;">$${balance.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
                <div style="font-size:11px; color:#95a5a6; margin-top:2px;">As of ${asOfDate}</div>
            </div>
            <div>
                <div style="font-size:11px; color:#7f8c8d; margin-bottom:4px;">6-MONTH EMERGENCY FUND</div>
                <div style="font-size:24px; font-weight:700; color:#7f8c8d;">$${emergencyFundTarget.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
                <div style="font-size:11px; color:#95a5a6; margin-top:2px;">$${monthlyBurn.toFixed(2)} × 6 months</div>
            </div>
        </div>
        ${totalScheduled > 0 ? `
        <div style="background:#fff3cd; border:1px solid #ffc107; border-radius:6px; padding:12px; margin-bottom:12px;">
            <div style="font-size:12px; font-weight:600; margin-bottom:4px;">After Scheduled Activities:</div>
            <div style="display:flex; justify-content:space-between; font-size:13px;">
                <span>Projected Balance:</span>
                <strong style="color:${projectedBalance < emergencyFundTarget ? '#e74c3c' : '#27ae60'};">$${projectedBalance.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</strong>
            </div>
            <div style="display:flex; justify-content:space-between; font-size:13px; margin-top:4px;">
                <span>Emergency Fund Coverage:</span>
                <strong style="color:${statusColor};">${monthsCovered.toFixed(1)} months</strong>
            </div>
        </div>
        ` : ''}
        <div style="display:flex; align-items:center; gap:8px; padding:10px; background:${statusColor}15; border-radius:6px;">
            <span style="font-size:20px;">${statusIcon}</span>
            <div>
                <div style="font-weight:600; font-size:14px; color:${statusColor};">${statusText}</div>
                <div style="font-size:12px; color:#7f8c8d;">
                    ${projectedBalance >= emergencyFundTarget 
                        ? 'You can afford scheduled activities comfortably' 
                        : projectedBalance >= monthlyBurn * 3
                            ? 'Below 6-month target but above 3 months'
                            : 'Critical: Below 3-month emergency fund'}
                </div>
            </div>
        </div>
    `;
}

function showUpdateBalanceForm() {
    document.getElementById('updateBalanceForm').style.display = 'block';
    document.getElementById('balanceDate').value = new Date().toISOString().split('T')[0];
}

function cancelBalanceForm() {
    document.getElementById('updateBalanceForm').style.display = 'none';
    document.getElementById('balanceAccountName').value = '';
    document.getElementById('balanceAmount').value = '';
}

function saveBalance() {
    const accountName = document.getElementById('balanceAccountName').value.trim();
    const amount = parseFloat(document.getElementById('balanceAmount').value);
    const asOfDate = document.getElementById('balanceDate').value;

    if (!accountName || !amount || !asOfDate) {
        alert('Please fill in all fields');
        return;
    }

    db.run('INSERT INTO bank_balances (account_name, balance, as_of_date) VALUES (?, ?, ?)', [accountName, amount, asOfDate]);
    markDirty();
    cancelBalanceForm();
    loadFinancialHealth();
    showMessage('success', 'Bank balance updated');
}

const ACTIVITY_TEMPLATES = [
    {
        name: '🎬 Movie Night',
        type: 'domestic',
        items: [
            { description: 'Transport', category: 'Transport', amount: 10 },
            { description: 'Movie Tickets', category: 'Entertainment', amount: 30 },
            { description: 'Snacks', category: 'Food', amount: 15 }
        ]
    },
    {
        name: '🦁 Zoo/Attraction Visit',
        type: 'domestic',
        items: [
            { description: 'Transport', category: 'Transport', amount: 20 },
            { description: 'Entry Tickets', category: 'Entertainment', amount: 80 },
            { description: 'Dining', category: 'Food', amount: 50 },
            { description: 'Souvenirs', category: 'Shopping', amount: 30 }
        ]
    },
    {
        name: '🍽️ Dining Out',
        type: 'domestic',
        items: [
            { description: 'Transport', category: 'Transport', amount: 15 },
            { description: 'Restaurant Bill', category: 'Food', amount: 80 }
        ]
    },
    {
        name: '🏖️ Weekend Getaway',
        type: 'domestic',
        items: [
            { description: 'Transport', category: 'Transport', amount: 100 },
            { description: 'Accommodation', category: 'Accommodation', amount: 200 },
            { description: 'Meals', category: 'Food', amount: 150 },
            { description: 'Activities', category: 'Entertainment', amount: 100 }
        ]
    },
    {
        name: '✈️ Overseas Trip',
        type: 'overseas',
        items: [
            { description: 'Flights', category: null, amount: 1200 },
            { description: 'Accommodation', category: null, amount: 1500 },
            { description: 'Daily Expenses', category: null, amount: 800 },
            { description: 'Activities & Tours', category: null, amount: 500 },
            { description: 'Miscellaneous', category: null, amount: 200 }
        ]
    }
];

function showActivityTemplates() {
    const container = document.getElementById('templatesList');
    container.innerHTML = ACTIVITY_TEMPLATES.map((tpl, idx) => {
        const total = tpl.items.reduce((sum, item) => sum + item.amount, 0);
        return `
            <div onclick="selectTemplate(${idx})" style="border:1px solid #dee2e6; border-radius:6px; padding:12px; margin-bottom:8px; cursor:pointer; transition:all .15s;" onmouseenter="this.style.background='#f8f9fa'" onmouseleave="this.style.background='white'">
                <div style="font-weight:600; margin-bottom:4px;">${tpl.name} <span style="color:#7f8c8d; font-weight:400;">($${total.toFixed(2)})</span></div>
                <div style="font-size:12px; color:#7f8c8d;">${tpl.items.map(i => i.description).join(' • ')}</div>
            </div>
        `;
    }).join('');
    document.getElementById('templatePicker').style.display = 'block';
}

function cancelTemplatePicker() {
    document.getElementById('templatePicker').style.display = 'none';
}

function selectTemplate(idx) {
    const tpl = ACTIVITY_TEMPLATES[idx];
    cancelTemplatePicker();
    showAddActivityForm();

    document.getElementById('activityName').value = tpl.name;
    document.getElementById('activityType').value = tpl.type;

    // Clear and populate items
    activityItemsData = tpl.items.map(item => {
        const categoryId = item.category ? dbHelpers.queryValue('SELECT id FROM categories WHERE name = ?', [item.category]) : null;
        return {
            description: item.description,
            category_id: categoryId,
            amount: item.amount
        };
    });
    renderActivityItems();
}

let activityItemsData = [];

function showAddActivityForm() {
    document.getElementById('activityFormTitle').textContent = 'Add Activity';
    document.getElementById('activityEditId').value = '';
    document.getElementById('activityName').value = '';
    document.getElementById('activityType').value = 'domestic';
    document.getElementById('activityNotes').value = '';
    activityItemsData = [];
    renderActivityItems();
    document.getElementById('activityForm').style.display = 'block';
}

function cancelActivityForm() {
    document.getElementById('activityForm').style.display = 'none';
    activityItemsData = [];
}

function addActivityItem() {
    activityItemsData.push({ description: '', category_id: null, amount: 0 });
    renderActivityItems();
}

function removeActivityItem(idx) {
    activityItemsData.splice(idx, 1);
    renderActivityItems();
}

function renderActivityItems() {
    const container = document.getElementById('activityItemsList');
    const type = document.getElementById('activityType').value;

    if (!activityItemsData.length) {
        container.innerHTML = '<div style="color:#7f8c8d; font-size:12px; padding:8px;">No items yet. Click "+ Add Item" to add.</div>';
        return;
    }

    const categories = dbHelpers.queryAll('SELECT id, name, icon FROM categories ORDER BY name');
    const categoryOptions = categories.map(c => `<option value="${c[0]}">${c[2] || ''} ${c[1]}</option>`).join('');

    container.innerHTML = activityItemsData.map((item, idx) => `
        <div style="display:grid; grid-template-columns:${type === 'domestic' ? '2fr 2fr' : '3fr'} 1fr auto; gap:8px; margin-bottom:8px; align-items:center;">
            <input type="text" placeholder="Description" value="${escapeHtml(item.description || '')}" 
                   onchange="activityItemsData[${idx}].description = this.value" 
                   style="padding:6px 8px; border:1px solid #ddd; border-radius:4px; font-size:13px;">
            ${type === 'domestic' ? `
            <select onchange="activityItemsData[${idx}].category_id = this.value ? parseInt(this.value) : null" 
                    style="padding:6px 8px; border:1px solid #ddd; border-radius:4px; font-size:13px;">
                <option value="">— Select Category —</option>
                ${categoryOptions}
            </select>
            ` : ''}
            <input type="number" placeholder="0.00" min="0" step="0.01" value="${item.amount || ''}" 
                   onchange="activityItemsData[${idx}].amount = parseFloat(this.value) || 0" 
                   style="padding:6px 8px; border:1px solid #ddd; border-radius:4px; font-size:13px;">
            <button onclick="removeActivityItem(${idx})" class="danger-btn" style="padding:6px 10px; font-size:12px;">×</button>
        </div>
    `).join('');

    // Set selected category values
    activityItemsData.forEach((item, idx) => {
        if (type === 'domestic' && item.category_id) {
            const select = container.querySelectorAll('select')[idx];
            if (select) select.value = item.category_id;
        }
    });
}

function saveActivity() {
    const name = document.getElementById('activityName').value.trim();
    const type = document.getElementById('activityType').value;
    const notes = document.getElementById('activityNotes').value.trim();
    const editId = document.getElementById('activityEditId').value;

    if (!name) {
        alert('Please enter activity name');
        return;
    }

    if (!activityItemsData.length) {
        alert('Please add at least one cost item');
        return;
    }

    // Validate items
    for (let item of activityItemsData) {
        if (!item.description || !item.amount) {
            alert('Please fill in all item descriptions and amounts');
            return;
        }
        if (type === 'domestic' && !item.category_id) {
            alert('Please select a category for all domestic activity items');
            return;
        }
    }

    let activityId;
    if (editId) {
        // Update existing
        activityId = editId;
        db.run('UPDATE planned_activities SET name = ?, type = ?, notes = ? WHERE id = ?', [name, type, notes, editId]);
        db.run('DELETE FROM activity_items WHERE activity_id = ?', [editId]);
    } else {
        // Insert new
        db.run('INSERT INTO planned_activities (name, type, notes) VALUES (?, ?, ?)', [name, type, notes]);
        activityId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
    }

    // Insert items
    activityItemsData.forEach(item => {
        db.run('INSERT INTO activity_items (activity_id, description, category_id, estimated_cost) VALUES (?, ?, ?, ?)',
            [activityId, item.description, item.category_id, item.amount]);
    });

    markDirty();
    cancelActivityForm();
    loadActivities();
    loadFinancialHealth();
    showMessage('success', 'Activity saved');
}

function loadActivities() {
    loadUnscheduledActivities();
    loadScheduledActivities();
}

function loadUnscheduledActivities() {
    const activities = dbHelpers.queryAll(`
        SELECT pa.id, pa.name, pa.type, pa.notes,
               SUM(ai.estimated_cost) as total
        FROM planned_activities pa
        JOIN activity_items ai ON ai.activity_id = pa.id
        WHERE pa.status = 'unscheduled'
        GROUP BY pa.id
        ORDER BY pa.created_at DESC
    `);

    const container = document.getElementById('unscheduledList');

    if (!activities.length) {
        container.innerHTML = '<div style="color:#7f8c8d; font-size:13px;">No unscheduled activities. Click "+ Add Activity" to create one.</div>';
        return;
    }

    container.innerHTML = activities.map(activity => {
        const [id, name, type, notes, total] = activity;
        const typeLabel = type === 'overseas' ? ' (Overseas)' : '';

        // Get items for this activity
        const items = dbHelpers.queryAll(`
            SELECT ai.description, c.name, ai.estimated_cost
            FROM activity_items ai
            LEFT JOIN categories c ON ai.category_id = c.id
            WHERE ai.activity_id = ?
            ORDER BY COALESCE(c.name, 'zzz'), ai.description
        `, [id]);

        const itemsSummary = items.map(i => `${i[0]}: $${i[2].toFixed(0)}`).join(' • ');

        return `
            <div style="border:1px solid #dee2e6; border-radius:6px; padding:12px; margin-bottom:8px; background:white;">
                <div style="display:flex; justify-content:space-between; align-items:start; margin-bottom:6px;">
                    <div>
                        <div style="font-weight:600;">${type === 'overseas' ? '✈️' : '🎯'} ${escapeHtml(name)}${typeLabel}</div>
                        <div style="font-size:12px; color:#7f8c8d; margin-top:4px;">${itemsSummary}</div>
                        ${notes ? `<div style="font-size:11px; color:#95a5a6; margin-top:4px; font-style:italic;">${escapeHtml(notes)}</div>` : ''}
                    </div>
                    <div style="font-weight:700; color:#3498db; font-size:16px;">$${total.toFixed(2)}</div>
                </div>
                <div style="display:flex; gap:6px; margin-top:8px;">
                    <button onclick="scheduleActivity(${id})" class="secondary-btn" style="padding:4px 10px; font-size:12px;">📅 Schedule</button>
                    <button onclick="editActivity(${id})" class="secondary-btn" style="padding:4px 10px; font-size:12px;">✏️ Edit</button>
                    <button onclick="deleteActivity(${id})" class="danger-btn" style="padding:4px 10px; font-size:12px;">🗑️ Delete</button>
                </div>
            </div>
        `;
    }).join('');
}

function loadScheduledActivities() {
    const activities = dbHelpers.queryAll(`
        SELECT pa.id, pa.name, pa.type, pa.scheduled_month, pa.notes,
               SUM(ai.estimated_cost) as total
        FROM planned_activities pa
        JOIN activity_items ai ON ai.activity_id = pa.id
        WHERE pa.status = 'scheduled'
        GROUP BY pa.id
        ORDER BY pa.scheduled_month
    `);

    if (!activities.length) {
        document.getElementById('scheduledActivities').innerHTML = '';
        return;
    }

    // Group by month
    const byMonth = {};
    activities.forEach(activity => {
        const month = activity[3];
        if (!byMonth[month]) byMonth[month] = [];
        byMonth[month].push(activity);
    });

    const html = Object.keys(byMonth).sort().map(month => {
        const [y, m] = month.split('-');
        const monthLabel = new Date(+y, +m - 1).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
        const monthActivities = byMonth[month];
        const monthTotal = monthActivities.reduce((sum, a) => sum + a[5], 0);

        return `
            <div style="border:1px solid #3498db; border-radius:8px; padding:16px; margin-bottom:16px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                    <h5 style="margin:0; color:#3498db;">${monthLabel}</h5>
                    <div style="font-weight:700; color:#3498db; font-size:16px;">Total: $${monthTotal.toFixed(2)}</div>
                </div>
                ${monthActivities.map(activity => {
                    const [id, name, type, , notes, total] = activity;
                    const typeLabel = type === 'overseas' ? ' (Overseas)' : '';

                    const items = dbHelpers.queryAll(`
                        SELECT ai.description, c.name, ai.estimated_cost
                        FROM activity_items ai
                        LEFT JOIN categories c ON ai.category_id = c.id
                        WHERE ai.activity_id = ?
                        ORDER BY COALESCE(c.name, 'zzz'), ai.description
                    `, [id]);

                    const itemsSummary = items.map(i => `${i[0]}: $${i[2].toFixed(0)}`).join(' • ');

                    return `
                        <div style="background:#f8f9fa; border-radius:6px; padding:12px; margin-bottom:8px;">
                            <div style="display:flex; justify-content:space-between; align-items:start; margin-bottom:6px;">
                                <div style="flex:1;">
                                    <div style="font-weight:600;">${type === 'overseas' ? '✈️' : '🎯'} ${escapeHtml(name)}${typeLabel}</div>
                                    <div style="font-size:12px; color:#7f8c8d; margin-top:4px;">${itemsSummary}</div>
                                    ${notes ? `<div style="font-size:11px; color:#95a5a6; margin-top:4px; font-style:italic;">${escapeHtml(notes)}</div>` : ''}
                                </div>
                                <div style="font-weight:700; color:#3498db; font-size:16px; margin-left:12px;">$${total.toFixed(2)}</div>
                            </div>
                            <div style="display:flex; gap:6px; margin-top:8px;">
                                <button onclick="unscheduleActivity(${id})" class="secondary-btn" style="padding:4px 10px; font-size:12px;">↩️ Unschedule</button>
                                <button onclick="editActivity(${id})" class="secondary-btn" style="padding:4px 10px; font-size:12px;">✏️ Edit</button>
                                <button onclick="deleteActivity(${id})" class="danger-btn" style="padding:4px 10px; font-size:12px;">🗑️ Delete</button>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }).join('');

    document.getElementById('scheduledActivities').innerHTML = html;
}

function scheduleActivity(id) {
    const monthInput = prompt('Enter month (YYYY-MM):');
    if (!monthInput) return;

    // Validate format
    if (!/^\d{4}-\d{2}$/.test(monthInput)) {
        alert('Invalid format. Please use YYYY-MM (e.g., 2026-03)');
        return;
    }

    db.run('UPDATE planned_activities SET status = ?, scheduled_month = ? WHERE id = ?', ['scheduled', monthInput, id]);
    markDirty();
    loadActivities();
    loadFinancialHealth();
    showMessage('success', 'Activity scheduled');
}

function unscheduleActivity(id) {
    db.run('UPDATE planned_activities SET status = ?, scheduled_month = NULL WHERE id = ?', ['unscheduled', id]);
    markDirty();
    loadActivities();
    loadFinancialHealth();
    showMessage('success', 'Activity unscheduled');
}

function editActivity(id) {
    const activity = dbHelpers.queryAll('SELECT name, type, notes FROM planned_activities WHERE id = ?', [id])[0];
    if (!activity) return;

    const items = dbHelpers.queryAll(`
        SELECT ai.description, ai.category_id, ai.estimated_cost
        FROM activity_items ai
        LEFT JOIN categories c ON ai.category_id = c.id
        WHERE ai.activity_id = ?
        ORDER BY COALESCE(c.name, 'zzz'), ai.description
    `, [id]);

    document.getElementById('activityFormTitle').textContent = 'Edit Activity';
    document.getElementById('activityEditId').value = id;
    document.getElementById('activityName').value = activity[0];
    document.getElementById('activityType').value = activity[1];
    document.getElementById('activityNotes').value = activity[2] || '';

    activityItemsData = items.map(i => ({ description: i[0], category_id: i[1], amount: i[2] }));
    renderActivityItems();
    document.getElementById('activityForm').style.display = 'block';
}

function deleteActivity(id) {
    if (!confirm('Delete this activity?')) return;

    db.run('DELETE FROM planned_activities WHERE id = ?', [id]);
    markDirty();
    loadActivities();
    loadFinancialHealth();
    showMessage('success', 'Activity deleted');
}

async function savePlannerVariable() {
    const val = parseFloat(document.getElementById('plannerVariableSpend').value) || 0;
    dbHelpers.safeRun(`
        INSERT INTO planner_settings (key, value) VALUES ('variable_spend', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `, [val], 'Save variable spend');
    markDirty();
    await loadPlanner();
}

// ═══════════════════════════════════════════════════════════════════════════
// APPLICATION BOOTSTRAP
// ═══════════════════════════════════════════════════════════════════════════

// Initialize on load
window.addEventListener('DOMContentLoaded', init);

/*
═══════════════════════════════════════════════════════════════════════════
  END OF BANK STATEMENT CONSOLIDATOR
═══════════════════════════════════════════════════════════════════════════
*/
