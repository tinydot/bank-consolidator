// §9. CATEGORIES
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// §16. SETTINGS
// ═══════════════════════════════════════════════════════════════════════════

function loadMonthlyIncomeSettings() {
    const val = dbHelpers.queryValue("SELECT value FROM settings WHERE key = 'monthly_expected_income'");
    const input = document.getElementById('monthlyExpectedIncome');
    // Stored as integer cents — display as decimal dollars in the form.
    if (input) input.value = val ? fromCents(parseInt(val, 10)).toFixed(2) : '';
}

async function saveMonthlyIncome() {
    const input = document.getElementById('monthlyExpectedIncome');
    const val = input ? input.value.trim() : '';
    if (val !== '' && (isNaN(parseFloat(val)) || parseFloat(val) < 0)) {
        alert('Please enter a valid positive number.');
        return;
    }
    if (val === '') {
        db.run("DELETE FROM settings WHERE key = 'monthly_expected_income'");
    } else {
        const cents = toCents(val);
        db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('monthly_expected_income', ?)", [String(cents)]);
    }
    markDirty();
    showMessage('success', val === '' ? 'Monthly income cleared.' : `Monthly income set to $${fmtMoneyLocale(toCents(val))}.`);
    if (document.getElementById('analytics-tab').classList.contains('active')) {
        await updateAnalytics();
    }
}

