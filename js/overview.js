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

// Balance helpers (accountPurposeMap / emergencyEligibleTotal /
// netWorthByBucket / BALANCE_BUCKETS) live in js/planner.js, which loads
// first, so the Planner and Overview screens compute identically.

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
    const { total: current, count: eligibleCount } = emergencyEligibleTotal();
    const nw = netWorthByBucket();

    if (target <= 0) {
        container.innerHTML = `<div style="color:#7f8c8d; font-size:13px;">
            Set up your fixed commitments and variable spend in the
            <strong>Planner</strong> tab to calculate your emergency-fund target.</div>`;
        return;
    }
    if (eligibleCount === 0) {
        container.innerHTML = `<div style="color:#7f8c8d; font-size:13px;">
            Your 6-month target is <strong>$${fmtMoneyLocale(target)}</strong>
            ($${fmtMoney(monthlyBurn)}/mo × 6). Record a balance and tick
            <em>"Counts toward emergency fund"</em> via <strong>Update Balance</strong>
            in the Planner tab to track progress.</div>`;
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
            Emergency-eligible cash across ${eligibleCount} account${eligibleCount === 1 ? '' : 's'} ·
            target = $${fmtMoney(monthlyBurn)}/mo burn × 6
        </div>
        ${(nw.investment > 0 || nw.locked > 0) ? `
        <div style="font-size:11px; color:#95a5a6; margin-top:2px;">
            Not counted: ${nw.investment > 0 ? `📈 $${fmtMoneyLocale(nw.investment)} investment` : ''}${(nw.investment > 0 && nw.locked > 0) ? ' · ' : ''}${nw.locked > 0 ? `🔒 $${fmtMoneyLocale(nw.locked)} locked` : ''} · net worth $${fmtMoneyLocale(nw.total)}
        </div>` : ''}
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

    // Every snapshot in date order. We carry each account's last-known balance
    // forward and, at each distinct date, total it by bucket — a stacked
    // net-worth-over-time view. An account only contributes from its own first
    // reading onward, so a newly-tracked account appears as a new band rather
    // than faking a jump in the existing total.
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

    const purpose = accountPurposeMap();
    const dates = [...new Set(rows.map(r => r[2]))];  // sorted (rows are date-ordered)
    const known = {};
    let ri = 0;
    const series = { liquid: [], investment: [], locked: [] };
    const totalsByDate = [];

    dates.forEach(date => {
        while (ri < rows.length && rows[ri][2] <= date) {
            known[rows[ri][0]] = rows[ri][1];  // later row on same date wins
            ri++;
        }
        const sums = { liquid: 0, investment: 0, locked: 0 };
        Object.keys(known).forEach(name => {
            sums[(purpose[name] || { bucket: 'liquid' }).bucket] += known[name];
        });
        series.liquid.push(fromCents(sums.liquid));
        series.investment.push(fromCents(sums.investment));
        series.locked.push(fromCents(sums.locked));
        totalsByDate.push(sums.liquid + sums.investment + sums.locked);
    });

    const last = totalsByDate[totalsByDate.length - 1];
    const change = last - totalsByDate[0];
    const changeColor = change >= 0 ? '#27ae60' : '#e74c3c';
    const nw = netWorthByBucket();

    const bucketChip = (key) => nw[key] > 0
        ? `<span style="font-size:12px; color:#2c3e50;">${BALANCE_BUCKETS[key].icon} ${BALANCE_BUCKETS[key].label}: <strong>$${fmtMoneyLocale(nw[key])}</strong></span>`
        : '';

    summary.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px;">
            <div>
                <div style="font-size:11px; color:#7f8c8d; margin-bottom:2px;">CURRENT NET WORTH</div>
                <div style="font-size:24px; font-weight:700; color:#2c3e50;">$${fmtMoneyLocale(nw.total)}</div>
            </div>
            ${dates.length > 1 ? `
            <div style="text-align:right;">
                <div style="font-size:11px; color:#7f8c8d; margin-bottom:2px;">SINCE ${dates[0]}</div>
                <div style="font-size:18px; font-weight:700; color:${changeColor};">${change >= 0 ? '+' : '−'}$${fmtMoneyLocale(change)}</div>
            </div>` : ''}
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:14px; margin-bottom:16px;">
            ${bucketChip('liquid')} ${bucketChip('investment')} ${bucketChip('locked')}
        </div>
    `;

    // One stacked area per bucket; skip buckets that are empty throughout.
    const datasets = ['liquid', 'investment', 'locked']
        .filter(key => series[key].some(v => v !== 0))
        .map(key => ({
            label: `${BALANCE_BUCKETS[key].icon} ${BALANCE_BUCKETS[key].label}`,
            data: series[key],
            borderColor: BALANCE_BUCKETS[key].color,
            backgroundColor: BALANCE_BUCKETS[key].color + '55',
            fill: true,
            tension: 0.2,
            pointRadius: 3,
        }));

    overviewBalanceChart = new Chart(canvas, {
        type: 'line',
        data: { labels: dates, datasets },
        options: {
            responsive: true,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'bottom' },
                tooltip: {
                    callbacks: {
                        label: ctx => ` ${ctx.dataset.label}: $${ctx.parsed.y.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                    },
                },
            },
            scales: {
                x: { stacked: true },
                y: {
                    stacked: true,
                    beginAtZero: true,
                    ticks: { callback: val => '$' + val.toLocaleString() },
                },
            },
        },
    });
}
