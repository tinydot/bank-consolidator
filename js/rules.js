// §12. TRANSACTION RULES
// ═══════════════════════════════════════════════════════════════════════════

async function loadRules() {
    const result = db.exec(`
        SELECT tr.id, tr.name, tr.keyword, tr.action, c.name as category_name, tr.case_sensitive, tr.enabled, tr.priority,
               sc.name as subcategory_name, tr.category_value, tr.subcategory_value
        FROM transaction_rules tr
        LEFT JOIN categories c ON tr.category_value = c.id
        LEFT JOIN subcategories sc ON tr.subcategory_value = sc.id
        ORDER BY tr.priority DESC, tr.name
    `);

    displayRules(result);
    renderFrequentTransactions();
}

function displayRules(result) {
    const container = document.getElementById('rulesListContainer');
    if (!container) return;

    if (!result.length || !result[0].values.length) {
        container.innerHTML = '<div class="loading">No rules defined. Click "Add New Rule" to create one.</div>';
        return;
    }

    const rows = result[0].values;

    // Split into ignore group and per-category groups
    const ignoreRules = [];
    const categoryGroups = {}; // key: category_name → []

    rows.forEach(row => {
        const [id, name, keyword, action, categoryName, caseSensitive, enabled, priority, subcategoryName, categoryValue, subcategoryValue] = row;
        const rule = { id, name, keyword, action, categoryName, caseSensitive, enabled, priority, subcategoryName, categoryValue, subcategoryValue };
        if (action === 'ignore') {
            ignoreRules.push(rule);
        } else {
            const key = categoryName || 'Uncategorized';
            if (!categoryGroups[key]) categoryGroups[key] = [];
            categoryGroups[key].push(rule);
        }
    });

    const frag = document.createDocumentFragment();

    function makeRuleTag(rule) {
        const { id, name, keyword, caseSensitive, priority, subcategoryName } = rule;
        const tag = document.createElement('div');
        tag.style.cssText = 'display:inline-flex; align-items:center; gap:6px; background:white; border:1px solid #dee2e6; border-radius:16px; padding:6px 10px 6px 12px; margin:4px 4px 4px 0; font-size:13px; transition:all .15s;';
        tag.onmouseenter = () => tag.style.boxShadow = '0 2px 6px rgba(0,0,0,0.1)';
        tag.onmouseleave = () => tag.style.boxShadow = 'none';

        const content = document.createElement('div');
        content.style.cssText = 'display:flex; align-items:center; gap:5px;';

        const keywordSpan = document.createElement('span');
        keywordSpan.style.cssText = 'font-family:monospace; color:#2c3e50; font-weight:500;';
        keywordSpan.textContent = keyword;
        content.appendChild(keywordSpan);

        if (subcategoryName) {
            const subTag = document.createElement('span');
            subTag.style.cssText = 'font-size:11px; background:#2ecc71; color:white; padding:1px 6px; border-radius:10px; font-weight:600;';
            subTag.textContent = subcategoryName;
            content.appendChild(subTag);
        }

        if (caseSensitive) {
            const csTag = document.createElement('span');
            csTag.style.cssText = 'font-size:9px; background:#f39c12; color:white; padding:1px 4px; border-radius:2px; font-weight:600;';
            csTag.textContent = 'Aa';
            content.appendChild(csTag);
        }

        if (priority > 0) {
            const priTag = document.createElement('span');
            priTag.style.cssText = 'font-size:10px; color:#95a5a6; font-weight:600;';
            priTag.textContent = `p${priority}`;
            content.appendChild(priTag);
        }

        tag.appendChild(content);

        const editBtn = document.createElement('button');
        editBtn.style.cssText = 'background:none; border:none; color:#3498db; font-size:12px; cursor:pointer; padding:0; line-height:1; width:18px; height:18px; display:flex; align-items:center; justify-content:center; border-radius:50%; transition:background .15s;';
        editBtn.innerHTML = '✎';
        editBtn.title = `Edit rule: ${keyword}`;
        editBtn.onmouseenter = () => editBtn.style.background = '#3498db20';
        editBtn.onmouseleave = () => editBtn.style.background = 'none';
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            editRule(id);
        });
        tag.appendChild(editBtn);

        const delBtn = document.createElement('button');
        delBtn.style.cssText = 'background:none; border:none; color:#e74c3c; font-size:14px; cursor:pointer; padding:0; line-height:1; width:16px; height:16px; display:flex; align-items:center; justify-content:center; border-radius:50%; transition:background .15s;';
        delBtn.innerHTML = '×';
        delBtn.title = `Delete rule: ${keyword}`;
        delBtn.onmouseenter = () => delBtn.style.background = '#e74c3c20';
        delBtn.onmouseleave = () => delBtn.style.background = 'none';
        delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteRule(id);
        });
        tag.appendChild(delBtn);

        return tag;
    }

    function makeGroup(title, borderColor, rules, defaultOpen = false) {
        const section = document.createElement('div');
        section.style.cssText = `border:1px solid ${borderColor}20; border-radius:8px; margin-bottom:12px; overflow:hidden;`;

        const header = document.createElement('div');
        header.style.cssText = `display:flex; align-items:center; gap:10px; padding:10px 16px; background:${borderColor}10; cursor:pointer; user-select:none;`;
        header.innerHTML = `
            <span style="font-size:12px; color:${borderColor}; transition:transform .2s;" data-arrow>${defaultOpen ? '▼' : '▶'}</span>
            <span style="font-weight:600; font-size:13px;">${title}</span>
            <span style="background:${borderColor}; color:white; font-size:10px; font-weight:600; padding:2px 7px; border-radius:10px; margin-left:auto;">${rules.length}</span>
        `;

        const body = document.createElement('div');
        body.style.cssText = `padding:8px 12px; display:${defaultOpen ? 'flex' : 'none'}; flex-wrap:wrap;`;

        rules.forEach(rule => body.appendChild(makeRuleTag(rule)));
        section.appendChild(header);
        section.appendChild(body);

        header.addEventListener('click', () => {
            const open = body.style.display !== 'none';
            body.style.display = open ? 'none' : 'flex';
            header.querySelector('[data-arrow]').textContent = open ? '▶' : '▼';
        });

        return section;
    }

    // Auto-Ignore group
    if (ignoreRules.length) {
        frag.appendChild(makeGroup('🚫 Auto-Ignore', '#e74c3c', ignoreRules, false));
    }

    // Auto-Categorize groups — one per category, sorted by name
    const sortedCategories = Object.keys(categoryGroups).sort();
    sortedCategories.forEach(catName => {
        const rules = categoryGroups[catName];
        frag.appendChild(makeGroup(`🏷 ${catName}`, '#3498db', rules, false));
    });

    // Summary line
    const total = rows.length;
    const summary = document.createElement('div');
    summary.style.cssText = 'font-size:12px; color:#95a5a6; margin-top:8px; padding:0 4px;';
    summary.textContent = `${total} rule${total !== 1 ? 's' : ''} total`;
    frag.appendChild(summary);

    container.innerHTML = '';
    container.appendChild(frag);
}