async function clearMonthlyIncome() {
    const input = document.getElementById('monthlyExpectedIncome');
    if (input) input.value = '';
    db.run("DELETE FROM settings WHERE key = 'monthly_expected_income'");
    markDirty();
    showMessage('success', 'Monthly income cleared. Analytics will use actual transaction income.');
    if (document.getElementById('analytics-tab').classList.contains('active')) {
        await updateAnalytics();
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// §17. CATEGORIES
// ═══════════════════════════════════════════════════════════════════════════

async function loadCategories() {
    const result = db.exec('SELECT id, name, color, icon, sort_order FROM categories ORDER BY sort_order, name');
    displayCategories(result);
    populateCategoryDropdowns();
}

function displayCategories(result) {
    const container = document.getElementById('categoriesListContainer');
    if (!container) return;

    if (!result.length || !result[0].values.length) {
        container.innerHTML = '<div class="loading">No categories found</div>';
        return;
    }

    // Get all subcategories in one query to avoid N+1
    const allSubcategories = {};
    const subResult = dbHelpers.queryAll(`
        SELECT category_id, id, name, sort_order 
        FROM subcategories 
        ORDER BY category_id, sort_order, name
    `);

    subResult.forEach(row => {
        const categoryId = row[0];
        if (!allSubcategories[categoryId]) {
            allSubcategories[categoryId] = [];
        }
        allSubcategories[categoryId].push({
            id: row[1],
            name: row[2],
            sortOrder: row[3]
        });
    });

    const rows = result[0].values;
    const fragment = document.createDocumentFragment();

    rows.forEach(row => {
        const id = row[0];
        const name = row[1];
        const color = row[2] || '#95a5a6';
        const icon = row[3] || '📦';

        const subcategories = allSubcategories[id] || [];

        const div = document.createElement('div');
        div.style.cssText = 'background: white; border: 1px solid #ecf0f1; border-radius: 8px; padding: 10px 14px; margin-bottom: 8px;';
        div.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="font-size: 20px;">${escapeHtml(icon)}</span>
                    <div>
                        <h4 style="margin: 0;">${escapeHtml(name)}</h4>
                        <span style="background: ${escapeHtml(color)}; color: white; padding: 2px 8px; border-radius: 4px; font-size: 12px;">${escapeHtml(color)}</span>
                    </div>
                </div>
                <div>
                    <button data-action="add-sub" style="padding: 4px 8px; font-size: 12px; margin-right: 4px;">+ Add Subcategory</button>
                    <button data-action="delete-cat" class="danger-btn" style="padding: 4px 8px; font-size: 12px;">Delete</button>
                </div>
            </div>
            <div style="margin-left: 28px;">
                <strong style="color: #7f8c8d; font-size: 12px;">SUBCATEGORIES:</strong>
                <div data-subcats style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px;"></div>
            </div>
        `;

        div.querySelector('[data-action="add-sub"]').addEventListener('click', () => showAddSubcategoryForm(id, name));
        div.querySelector('[data-action="delete-cat"]').addEventListener('click', () => deleteCategory(id, name));

        const subcatContainer = div.querySelector('[data-subcats]');
        if (subcategories.length > 0) {
            subcategories.forEach(sub => {
                const span = document.createElement('span');
                span.style.cssText = 'background: #f8f9fa; padding: 6px 12px; border-radius: 4px; font-size: 13px; display: flex; align-items: center; gap: 5px;';
                span.innerHTML = `${escapeHtml(sub.name)} <button data-del style="background: none; border: none; color: #e74c3c; cursor: pointer; padding: 0 4px; font-size: 16px;" title="Delete">×</button>`;
                span.querySelector('[data-del]').addEventListener('click', () => deleteSubcategory(sub.id, sub.name, name));
                subcatContainer.appendChild(span);
            });
        } else {
            subcatContainer.innerHTML = '<span style="color: #95a5a6; font-size: 13px;">No subcategories</span>';
        }

        fragment.appendChild(div);
    });

    container.innerHTML = '';
    container.appendChild(fragment);
}

function populateCategoryDropdowns() {
    const result = db.exec('SELECT id, name FROM categories ORDER BY sort_order, name');
    const options = result.length > 0 
        ? result[0].values.map(row => `<option value="${row[0]}">${escapeHtml(row[1])}</option>`).join('')
        : '<option value="">Other</option>';

    // Update rule form category dropdown
    const ruleSelect = document.getElementById('newRuleCategory');
    if (ruleSelect) {
        ruleSelect.innerHTML = options;
    }
}

function updateRuleSubcategoryOptions() {
    const categoryId = document.getElementById('newRuleCategory').value;
    const select = document.getElementById('newRuleSubcategory');

    select.innerHTML = '<option value="">-- None --</option>';

    if (!categoryId) return;

    const result = db.exec('SELECT id, name FROM subcategories WHERE category_id = ? ORDER BY sort_order, name', [categoryId]);
    if (result.length > 0) {
        result[0].values.forEach(row => {
            const id = row[0];
            const name = row[1];
            select.innerHTML += `<option value="${id}">${escapeHtml(name)}</option>`;
        });
    }
}

function showAddCategoryForm() {
    document.getElementById('addCategoryForm').style.display = 'block';
}

function cancelAddCategory() {
    document.getElementById('addCategoryForm').style.display = 'none';
    document.getElementById('newCategoryName').value = '';
    document.getElementById('newCategoryIcon').value = '';
    document.getElementById('newCategoryColor').value = '#3498db';
}

async function addCategory() {
    const name = document.getElementById('newCategoryName').value.trim();
    const icon = document.getElementById('newCategoryIcon').value.trim();
    const color = document.getElementById('newCategoryColor').value;

    // Validate input
    const validationError = validators.categoryName(name);
    if (validationError) {
        showMessage('error', validationError);
        return;
    }

    showLoading('Creating category...');

    try {
        // Get max sort_order
        const maxOrder = dbHelpers.queryValue('SELECT MAX(sort_order) FROM categories') || 0;

        const result = dbHelpers.safeRun(`
            INSERT INTO categories (name, color, icon, sort_order)
            VALUES (?, ?, ?, ?)
        `, [name, color, icon || '📦', maxOrder + 1], 'Add category');

        if (!result.success) {
            hideLoading();
            return;
        }

        markDirty();
        await loadCategories();
        cancelAddCategory();
        hideLoading();
        showMessage('success', `Category "${name}" created successfully`);
    } catch (e) {
        hideLoading();
        if (e.message.includes('UNIQUE constraint')) {
            showMessage('error', 'A category with this name already exists');
        } else {
            showMessage('error', 'Error creating category: ' + e.message);
        }
    }
}

async function deleteCategory(categoryId, categoryName) {
    if (!confirm(`Delete category "${categoryName}"? This will also delete all its subcategories. Transactions using this category will become uncategorized.`)) return;

    db.run('UPDATE transactions SET category_id = NULL, subcategory_id = NULL WHERE category_id = ?', [categoryId]);
    db.run('DELETE FROM subcategories WHERE category_id = ?', [categoryId]);
    db.run('DELETE FROM categories WHERE id = ?', [categoryId]);
    markDirty();
    await loadCategories();
    showMessage('success', 'Category deleted');
}

function showAddSubcategoryForm(categoryId, categoryName) {
    const formHtml = `
        <div id="addSubcategoryModal" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000;">
            <div style="background: white; padding: 30px; border-radius: 8px; max-width: 400px; width: 90%;">
                <h3 style="margin-top: 0;">Add Subcategory to ${categoryName}</h3>
                <div class="form-group">
                    <label>Subcategory Name</label>
                    <input type="text" id="newSubcategoryName" placeholder="e.g., Fast Casual">
                </div>
                <div style="display: flex; gap: 10px; margin-top: 20px;">
                    <button onclick="addSubcategory(${categoryId})">Create</button>
                    <button class="secondary-btn" onclick="closeSubcategoryModal()">Cancel</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', formHtml);
    document.getElementById('newSubcategoryName').focus();
}

function closeSubcategoryModal() {
    const modal = document.getElementById('addSubcategoryModal');
    if (modal) modal.remove();
}

async function addSubcategory(categoryId) {
    const name = document.getElementById('newSubcategoryName').value.trim();

    const validationError = validators.categoryName(name);
    if (validationError) {
        showMessage('error', validationError);
        return;
    }

    showLoading('Creating subcategory...');

    try {
        // Get max sort_order for this category
        const maxOrder = dbHelpers.queryValue(
            'SELECT MAX(sort_order) FROM subcategories WHERE category_id = ?', 
            [categoryId]
        ) || 0;

        const result = dbHelpers.safeRun(`
            INSERT INTO subcategories (category_id, name, sort_order)
            VALUES (?, ?, ?)
        `, [categoryId, name, maxOrder + 1], 'Add subcategory');

        if (!result.success) {
            hideLoading();
            return;
        }

        markDirty();
        await loadCategories();
        closeSubcategoryModal();
        hideLoading();
        showMessage('success', `Subcategory "${name}" created`);
    } catch (e) {
        hideLoading();
        if (e.message.includes('UNIQUE constraint')) {
            showMessage('error', 'A subcategory with this name already exists in this category');
        } else {
            showMessage('error', 'Error creating subcategory: ' + e.message);
        }
    }
}

async function deleteSubcategory(subcategoryId, subcategoryName, categoryName) {
    if (!confirm(`Delete subcategory "${subcategoryName}" from ${categoryName}? Transactions using this subcategory will become uncategorized.`)) return;

    db.run('UPDATE transactions SET category_id = NULL, subcategory_id = NULL WHERE subcategory_id = ?', [subcategoryId]);
    db.run('DELETE FROM subcategories WHERE id = ?', [subcategoryId]);
    markDirty();
    await loadCategories();
    showMessage('success', 'Subcategory deleted');
}

// ═══════════════════════════════════════════════════════════════════════════
