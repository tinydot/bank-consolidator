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
    const spentSubquery = `(SELECT ABS(SUM(t.amount))
             FROM transactions t
             WHERE t.category_id = c.id
               AND t.ignored = 0
               AND t.amount < 0
               AND strftime('%Y-%m', t.date) = ?)`;
    const queryParams = [budgetMonth];

    const rows = dbHelpers.queryAll(`
        SELECT
            c.id,
            c.name,
            c.icon,
            c.color,
            COALESCE(b.monthly_limit, '') as monthly_limit,
            COALESCE(${spentSubquery}, 0) as spent
        FROM categories c
        LEFT JOIN budget b ON b.category_id = c.id
        ORDER BY c.sort_order, c.name
    `, queryParams);

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
            <div style="font-size:22px; font-weight:700; color:#2c3e50;">$${fmtMoney(totalBudget)}</div>
            <div style="font-size:12px; color:#95a5a6; margin-top:4px;">${assignedCount} of ${rows.length} categories assigned</div>
        </div>
        <div style="background:white; border:1px solid #ecf0f1; border-radius:8px; padding:16px;">
            <div style="font-size:12px; color:#7f8c8d; text-transform:uppercase; letter-spacing:.5px; margin-bottom:6px;">Total Spent</div>
            <div style="font-size:22px; font-weight:700; color:#e74c3c;">$${fmtMoney(totalSpent)}</div>
            <div style="font-size:12px; color:#95a5a6; margin-top:4px;">this month</div>
        </div>
        <div style="background:white; border:1px solid #ecf0f1; border-radius:8px; padding:16px;">
            <div style="font-size:12px; color:#7f8c8d; text-transform:uppercase; letter-spacing:.5px; margin-bottom:6px;">${totalRemaining >= 0 ? 'Remaining' : 'Over Budget'}</div>
            <div style="font-size:22px; font-weight:700; color:${totalRemaining >= 0 ? '#27ae60' : '#e74c3c'};">
                ${totalRemaining >= 0 ? '' : '-'}$${fmtMoney(totalRemaining)}
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
        const overAmount = over ? fmtMoney(spent - limit) : null;

        const row_el = document.createElement('div');
        row_el.style.cssText = `display:grid; grid-template-columns:${gridCols}; gap:8px; align-items:center; padding:10px 16px; background:white; border:1px solid ${over ? '#fadbd8' : '#ecf0f1'}; border-radius:6px; margin-bottom:6px;`;
        row_el.dataset.categoryId = id;

        const statusLine = hasLimit
            ? (over
                ? `<span style="color:#e74c3c; font-weight:600;">▲ Over by $${overAmount}</span>`
                : `<span style="color:#27ae60;">$${fmtMoney(limit - spent)} remaining</span>`)
            : '<span style="color:#bdc3c7;">No limit set</span>';

        const budgetCell = isCurrentMonth
            ? `<input type="number" min="0" step="0.01"
                    value="${hasLimit ? fromCents(limit).toFixed(2) : ''}"
                    placeholder="—"
                    style="width:90px; text-align:right; border:1px solid #ddd; border-radius:4px; padding:4px 6px; font-size:14px;"
                    data-id="${id}">`
            : `<span style="font-weight:600; color:#2c3e50;">${hasLimit ? '$' + fmtMoney(limit) : '—'}</span>`;

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
                $${fmtMoney(spent)}
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
        const parsed = parseFloat(rawValue);
        if (isNaN(parsed) || parsed < 0) {
            showMessage('error', 'Budget amount must be a positive number');
            return;
        }
        const amount = toCents(rawValue);
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
            const parsed = parseFloat(raw);
            if (isNaN(parsed) || parsed < 0) {
                hasError = true;
                return;
            }
            const amount = toCents(raw);
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
