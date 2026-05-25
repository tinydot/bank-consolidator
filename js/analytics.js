// §8. ANALYTICS & REPORTING
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────
// §8.1. Statistics Calculation
// ─────────────────────────────────────────────────────────────────────────

async function updateAnalytics() {
    // Monthly breakdown — last 6 months
    const monthlyResult = db.exec(`
        SELECT
            strftime('%Y-%m', date) as month,
            SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as income,
            SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as expenses,
            SUM(amount) as net
        FROM transactions
        WHERE ignored = 0
          AND date >= date('now', '-6 months', 'start of month')
        GROUP BY month
        ORDER BY month DESC
    `);

    updateMonthlyTable(monthlyResult);

    // Category breakdown by month — last 6 months, expenses only
    const categoryResult = db.exec(`
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
    `);

    updateCategoryChart(categoryResult);

    // Last transaction date per account
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
                Total: <strong style="color: #e74c3c;">$${fmtMoneyLocale(group.total)}</strong>
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
            <td style="padding:10px 8px; text-align:right; font-weight:600; color:#e74c3c; white-space:nowrap;">$${fmtMoneyLocale(tx.amount)}</td>
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

    const result = db.exec(`
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
    `, [tagViewMonth]);

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

    // Use fixed expected income if set, otherwise derive from transactions
    const expectedIncomeVal = dbHelpers.queryValue("SELECT value FROM settings WHERE key = 'monthly_expected_income'");
    const usingExpectedIncome = expectedIncomeVal !== null && expectedIncomeVal !== '' && !isNaN(parseFloat(expectedIncomeVal));

    if (usingExpectedIncome) {
        totalIncome = parseFloat(expectedIncomeVal);
    } else {
        // Get income for this month from transactions
        const incomeResult = db.exec(`
            SELECT SUM(amount) FROM transactions
            WHERE amount > 0 AND ignored = 0 AND strftime('%Y-%m', date) = ?
        `, [tagViewMonth]);
        if (incomeResult.length && incomeResult[0].values[0][0]) {
            totalIncome = incomeResult[0].values[0][0];
        }
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

    // For the current month, calculate upcoming committed bills from the planner
    // (term commitments with specific payment dates still in the future this month)
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10); // YYYY-MM-DD
    const currentMonthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const isCurrentMonth = tagViewMonth === currentMonthKey;

    let upcomingCommitted = 0;
    if (isCurrentMonth) {
        const currentMonthNum = today.getMonth() + 1;
        const todayDay = today.getDate();
        const commitRows = dbHelpers.queryAll(
            `SELECT type, amount, day_of_month, payment_dates, active_months FROM expense_commitments WHERE enabled = 1`
        );
        commitRows.forEach(r => {
            const [type, amount, dayOfMonth, paymentDates, activeMonths] = r;
            if (type === 'monthly') {
                if (activeMonths) {
                    const allowed = activeMonths.split(',').map(m => parseInt(m.trim()));
                    if (!allowed.includes(currentMonthNum)) return;
                }
                // Only count if there's a specific day set and it's still upcoming
                if (dayOfMonth && dayOfMonth > todayDay) {
                    upcomingCommitted += amount;
                }
            } else if (type === 'term' && paymentDates) {
                paymentDates.split(',').map(d => d.trim()).forEach(d => {
                    if (d.startsWith(currentMonthKey) && d > todayStr) {
                        upcomingCommitted += amount;
                    }
                });
            }
        });
    }

    // Add monthly summary header
    const summaryHeader = document.createElement('div');
    const showUpcoming = isCurrentMonth && upcomingCommitted > 0;
    summaryHeader.style.cssText = `background:#f8f9fa; border:1px solid #dee2e6; border-radius:8px; padding:16px 20px; margin-bottom:20px; display:grid; grid-template-columns:repeat(${showUpcoming ? 5 : 4}, 1fr); gap:20px;`;

    const netAmount = totalIncome - totalExpenses;
    const netColor = netAmount >= 0 ? '#27ae60' : '#e74c3c';
    const budgetColor = totalExpenses > totalBudget ? '#e74c3c' : '#27ae60';
    const incomeLabel = usingExpectedIncome ? 'Expected Income' : 'Total Income';

    const safeToSpend = netAmount - upcomingCommitted;
    const safeColor = safeToSpend >= 0 ? '#27ae60' : '#e74c3c';
    const upcomingCard = showUpcoming ? `
        <div style="border-left:3px solid #e67e22; padding-left:12px;">
            <div style="font-size:11px; color:#7f8c8d; font-weight:600; margin-bottom:6px; text-transform:uppercase;">After Planned Bills</div>
            <div style="font-size:20px; font-weight:700; color:${safeColor};">${safeToSpend >= 0 ? '+' : '-'}$${fmtMoneyLocale(safeToSpend)}</div>
            <div style="font-size:11px; color:#e67e22; margin-top:4px;">$${fmtMoneyLocale(upcomingCommitted)} still due</div>
        </div>` : '';

    summaryHeader.innerHTML = `
        <div>
            <div style="font-size:11px; color:#7f8c8d; font-weight:600; margin-bottom:6px; text-transform:uppercase;">${incomeLabel}</div>
            <div style="font-size:20px; font-weight:700; color:#27ae60;">$${fmtMoneyLocale(totalIncome)}</div>
        </div>
        <div>
            <div style="font-size:11px; color:#7f8c8d; font-weight:600; margin-bottom:6px; text-transform:uppercase;">Total Expenses</div>
            <div style="font-size:20px; font-weight:700; color:#e74c3c;">$${fmtMoneyLocale(totalExpenses)}</div>
        </div>
        <div>
            <div style="font-size:11px; color:#7f8c8d; font-weight:600; margin-bottom:6px; text-transform:uppercase;">Total Budget</div>
            <div style="font-size:20px; font-weight:700; color:${budgetColor};">$${fmtMoneyLocale(totalBudget)}</div>
        </div>
        <div>
            <div style="font-size:11px; color:#7f8c8d; font-weight:600; margin-bottom:6px; text-transform:uppercase;">Remaining</div>
            <div style="font-size:20px; font-weight:700; color:${netColor};">${netAmount >= 0 ? '+' : '-'}$${fmtMoneyLocale(netAmount)}</div>
        </div>
        ${upcomingCard}
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
        header.style.cssText = `display:flex; flex-direction:column; background:${cat.color}15; cursor:pointer; user-select:none;`;

        let amountDisplay = `<div style="font-weight:600; color:#222;">$${fmtMoney(total)}</div>`;
        let budgetBar = '';
        if (cat.budget) {
            const overBudget = total > cat.budget;
            const pct = cat.budget > 0 ? (total / cat.budget * 100) : 0;
            const barWidth = Math.min(pct, 100);
            const barColor = overBudget ? '#e74c3c' : pct > 80 ? '#f39c12' : '#2ecc71';
            const diff = fmtMoney(cat.budget - total);
            const diffLabel = overBudget ? `$${diff} over` : `$${diff} left`;
            amountDisplay = `
                <div style="text-align:right;">
                    <div style="font-weight:600; color:${overBudget ? '#e74c3c' : '#222'};">$${fmtMoney(total)}</div>
                    <div style="font-size:11px; color:#95a5a6;">Budget: $${fmtMoney(cat.budget)}</div>
                    <div style="font-size:11px; color:${overBudget ? '#e74c3c' : '#27ae60'}; font-weight:500;">${diffLabel}</div>
                </div>
            `;
            budgetBar = `<div style="background:#ecf0f1; height:6px; overflow:hidden;"><div style="width:${barWidth.toFixed(1)}%; height:100%; background:${barColor};"></div></div>`;
        }

        header.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:space-between; padding:12px 16px;">
                <div style="display:flex; align-items:center; gap:10px;">
                    <span data-arrow style="color:${cat.color}; font-size:12px; transition:transform .2s;">▶</span>
                    <span style="font-size:18px;">${cat.icon}</span>
                    <span style="font-weight:600; font-size:14px;">${escapeHtml(catName)}</span>
                    <span style="color:#95a5a6; font-size:12px;">${Object.keys(labelGroups).length} unique · ${cat.transactions.length} total</span>
                </div>
                ${amountDisplay}
            </div>
            ${budgetBar}
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
                <span style="color:#e74c3c; font-weight:600;">$${fmtMoney(group.total)}</span>
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
            <td class="transaction-positive" style="text-align:right;">$${fmtMoney(income)}</td>
            <td class="transaction-negative" style="text-align:right;">$${fmtMoney(expenses)}</td>
            <td class="${netClass}" style="text-align:right;">${netSign}$${fmtMoney(net)}</td>
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
                ${income > 0 ? '$' + fmtMoney(income) : '—'}
            </td>
            <td class="transaction-negative" style="text-align:right; padding:5px 8px;">
                ${expenses > 0 ? '$' + fmtMoney(expenses) : '—'}
            </td>
            <td class="${netClass}" style="text-align:right; padding:5px 8px;">
                ${netSign}$${fmtMoney(net)}
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
        SELECT t.date, t.description, t.amount, b.name, a.account_name, t.note
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
        const [date, description, amount, bank, account, note] = row;
        const amtClass = amount >= 0 ? 'transaction-positive' : 'transaction-negative';
        const amtStr = fmtMoneySigned(amount);

        const descCell = note
            ? `<div style="font-weight:500;">${escapeHtml(note)} <span style="color:#3498db;font-size:10px;">✎</span></div>
               <div style="color:#95a5a6;font-size:11px;">${escapeHtml(description || '')}</div>`
            : escapeHtml(description || '');
        const descTitle = note ? `Remark: ${note}\nOriginal: ${description || ''}` : (description || '');

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="padding:4px 8px 4px 56px; white-space:nowrap;">${date}</td>
            <td style="padding:4px 8px;" title="${escapeHtml(descTitle)}">${descCell}</td>
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

    // One dataset per category. Chart data is in dollars (the stored cents
    // values are converted at the boundary so axes/tooltips render normally).
    const datasets = categories.map((cat, i) => ({
        label: cat,
        data: months.map(m => fromCents(dataMap[m]?.[cat] || 0)),
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
    // `amount` is stored as integer cents — export it as decimal dollars.
    const amountIdx = columns.indexOf('amount');

    let csv = columns.join(',') + '\n';
    rows.forEach(row => {
        csv += row.map((cell, i) => {
            const value = (i === amountIdx && cell != null) ? fromCents(cell).toFixed(2) : cell;
            return `"${String(value ?? '').replace(/"/g, '""')}"`;
        }).join(',') + '\n';
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

function rpt_fmt(cents) { return `S$${fmtMoney(cents)}`; }
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
            return `<td class="r">${v > 0 ? `<span style="font-weight:600;">${rpt_fmt(v)}</span>` : '<span style="color:#e0e0e0;">—</span>'}</td>`;
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
