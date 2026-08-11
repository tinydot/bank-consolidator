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
    loadPurchases();
    populateManualAccountSelect();
    setupEventListeners();
    driveSyncInit();
    askAiLoadHistory();
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

    // Text-stored money values in key/value tables. (The old
    // planner_settings 'variable_spend' row is no longer used — the emergency
    // fund derives its baseline from the Budget tab — so it's purged in
    // setupSchema rather than converted here.)
    for (const [table, key] of [['settings', 'monthly_expected_income']]) {
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
    setupBalanceSnapshotIndex();
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

    // Ask AI conversation history. Persisted here (rather than in localStorage)
    // so it rides along in the single exported DB blob — i.e. it is included in
    // both the local .db download/import and the Google Drive backup/restore.
    // Only the plain question/answer text is stored: the SQL and the fetched
    // rows (tool_use / tool_result blocks) are stripped before saving so no
    // row-level data lands in the DB or its backups (see askAiSanitizedHistory).
    //   role    : the Anthropic message role ('user' | 'assistant')
    //   content : that message's plain text
    db.run(`
        CREATE TABLE IF NOT EXISTS ask_ai_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
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
            interval_months INTEGER,
            anchor_date   TEXT,
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

    // ─── Itemised marketplace purchases (Shopee, …) ───────────────────────
    // These are deliberately NOT rows in `transactions`. The money is already
    // in `transactions` — it arrived on the card/bank CSV as one charge per
    // order — so inserting orders here as well would double-count spend in
    // every SUM(amount) across analytics, budget, and the planner. This is a
    // descriptive itemisation *of* a bank charge: it answers "what was in that
    // $34.36 Shopee charge", drives restock cadence and unit-price trends, and
    // never contributes to a money total.
    //
    //   external_id : the marketplace's own order id. Stable across repeated
    //                 CSV exports, which is why UNIQUE(source, external_id)
    //                 makes re-import idempotent — see the note below.
    //   total       : integer cents, the amount actually paid for the order
    //                 (post-voucher), i.e. what the bank charge should equal.
    //   transaction_id : the reconciled bank row, NULL until matched.
    //   purchase_import_id : the file that first introduced this order. Its own
    //                 log rather than the bank `imports` table, because
    //                 imports.account_id is NOT NULL and FK-enforced — a
    //                 marketplace export has no bank account, and inventing one
    //                 would leak into every account dropdown, filter, balance
    //                 snapshot, and the Overview net-worth roll-up.
    //
    // NOTE — this is the one place the app dedupes on insert, contrary to the
    // "no silent duplicate deduplication" rule in CLAUDE.md. That rule protects
    // bank CSVs, where duplicate rows are legitimate data (pending → posted,
    // split charges) and no stable row id exists. Here the marketplace supplies
    // a real primary key, and overlapping re-exports are the normal workflow,
    // so re-importing a file must not restate orders. Bank imports are
    // unaffected.
    // Log of itemised-purchase CSV imports. Informational: because the import
    // is idempotent on (source, external_id) and real exports overlap heavily,
    // "undo this file" is not a coherent operation — an order can be present in
    // five exports. Orders are therefore removed per-order or per-source, and
    // deleting a log row just forgets the provenance (ON DELETE SET NULL).
    db.run(`
        CREATE TABLE IF NOT EXISTS purchase_imports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL DEFAULT 'shopee',
            filename TEXT NOT NULL,
            import_date TEXT NOT NULL,
            orders_new INTEGER NOT NULL DEFAULT 0,
            orders_updated INTEGER NOT NULL DEFAULT 0,
            item_count INTEGER NOT NULL DEFAULT 0
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS purchase_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL DEFAULT 'shopee',
            external_id TEXT NOT NULL,
            order_date TEXT,
            shop TEXT,
            status TEXT,
            total INTEGER NOT NULL DEFAULT 0,
            url TEXT,
            transaction_id INTEGER,
            purchase_import_id INTEGER,
            UNIQUE(source, external_id),
            FOREIGN KEY (purchase_import_id) REFERENCES purchase_imports(id) ON DELETE SET NULL,
            FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE SET NULL
        )
    `);

    // One row per line item on an order.
    //   unit_price       : integer cents actually paid per unit (pre-voucher)
    //   unit_price_original : integer cents list price, NULL when not exported
    //   allocated_amount : this item's share of the order's post-voucher total,
    //                      apportioned by gross value. Item prices do NOT sum
    //                      to order total (vouchers, coins, shipping, free
    //                      gifts), so this is the only item figure that
    //                      reconciles — the allocations of an order sum exactly
    //                      to purchase_orders.total.
    //   product_key      : identity used for restock/price analysis. Seeded
    //                      from the item name, then corrected by hand in the
    //                      catalog — marketplace titles are keyword soup, so
    //                      the same product appears under many names.
    //   source_key       : the seed product_key as first derived from this
    //                      item's own name, never rewritten by a merge. It is
    //                      what makes merging reversible: unmerging restores
    //                      product_key from it, so a wrong merge is not a
    //                      one-way door needing a re-import to undo.
    db.run(`
        CREATE TABLE IF NOT EXISTS purchase_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            variation TEXT,
            qty INTEGER NOT NULL DEFAULT 1,
            unit_price INTEGER NOT NULL DEFAULT 0,
            unit_price_original INTEGER,
            allocated_amount INTEGER NOT NULL DEFAULT 0,
            product_key TEXT,
            source_key TEXT,
            FOREIGN KEY (order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE
        )
    `);

    // Added after the initial Purchases release; backfill leaves merged rows
    // alone (their source_key is already set and differs from product_key).
    try { db.run('ALTER TABLE purchase_items ADD COLUMN source_key TEXT'); } catch(e) {}
    db.run('UPDATE purchase_items SET source_key = product_key WHERE source_key IS NULL');

    // Durable record of "these seed keys are the same product". Merging must
    // not live only in purchase_items.product_key: re-importing an order
    // deletes and re-inserts its items, which would silently discard every
    // merge made since. The item's product_key is therefore derived —
    // alias(source_key) or source_key — and this table is the decision.
    db.run(`
        CREATE TABLE IF NOT EXISTS product_aliases (
            source_key  TEXT PRIMARY KEY,
            product_key TEXT NOT NULL
        )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_product_aliases_target ON product_aliases(product_key)`);

    // Curated product identity. Only worth filling in for things actually
    // rebought — pack_size/unit is what makes a unit-price trend meaningful
    // (a 100-pack and a 40-pack of the same nappy are not comparable), and
    // is_consumable is what makes a restock interval meaningful.
    db.run(`
        CREATE TABLE IF NOT EXISTS product_catalog (
            product_key TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            category_id INTEGER,
            subcategory_id INTEGER,
            is_consumable INTEGER NOT NULL DEFAULT 0,
            pack_size REAL,
            unit TEXT,
            FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
            FOREIGN KEY (subcategory_id) REFERENCES subcategories(id) ON DELETE SET NULL
        )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_purchase_orders_date ON purchase_orders(order_date)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_purchase_orders_txn ON purchase_orders(transaction_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_purchase_items_order ON purchase_items(order_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_purchase_items_key ON purchase_items(product_key)`);

    db.run(`CREATE INDEX IF NOT EXISTS idx_activity_items_activity ON activity_items(activity_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_planned_activities_month ON planned_activities(scheduled_month)`);

    // Add category columns to expense_commitments if upgrading from earlier version
    try { db.run('ALTER TABLE expense_commitments ADD COLUMN category_id INTEGER'); } catch(e) {}
    try { db.run('ALTER TABLE expense_commitments ADD COLUMN subcategory_id INTEGER'); } catch(e) {}
    // Add interval-recurrence columns (every-N-months expenses: aircon, dental…)
    try { db.run('ALTER TABLE expense_commitments ADD COLUMN interval_months INTEGER'); } catch(e) {}
    try { db.run('ALTER TABLE expense_commitments ADD COLUMN anchor_date TEXT'); } catch(e) {}

    // Purge the retired manual variable-spend setting (the emergency-fund
    // baseline now comes from the Budget tab). Idempotent — a no-op once gone.
    try { db.run(`DELETE FROM planner_settings WHERE key = 'variable_spend'`); } catch(e) {}
}

// Enforce one balance snapshot per account per day, so re-recording a date
// corrects it in place (see saveBalance upsert) instead of stacking duplicates.
// Runs after migrateToForeignKeys, which rebuilds bank_balances and would
// otherwise drop the index. One-shot dedupe of legacy duplicates first.
function setupBalanceSnapshotIndex() {
    const bbDedupe = db.exec(`SELECT value FROM settings WHERE key = 'migration_balance_snapshot_dedupe'`);
    const bbDedupeDone = bbDedupe.length && bbDedupe[0].values.length && bbDedupe[0].values[0][0] === 'done';
    if (!bbDedupeDone) {
        db.run(`DELETE FROM bank_balances
                WHERE id NOT IN (SELECT MAX(id) FROM bank_balances GROUP BY account_id, as_of_date)`);
        db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('migration_balance_snapshot_dedupe', 'done')`);
    }
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_balances_acct_date ON bank_balances(account_id, as_of_date)`);
}

// ═══════════════════════════════════════════════════════════════════════════
