// §15. OVERVIEW (Home Dashboard)
// ═══════════════════════════════════════════════════════════════════════════
//
// A consolidated "how am I doing" screen tuned for the emergency-fund stage.
// It reuses data already captured elsewhere — expense commitments + variable
// spend from the Planner, bank balances, and transactions — and surfaces the
// trajectory the other tabs don't: progress toward the fund, an ETA at the
// current savings pace, the savings-rate trend, and the balance trend.
//
// Read-only: it computes from existing rows and never mutates, so there is no
// markDirty() here. All money is integer cents until the render boundary.

let overviewSavingsChart = null;
let overviewBalanceChart = null;

// Monthly burn = enabled monthly commitments + variable spend (mirrors the
// Planner's Financial Health calc so the two screens agree). All in cents.
function overviewMonthlyBurn() {
    const varRow = dbHelpers.queryValue(`SELECT value FROM planner_settings WHERE key='variable_spend'`);
    const variableSpend = varRow ? (parseInt(varRow, 10) || 0) : 0;

    let monthlyCommitments = 0;
    dbHelpers.queryAll(`SELECT amount FROM expense_commitments WHERE enabled = 1 AND type = 'monthly'`)
        .forEach(([amount]) => { monthlyCommitments += amount; });

    return monthlyCommitments + variableSpend;
}

// Total cash = latest recorded balance per account, summed. bank_balances
// keeps every snapshot, so we take the most recent (by updated_at) per name.
function overviewTotalBalance() {
    const rows = dbHelpers.queryAll(`
        SELECT account_name, balance
        FROM bank_balances
        ORDER BY updated_at ASC
    `);
    const latest = {};
    rows.forEach(([account, balance]) => { latest[account] = balance; });
    const accounts = Object.keys(latest);
    const total = accounts.reduce((sum, name) => sum + latest[name], 0);
    return { total, accountCount: accounts.length };
}

// Per-month income/expenses for the last 6 months (oldest → newest), cents.
function overviewMonthlySavings() {
    const result = db.exec(`
        SELECT
            strftime('%Y-%m', date) as month,
            SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as income,
            SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as expenses
        FROM transactions
        WHERE ignored = 0
          AND date >= date('now', '-6 months', 'start of month')
        GROUP BY month
        ORDER BY month ASC
    `);
    if (!result.length || !result[0].values.length) return [];
    return result[0].values.map(([month, income, expenses]) => ({
        month,
        income: income || 0,
        expenses: expenses || 0,
        net: (income || 0) - (expenses || 0),
    }));
}

function overviewMonthLabel(ym) {
    const [year, mo] = ym.split('-');
    return new Date(year, mo - 1).toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
}

function loadOverview() {
    renderEmergencyFundProgress();
    renderSavingsRate();
    renderBalanceTrend();
}

// ─────────────────────────────────────────────────────────────────────────
// §15.1. Emergency Fund Progress + ETA
// ─────────────────────────────────────────────────────────────────────────

