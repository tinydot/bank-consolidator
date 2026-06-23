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
    loadOverview();
    populateManualAccountSelect();
    setupEventListeners();
    driveSyncInit();
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
        setupSchema();
        await saveDatabaseToIndexedDB();
    } else {
        db = savedDb ? new SQL.Database(new Uint8Array(savedDb)) : new SQL.Database();
        setupSchema();
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
    try { db.run(`UPDATE manual_transactions SET amount = CAST(ROUND(amount * 100) AS INTEGER)`); } catch(e) {}
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

// Rebuild a single table with a new definition (SQLite can't ALTER in FK
// actions): create <name>__mig, copy, drop original, rename. Indexes that
// lived on the old table must be re-supplied.
function fkRebuild(name, body, columns, selectSql, indexes, orIgnore) {
    db.run(`CREATE TABLE ${name}__mig (${body})`);
    db.run(`INSERT ${orIgnore ? 'OR IGNORE ' : ''}INTO ${name}__mig (${columns}) ${selectSql}`);
    db.run(`DROP TABLE ${name}`);
    db.run(`ALTER TABLE ${name}__mig RENAME TO ${name}`);
    (indexes || []).forEach(ix => db.run(ix));
}

// One-shot migration that rebuilds the schema with real ON DELETE behaviour,
// re-keys the balance tables from account_name → account_id, then turns on
// foreign-key enforcement. Idempotent via the `migration_fk_constraints` flag.
// Runs inside a transaction with enforcement OFF; orphaned rows are cleaned
// first so the new constraints are satisfiable, and a foreign_key_check gates
// the COMMIT (rolls back on any violation).
function migrateToForeignKeys() {
    let done = false;
    try {
        const r = db.exec(`SELECT value FROM settings WHERE key = 'migration_fk_constraints'`);
        done = r.length > 0 && r[0].values.length > 0 && r[0].values[0][0] === 'done';
    } catch (e) { /* settings missing — first run */ }
    if (done) return;

    // Fresh databases are already created with the target schema, so there's
    // nothing to convert — the discriminator is the old bank_balances.account_name.
    const bbInfo = db.exec(`PRAGMA table_info(bank_balances)`);
    const bbCols = bbInfo.length ? bbInfo[0].values.map(r => r[1]) : [];
    if (!bbCols.includes('account_name')) {
        db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('migration_fk_constraints', 'done')`);
        return;
    }

    db.run('PRAGMA foreign_keys = OFF');
    db.run('BEGIN');
    try {
        // 1. Structural orphans (NOT NULL FKs) — delete top-down so it propagates.
        db.run(`DELETE FROM accounts      WHERE bank_id     NOT IN (SELECT id FROM banks)`);
        db.run(`DELETE FROM imports       WHERE account_id  NOT IN (SELECT id FROM accounts)`);
        db.run(`DELETE FROM transactions  WHERE import_id   NOT IN (SELECT id FROM imports)`);
        db.run(`DELETE FROM subcategories WHERE category_id NOT IN (SELECT id FROM categories)`);
        db.run(`DELETE FROM budget        WHERE category_id NOT IN (SELECT id FROM categories)`);
        try { db.run(`DELETE FROM activity_items WHERE activity_id NOT IN (SELECT id FROM planned_activities)`); } catch (e) {}

        // 2. Dangling optional refs → NULL (matches the new SET NULL columns).
        db.run(`UPDATE transactions SET category_id    = NULL WHERE category_id    IS NOT NULL AND category_id    NOT IN (SELECT id FROM categories)`);
        db.run(`UPDATE transactions SET subcategory_id = NULL WHERE subcategory_id IS NOT NULL AND subcategory_id NOT IN (SELECT id FROM subcategories)`);
        db.run(`UPDATE transaction_rules SET category_value    = NULL WHERE category_value    IS NOT NULL AND category_value    NOT IN (SELECT id FROM categories)`);
        db.run(`UPDATE transaction_rules SET subcategory_value = NULL WHERE subcategory_value IS NOT NULL AND subcategory_value NOT IN (SELECT id FROM subcategories)`);
        db.run(`UPDATE expense_commitments SET category_id    = NULL WHERE category_id    IS NOT NULL AND category_id    NOT IN (SELECT id FROM categories)`);
        db.run(`UPDATE expense_commitments SET subcategory_id = NULL WHERE subcategory_id IS NOT NULL AND subcategory_id NOT IN (SELECT id FROM subcategories)`);
        db.run(`UPDATE activity_items SET category_id = NULL WHERE category_id IS NOT NULL AND category_id NOT IN (SELECT id FROM categories)`);

        // 3. Rebuild child tables with ON DELETE actions.
        fkRebuild('subcategories',
            `id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER NOT NULL, name TEXT NOT NULL, sort_order INTEGER DEFAULT 0,
             FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE, UNIQUE(category_id, name)`,
            'id, category_id, name, sort_order',
            'SELECT id, category_id, name, sort_order FROM subcategories');

        fkRebuild('accounts',
            `id INTEGER PRIMARY KEY AUTOINCREMENT, bank_id INTEGER NOT NULL, account_name TEXT NOT NULL, account_number TEXT, keyword TEXT DEFAULT '',
             FOREIGN KEY (bank_id) REFERENCES banks(id) ON DELETE CASCADE, UNIQUE(bank_id, account_name)`,
            'id, bank_id, account_name, account_number, keyword',
            'SELECT id, bank_id, account_name, account_number, keyword FROM accounts');

        fkRebuild('transaction_rules',
            `id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, keyword TEXT NOT NULL, action TEXT NOT NULL,
             category_value INTEGER, subcategory_value INTEGER, case_sensitive INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1,
             priority INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
             FOREIGN KEY (category_value) REFERENCES categories(id) ON DELETE SET NULL,
             FOREIGN KEY (subcategory_value) REFERENCES subcategories(id) ON DELETE SET NULL`,
            'id, name, keyword, action, category_value, subcategory_value, case_sensitive, enabled, priority, created_at',
            'SELECT id, name, keyword, action, category_value, subcategory_value, case_sensitive, enabled, priority, created_at FROM transaction_rules');

        fkRebuild('imports',
            `id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL, import_date TEXT NOT NULL, account_id INTEGER NOT NULL, transaction_count INTEGER DEFAULT 0,
             FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE`,
            'id, filename, import_date, account_id, transaction_count',
            'SELECT id, filename, import_date, account_id, transaction_count FROM imports');

        fkRebuild('transactions',
            `id INTEGER PRIMARY KEY AUTOINCREMENT, import_id INTEGER NOT NULL, date TEXT NOT NULL, description TEXT, amount INTEGER NOT NULL,
             category_id INTEGER, subcategory_id INTEGER, ignored INTEGER DEFAULT 0, auto_ignored INTEGER DEFAULT 0, manual_category INTEGER DEFAULT 0, note TEXT,
             FOREIGN KEY (import_id) REFERENCES imports(id) ON DELETE CASCADE,
             FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
             FOREIGN KEY (subcategory_id) REFERENCES subcategories(id) ON DELETE SET NULL`,
            'id, import_id, date, description, amount, category_id, subcategory_id, ignored, auto_ignored, manual_category, note',
            'SELECT id, import_id, date, description, amount, category_id, subcategory_id, ignored, auto_ignored, manual_category, note FROM transactions',
            [
                'CREATE INDEX IF NOT EXISTS idx_date ON transactions(date)',
                'CREATE INDEX IF NOT EXISTS idx_import ON transactions(import_id)',
                'CREATE INDEX IF NOT EXISTS idx_ignored ON transactions(ignored)',
                'CREATE INDEX IF NOT EXISTS idx_category ON transactions(category_id)',
                'CREATE INDEX IF NOT EXISTS idx_subcategory ON transactions(subcategory_id)',
            ]);

        fkRebuild('budget',
            `category_id INTEGER PRIMARY KEY, monthly_limit INTEGER NOT NULL,
             FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE`,
            'category_id, monthly_limit',
            'SELECT category_id, monthly_limit FROM budget');

        fkRebuild('expense_commitments',
            `id INTEGER PRIMARY KEY AUTOINCREMENT, description TEXT NOT NULL, amount INTEGER NOT NULL, type TEXT NOT NULL DEFAULT 'monthly',
             category_id INTEGER, subcategory_id INTEGER, day_of_month INTEGER, payment_dates TEXT, active_months TEXT, notes TEXT, enabled INTEGER DEFAULT 1,
             FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
             FOREIGN KEY (subcategory_id) REFERENCES subcategories(id) ON DELETE SET NULL`,
            'id, description, amount, type, category_id, subcategory_id, day_of_month, payment_dates, active_months, notes, enabled',
            'SELECT id, description, amount, type, category_id, subcategory_id, day_of_month, payment_dates, active_months, notes, enabled FROM expense_commitments');

        fkRebuild('activity_items',
            `id INTEGER PRIMARY KEY AUTOINCREMENT, activity_id INTEGER NOT NULL, category_id INTEGER, description TEXT NOT NULL, estimated_cost INTEGER NOT NULL, actual_cost INTEGER,
             FOREIGN KEY (activity_id) REFERENCES planned_activities(id) ON DELETE CASCADE,
             FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL`,
            'id, activity_id, category_id, description, estimated_cost, actual_cost',
            'SELECT id, activity_id, category_id, description, estimated_cost, actual_cost FROM activity_items',
            ['CREATE INDEX IF NOT EXISTS idx_activity_items_activity ON activity_items(activity_id)']);

        // 4. Re-key balance tables to account_id. Rows whose account_name no
        //    longer matches an account (rogue/orphaned) are dropped here.
        fkRebuild('bank_balances',
            `id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, balance INTEGER NOT NULL, as_of_date TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
             FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE`,
            'id, account_id, balance, as_of_date, updated_at',
            `SELECT bb.id, (SELECT a.id FROM accounts a WHERE a.account_name = bb.account_name ORDER BY a.id LIMIT 1),
                    bb.balance, bb.as_of_date, bb.updated_at
             FROM bank_balances bb
             WHERE (SELECT a.id FROM accounts a WHERE a.account_name = bb.account_name ORDER BY a.id LIMIT 1) IS NOT NULL`);

        fkRebuild('account_purpose',
            `account_id INTEGER PRIMARY KEY, bucket TEXT NOT NULL DEFAULT 'liquid', emergency INTEGER NOT NULL DEFAULT 1,
             FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE`,
            'account_id, bucket, emergency',
            `SELECT (SELECT a.id FROM accounts a WHERE a.account_name = ap.account_name ORDER BY a.id LIMIT 1), ap.bucket, ap.emergency
             FROM account_purpose ap
             WHERE (SELECT a.id FROM accounts a WHERE a.account_name = ap.account_name ORDER BY a.id LIMIT 1) IS NOT NULL`,
            null, true);

        // 5. Validate before committing.
        const violations = db.exec('PRAGMA foreign_key_check');
        if (violations.length && violations[0].values.length) {
            throw new Error('foreign_key_check found ' + violations[0].values.length + ' violation(s)');
        }
        db.run('COMMIT');
    } catch (e) {
        db.run('ROLLBACK');
        db.run('PRAGMA foreign_keys = ON');
        if (typeof showMessage === 'function') {
            showMessage('error', 'Foreign-key migration failed and was rolled back: ' + e.message);
        }
        throw e;
    }
    db.run('PRAGMA foreign_keys = ON');
    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('migration_fk_constraints', 'done')`);
}

// Create any missing tables, then run the one-shot migrations and enable FK
// enforcement. Shared by both initSQLite load paths.
function setupSchema() {
    createTables();
    migrateMoneyToCents();
    migrateToForeignKeys();
    db.run('PRAGMA foreign_keys = ON');
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
            FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
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
            FOREIGN KEY (bank_id) REFERENCES banks(id) ON DELETE CASCADE,
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
            FOREIGN KEY (category_value) REFERENCES categories(id) ON DELETE SET NULL,
            FOREIGN KEY (subcategory_value) REFERENCES subcategories(id) ON DELETE SET NULL
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS imports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL,
            import_date TEXT NOT NULL,
            account_id INTEGER NOT NULL,
            transaction_count INTEGER DEFAULT 0,
            FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
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
            note TEXT,
            FOREIGN KEY (import_id) REFERENCES imports(id) ON DELETE CASCADE,
            FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
            FOREIGN KEY (subcategory_id) REFERENCES subcategories(id) ON DELETE SET NULL
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
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS budget (
            category_id INTEGER PRIMARY KEY,
            monthly_limit INTEGER NOT NULL,
            FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
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
            FOREIGN KEY (category_id)    REFERENCES categories(id) ON DELETE SET NULL,
            FOREIGN KEY (subcategory_id) REFERENCES subcategories(id) ON DELETE SET NULL
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
            FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS bank_balances (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL,
            balance INTEGER NOT NULL,
            as_of_date TEXT NOT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
        )
    `);

    // Per-account classification for the Overview/Planner balance views.
    //   bucket    : liquid | investment | locked  (drives net-worth grouping)
    //   emergency : 1 if this account counts toward the emergency-fund target
    // Unclassified accounts default to liquid + counted (see accountPurposeMap).
    db.run(`
        CREATE TABLE IF NOT EXISTS account_purpose (
            account_id INTEGER PRIMARY KEY,
            bucket TEXT NOT NULL DEFAULT 'liquid',
            emergency INTEGER NOT NULL DEFAULT 1,
            FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
        )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_activity_items_activity ON activity_items(activity_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_planned_activities_month ON planned_activities(scheduled_month)`);

    // Add category columns to expense_commitments if upgrading from earlier version
    try { db.run('ALTER TABLE expense_commitments ADD COLUMN category_id INTEGER'); } catch(e) {}
    try { db.run('ALTER TABLE expense_commitments ADD COLUMN subcategory_id INTEGER'); } catch(e) {}
}

// ═══════════════════════════════════════════════════════════════════════════
