// §11. MANUAL TRANSACTIONS
// ═══════════════════════════════════════════════════════════════════════════

async function addManualTransaction() {
    const date = document.getElementById('manualDate').value;
    const sign = document.getElementById('manualSign').value;
    const amountCents = toCents(document.getElementById('manualAmount').value);
    const description = document.getElementById('manualDescription').value.trim();

    // Validate
    if (!date) {
        showManualMessage('error', 'Please enter a date');
        return;
    }
    if (!amountCents || amountCents <= 0) {
        showManualMessage('error', 'Please enter a valid amount');
        return;
    }
    if (!description) {
        showManualMessage('error', 'Please enter a description');
        return;
    }

    const amount = sign === '-' ? -Math.abs(amountCents) : Math.abs(amountCents);

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
    await updateAnalytics();

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
        const dayNetStr = fmtMoneySigned(dayNet);

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
                    ${dayIncome  > 0 ? `<span class="transaction-positive">+$${fmtMoney(dayIncome)}</span>` : ''}
                    ${dayExpenses > 0 ? `<span class="transaction-negative">-$${fmtMoney(dayExpenses)}</span>` : ''}
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
            const amountStr   = fmtMoneySigned(amount);
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
    document.getElementById('manualIncome').textContent = `+$${fmtMoney(income)}`;
    document.getElementById('manualExpenses').textContent = `-$${fmtMoney(expenses)}`;
    const netEl = document.getElementById('manualNet');
    netEl.textContent = fmtMoneySigned(net);
    netEl.className = net >= 0 ? 'transaction-positive' : 'transaction-negative';
}

function showManualMessage(type, text) {
    const el = document.getElementById('manual-message');
    el.innerHTML = `<div class="${type}-message" style="margin-bottom: 15px;">${text}</div>`;
    setTimeout(() => el.innerHTML = '', 3000);
}

// ═══════════════════════════════════════════════════════════════════════════