function renderEmergencyFundProgress() {
    const container = document.getElementById('overviewEmergencyFund');
    if (!container) return;

    const monthlyBurn = overviewMonthlyBurn();
    const target = monthlyBurn * 6;
    const { total: current, accountCount } = overviewTotalBalance();

    if (target <= 0) {
        container.innerHTML = `<div style="color:#7f8c8d; font-size:13px;">
            Set up your fixed commitments and variable spend in the
            <strong>Planner</strong> tab to calculate your emergency-fund target.</div>`;
        return;
    }
    if (accountCount === 0) {
        container.innerHTML = `<div style="color:#7f8c8d; font-size:13px;">
            Your 6-month target is <strong>$${fmtMoneyLocale(target)}</strong>
            ($${fmtMoney(monthlyBurn)}/mo × 6). Add your current balance via
            <strong>Update Balance</strong> in the Planner tab to track progress.</div>`;
        return;
    }

    const pct = Math.max(0, Math.min(100, (current / target) * 100));
    const remaining = Math.max(0, target - current);
    const monthsCovered = current / monthlyBurn;

    // ETA from the actual savings pace: average monthly net over the months we
    // have. Exclude the current (partial) month so a mid-month dip doesn't
    // skew the pace. Fall back to including it if that's all we have.
    const months = overviewMonthlySavings();
    const currentYm = new Date().toISOString().slice(0, 7);
    let paceMonths = months.filter(m => m.month !== currentYm);
    if (paceMonths.length === 0) paceMonths = months;
    const avgSavings = paceMonths.length
        ? paceMonths.reduce((s, m) => s + m.net, 0) / paceMonths.length
        : 0;

    let etaText;
    if (remaining <= 0) {
        etaText = `🎉 Fully funded — you've reached your 6-month target.`;
    } else if (avgSavings > 0) {
        const monthsToGo = Math.ceil(remaining / avgSavings);
        const eta = new Date();
        eta.setMonth(eta.getMonth() + monthsToGo);
        const etaLabel = eta.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
        etaText = `At your recent pace of <strong>$${fmtMoneyLocale(Math.round(avgSavings))}/mo</strong> saved, ` +
                  `you'll be fully funded in <strong>${monthsToGo} month${monthsToGo === 1 ? '' : 's'}</strong> ` +
                  `(around <strong>${etaLabel}</strong>).`;
    } else {
        etaText = `Your recent months net out negative, so there's no ETA yet. ` +
                  `Trimming spending to free up even a small monthly surplus starts the clock.`;
    }

    const barColor = pct >= 100 ? '#27ae60' : pct >= 50 ? '#3498db' : '#f39c12';

    container.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:6px;">
            <div style="font-size:22px; font-weight:700; color:#2c3e50;">$${fmtMoneyLocale(current)}</div>
            <div style="font-size:13px; color:#7f8c8d;">of $${fmtMoneyLocale(target)} target</div>
        </div>
        <div style="background:#ecf0f1; border-radius:999px; height:16px; overflow:hidden; margin-bottom:6px;">
            <div style="width:${pct}%; height:100%; background:${barColor}; border-radius:999px; transition:width .3s;"></div>
        </div>
        <div style="display:flex; justify-content:space-between; font-size:12px; color:#7f8c8d; margin-bottom:14px;">
            <span><strong style="color:${barColor};">${pct.toFixed(0)}%</strong> funded · ${monthsCovered.toFixed(1)} months covered</span>
            <span>${remaining > 0 ? '$' + fmtMoneyLocale(remaining) + ' to go' : 'Target met'}</span>
        </div>
        <div style="padding:10px 12px; background:#3498db15; border-radius:6px; font-size:13px; color:#2c3e50; line-height:1.5;">
            ${etaText}
        </div>
        <div style="font-size:11px; color:#95a5a6; margin-top:8px;">
            Balance across ${accountCount} account${accountCount === 1 ? '' : 's'} ·
            target = $${fmtMoney(monthlyBurn)}/mo burn × 6
        </div>
    `;
}

// ─────────────────────────────────────────────────────────────────────────
// §15.2. Savings Rate (this month + 6-month trend)
// ─────────────────────────────────────────────────────────────────────────

function renderSavingsRate() {
    const summary = document.getElementById('overviewSavingsSummary');
    const canvas = document.getElementById('overviewSavingsChart');
    if (!summary || !canvas) return;

    if (overviewSavingsChart) {
        overviewSavingsChart.destroy();
        overviewSavingsChart = null;
    }

    const months = overviewMonthlySavings();
    if (!months.length) {
        summary.innerHTML = `<div style="color:#7f8c8d; font-size:13px;">
            Import some transactions to see your savings rate.</div>`;
        return;
    }

    const rateFor = m => (m.income > 0 ? (m.net / m.income) * 100 : 0);
    const latest = months[months.length - 1];
    const latestRate = rateFor(latest);
    const avgRate = months.reduce((s, m) => s + rateFor(m), 0) / months.length;

    const latestColor = latestRate >= 0 ? '#27ae60' : '#e74c3c';
    summary.innerHTML = `
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:16px;">
            <div>
                <div style="font-size:11px; color:#7f8c8d; margin-bottom:2px;">${overviewMonthLabel(latest.month).toUpperCase()} — SAVED</div>
                <div style="font-size:24px; font-weight:700; color:${latestColor};">${latestRate.toFixed(0)}%</div>
                <div style="font-size:11px; color:#95a5a6;">$${fmtMoneyLocale(latest.net)} of $${fmtMoneyLocale(latest.income)} income</div>
            </div>
            <div>
                <div style="font-size:11px; color:#7f8c8d; margin-bottom:2px;">6-MONTH AVERAGE</div>
                <div style="font-size:24px; font-weight:700; color:#2c3e50;">${avgRate.toFixed(0)}%</div>
                <div style="font-size:11px; color:#95a5a6;">across ${months.length} month${months.length === 1 ? '' : 's'}</div>
            </div>
        </div>
    `;

    const labels = months.map(m => overviewMonthLabel(m.month));
    const rates = months.map(rateFor);

    overviewSavingsChart = new Chart(canvas, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: 'Savings rate',
                data: rates,
                backgroundColor: rates.map(r => (r >= 0 ? '#27ae60' : '#e74c3c')),
            }],
        },
        options: {
            responsive: true,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: ctx => ` ${ctx.parsed.y.toFixed(1)}% saved`,
                    },
                },
            },
            scales: {
                y: {
                    ticks: { callback: val => val + '%' },
                },
            },
        },
    });
}

// ─────────────────────────────────────────────────────────────────────────
// §15.3. Balance Trend
// ─────────────────────────────────────────────────────────────────────────

function renderBalanceTrend() {
    const summary = document.getElementById('overviewBalanceSummary');
    const canvas = document.getElementById('overviewBalanceChart');
    if (!summary || !canvas) return;

    if (overviewBalanceChart) {
        overviewBalanceChart.destroy();
        overviewBalanceChart = null;
    }

    // Every snapshot in date order. We walk forward keeping the latest known
    // balance per account, emitting the running total at each distinct date —
    // a true net-worth line even when accounts are updated on different days.
    const rows = dbHelpers.queryAll(`
        SELECT account_name, balance, as_of_date
        FROM bank_balances
        ORDER BY as_of_date ASC, updated_at ASC
    `);

    if (!rows.length) {
        summary.innerHTML = `<div style="color:#7f8c8d; font-size:13px;">
            Record balances via <strong>Update Balance</strong> in the Planner tab.
            Each update adds a point here so you can watch your savings grow.</div>`;
        return;
    }

    const known = {};
    const byDate = new Map();  // as_of_date → running total
    rows.forEach(([account, balance, asOf]) => {
        known[account] = balance;
        const total = Object.values(known).reduce((a, b) => a + b, 0);
        byDate.set(asOf, total);  // later row on same date overwrites → last wins
    });

    const dates = [...byDate.keys()];
    const totals = dates.map(d => byDate.get(d));

    const first = totals[0];
    const last = totals[totals.length - 1];
    const change = last - first;
    const changeColor = change >= 0 ? '#27ae60' : '#e74c3c';

    summary.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:16px;">
            <div>
                <div style="font-size:11px; color:#7f8c8d; margin-bottom:2px;">CURRENT TOTAL</div>
                <div style="font-size:24px; font-weight:700; color:#2c3e50;">$${fmtMoneyLocale(last)}</div>
            </div>
            ${dates.length > 1 ? `
            <div style="text-align:right;">
                <div style="font-size:11px; color:#7f8c8d; margin-bottom:2px;">SINCE ${dates[0]}</div>
                <div style="font-size:18px; font-weight:700; color:${changeColor};">${change >= 0 ? '+' : '−'}$${fmtMoneyLocale(change)}</div>
            </div>` : ''}
        </div>
    `;

    overviewBalanceChart = new Chart(canvas, {
        type: 'line',
        data: {
            labels: dates,
            datasets: [{
                label: 'Total balance',
                data: totals.map(fromCents),
                borderColor: '#3498db',
                backgroundColor: '#3498db22',
                fill: true,
                tension: 0.2,
                pointRadius: 3,
            }],
        },
        options: {
            responsive: true,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: ctx => ` $${ctx.parsed.y.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                    },
                },
            },
            scales: {
                y: {
                    beginAtZero: false,
                    ticks: { callback: val => '$' + val.toLocaleString() },
                },
            },
        },
    });
}
