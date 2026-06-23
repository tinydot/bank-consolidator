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

// Count Mon–Fri days in a given month
function countWorkdaysInMonth(year, month) {
    const days = new Date(year, month, 0).getDate();
    let n = 0;
    for (let d = 1; d <= days; d++) {
        const dow = new Date(year, month - 1, d).getDay(); // 0=Sun
        if (dow >= 1 && dow <= 5) n++;
    }
    return n;
}

// Count Sat–Sun days in a given month
function countNonWorkdaysInMonth(year, month) {
    const days = new Date(year, month, 0).getDate();
    let n = 0;
    for (let d = 1; d <= days; d++) {
        const dow = new Date(year, month - 1, d).getDay();
        if (dow === 0 || dow === 6) n++;
    }
    return n;
}

// Returns true if dateStr (YYYY-MM-DD) is a Mon–Fri
function isWorkday(dateStr) {
    const dow = new Date(dateStr).getDay();
    return dow >= 1 && dow <= 5;
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

    if (commitment.type === 'workday') {
        return commitment.amount * countWorkdaysInMonth(year, month);
    }

    if (commitment.type === 'nonworkday') {
        return commitment.amount * countNonWorkdaysInMonth(year, month);
    }

    return 0;
}

// ── Load & render ─────────────────────────────────────────────────────────

async function loadPlanner() {
    const varRow = dbHelpers.queryAll(`SELECT value FROM planner_settings WHERE key = 'variable_spend'`);
    const variableSpend = varRow.length ? parseFloat(varRow[0][0]) : 0;
    const varInput = document.getElementById('plannerVariableSpend');
    if (varInput) varInput.value = variableSpend ? fromCents(variableSpend).toFixed(2) : '';

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
    if (monthViewYear) renderMonthView();
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
        const typeTags = {
            term:       '<span style="font-size:10px; background:#9b59b620; color:#9b59b6;  padding:1px 5px; border-radius:3px; margin-left:4px;">term</span>',
            workday:    '<span style="font-size:10px; background:#16a08520; color:#16a085;  padding:1px 5px; border-radius:3px; margin-left:4px;">workday</span>',
            nonworkday: '<span style="font-size:10px; background:#d3540020; color:#d35400;  padding:1px 5px; border-radius:3px; margin-left:4px;">weekend</span>',
        };
        const typeTag = typeTags[c.type] || '';
        const perDayHint = (c.type === 'workday' || c.type === 'nonworkday')
            ? `<div style="font-size:11px; color:#95a5a6;">S$${fmtMoney(c.amount)} / day</div>`
            : '';
        tdName.innerHTML = `
            <div style="font-weight:500; font-size:13px;">${escapeHtml(c.description)}${typeTag}</div>
            ${perDayHint}
            ${c.subcat_name ? `<div style="font-size:11px; color:#95a5a6;">${escapeHtml(c.subcat_name)}</div>` : ''}
            ${c.notes ? `<div style="font-size:11px; color:#bdc3c7; font-style:italic;">${escapeHtml(c.notes)}</div>` : ''}
        `;
        tr.appendChild(tdName);

        months.forEach(m => {
            const amt = matrix[c.id][m.key];
            const td = document.createElement('td');
            td.style.cssText = 'text-align:right; padding:8px 14px; border-bottom:1px solid #f0f0f0; font-size:13px;';
            td.innerHTML = amt > 0
                ? `<span style="font-weight:600; color:#2c3e50;">S$${fmtMoney(amt)}</span>`
                : `<span style="color:#e0e0e0;">—</span>`;
            tr.appendChild(td);
        });

        const td3mo = document.createElement('td');
        td3mo.style.cssText = 'text-align:right; padding:8px 14px; border-bottom:1px solid #f0f0f0; color:#7f8c8d; font-weight:600; font-size:13px;';
        td3mo.textContent = commitmentTotals3mo[c.id] > 0 ? `S$${fmtMoney(commitmentTotals3mo[c.id])}` : '—';
        tr.appendChild(td3mo);

        const tdTot = document.createElement('td');
        tdTot.style.cssText = 'text-align:right; padding:8px 14px; border-bottom:1px solid #f0f0f0; color:#7f8c8d; font-weight:600; font-size:13px;';
        tdTot.textContent = commitmentTotals6mo[c.id] > 0 ? `S$${fmtMoney(commitmentTotals6mo[c.id])}` : '—';
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
            td.textContent = catMonthTotals[m.key] > 0 ? `S$${fmtMoney(catMonthTotals[m.key])}` : '—';
            tr.appendChild(td);
        });

        const tdTot = document.createElement('td');
        tdTot.style.cssText = `text-align:right; padding:6px 14px; border-bottom:1px solid #e8e8e8; font-weight:700; color:${color};`;
        tdTot.textContent = catTotal > 0 ? `S$${fmtMoney(catTotal)}` : '—';
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
            <span style="margin-left:auto; font-weight:700; color:${cat.color};">S$${fmtMoney(catTotal6mo)}</span>
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
            td.textContent = `S$${fmtMoney(variableSpend)}`;
            tr.appendChild(td);
        });
        const tdTot = document.createElement('td');
        tdTot.style.cssText = 'text-align:right; padding:10px 14px; background:#fff8e1; font-weight:700; color:#e67e22;';
        tdTot.textContent = `S$${fmtMoney(variableSpend * 6)}`;
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
        td.textContent = `S$${fmtMoney(colTotal)}`;
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
            <div style="font-size:32px; font-weight:800; color:#3498db;">S$${fmtMoneyLocale(grandTotal3mo, 'en-SG')}</div>
            <div style="font-size:12px; color:#95a5a6; margin-top:2px;">≈ S$${fmtMoneyLocale(grandTotal3mo / 3, 'en-SG')} / month average</div>
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
            <div style="font-size:32px; font-weight:800; color:#27ae60;">S$${fmtMoneyLocale(grandTotal6mo, 'en-SG')}</div>
            <div style="font-size:12px; color:#95a5a6; margin-top:2px;">≈ S$${fmtMoneyLocale(grandTotal6mo / 6, 'en-SG')} / month average</div>
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
    document.getElementById('plannerAmount').value = fromCents(c.amount).toFixed(2);
    document.getElementById('plannerType').value = c.type;
    document.getElementById('plannerActiveMonths').value = c.active_months || '';
    document.getElementById('plannerDates').value = c.payment_dates || '';
    document.getElementById('plannerNotes').value = c.notes || '';
    populatePlannerCategoryDropdown(c.category_id, c.subcategory_id);
    togglePlannerTypeFields();
    document.getElementById('plannerForm').style.display = 'block';
    document.getElementById('plannerDesc').focus();
}

