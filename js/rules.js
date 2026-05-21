// §12. TRANSACTION RULES
// ═══════════════════════════════════════════════════════════════════════════

async function loadRules() {
    const result = db.exec(`
        SELECT tr.id, tr.name, tr.keyword, tr.action, c.name as category_name, tr.case_sensitive, tr.enabled, tr.priority
        FROM transaction_rules tr
        LEFT JOIN categories c ON tr.category_value = c.id
        ORDER BY tr.priority DESC, tr.name
    `);

    displayRules(result);
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
        const [id, name, keyword, action, categoryName, caseSensitive, enabled, priority] = row;
        const rule = { id, name, keyword, action, categoryName, caseSensitive, enabled, priority };
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
        const { id, name, keyword, caseSensitive, priority } = rule;
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

function showAddRuleForm() {
    document.getElementById('addRuleForm').style.display = 'block';
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
    document.getElementById('addRuleForm').style.display = 'none';
    document.getElementById('newRuleName').value = '';
    document.getElementById('newRuleKeyword').value = '';
    document.getElementById('newRuleAction').value = 'categorize';
    document.getElementById('newRuleCaseSensitive').checked = false;
    document.getElementById('newRulePriority').value = '10';
    document.getElementById('categoryFieldGroup').style.display = 'block';
    document.getElementById('subcategoryFieldGroup').style.display = 'block';
}

async function addRule() {
    const name = document.getElementById('newRuleName').value.trim();
    const keyword = document.getElementById('newRuleKeyword').value.trim();
    const action = document.getElementById('newRuleAction').value;
    const caseSensitive = document.getElementById('newRuleCaseSensitive').checked;
    const priority = parseInt(document.getElementById('newRulePriority').value) || 0;

    let categoryValue = null;
    if (action === 'categorize') {
        categoryValue = document.getElementById('newRuleCategory').value;
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

    showLoading('Creating rule...');

    try {
        const result = dbHelpers.safeRun(`
            INSERT INTO transaction_rules (name, keyword, action, category_value, case_sensitive, enabled, priority)
            VALUES (?, ?, ?, ?, ?, 1, ?)
        `, [name, keyword, action, categoryValue, caseSensitive ? 1 : 0, priority], 'Add rule');

        if (!result.success) {
            hideLoading();
            return;
        }

        markDirty();
        await loadRules();
        cancelAddRule();
        hideLoading();
        showMessage('success', `Rule "${name}" created successfully`);
    } catch (e) {
        hideLoading();
        showMessage('error', 'Error creating rule: ' + e.message);
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
    let skippedManual = 0;

    // Get all transactions, excluding those with manual category overrides
    const transResult = db.exec(`
        SELECT t.id, t.description, t.category_id, c.name as category_name, t.manual_category
        FROM transactions t
        LEFT JOIN categories c ON t.category_id = c.id
    `);
    if (transResult.length > 0) {
        transResult[0].values.forEach(row => {
            const transId = row[0];
            const description = row[1] || '';
            const currentCategoryName = row[3];
            const manualCategory = row[4];

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

            if (ruleResult.category !== currentCategoryName) {
                const newCategoryId = dbHelpers.queryValue('SELECT id FROM categories WHERE name = ?', [ruleResult.category]);
                if (newCategoryId) {
                    db.run('UPDATE transactions SET category_id = ? WHERE id = ?', [newCategoryId, transId]);
                    categorizedCount++;
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
    if (skippedManual > 0) parts.push(`${skippedManual} skipped (manual override)`);

    if (parts.length > 0) {
        message += parts.join(', ');
    } else {
        message = 'No transactions matched the rules';
    }

    showMessage('success', message);
}

// ═══════════════════════════════════════════════════════════════════════════
