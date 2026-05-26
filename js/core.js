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
let selectedTransactionIds = new Set();
let previewTransactions = []; // parsed rows waiting to be imported
let _showDuplicates = false;  // toggle state for hidden duplicate rows
let budgetMonth = new Date().toISOString().slice(0, 7); // YYYY-MM, current month

// ─────────────────────────────────────────────────────────────────────────
// §1.1. Constants
// ─────────────────────────────────────────────────────────────────────────

const CONFIG = {
    PAGE_SIZE: 50,
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
    // div.innerHTML escapes & < >; also escape quotes so the result is safe
    // inside double/single-quoted HTML attributes, not just text content.
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
