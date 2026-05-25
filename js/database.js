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
    populateTemplateAccountSelect();
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
        migrateMoneyToCents();
        await saveDatabaseToIndexedDB();
    } else {
        db = savedDb ? new SQL.Database(new Uint8Array(savedDb)) : new SQL.Database();
        createTables();
        migrateMoneyToCents();
    }
}

// One-shot migration converting every persisted money column from REAL
// (decimal dollars) to INTEGER cents. Runs once per database; idempotent via
// the `migration_money_to_cents` settings flag. New / empty databases hit no
// rows and just set the flag.
function migrateMoneyToCents() {
    let done = false;
    try {
        const r = db.exec(`SELECT value FROM settings WHERE key = 'migration_money_to_cents'`);
        done = r.length > 0 && r[0].values.length > 0 && r[0].values[0][0] === 'done';
    } catch (e) { /* settings table missing — first run, treat as not done */ }
    if (done) return;

    db.run(`UPDATE transactions         SET amount         = CAST(ROUND(amount         * 100) AS INTEGER)`);
    db.run(`UPDATE manual_transactions  SET amount         = CAST(ROUND(amount         * 100) AS INTEGER)`);
    db.run(`UPDATE budget               SET monthly_limit  = CAST(ROUND(monthly_limit  * 100) AS INTEGER)`);
    db.run(`UPDATE expense_commitments  SET amount         = CAST(ROUND(amount         * 100) AS INTEGER)`);
    db.run(`UPDATE activity_items       SET estimated_cost = CAST(ROUND(estimated_cost * 100) AS INTEGER) WHERE estimated_cost IS NOT NULL`);
    db.run(`UPDATE activity_items       SET actual_cost    = CAST(ROUND(actual_cost    * 100) AS INTEGER) WHERE actual_cost IS NOT NULL`);
    db.run(`UPDATE bank_balances        SET balance        = CAST(ROUND(balance        * 100) AS INTEGER)`);

    // Text-stored money values in key/value tables.
    for (const [table, key] of [['settings', 'monthly_expected_income'], ['planner_settings', 'variable_spend']]) {
        try {
            const r = db.exec(`SELECT value FROM ${table} WHERE key = ?`, [key]);
            if (r.length > 0 && r[0].values.length > 0) {
                const v = parseFloat(r[0].values[0][0]);
                if (isFinite(v)) {
                    db.run(`UPDATE ${table} SET value = ? WHERE key = ?`, [String(Math.round(v * 100)), key]);
                }
            }
        } catch (e) { /* table or row absent — nothing to migrate */ }
    }

    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('migration_money_to_cents', 'done')`);
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
            keyword TEXT DEFAULT '',
            FOREIGN KEY (bank_id) REFERENCES banks(id),
            UNIQUE(bank_id, account_name)
        )
    `);

    // Migrate: add keyword column to existing databases
    try { db.run("ALTER TABLE accounts ADD COLUMN keyword TEXT DEFAULT ''"); } catch(e) {}

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
            amount INTEGER NOT NULL,
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
    try { db.run('ALTER TABLE transactions ADD COLUMN note TEXT'); } catch(e) {}

    db.run(`
        CREATE TABLE IF NOT EXISTS manual_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            description TEXT NOT NULL,
            amount INTEGER NOT NULL,
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
            monthly_limit INTEGER NOT NULL,
            FOREIGN KEY (category_id) REFERENCES categories(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS expense_commitments (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            description   TEXT NOT NULL,
            amount        INTEGER NOT NULL,
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
            estimated_cost INTEGER NOT NULL,
            actual_cost INTEGER,
            FOREIGN KEY (activity_id) REFERENCES planned_activities(id) ON DELETE CASCADE,
            FOREIGN KEY (category_id) REFERENCES categories(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS bank_balances (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_name TEXT NOT NULL,
            balance INTEGER NOT NULL,
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