// Look up a full commitment row by id and open the editor. Used by the
// day-detail buttons, which only carry the commitment id.
function openEditCommitment(id) {
    const r = dbHelpers.queryFirst(`
        SELECT id, description, amount, type, active_months, payment_dates,
               notes, category_id, subcategory_id
        FROM expense_commitments WHERE id = ?
    `, [id]);
    if (!r) {
        showMessage('error', 'Commitment not found');
        return;
    }
    closePlannerDayDetail();
    editCommitment({
        id: r[0], description: r[1], amount: r[2], type: r[3],
        active_months: r[4], payment_dates: r[5], notes: r[6],
        category_id: r[7], subcategory_id: r[8]
    });
}

function togglePlannerTypeFields() {
    const type = document.getElementById('plannerType').value;
    document.getElementById('plannerMonthsField').style.display = type === 'monthly'    ? '' : 'none';
    document.getElementById('plannerDatesField').style.display  = type === 'term'       ? '' : 'none';
    const amtLabels = {
        monthly:    'Amount (SGD)',
        term:       'Amount (SGD)',
        workday:    'Daily amount (SGD / workday)',
        nonworkday: 'Daily amount (SGD / non-workday)',
    };
    const lbl = document.getElementById('plannerAmountLabel');
    if (lbl) lbl.textContent = amtLabels[type] || 'Amount (SGD)';
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
    const amount       = toCents(document.getElementById('plannerAmount').value);
    const type         = document.getElementById('plannerType').value;
    const activeMonths = document.getElementById('plannerActiveMonths').value.trim() || null;
    const dates        = document.getElementById('plannerDates').value.trim() || null;
    const notes        = document.getElementById('plannerNotes').value.trim() || null;
    const catVal       = document.getElementById('plannerCategory').value;
    const subcatVal    = document.getElementById('plannerSubcategory').value;
    const categoryId   = catVal    ? parseInt(catVal)    : null;
    const subcategoryId = subcatVal ? parseInt(subcatVal) : null;

    if (!desc) { showMessage('error', 'Description is required'); return; }
    if (!amount || amount <= 0) { showMessage('error', 'Enter a valid amount'); return; }
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
    closePlannerDayDetail();
    await loadPlanner();
}

// ═══════════════════════════════════════════════════════════════════════════
// §15.5. Financial Health & Activities
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────
// §14.1. Balance buckets (shared by Planner Financial Health + Overview)
// ─────────────────────────────────────────────────────────────────────────
//
// Balances live in bank_balances (append-only snapshots per account) and each
// account is classified once in account_purpose:
//   bucket    : how it groups in net worth — liquid / investment / locked
//   emergency : whether it counts toward the 6-month emergency-fund target
// These helpers are the single source of truth so the Planner and Overview
// screens agree. All amounts are integer cents.

const BALANCE_BUCKETS = {
    liquid:     { label: 'Liquid', icon: '💵', color: '#27ae60' },
    investment: { label: 'Investment', icon: '📈', color: '#3498db' },
    locked:     { label: 'Locked', icon: '🔒', color: '#95a5a6' },
};

// account_name → { bucket, emergency }. Accounts with a balance but no
// classification row default to liquid + counted toward the fund.
function accountPurposeMap() {
    const map = {};
    dbHelpers.queryAll(`SELECT account_name, bucket, emergency FROM account_purpose`)
        .forEach(([name, bucket, emergency]) => {
            map[name] = {
                bucket: BALANCE_BUCKETS[bucket] ? bucket : 'liquid',
                emergency: emergency ? 1 : 0,
            };
        });
    return map;
}

function purposeFor(map, accountName) {
    return map[accountName] || { bucket: 'liquid', emergency: 1 };
}

// account_name → latest recorded balance (cents), newest by updated_at wins.
function latestBalancesByAccount() {
    const map = {};
    dbHelpers.queryAll(`SELECT account_name, balance FROM bank_balances ORDER BY updated_at ASC`)
        .forEach(([name, balance]) => { map[name] = balance; });
    return map;
}

// Sum of latest balances for accounts flagged emergency = 1.
function emergencyEligibleTotal() {
    const purpose = accountPurposeMap();
    const balances = latestBalancesByAccount();
    let total = 0, count = 0;
    Object.keys(balances).forEach(name => {
        if (purposeFor(purpose, name).emergency) { total += balances[name]; count++; }
    });
    return { total, count };
}

// { liquid, investment, locked, total } of latest balances.
function netWorthByBucket() {
    const purpose = accountPurposeMap();
    const balances = latestBalancesByAccount();
    const out = { liquid: 0, investment: 0, locked: 0, total: 0 };
    Object.keys(balances).forEach(name => {
        out[purposeFor(purpose, name).bucket] += balances[name];
        out.total += balances[name];
    });
    return out;
}

// One row per account with its latest manually-entered balance, classification
// and as-of date — emergency-counted accounts first, then by amount. Used to
// show exactly how the emergency-fund figure is made up.
function latestBalanceDetails() {
    const purpose = accountPurposeMap();

    // account_name → bank name, to label each row "Bank — Account".
    const bankByAccount = {};
    dbHelpers.queryAll(`SELECT a.account_name, b.name FROM accounts a JOIN banks b ON a.bank_id = b.id`)
        .forEach(([account, bank]) => { if (!bankByAccount[account]) bankByAccount[account] = bank; });

    const map = {};
    dbHelpers.queryAll(`SELECT account_name, balance, as_of_date FROM bank_balances ORDER BY updated_at ASC`)
        .forEach(([account, balance, asOf]) => { map[account] = { account, balance, asOf }; });
    return Object.values(map)
        .map(r => ({ ...r, bank: bankByAccount[r.account] || '', ...purposeFor(purpose, r.account) }))
        .sort((a, b) => (b.emergency - a.emergency) || (b.balance - a.balance));
}