// Tracks the rule currently being edited (null = adding a new rule).
let editingRuleId = null;

function showAddRuleForm() {
    editingRuleId = null;
    const title = document.getElementById('ruleFormTitle');
    if (title) title.textContent = 'Add New Rule';
    const submitBtn = document.getElementById('ruleFormSubmitBtn');
    if (submitBtn) submitBtn.textContent = 'Create Rule';
    document.getElementById('addRuleForm').style.display = 'block';
}

function editRule(ruleId) {
    const rule = dbHelpers.queryFirst(`
        SELECT name, keyword, action, category_value, subcategory_value, case_sensitive, priority
        FROM transaction_rules WHERE id = ?
    `, [ruleId]);
    if (!rule) {
        showMessage('error', 'Rule not found');
        return;
    }
    const [name, keyword, action, categoryValue, subcategoryValue, caseSensitive, priority] = rule;

    editingRuleId = ruleId;
    document.getElementById('newRuleName').value = name || '';
    document.getElementById('newRuleKeyword').value = keyword || '';
    document.getElementById('newRuleAction').value = action;
    document.getElementById('newRuleCaseSensitive').checked = caseSensitive === 1;
    document.getElementById('newRulePriority').value = priority != null ? priority : 0;
    toggleCategoryField();
    if (action === 'categorize' && categoryValue != null) {
        document.getElementById('newRuleCategory').value = String(categoryValue);
        updateRuleSubcategoryOptions();
        if (subcategoryValue != null) {
            document.getElementById('newRuleSubcategory').value = String(subcategoryValue);
        }
    }

    const title = document.getElementById('ruleFormTitle');
    if (title) title.textContent = 'Edit Rule';
    const submitBtn = document.getElementById('ruleFormSubmitBtn');
    if (submitBtn) submitBtn.textContent = 'Save Changes';

    const form = document.getElementById('addRuleForm');
    form.style.display = 'block';
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function toggleCategoryField() {
    const action = document.getElementById('newRuleAction').value;
    const categoryField = document.getElementById('categoryFieldGroup');
    const subcategoryField = document.getElementById('subcategoryFieldGroup');
    const showFields = action === 'categorize';
    categoryField.style.display = showFields ? 'block' : 'none';
    subcategoryField.style.display = showFields ? 'block' : 'none';
}

function cancelAddRule() {
    editingRuleId = null;
    document.getElementById('addRuleForm').style.display = 'none';
    document.getElementById('newRuleName').value = '';
    document.getElementById('newRuleKeyword').value = '';
    document.getElementById('newRuleAction').value = 'categorize';
    document.getElementById('newRuleCaseSensitive').checked = false;
    document.getElementById('newRulePriority').value = '10';
    document.getElementById('categoryFieldGroup').style.display = 'block';
    document.getElementById('subcategoryFieldGroup').style.display = 'block';
    const subSelect = document.getElementById('newRuleSubcategory');
    if (subSelect) subSelect.innerHTML = '<option value="">-- None --</option>';
    const title = document.getElementById('ruleFormTitle');
    if (title) title.textContent = 'Add New Rule';
    const submitBtn = document.getElementById('ruleFormSubmitBtn');
    if (submitBtn) submitBtn.textContent = 'Create Rule';
}

async function addRule() {
    const name = document.getElementById('newRuleName').value.trim();
    const keyword = document.getElementById('newRuleKeyword').value.trim();
    const action = document.getElementById('newRuleAction').value;
    const caseSensitive = document.getElementById('newRuleCaseSensitive').checked;
    const priority = parseInt(document.getElementById('newRulePriority').value) || 0;

    let categoryValue = null;
    let subcategoryValue = null;
    if (action === 'categorize') {
        categoryValue = document.getElementById('newRuleCategory').value || null;
        subcategoryValue = document.getElementById('newRuleSubcategory').value || null;
    }

    // Validate inputs
    const nameError = validators.ruleName(name);
    if (nameError) {
        showMessage('error', nameError);
        return;
    }

    const keywordError = validators.keyword(keyword);
    if (keywordError) {
        showMessage('error', keywordError);
        return;
    }

    if (action === 'categorize' && !categoryValue) {
        showMessage('error', 'Please select a category');
        return;
    }

    const isEdit = editingRuleId != null;
    showLoading(isEdit ? 'Saving rule...' : 'Creating rule...');

    try {
        let result;
        if (isEdit) {
            result = dbHelpers.safeRun(`
                UPDATE transaction_rules
                SET name = ?, keyword = ?, action = ?, category_value = ?, subcategory_value = ?, case_sensitive = ?, priority = ?
                WHERE id = ?
            `, [name, keyword, action, categoryValue, subcategoryValue, caseSensitive ? 1 : 0, priority, editingRuleId], 'Edit rule');
        } else {
            result = dbHelpers.safeRun(`
                INSERT INTO transaction_rules (name, keyword, action, category_value, subcategory_value, case_sensitive, enabled, priority)
                VALUES (?, ?, ?, ?, ?, ?, 1, ?)
            `, [name, keyword, action, categoryValue, subcategoryValue, caseSensitive ? 1 : 0, priority], 'Add rule');
        }

        if (!result.success) {
            hideLoading();
            return;
        }

        markDirty();
        await loadRules();
        cancelAddRule();
        hideLoading();
        showMessage('success', isEdit ? `Rule "${name}" updated` : `Rule "${name}" created successfully`);
    } catch (e) {
        hideLoading();
        showMessage('error', `Error ${isEdit ? 'saving' : 'creating'} rule: ` + e.message);
    }
}

async function deleteRule(ruleId) {
    if (!confirm('Delete this rule? This will not affect already ignored transactions.')) return;

    db.run('DELETE FROM transaction_rules WHERE id = ?', [ruleId]);
    markDirty();
    await loadRules();
    showMessage('success', 'Rule deleted');
}

async function applyRulesToExisting() {
    if (!confirm('Apply all enabled rules to existing transactions?\n\nThis will skip transactions with manual category overrides.')) return;

    // Check that there are enabled rules before proceeding
    const ruleCount = dbHelpers.queryValue('SELECT COUNT(*) FROM transaction_rules WHERE enabled = 1');
    if (!ruleCount) {
        alert('No enabled rules to apply');
        return;
    }

    let ignoredCount = 0;
    let categorizedCount = 0;
    let subcategorizedCount = 0;
    let skippedManual = 0;

    // Get all transactions, excluding those with manual category overrides
    const transResult = db.exec(`
        SELECT t.id, t.description, t.category_id, c.name as category_name, t.manual_category, t.subcategory_id
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
    `);
    if (transResult.length > 0) {
        transResult[0].values.forEach(row => {
            const transId = row[0];
            const description = row[1] || '';
            const currentCategoryName = row[3];
            const manualCategory = row[4];
            const currentSubcategoryId = row[5];

            // Skip transactions with manual category overrides
            if (manualCategory === 1) {
                skippedManual++;
                return;
            }

            const ruleResult = applyTransactionRules(description, currentCategoryName);

            // Update if rules matched
            if (ruleResult.shouldIgnore) {
                db.run('UPDATE transactions SET ignored = 1 WHERE id = ?', [transId]);
                ignoredCount++;
            }

            if (ruleResult.categorized) {
                const newCategoryId = dbHelpers.queryValue('SELECT id FROM categories WHERE name = ?', [ruleResult.category]);
                if (newCategoryId) {
                    const categoryChanged = ruleResult.category !== currentCategoryName;
                    // On a category change the old subcategory no longer belongs, so it is
                    // replaced (with the rule's, or cleared). Otherwise only overwrite when
                    // the rule actually provides a subcategory — never wipe an existing one.
                    const newSubId = categoryChanged
                        ? (ruleResult.subcategoryId ?? null)
                        : (ruleResult.subcategoryId ?? currentSubcategoryId ?? null);

                    if (categoryChanged) {
                        db.run('UPDATE transactions SET category_id = ?, subcategory_id = ? WHERE id = ?', [newCategoryId, newSubId, transId]);
                        categorizedCount++;
                        if (newSubId != null && newSubId !== currentSubcategoryId) subcategorizedCount++;
                    } else if (newSubId !== currentSubcategoryId) {
                        db.run('UPDATE transactions SET subcategory_id = ? WHERE id = ?', [newSubId, transId]);
                        if (newSubId != null) subcategorizedCount++;
                    }
                }
            }
        });
    }

    markDirty();
    await loadTransactions();
    refreshFilters();
    await updateAnalytics();

    let message = 'Applied rules: ';
    const parts = [];
    if (ignoredCount > 0) parts.push(`${ignoredCount} ignored`);
    if (categorizedCount > 0) parts.push(`${categorizedCount} re-categorized`);
    if (subcategorizedCount > 0) parts.push(`${subcategorizedCount} sub-categorized`);
    if (skippedManual > 0) parts.push(`${skippedManual} skipped (manual override)`);

    if (parts.length > 0) {
        message += parts.join(', ');
    } else {
        message = 'No transactions matched the rules';
    }

    showMessage('success', message);
}

// ─────────────────────────────────────────────────────────────────────────
// §12.1. Frequent-merchant grouping + rule coverage
// ─────────────────────────────────────────────────────────────────────────

// Collapse a raw bank description down to a stable merchant key so that
// "NTUC FAIRPRICE 123 12/03" and "NTUC FAIRPRICE 887 04/06" group together.
// Strips digit/date/reference noise, punctuation, then keeps the leading words.
function normalizeMerchant(desc) {
    if (!desc) return '';
    let s = String(desc).toUpperCase();
    s = s.replace(/\b\w*\d\w*\b/g, ' '); // drop any token containing a digit (dates, amounts, refs, card ids)
    s = s.replace(/[^A-Z ]+/g, ' ');     // drop remaining punctuation/symbols
    s = s.replace(/\s+/g, ' ').trim();
    // Keep the leading words, ignoring stray single-letter tokens left by broken refs.
    let tokens = s.split(' ').filter(t => t.length > 1);
    if (!tokens.length) tokens = s.split(' ').filter(Boolean); // fall back if everything was tiny
    return tokens.slice(0, 4).join(' ');
}

function renderFrequentTransactions() {
    const container = document.getElementById('frequentTransactionsContainer');
    if (!container) return;

    const onlyUnsub = document.getElementById('freqOnlyUnsub');
    const onlyMissing = onlyUnsub ? onlyUnsub.checked : true;

    const rows = dbHelpers.queryAll(`
        SELECT t.description, t.category_id, c.name AS cat_name, t.subcategory_id
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
        WHERE t.ignored = 0
    `);

    if (!rows.length) {
        container.innerHTML = '<div class="loading">No transactions yet — import some first.</div>';
        return;
    }

    // Group by normalized merchant key.
    const groups = new Map();
    rows.forEach(([desc, catId, catName, subId]) => {
        const key = normalizeMerchant(desc);
        if (!key) return;
        let g = groups.get(key);
        if (!g) {
            g = { key, count: 0, withSub: 0, sample: desc, catCounts: new Map() };
            groups.set(key, g);
        }
        g.count++;
        if (subId != null) g.withSub++;
        // Tally the dominant category so a created rule can be pre-filled.
        if (catId != null) {
            const entry = g.catCounts.get(catId) || { id: catId, name: catName || 'Uncategorized', n: 0 };
            entry.n++;
            g.catCounts.set(catId, entry);
        }
    });

    let list = [...groups.values()];
    if (onlyMissing) list = list.filter(g => g.withSub < g.count);
    list.sort((a, b) => b.count - a.count);
    const TOP_N = 40;
    const shown = list.slice(0, TOP_N);

    if (!shown.length) {
        container.innerHTML = '<div class="loading">🎉 Every frequent merchant already has a subcategory.</div>';
        return;
    }

    // Build a subcategory id→name map once for rule-match previews.
    const subNameById = {};
    dbHelpers.queryAll('SELECT id, name FROM subcategories').forEach(r => { subNameById[r[0]] = r[1]; });

    const frag = document.createDocumentFragment();

    shown.forEach(g => {
        // Dominant current category for this merchant.
        let dominant = null;
        g.catCounts.forEach(e => { if (!dominant || e.n > dominant.n) dominant = e; });

        // What would the current rules do with this merchant?
        const ruleResult = applyTransactionRules(g.sample, null);
        let ruleLabel, ruleColor;
        if (ruleResult.shouldIgnore) {
            ruleLabel = 'Rule: ignored';
            ruleColor = '#e74c3c';
        } else if (ruleResult.categorized) {
            const subName = ruleResult.subcategoryId != null ? subNameById[ruleResult.subcategoryId] : null;
            if (subName) {
                ruleLabel = `Rule → ${ruleResult.category} · ${subName}`;
                ruleColor = '#2ecc71';
            } else {
                ruleLabel = `Rule → ${ruleResult.category} (no subcategory)`;
                ruleColor = '#f39c12';
            }
        } else {
            ruleLabel = 'No rule';
            ruleColor = '#95a5a6';
        }

        const card = document.createElement('div');
        card.style.cssText = 'display:flex; align-items:center; gap:12px; flex-wrap:wrap; background:white; border:1px solid #ecf0f1; border-radius:8px; padding:10px 14px; margin-bottom:8px;';

        const left = document.createElement('div');
        left.style.cssText = 'flex:1 1 220px; min-width:200px;';
        const subPct = g.count ? Math.round((g.withSub / g.count) * 100) : 0;
        left.innerHTML = `
            <div style="font-family:monospace; font-weight:600; color:#2c3e50;">${escapeHtml(g.key)}</div>
            <div style="font-size:12px; color:#7f8c8d; margin-top:2px;">
                ${g.count}× · ${dominant ? escapeHtml(dominant.name) : 'Uncategorized'} ·
                <span style="color:${subPct === 100 ? '#2ecc71' : '#e67e22'};">${g.withSub}/${g.count} sub-categorized</span>
            </div>
        `;

        const pill = document.createElement('span');
        pill.style.cssText = `font-size:11px; font-weight:600; color:white; background:${ruleColor}; padding:3px 9px; border-radius:10px; white-space:nowrap;`;
        pill.textContent = ruleLabel;

        const btn = document.createElement('button');
        btn.style.cssText = 'padding:5px 10px; font-size:12px; white-space:nowrap;';
        btn.textContent = ruleResult.categorized ? '✎ Refine rule' : '+ Create rule';
        const domId = dominant ? dominant.id : null;
        btn.addEventListener('click', () => createRuleFromMerchant(g.key, domId));

        card.appendChild(left);
        card.appendChild(pill);
        card.appendChild(btn);
        frag.appendChild(card);
    });

    const note = document.createElement('div');
    note.style.cssText = 'font-size:12px; color:#95a5a6; margin-top:8px;';
    note.textContent = list.length > TOP_N
        ? `Showing top ${TOP_N} of ${list.length} merchant groups.`
        : `${shown.length} merchant group${shown.length !== 1 ? 's' : ''}.`;
    frag.appendChild(note);

    container.innerHTML = '';
    container.appendChild(frag);
}

// Open the rule form pre-filled from a frequent-merchant group so the user
// only needs to pick a subcategory and save.
function createRuleFromMerchant(keyword, categoryId) {
    showAddRuleForm();
    document.getElementById('newRuleName').value = keyword;
    document.getElementById('newRuleKeyword').value = keyword;
    document.getElementById('newRuleAction').value = 'categorize';
    toggleCategoryField();
    if (categoryId != null) {
        const catSelect = document.getElementById('newRuleCategory');
        catSelect.value = String(categoryId);
        updateRuleSubcategoryOptions();
    }
    const form = document.getElementById('addRuleForm');
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const subSelect = document.getElementById('newRuleSubcategory');
    if (subSelect) subSelect.focus();
}

// ═══════════════════════════════════════════════════════════════════════════