function loadFinancialHealth() {
    const container = document.getElementById('balanceDisplay');
    const balances = latestBalancesByAccount();

    if (Object.keys(balances).length === 0) {
        container.innerHTML = '<div style="color:#7f8c8d; font-size:13px;">No bank balance recorded yet. Click "Update Balance" to add.</div>';
        return;
    }

    const { total: eligible, count: eligibleCount } = emergencyEligibleTotal();
    const nw = netWorthByBucket();

    // Emergency-fund target = 6 × monthly burn (monthly commitments + variable spend).
    const varRow = dbHelpers.queryAll(`SELECT value FROM planner_settings WHERE key = 'variable_spend'`);
    const variableSpend = varRow.length ? parseFloat(varRow[0][0]) : 0;

    let monthlyCommitments = 0;
    dbHelpers.queryAll(`SELECT amount, type FROM expense_commitments WHERE enabled = 1`)
        .forEach(([amount, type]) => { if (type === 'monthly') monthlyCommitments += amount; });

    const monthlyBurn = monthlyCommitments + variableSpend;
    const emergencyFundTarget = monthlyBurn * 6;

    // Scheduled activities draw down the spendable (emergency-eligible) pot.
    const scheduledActivities = dbHelpers.queryAll(`
        SELECT SUM(ai.estimated_cost)
        FROM planned_activities pa
        JOIN activity_items ai ON ai.activity_id = pa.id
        WHERE pa.status = 'scheduled'
    `);
    const totalScheduled = scheduledActivities.length && scheduledActivities[0][0] ? scheduledActivities[0][0] : 0;

    const projectedBalance = eligible - totalScheduled;
    const monthsCovered = monthlyBurn > 0 ? projectedBalance / monthlyBurn : 0;

    let statusIcon, statusText, statusColor;
    if (monthlyBurn <= 0) {
        statusIcon = 'ℹ️'; statusText = 'Set your target'; statusColor = '#7f8c8d';
    } else if (projectedBalance >= emergencyFundTarget) {
        statusIcon = '✅'; statusText = 'Healthy'; statusColor = '#27ae60';
    } else if (monthsCovered >= 3) {
        statusIcon = '⚠️'; statusText = 'At Risk'; statusColor = '#f39c12';
    } else {
        statusIcon = '🔴'; statusText = 'Critical'; statusColor = '#e74c3c';
    }

    const bucketChip = (key) => nw[key] > 0
        ? `<span style="display:inline-flex; align-items:center; gap:4px; font-size:12px; color:#2c3e50;">
               ${BALANCE_BUCKETS[key].icon} ${BALANCE_BUCKETS[key].label}: <strong>$${fmtMoneyLocale(nw[key])}</strong></span>`
        : '';

    // Per-account breakdown: each amount is exactly what was typed into Update
    // Balance — nothing is derived from transactions.
    const details = latestBalanceDetails();
    const breakdownRows = details.map(d => {
        const b = BALANCE_BUCKETS[d.bucket];
        const counted = d.emergency
            ? '<span style="color:#27ae60; font-weight:600;">✓ counted</span>'
            : '<span style="color:#b0b8bf;">— excluded</span>';
        return `
            <tr style="border-top:1px solid #eef1f4; ${d.emergency ? 'background:#27ae6008;' : ''}">
                <td style="padding:7px 8px; font-size:13px; color:#2c3e50;">${d.bank ? escapeHtml(d.bank) + ' — ' : ''}${escapeHtml(d.account)}</td>
                <td style="padding:7px 8px; font-size:12px; color:#7f8c8d; white-space:nowrap;">${b.icon} ${b.label}</td>
                <td style="padding:7px 8px; font-size:12px; white-space:nowrap;">${counted}</td>
                <td style="padding:7px 8px; font-size:13px; font-weight:600; color:#2c3e50; text-align:right; white-space:nowrap;">$${fmtMoneyLocale(d.balance)}</td>
                <td style="padding:7px 8px; font-size:11px; color:#95a5a6; white-space:nowrap;">${escapeHtml(d.asOf || '')}</td>
                <td style="padding:7px 8px; text-align:right;"><button data-update-account="${escapeHtml(d.account)}" class="secondary-btn" style="padding:3px 10px; font-size:12px;">Update</button></td>
            </tr>`;
    }).join('');

    const breakdownHtml = details.length ? `
        <details open style="margin-bottom:12px;">
            <summary style="cursor:pointer; font-size:12px; font-weight:600; color:#2c3e50; margin-bottom:8px;">
                Emergency-fund breakdown by account
            </summary>
            <div style="overflow-x:auto;">
            <table style="width:100%; border-collapse:collapse;">
                <thead>
                    <tr style="text-align:left; color:#7f8c8d; font-size:11px; text-transform:uppercase;">
                        <th style="padding:4px 8px; font-weight:600;">Account</th>
                        <th style="padding:4px 8px; font-weight:600;">Type</th>
                        <th style="padding:4px 8px; font-weight:600;">Counts?</th>
                        <th style="padding:4px 8px; font-weight:600; text-align:right;">Balance</th>
                        <th style="padding:4px 8px; font-weight:600;">As of</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>${breakdownRows}</tbody>
                <tfoot>
                    <tr style="border-top:2px solid #dfe4e8;">
                        <td colspan="3" style="padding:8px; font-size:12px; font-weight:600; color:#27ae60;">Emergency-fund total (counted)</td>
                        <td style="padding:8px; font-size:14px; font-weight:700; color:#27ae60; text-align:right;">$${fmtMoneyLocale(eligible)}</td>
                        <td colspan="2"></td>
                    </tr>
                </tfoot>
            </table>
            </div>
            <div style="font-size:11px; color:#95a5a6; margin-top:6px;">
                Each amount is the balance you last entered for that account — never derived from transactions.
                Hit <em>Update</em> to revise an account, or use it to set its type / whether it counts.
            </div>
        </details>
    ` : '';

    container.innerHTML = `
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:20px; margin-bottom:12px;">
            <div>
                <div style="font-size:11px; color:#7f8c8d; margin-bottom:4px;">EMERGENCY-FUND BALANCE</div>
                <div style="font-size:24px; font-weight:700; color:#2c3e50;">$${fmtMoneyLocale(eligible)}</div>
                <div style="font-size:11px; color:#95a5a6; margin-top:2px;">${eligibleCount} account${eligibleCount === 1 ? '' : 's'} counted</div>
            </div>
            <div>
                <div style="font-size:11px; color:#7f8c8d; margin-bottom:4px;">6-MONTH TARGET</div>
                <div style="font-size:24px; font-weight:700; color:#7f8c8d;">$${fmtMoneyLocale(emergencyFundTarget)}</div>
                <div style="font-size:11px; color:#95a5a6; margin-top:2px;">$${fmtMoney(monthlyBurn)} × 6 months</div>
            </div>
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:14px; padding:10px 12px; background:#f8f9fa; border-radius:6px; margin-bottom:12px;">
            ${bucketChip('liquid')} ${bucketChip('investment')} ${bucketChip('locked')}
            <span style="font-size:12px; color:#7f8c8d; margin-left:auto;">Net worth: <strong style="color:#2c3e50;">$${fmtMoneyLocale(nw.total)}</strong></span>
        </div>
        ${breakdownHtml}
        ${totalScheduled > 0 ? `
        <div style="background:#fff3cd; border:1px solid #ffc107; border-radius:6px; padding:12px; margin-bottom:12px;">
            <div style="font-size:12px; font-weight:600; margin-bottom:4px;">After Scheduled Activities:</div>
            <div style="display:flex; justify-content:space-between; font-size:13px;">
                <span>Projected Emergency-Fund Balance:</span>
                <strong style="color:${projectedBalance < emergencyFundTarget ? '#e74c3c' : '#27ae60'};">$${fmtMoneyLocale(projectedBalance)}</strong>
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
                    ${monthlyBurn <= 0
                        ? 'Add commitments / variable spend in the Planner to set your target'
                        : projectedBalance >= emergencyFundTarget
                            ? 'Your emergency-eligible cash covers the full 6-month target'
                            : projectedBalance >= monthlyBurn * 3
                                ? 'Below 6-month target but above 3 months'
                                : 'Critical: Below 3-month emergency fund'}
                </div>
            </div>
        </div>
    `;

    // Wire the per-row Update buttons (data-attribute avoids quoting issues
    // with account names containing apostrophes/quotes in inline onclick).
    container.querySelectorAll('[data-update-account]').forEach(btn => {
        btn.addEventListener('click', () => quickUpdateBalance(btn.getAttribute('data-update-account')));
    });
}

// Open the Update Balance form pre-selected to a specific account so the user
// can revise its amount / classification with one click.
function quickUpdateBalance(accountName) {
    showUpdateBalanceForm();
    const select = document.getElementById('balanceAccountName');
    select.value = accountName;
    onBalanceAccountChange();
    document.getElementById('balanceAmount').value = '';
    const form = document.getElementById('updateBalanceForm');
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    document.getElementById('balanceAmount').focus();
}

function showUpdateBalanceForm() {
    document.getElementById('updateBalanceForm').style.display = 'block';
    document.getElementById('balanceDate').value = new Date().toISOString().split('T')[0];

    const select = document.getElementById('balanceAccountName');
    const accounts = dbHelpers.queryAll(`
        SELECT DISTINCT a.account_name, b.name AS bank_name
        FROM accounts a
        JOIN banks b ON a.bank_id = b.id
        ORDER BY b.name, a.account_name
    `);

    select.innerHTML = '';
    if (accounts.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No accounts imported yet';
        opt.disabled = true;
        opt.selected = true;
        select.appendChild(opt);
    } else {
        accounts.forEach(acc => {
            const accountName = acc[0];
            const bankName = acc[1];
            const opt = document.createElement('option');
            opt.value = accountName;
            opt.textContent = `${bankName} — ${accountName}`;
            select.appendChild(opt);
        });
        onBalanceAccountChange();  // reflect the first account's saved classification
    }
}

function cancelBalanceForm() {
    document.getElementById('updateBalanceForm').style.display = 'none';
    document.getElementById('balanceAccountName').selectedIndex = 0;
    document.getElementById('balanceAmount').value = '';
}

// Pre-fill the bucket / emergency fields from the selected account's saved
// classification (or sensible defaults for a never-classified account).
function onBalanceAccountChange() {
    const name = document.getElementById('balanceAccountName').value;
    const p = accountPurposeMap()[name] || { bucket: 'liquid', emergency: 1 };
    document.getElementById('balanceBucket').value = p.bucket;
    document.getElementById('balanceEmergency').checked = !!p.emergency;
}

// Picking a bucket suggests a default for "counts toward emergency fund"
// (only liquid cash by default); the user can still override the checkbox.
function onBalanceBucketChange() {
    document.getElementById('balanceEmergency').checked =
        document.getElementById('balanceBucket').value === 'liquid';
}

function saveBalance() {
    const accountName = document.getElementById('balanceAccountName').value.trim();
    const amount = toCents(document.getElementById('balanceAmount').value);
    const asOfDate = document.getElementById('balanceDate').value;
    const bucket = document.getElementById('balanceBucket').value;
    const emergency = document.getElementById('balanceEmergency').checked ? 1 : 0;

    if (!accountName || !amount || !asOfDate) {
        alert('Please fill in all fields');
        return;
    }

    db.run('INSERT INTO bank_balances (account_name, balance, as_of_date) VALUES (?, ?, ?)', [accountName, amount, asOfDate]);
    db.run(`INSERT INTO account_purpose (account_name, bucket, emergency) VALUES (?, ?, ?)
            ON CONFLICT(account_name) DO UPDATE SET bucket = excluded.bucket, emergency = excluded.emergency`,
        [accountName, bucket, emergency]);
    markDirty();
    cancelBalanceForm();
    loadFinancialHealth();
    if (typeof loadOverview === 'function') loadOverview();
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

    // Clear and populate items. Template amounts are decimal dollars (literal
    // hard-coded values above); convert to integer cents so activityItemsData
    // matches the DB convention everywhere else.
    activityItemsData = tpl.items.map(item => {
        const categoryId = item.category ? dbHelpers.queryValue('SELECT id FROM categories WHERE name = ?', [item.category]) : null;
        return {
            description: item.description,
            category_id: categoryId,
            amount: toCents(item.amount)
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
    const categoryOptions = categories.map(c => `<option value="${c[0]}">${escapeHtml(c[2] || '')} ${escapeHtml(c[1])}</option>`).join('');

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
            <input type="number" placeholder="0.00" min="0" step="0.01" value="${item.amount ? fromCents(item.amount) : ''}"
                   onchange="activityItemsData[${idx}].amount = toCents(this.value)"
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

        const itemsSummary = items.map(i => `${i[0]}: $${fromCents(i[2]).toFixed(0)}`).join(' • ');

        return `
            <div style="border:1px solid #dee2e6; border-radius:6px; padding:12px; margin-bottom:8px; background:white;">
                <div style="display:flex; justify-content:space-between; align-items:start; margin-bottom:6px;">
                    <div>
                        <div style="font-weight:600;">${type === 'overseas' ? '✈️' : '🎯'} ${escapeHtml(name)}${typeLabel}</div>
                        <div style="font-size:12px; color:#7f8c8d; margin-top:4px;">${itemsSummary}</div>
                        ${notes ? `<div style="font-size:11px; color:#95a5a6; margin-top:4px; font-style:italic;">${escapeHtml(notes)}</div>` : ''}
                    </div>
                    <div style="font-weight:700; color:#3498db; font-size:16px;">$${fmtMoney(total)}</div>
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
                    <div style="font-weight:700; color:#3498db; font-size:16px;">Total: $${fmtMoney(monthTotal)}</div>
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

                    const itemsSummary = items.map(i => `${i[0]}: $${fromCents(i[2]).toFixed(0)}`).join(' • ');

                    return `
                        <div style="background:#f8f9fa; border-radius:6px; padding:12px; margin-bottom:8px;">
                            <div style="display:flex; justify-content:space-between; align-items:start; margin-bottom:6px;">
                                <div style="flex:1;">
                                    <div style="font-weight:600;">${type === 'overseas' ? '✈️' : '🎯'} ${escapeHtml(name)}${typeLabel}</div>
                                    <div style="font-size:12px; color:#7f8c8d; margin-top:4px;">${itemsSummary}</div>
                                    ${notes ? `<div style="font-size:11px; color:#95a5a6; margin-top:4px; font-style:italic;">${escapeHtml(notes)}</div>` : ''}
                                </div>
                                <div style="font-weight:700; color:#3498db; font-size:16px; margin-left:12px;">$${fmtMoney(total)}</div>
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
    const val = toCents(document.getElementById('plannerVariableSpend').value);
    dbHelpers.safeRun(`
        INSERT INTO planner_settings (key, value) VALUES ('variable_spend', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `, [val], 'Save variable spend');
    markDirty();
    await loadPlanner();
}

// ═══════════════════════════════════════════════════════════════════════════
// §16. PLANNER MONTH VIEW
// ═══════════════════════════════════════════════════════════════════════════

let monthViewYear  = null;
let monthViewMonth = null; // 1–12

function switchPlannerView(mode) {
    document.getElementById('plannerGridView').style.display  = mode === 'grid'  ? '' : 'none';
    document.getElementById('plannerMonthView').style.display = mode === 'month' ? '' : 'none';
    document.querySelectorAll('.planner-view-btn').forEach(btn => {
        const active = btn.dataset.view === mode;
        if (active) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
    if (mode === 'month') {
        if (!monthViewYear) {
            const now = new Date();
            monthViewYear  = now.getFullYear();
            monthViewMonth = now.getMonth() + 1;
        }
        renderMonthView();
    }
}

function shiftMonthView(delta) {
    monthViewMonth += delta;
    if (monthViewMonth > 12) { monthViewMonth = 1;  monthViewYear++; }
    if (monthViewMonth < 1)  { monthViewMonth = 12; monthViewYear--; }
    closePlannerDayDetail();
    renderMonthView();
}

function renderMonthView() {
    const container = document.getElementById('monthViewCalendar');
    if (!container) return;

    const year  = monthViewYear;
    const month = monthViewMonth;

    // Update navigation label
    const labelEl = document.getElementById('monthViewLabel');
    if (labelEl) {
        labelEl.textContent = new Date(year, month - 1, 1)
            .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    }

    const monthKey = `${year}-${String(month).padStart(2, '0')}`;

    // ── Actual bank transactions ───────────────────────────────────────────
    const txRows = dbHelpers.queryAll(`
        SELECT t.date, t.description, t.amount,
               c.name AS cat_name, c.icon AS cat_icon, c.color AS cat_color
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE strftime('%Y-%m', t.date) = ? AND t.ignored = 0
        ORDER BY t.date, t.amount
    `, [monthKey]);

    // ── Planner commitments ────────────────────────────────────────────────
    const commitmentRows = dbHelpers.queryAll(`
        SELECT ec.id, ec.description, ec.amount, ec.type,
               ec.day_of_month, ec.payment_dates, ec.active_months,
               ec.notes, ec.enabled,
               c.name AS cat_name, c.icon AS cat_icon, c.color AS cat_color
        FROM expense_commitments ec
        LEFT JOIN categories c ON ec.category_id = c.id
        WHERE ec.enabled = 1
    `);

    const commitments = commitmentRows.map(r => ({
        id: r[0], description: r[1], amount: r[2], type: r[3],
        day_of_month: r[4], payment_dates: r[5], active_months: r[6],
        notes: r[7], enabled: r[8],
        cat_name: r[9] || 'Uncategorised', cat_icon: r[10] || '📦', cat_color: r[11] || '#9b59b6'
    }));

    // ── Index by day ───────────────────────────────────────────────────────
    const txByDay             = {};
    const commitmentsByDay    = {};
    const monthlyNoDay        = []; // monthly commitments without a specific day
    const workdayCommitments  = []; // apply to every Mon–Fri
    const nonwkdCommitments   = []; // apply to every Sat–Sun

    txRows.forEach(([date, desc, amount, catName, catIcon, catColor]) => {
        const day = parseInt(date.split('-')[2]);
        if (!txByDay[day]) txByDay[day] = [];
        txByDay[day].push({ desc, amount, catName: catName || 'Uncategorised', catColor: catColor || '#95a5a6', catIcon: catIcon || '📦' });
    });

    commitments.forEach(c => {
        if (commitmentAmountForMonth(c, year, month) === 0) return;
        if (c.type === 'term' && c.payment_dates) {
            c.payment_dates.split(',').forEach(dateStr => {
                dateStr = dateStr.trim();
                if (dateStr.startsWith(monthKey + '-')) {
                    const day = parseInt(dateStr.split('-')[2]);
                    if (!commitmentsByDay[day]) commitmentsByDay[day] = [];
                    commitmentsByDay[day].push(c);
                }
            });
        } else if (c.type === 'monthly') {
            if (c.day_of_month) {
                const day = c.day_of_month;
                if (!commitmentsByDay[day]) commitmentsByDay[day] = [];
                commitmentsByDay[day].push(c);
            } else {
                monthlyNoDay.push(c);
            }
        } else if (c.type === 'workday') {
            workdayCommitments.push(c);
        } else if (c.type === 'nonworkday') {
            nonwkdCommitments.push(c);
        }
    });

    // ── Today reference ───────────────────────────────────────────────────
    const now     = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const daysInMonth = new Date(year, month, 0).getDate();
    const firstDayJS  = new Date(year, month - 1, 1).getDay(); // 0=Sun
    const startOffset = (firstDayJS + 6) % 7;                  // Mon-first: Mon=0 … Sun=6

    let html = '';

    // ── Summary banners for undated commitments ────────────────────────────
    function makeBanner(items, accentColor, icon, titleText) {
        const total = items.reduce((s, c) => s + commitmentAmountForMonth(c, year, month), 0);
        let b = `<div style="background:${accentColor}10; border:1px solid ${accentColor}30; border-radius:8px; padding:12px 16px; margin-bottom:12px;">`;
        b += `<div style="font-size:11px; font-weight:700; color:${accentColor}; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:8px;">${icon} ${escapeHtml(titleText)}</div>`;
        b += `<div style="display:flex; flex-wrap:wrap; gap:8px;">`;
        items.forEach(c => {
            const monthAmt = commitmentAmountForMonth(c, year, month);
            b += `<div style="background:white; border:1px solid ${accentColor}20; border-radius:6px; padding:6px 10px; font-size:12px; display:flex; align-items:center; gap:6px;">`;
            b += `<span style="font-size:14px;">${escapeHtml(c.cat_icon)}</span>`;
            b += `<div><div style="font-weight:600; color:#2c3e50;">${escapeHtml(c.description)}</div>`;
            b += `<div style="font-size:10px; color:#95a5a6;">${escapeHtml(c.cat_name)}</div></div>`;
            b += `<span style="color:${accentColor}; font-weight:700; margin-left:4px;">S$${fmtMoney(monthAmt)}</span>`;
            b += `</div>`;
        });
        b += `</div>`;
        b += `<div style="margin-top:8px; font-size:12px; color:#7f8c8d;">Total this month: <strong style="color:${accentColor};">S$${fmtMoney(total)}</strong></div>`;
        b += `</div>`;
        return b;
    }

    if (monthlyNoDay.length > 0)       html += makeBanner(monthlyNoDay,       '#9b59b6', '📅', 'Monthly Commitments — no specific date');
    if (workdayCommitments.length > 0) html += makeBanner(workdayCommitments, '#16a085', '💼', `Workday Costs — ${countWorkdaysInMonth(year, month)} workdays this month`);
    if (nonwkdCommitments.length > 0)  html += makeBanner(nonwkdCommitments,  '#d35400', '🏖️', `Non-workday Costs — ${countNonWorkdaysInMonth(year, month)} non-workdays this month`);

    // ── Calendar grid ──────────────────────────────────────────────────────
    html += `<div style="display:grid; grid-template-columns:repeat(7, 1fr); gap:1px; background:#dee2e6; border-radius:8px; overflow:hidden;">`;

    // Day-of-week headers
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach((name, idx) => {
        const wknd = idx >= 5;
        html += `<div style="background:#f8f9fa; text-align:center; padding:8px 4px; font-size:11px; font-weight:700; color:${wknd ? '#e67e22' : '#7f8c8d'}; letter-spacing:0.5px; text-transform:uppercase;">${name}</div>`;
    });

    // Leading empty cells
    for (let i = 0; i < startOffset; i++) {
        html += `<div style="background:#fafafa; min-height:90px;"></div>`;
    }

    // Day cells
    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const isToday  = dateStr === todayStr;
        const isPast   = dateStr < todayStr;
        const colIdx   = (startOffset + day - 1) % 7;
        const isWeekend = colIdx >= 5;

        const dayTx          = txByDay[day]          || [];
        const dayCommitments = commitmentsByDay[day] || [];
        // Workday/nonworkday commitments apply to every applicable day
        const dayWorkday     = isWeekend ? [] : workdayCommitments;
        const dayNonwkd      = isWeekend ? nonwkdCommitments : [];

        const bg = isToday ? '#fff9c4' : (isWeekend ? '#fdf8f0' : 'white');

        html += `<div class="planner-cal-day" style="background:${bg}; min-height:90px; padding:5px; cursor:pointer;" `;
        html += `onclick="showPlannerDayDetail('${dateStr}')">`;

        // Day number
        const numColor = isToday ? '#e67e22' : (isPast ? '#2c3e50' : '#95a5a6');
        if (isToday) {
            html += `<div style="text-align:right; margin-bottom:3px;"><span style="background:#e67e22; color:white; border-radius:50%; width:20px; height:20px; display:inline-flex; align-items:center; justify-content:center; font-size:11px; font-weight:700;">${day}</span></div>`;
        } else {
            html += `<div style="text-align:right; font-size:12px; font-weight:500; color:${numColor}; margin-bottom:3px;">${day}</div>`;
        }

        // Bank transactions badge
        if (dayTx.length) {
            const spend  = dayTx.filter(t => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);
            const income = dayTx.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0);
            html += `<div style="background:#e8f4fd; border-left:3px solid #3498db; border-radius:2px; padding:2px 4px; margin-bottom:2px; font-size:10px; white-space:nowrap; overflow:hidden;">`;
            html += `<span style="color:#3498db; font-weight:600;">${dayTx.length}tx</span>`;
            if (spend  > 0) html += ` <span style="color:#e74c3c;">-${fromCents(spend).toFixed(0)}</span>`;
            if (income > 0) html += ` <span style="color:#27ae60;">+${fromCents(income).toFixed(0)}</span>`;
            html += `</div>`;
        }

        // Commitment badges (up to 2, then +N)
        if (dayCommitments.length) {
            dayCommitments.slice(0, 2).forEach(c => {
                const label = c.description.length > 10 ? c.description.substring(0, 10) + '…' : c.description;
                html += `<div style="background:#f3eeff; border-left:3px solid #9b59b6; border-radius:2px; padding:2px 4px; margin-bottom:2px; font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">`;
                html += `<span style="color:#9b59b6; font-weight:600;">S$${fromCents(c.amount).toFixed(0)}</span> <span style="color:#5d3a8a; font-size:9px;">${escapeHtml(label)}</span>`;
                html += `</div>`;
            });
            if (dayCommitments.length > 2) {
                html += `<div style="font-size:9px; color:#9b59b6; text-align:right;">+${dayCommitments.length - 2} more</div>`;
            }
        }

        // Workday badges (Mon–Fri)
        if (dayWorkday.length) {
            const wdTotal = dayWorkday.reduce((s, c) => s + c.amount, 0);
            html += `<div style="background:#e8f8f5; border-left:3px solid #16a085; border-radius:2px; padding:2px 4px; margin-bottom:2px; font-size:10px; white-space:nowrap; overflow:hidden;">`;
            html += `<span style="color:#16a085; font-weight:600;">💼 S$${fromCents(wdTotal).toFixed(0)}</span>`;
            html += `</div>`;
        }

        // Non-workday badges (Sat–Sun)
        if (dayNonwkd.length) {
            const nwTotal = dayNonwkd.reduce((s, c) => s + c.amount, 0);
            html += `<div style="background:#fef0e7; border-left:3px solid #d35400; border-radius:2px; padding:2px 4px; margin-bottom:2px; font-size:10px; white-space:nowrap; overflow:hidden;">`;
            html += `<span style="color:#d35400; font-weight:600;">🏖️ S$${fromCents(nwTotal).toFixed(0)}</span>`;
            html += `</div>`;
        }

        html += `</div>`;
    }

    // Trailing empty cells
    const totalCells = startOffset + daysInMonth;
    const trailing   = (7 - (totalCells % 7)) % 7;
    for (let i = 0; i < trailing; i++) {
        html += `<div style="background:#fafafa; min-height:90px;"></div>`;
    }
    html += `</div>`;

    container.innerHTML = html;
}

function showPlannerDayDetail(dateStr) {
    const panel = document.getElementById('plannerDayDetail');
    if (!panel) return;

    const [year, month, day] = dateStr.split('-').map(Number);
    const dateLabel = new Date(year, month - 1, day)
        .toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    // ── Bank transactions ──────────────────────────────────────────────────
    const txRows = dbHelpers.queryAll(`
        SELECT t.description, t.amount,
               c.name AS cat_name, c.icon AS cat_icon, c.color AS cat_color,
               sc.name AS subcat_name
        FROM transactions t
        LEFT JOIN categories c  ON t.category_id    = c.id
        LEFT JOIN subcategories sc ON t.subcategory_id = sc.id
        WHERE t.date = ? AND t.ignored = 0
        ORDER BY t.amount
    `, [dateStr]);

    // ── Planner commitments for this exact day ─────────────────────────────
    const monthKey = `${year}-${String(month).padStart(2, '0')}`;
    const commitmentRows = dbHelpers.queryAll(`
        SELECT ec.id, ec.description, ec.amount, ec.type,
               ec.day_of_month, ec.payment_dates, ec.active_months,
               ec.notes, ec.enabled,
               c.name AS cat_name, c.icon AS cat_icon, c.color AS cat_color
        FROM expense_commitments ec
        LEFT JOIN categories c ON ec.category_id = c.id
        WHERE ec.enabled = 1
    `);

    // Determine if this date is a workday (Mon–Fri) or non-workday (Sat–Sun)
    const dowForDetail = new Date(dateStr).getDay(); // 0=Sun, 6=Sat
    const isWorkdayDate = dowForDetail >= 1 && dowForDetail <= 5;

    const dayCommitments  = [];
    const dayWorkdayItems = [];
    const dayNonwkdItems  = [];

    commitmentRows.forEach(r => {
        const c = {
            id: r[0], description: r[1], amount: r[2], type: r[3],
            day_of_month: r[4], payment_dates: r[5], active_months: r[6],
            notes: r[7], enabled: r[8],
            cat_name: r[9] || 'Uncategorised', cat_icon: r[10] || '📦', cat_color: r[11] || '#9b59b6'
        };
        if (commitmentAmountForMonth(c, year, month) === 0) return;
        if (c.type === 'term' && c.payment_dates) {
            if (c.payment_dates.split(',').map(d => d.trim()).includes(dateStr)) dayCommitments.push(c);
        } else if (c.type === 'monthly' && c.day_of_month === day) {
            dayCommitments.push(c);
        } else if (c.type === 'workday' && isWorkdayDate) {
            dayWorkdayItems.push(c);
        } else if (c.type === 'nonworkday' && !isWorkdayDate) {
            dayNonwkdItems.push(c);
        }
    });

    // ── Build panel HTML ───────────────────────────────────────────────────
    let html = '';
    html += `<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">`;
    html += `<h5 style="margin:0; color:#2c3e50; font-size:14px;">${escapeHtml(dateLabel)}</h5>`;
    html += `<button class="secondary-btn" style="padding:3px 10px; font-size:12px;" onclick="closePlannerDayDetail()">✕ Close</button>`;
    html += `</div>`;

    if (!txRows.length && !dayCommitments.length && !dayWorkdayItems.length && !dayNonwkdItems.length) {
        html += `<div style="color:#95a5a6; font-size:13px; font-style:italic; text-align:center; padding:16px 0;">No transactions or commitments for this day.</div>`;
    }

    // Bank transactions section
    if (txRows.length) {
        const totalSpend  = txRows.filter(r => r[1] < 0).reduce((s, r) => s + Math.abs(r[1]), 0);
        const totalIncome = txRows.filter(r => r[1] > 0).reduce((s, r) => s + r[1], 0);
        html += `<div style="margin-bottom:14px;">`;
        html += `<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">`;
        html += `<span style="font-size:11px; font-weight:700; color:#3498db; text-transform:uppercase; letter-spacing:0.5px;">🏦 Bank Transactions (${txRows.length})</span>`;
        html += `<span style="font-size:12px;">`;
        if (totalSpend  > 0) html += `<span style="color:#e74c3c;">-S$${fmtMoney(totalSpend)}</span> `;
        if (totalIncome > 0) html += `<span style="color:#27ae60;">+S$${fmtMoney(totalIncome)}</span>`;
        html += `</span></div>`;
        txRows.forEach(([desc, amount, catName, catIcon, catColor, subcatName]) => {
            const isSpend = amount < 0;
            html += `<div style="display:flex; justify-content:space-between; align-items:center; padding:6px 8px; background:#f8f9fa; border-radius:4px; margin-bottom:3px; border-left:3px solid ${catColor || '#95a5a6'};">`;
            html += `<div style="flex:1; min-width:0; margin-right:8px;">`;
            html += `<div style="font-size:12px; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(desc)}</div>`;
            html += `<div style="font-size:10px; color:#95a5a6;">${escapeHtml(catIcon || '📦')} ${escapeHtml(catName || 'Uncategorised')}${subcatName ? ` › ${escapeHtml(subcatName)}` : ''}</div>`;
            html += `</div>`;
            html += `<span style="font-size:13px; font-weight:700; color:${isSpend ? '#e74c3c' : '#27ae60'}; white-space:nowrap;">${isSpend ? '-' : '+'}S$${fmtMoney(amount)}</span>`;
            html += `</div>`;
        });
        html += `</div>`;
    }


    // Expected commitments section (term/dated + monthly with specific day)
    if (dayCommitments.length) {
        const total = dayCommitments.reduce((s, c) => s + c.amount, 0);
        html += `<div style="margin-bottom:14px;">`;
        html += `<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">`;
        html += `<span style="font-size:11px; font-weight:700; color:#9b59b6; text-transform:uppercase; letter-spacing:0.5px;">📅 Expected Commitments (${dayCommitments.length})</span>`;
        html += `<span style="font-size:12px; color:#9b59b6; font-weight:600;">S$${fmtMoney(total)}</span>`;
        html += `</div>`;
        dayCommitments.forEach(c => {
            html += `<div style="display:flex; justify-content:space-between; align-items:center; padding:6px 8px; background:#f9f0ff; border-radius:4px; margin-bottom:3px; border-left:3px solid #9b59b6;">`;
            html += `<div style="flex:1; min-width:0; margin-right:8px;">`;
            html += `<div style="font-size:12px; font-weight:500;">${escapeHtml(c.description)}</div>`;
            html += `<div style="font-size:10px; color:#95a5a6;">${escapeHtml(c.cat_icon)} ${escapeHtml(c.cat_name)}${c.notes ? ` · ${escapeHtml(c.notes)}` : ''}</div>`;
            html += `</div>`;
            html += `<div style="display:flex; align-items:center; gap:6px; white-space:nowrap;">`;
            html += `<span style="font-size:13px; font-weight:700; color:#9b59b6;">S$${fmtMoney(c.amount)}</span>`;
            html += `<button class="secondary-btn" style="padding:2px 7px; font-size:11px;" onclick="openEditCommitment(${c.id})">Edit</button>`;
            html += `<button class="danger-btn" style="padding:2px 7px; font-size:11px;" onclick="deleteCommitment(${c.id})">Del</button>`;
            html += `</div>`;
            html += `</div>`;
        });
        html += `</div>`;
    }

    // Workday expenses section (Mon–Fri only)
    if (dayWorkdayItems.length) {
        const total = dayWorkdayItems.reduce((s, c) => s + c.amount, 0);
        html += `<div style="margin-bottom:14px;">`;
        html += `<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">`;
        html += `<span style="font-size:11px; font-weight:700; color:#16a085; text-transform:uppercase; letter-spacing:0.5px;">💼 Workday Costs (${dayWorkdayItems.length})</span>`;
        html += `<span style="font-size:12px; color:#16a085; font-weight:600;">S$${fmtMoney(total)}</span>`;
        html += `</div>`;
        dayWorkdayItems.forEach(c => {
            html += `<div style="display:flex; justify-content:space-between; align-items:center; padding:6px 8px; background:#e8f8f5; border-radius:4px; margin-bottom:3px; border-left:3px solid #16a085;">`;
            html += `<div style="flex:1; min-width:0; margin-right:8px;">`;
            html += `<div style="font-size:12px; font-weight:500;">${escapeHtml(c.description)}</div>`;
            html += `<div style="font-size:10px; color:#95a5a6;">${escapeHtml(c.cat_icon)} ${escapeHtml(c.cat_name)}${c.notes ? ` · ${escapeHtml(c.notes)}` : ''}</div>`;
            html += `</div>`;
            html += `<div style="display:flex; align-items:center; gap:6px; white-space:nowrap;">`;
            html += `<span style="font-size:13px; font-weight:700; color:#16a085;">S$${fmtMoney(c.amount)}</span>`;
            html += `<button class="secondary-btn" style="padding:2px 7px; font-size:11px;" onclick="openEditCommitment(${c.id})">Edit</button>`;
            html += `<button class="danger-btn" style="padding:2px 7px; font-size:11px;" onclick="deleteCommitment(${c.id})">Del</button>`;
            html += `</div>`;
            html += `</div>`;
        });
        html += `</div>`;
    }

    // Non-workday expenses section (Sat–Sun only)
    if (dayNonwkdItems.length) {
        const total = dayNonwkdItems.reduce((s, c) => s + c.amount, 0);
        html += `<div style="margin-bottom:14px;">`;
        html += `<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">`;
        html += `<span style="font-size:11px; font-weight:700; color:#d35400; text-transform:uppercase; letter-spacing:0.5px;">🏖️ Non-workday Costs (${dayNonwkdItems.length})</span>`;
        html += `<span style="font-size:12px; color:#d35400; font-weight:600;">S$${fmtMoney(total)}</span>`;
        html += `</div>`;
        dayNonwkdItems.forEach(c => {
            html += `<div style="display:flex; justify-content:space-between; align-items:center; padding:6px 8px; background:#fef0e7; border-radius:4px; margin-bottom:3px; border-left:3px solid #d35400;">`;
            html += `<div style="flex:1; min-width:0; margin-right:8px;">`;
            html += `<div style="font-size:12px; font-weight:500;">${escapeHtml(c.description)}</div>`;
            html += `<div style="font-size:10px; color:#95a5a6;">${escapeHtml(c.cat_icon)} ${escapeHtml(c.cat_name)}${c.notes ? ` · ${escapeHtml(c.notes)}` : ''}</div>`;
            html += `</div>`;
            html += `<div style="display:flex; align-items:center; gap:6px; white-space:nowrap;">`;
            html += `<span style="font-size:13px; font-weight:700; color:#d35400;">S$${fmtMoney(c.amount)}</span>`;
            html += `<button class="secondary-btn" style="padding:2px 7px; font-size:11px;" onclick="openEditCommitment(${c.id})">Edit</button>`;
            html += `<button class="danger-btn" style="padding:2px 7px; font-size:11px;" onclick="deleteCommitment(${c.id})">Del</button>`;
            html += `</div>`;
            html += `</div>`;
        });
        html += `</div>`;
    }

    panel.innerHTML = html;
    panel.style.display = 'block';
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closePlannerDayDetail() {
    const panel = document.getElementById('plannerDayDetail');
    if (panel) panel.style.display = 'none';
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
