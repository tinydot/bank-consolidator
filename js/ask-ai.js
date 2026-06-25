// ═══════════════════════════════════════════════════════════════════════════
// §13. ASK AI (optional, user-initiated)
// ═══════════════════════════════════════════════════════════════════════════
//
// A chat panel that answers free-text questions about your finances
// ("can I afford this $400 desktop speaker?", "what's my coffee habit costing
// me?") by letting Claude query your local SQLite database directly.
//
// HOW IT WORKS (the in-browser equivalent of an MCP server):
//  • Claude is given a single tool, `run_sql`, plus your live DB schema.
//  • It decides what to SELECT (balances, budget headroom, spending habits…),
//    we run the query locally via dbHelpers, and feed the rows back.
//  • It loops until it has enough to answer, then writes a plain-English reply.
//
// CONSTRAINTS (same spirit as Drive sync — optional, BYO-credential):
//  • READ-ONLY: the tool refuses anything that isn't a single SELECT/WITH
//    query, and every query runs inside a SAVEPOINT that is always rolled
//    back, so the AI can never mutate your data.
//  • You supply your own Anthropic API key (Settings → Ask AI). It is stored
//    only in this browser's localStorage and sent only to api.anthropic.com.
//  • Your transaction rows are sent to Anthropic's API to answer questions.
//    This is the one place data leaves the device, and it only happens when
//    you press Send. If that's not acceptable, don't configure a key — the
//    rest of the app stays fully offline.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// localStorage keys
const AI_KEY = 'askAi_apiKey';
const AI_MODEL = 'askAi_model';
const AI_CONTEXT = 'askAi_context';   // free-text "about me" injected into the system prompt

const AI_DEFAULT_MODEL = 'claude-opus-4-8';
const AI_MAX_TOOL_ROUNDS = 8;   // safety cap on the agentic query loop
const AI_MAX_ROWS = 500;        // truncate tool results so we don't blow context

// Conversation so follow-up questions ("…and the habit?") keep context. This
// is the live Anthropic message array; it is mirrored into the `ask_ai_messages`
// table (see askAiPersistHistory) so the history survives a reload and travels
// inside the exported DB blob — i.e. it is part of both the local .db
// download/import and the Google Drive backup/restore. The user can wipe it with
// the Clear button (askAiClear).
let askAiMessages = [];
let askAiBusy = false;

// ── Credential / settings plumbing ──────────────────────────────────────────

function askAiStoredKey() {
    return (localStorage.getItem(AI_KEY) || '').trim();
}

function askAiModel() {
    return localStorage.getItem(AI_MODEL) || AI_DEFAULT_MODEL;
}

// User-supplied situational context ("I'm in Singapore, hawker meals under $6
// are normal…"). Reframes answers so they fit the user's life instead of
// generic personal-finance defaults. Stored only in this browser.
function askAiStoredContext() {
    return (localStorage.getItem(AI_CONTEXT) || '').trim();
}

function askAiSaveContext() {
    const ta = document.getElementById('askAiContext');
    if (!ta) return;
    const val = ta.value.trim();
    if (val) localStorage.setItem(AI_CONTEXT, val);
    else localStorage.removeItem(AI_CONTEXT);
    showMessage('success', val ? 'Context saved — Claude will use it.' : 'Context cleared.');
    askAiRenderState();
}

function askAiClearContext() {
    localStorage.removeItem(AI_CONTEXT);
    const ta = document.getElementById('askAiContext');
    if (ta) ta.value = '';
    showMessage('success', 'Context cleared.');
    askAiRenderState();
}

function askAiIsConfigured() {
    return !!askAiStoredKey();
}

function askAiSaveSettings() {
    const keyInput = document.getElementById('askAiApiKey');
    const modelSel = document.getElementById('askAiModelSelect');
    if (keyInput) {
        const val = keyInput.value.trim();
        if (val) localStorage.setItem(AI_KEY, val);
        else localStorage.removeItem(AI_KEY);
        keyInput.value = '';   // don't leave the secret sitting in the field
    }
    if (modelSel) localStorage.setItem(AI_MODEL, modelSel.value);
    showMessage('success', askAiIsConfigured() ? 'Ask AI is ready.' : 'API key cleared.');
    askAiRenderState();
}

function askAiForget() {
    localStorage.removeItem(AI_KEY);
    showMessage('success', 'Anthropic API key removed from this browser.');
    askAiRenderState();
}

// ── Read-only query tool (the "MCP server" half) ────────────────────────────

// Only a single SELECT/WITH statement is allowed. Combined with the rollback
// below, this guarantees the AI cannot write to the database.
function askAiIsReadOnly(sql) {
    const s = String(sql || '').trim().replace(/;+\s*$/, '');   // drop trailing ;
    if (!s) return false;
    if (s.includes(';')) return false;                          // no multi-statement
    if (!/^(select|with)\b/i.test(s)) return false;             // must start read-only
    // Reject write verbs (REPLACE() the string function is allowed; REPLACE INTO is not).
    if (/\b(insert|update|delete|drop|alter|create|attach|detach|vacuum|reindex|truncate)\b/i.test(s)) return false;
    if (/\breplace\s+into\b/i.test(s)) return false;
    return true;
}

// Runs a validated SELECT and returns { columns, rows, truncated } or { error }.
// Executes inside a SAVEPOINT that is always rolled back, so even a query that
// slips past askAiIsReadOnly can never persist a change.
function askAiRunQuery(sql) {
    if (!askAiIsReadOnly(sql)) {
        return { error: 'Rejected: only a single read-only SELECT/WITH query is allowed.' };
    }
    let opened = false;
    try {
        db.run('SAVEPOINT askai_ro');
        opened = true;
        const result = db.exec(sql);
        if (!result.length) return { columns: [], rows: [], truncated: false };
        const { columns, values } = result[0];
        const truncated = values.length > AI_MAX_ROWS;
        const rows = (truncated ? values.slice(0, AI_MAX_ROWS) : values)
            .map(r => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
        return { columns, rows, truncated };
    } catch (e) {
        return { error: String(e && e.message ? e.message : e) };
    } finally {
        if (opened) {
            try { db.run('ROLLBACK TO askai_ro'); } catch (e) { /* ignore */ }
            try { db.run('RELEASE askai_ro'); } catch (e) { /* ignore */ }
        }
    }
}

// ── Privacy gate: confirm before row-level data leaves the device ───────────

// Columns whose contents are free-text / identifying rather than aggregates.
function askAiHasSensitiveColumn(columns) {
    return (columns || []).some(c =>
        /desc|note|memo|merchant|payee|narrat|remark|reference|account_number/i.test(c));
}

// A result is auto-sent only when it's a genuine summary: a single row with no
// free-text columns (the classic SELECT SUM(...)/COUNT(...) shape). Anything
// that ships multiple rows, or any raw text column, asks the user first.
function askAiNeedsConfirmation(out) {
    const n = out.rows ? out.rows.length : 0;
    if (n === 0) return false;                              // nothing to share
    if (askAiHasSensitiveColumn(out.columns)) return true;  // raw text leaving
    return n > 1;                                            // >1 raw row = not an aggregate
}

function askAiConfirmText(sql, out) {
    const n = out.rows.length;
    const more = out.truncated ? ` (capped at ${AI_MAX_ROWS})` : '';
    return [
        'Send this data to Anthropic?',
        '',
        'To answer your question, Claude wants to read row-level data from your',
        'database — not just a total. Approve sending it to api.anthropic.com?',
        '',
        `Rows: ${n}${more}`,
        `Columns: ${(out.columns || []).join(', ')}`,
        '',
        'Query:',
        sql,
        '',
        'OK = send these rows.   Cancel = keep them on this device.'
    ].join('\n');
}

const ASK_AI_TOOL = {
    name: 'run_sql',
    description:
        'Run a single READ-ONLY SQL query (SELECT or WITH … SELECT) against the ' +
        "user's local SQLite finance database and get the resulting rows back as " +
        'JSON. Use this to look up balances, spending, budgets and commitments. ' +
        'Writes are rejected. Prefer several small focused queries over one huge one.',
    input_schema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'A single SQLite SELECT statement.' }
        },
        required: ['query']
    }
};

// ── System prompt (live schema + money/semantics cheatsheet) ────────────────

function askAiSchemaDump() {
    const rows = dbHelpers.queryAll(
        "SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL ORDER BY name"
    );
    return rows.map(r => r[0]).join('\n\n');
}

function askAiSystemPrompt() {
    const today = new Date().toISOString().slice(0, 10);
    const userContext = askAiStoredContext();
    return [
        'You are a personal-finance assistant embedded in the user\'s "Bank Statement',
        'Consolidator" app. You answer questions about THEIR finances by querying their',
        'local SQLite database with the run_sql tool. Be concrete and show the numbers',
        'behind your reasoning. When asked "can I afford X", check liquid balances and',
        'remaining budget headroom for the relevant category this month, and consider',
        'upcoming committed expenses — then give a clear yes/no/maybe with the figures.',
        '',
        `Today is ${today}.`,
        '',
        // User-provided situational context. Treat as authoritative about the
        // user's circumstances and norms so advice fits their life rather than
        // generic defaults. Only included when the user has filled it in.
        ...(userContext ? [
            'USER-PROVIDED CONTEXT (authoritative about the user\'s situation, local',
            'norms and goals — weigh advice against it, do not override it with generic',
            'personal-finance assumptions):',
            userContext,
            '',
        ] : []),
        'Before labelling spending as wasteful or a "bad habit", consider local cost',
        'norms and the user\'s stated context above. If their intent or what counts as',
        'reasonable for them is unclear, ask a brief clarifying question rather than',
        'assuming. Do not apply one-size-fits-all advice (e.g. "meal-prep instead of',
        'eating out") when local norms or the user\'s context make it inappropriate.',
        '',
        'CRITICAL DATA SEMANTICS:',
        '- ALL money columns are stored as INTEGER CENTS. Divide by 100 to get dollars',
        '  (e.g. amount = -1299 means -$12.99). Always present dollars to the user.',
        '- transactions.amount: negative = money out (spending), positive = money in',
        '  (income). transactions.date is TEXT "YYYY-MM-DD".',
        '- Exclude transactions where ignored = 1 unless the user asks otherwise.',
        '- Join transactions → imports → accounts → banks for account/bank context,',
        '  and transactions.category_id → categories for spending categories.',
        '- bank_balances holds point-in-time balances per account_id; the latest row',
        '  per account (max as_of_date) is the current balance. account_purpose.bucket',
        '  is liquid|investment|locked and emergency=1 means it counts toward the',
        '  emergency fund. "Can I afford" should lean on liquid balances.',
        '- budget.monthly_limit is the per-category monthly cap (cents).',
        '  expense_commitments are recurring/lumpy future costs (cents).',
        '',
        'PREFER AGGREGATE QUERIES (SUM/COUNT/AVG, returning a single summary row)',
        'over selecting raw rows. Row-level queries (multiple rows, or columns like',
        'description/note/account_number) require the user to approve sharing the',
        'data each time, so only request raw rows when a total genuinely cannot',
        'answer the question. If the user declines to share rows, fall back to an',
        'aggregate query or answer with what you already have.',
        '',
        'Query as many times as you need, then answer in plain English with short',
        'figures. Keep answers tight — a few sentences, not an essay. If the database',
        'lacks the data to answer, say so plainly.',
        '',
        'DATABASE SCHEMA:',
        askAiSchemaDump()
    ].join('\n');
}

// ── Anthropic API call + agentic tool loop ──────────────────────────────────

async function askAiCallApi(messages) {
    const resp = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-key': askAiStoredKey(),
            'anthropic-version': ANTHROPIC_VERSION,
            // Required to call the API directly from a browser page.
            'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
            model: askAiModel(),
            max_tokens: 2048,
            system: askAiSystemPrompt(),
            tools: [ASK_AI_TOOL],
            messages
        })
    });
    if (!resp.ok) {
        let detail = '';
        try { detail = (await resp.json()).error.message; } catch (e) { /* ignore */ }
        throw new Error(`Anthropic API ${resp.status}${detail ? ': ' + detail : ''}`);
    }
    return resp.json();
}

async function askAiSend() {
    if (askAiBusy) return;
    if (!askAiIsConfigured()) {
        showMessage('error', 'Add your Anthropic API key first (the setup box above).');
        return;
    }
    const input = document.getElementById('askAiInput');
    const question = (input.value || '').trim();
    if (!question) return;
    input.value = '';

    askAiMessages.push({ role: 'user', content: question });
    askAiAppendBubble('user', question);

    askAiBusy = true;
    askAiSetBusy(true);
    const thinking = askAiAppendBubble('assistant', '…thinking');

    try {
        for (let round = 0; round < AI_MAX_TOOL_ROUNDS; round++) {
            const data = await askAiCallApi(askAiMessages);
            askAiMessages.push({ role: 'assistant', content: data.content });

            // Surface any text the model produced this turn.
            const text = (data.content || [])
                .filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
            const toolUses = (data.content || []).filter(b => b.type === 'tool_use');

            if (data.stop_reason === 'tool_use' && toolUses.length) {
                if (text) askAiSetBubble(thinking, text + '\n\n…checking your data');
                else askAiSetBubble(thinking, '…checking your data');

                const toolResults = toolUses.map(askAiExecuteToolUse);
                askAiMessages.push({ role: 'user', content: toolResults });
                continue;   // let the model read the rows and continue
            }

            // Final answer.
            askAiSetBubble(thinking, text || '(no answer)');
            return;
        }
        askAiSetBubble(thinking, 'Stopped after too many lookups — try a narrower question.');
    } catch (e) {
        askAiSetBubble(thinking, '⚠️ ' + e.message);
    } finally {
        askAiBusy = false;
        askAiSetBusy(false);
        askAiPersistHistory();   // mirror the updated conversation into the DB
    }
}

// Runs one tool call locally and returns the tool_result block. Row-level
// results pass through the privacy gate: nothing has left the device yet (the
// query ran in a rolled-back savepoint), so a denial keeps the rows local.
function askAiExecuteToolUse(tu) {
    const sql = tu.input && tu.input.query;
    askAiAppendQueryTrace(sql);
    const out = askAiRunQuery(sql);

    if (!out.error && askAiNeedsConfirmation(out)) {
        if (!confirm(askAiConfirmText(sql, out))) {
            askAiAppendNote(`🚫 You declined to share ${out.rows.length} row(s) for that query.`);
            return {
                type: 'tool_result',
                tool_use_id: tu.id,
                content: JSON.stringify({
                    error: 'The user declined to share these rows. Do not retry the same ' +
                        'query — use an aggregate query (SUM/COUNT/AVG) instead, or answer ' +
                        'with the data you already have.'
                }),
                is_error: true
            };
        }
    }
    return {
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(out),
        is_error: !!out.error
    };
}

// Delete the conversation — both in memory and the persisted copy. Because the
// history lives in the DB, this is a real deletion, so confirm first (unless
// there is nothing saved yet).
function askAiClear() {
    const hadHistory = askAiMessages.length > 0;
    if (hadHistory && !confirm('Delete this Ask AI conversation? This permanently removes the saved chat history from your database (and from future backups). This cannot be undone.')) {
        return;
    }
    askAiMessages = [];
    const log = document.getElementById('askAiTranscript');
    if (log) log.innerHTML = '';
    if (typeof db !== 'undefined' && db) {
        dbHelpers.safeRun('DELETE FROM ask_ai_messages', [], 'Clear Ask AI history');
        if (typeof markDirty === 'function') markDirty();
    }
}

// ── History persistence (rides inside the exported DB blob) ──────────────────

// Build a privacy-preserving copy of the conversation for storage: only the
// user's questions and the assistant's plain-text answers. The SQL (tool_use)
// and the fetched rows (tool_result) blocks are DROPPED so no row-level data is
// ever written to the DB or its backups. Same-role runs are merged into one
// message, which keeps roles strictly alternating — so the saved transcript is
// also a valid conversation to resend to the API after a reload.
function askAiSanitizedHistory() {
    const out = [];
    for (const m of askAiMessages) {
        let text;
        if (m.role === 'user') {
            // String content is a question; array content is tool_result rows → drop.
            text = typeof m.content === 'string' ? m.content.trim() : '';
        } else if (m.role === 'assistant') {
            text = Array.isArray(m.content)
                ? m.content.filter(b => b && b.type === 'text').map(b => b.text).join('\n').trim()
                : (typeof m.content === 'string' ? m.content.trim() : '');
        } else {
            continue;
        }
        if (!text) continue;   // pure tool turn — nothing user-facing to keep
        const last = out[out.length - 1];
        if (last && last.role === m.role) last.content += '\n\n' + text;
        else out.push({ role: m.role, content: text });
    }
    return out;
}

// Mirror the (sanitized) conversation into the ask_ai_messages table. Rewrites
// the whole table each time (conversations are short) and marks the DB dirty so
// the debounced IndexedDB flush picks it up. Called after every completed turn.
function askAiPersistHistory() {
    if (typeof db === 'undefined' || !db) return;
    if (dbHelpers.safeRun('DELETE FROM ask_ai_messages', [], 'Save Ask AI history').success === false) return;
    for (const m of askAiSanitizedHistory()) {
        dbHelpers.safeRun(
            'INSERT INTO ask_ai_messages (role, content) VALUES (?, ?)',
            [m.role, m.content],
            'Save Ask AI history'
        );
    }
    if (typeof markDirty === 'function') markDirty();
}

// Load the persisted conversation into memory and re-render the transcript.
// Called on startup and after a DB import / Drive restore so the chat reflects
// whatever database is now loaded. Rows hold plain question/answer text (see
// askAiSanitizedHistory), so each becomes a simple { role, content } message.
function askAiLoadHistory() {
    askAiMessages = [];
    if (typeof db === 'undefined' || !db) return;
    let rows = [];
    try {
        rows = dbHelpers.queryAll('SELECT role, content FROM ask_ai_messages ORDER BY id');
    } catch (e) { /* table absent on a very old DB — setupSchema creates it */ }
    for (const r of rows) {
        if (r[0] && typeof r[1] === 'string') askAiMessages.push({ role: r[0], content: r[1] });
    }
    askAiRenderHistory();
}

// Rebuild the on-screen transcript from askAiMessages. The persisted messages
// are plain { role, content:string }, so this just lays out the bubbles. (Live
// turns are rendered incrementally by askAiSend; the SQL query traces shown live
// are intentionally not reconstructed here, since they aren't persisted.)
function askAiRenderHistory() {
    const log = document.getElementById('askAiTranscript');
    if (!log) return;
    log.innerHTML = '';
    for (const m of askAiMessages) {
        const text = typeof m.content === 'string'
            ? m.content
            : (Array.isArray(m.content)
                ? m.content.filter(b => b && b.type === 'text').map(b => b.text).join('\n').trim()
                : '');
        if (text) askAiAppendBubble(m.role === 'assistant' ? 'assistant' : 'user', text);
    }
}

// ── Rendering ───────────────────────────────────────────────────────────────

function askAiAppendBubble(role, text) {
    const log = document.getElementById('askAiTranscript');
    const div = document.createElement('div');
    div.className = 'ai-bubble ai-' + role;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
}

function askAiSetBubble(div, text) {
    if (!div) return;
    div.textContent = text;
    const log = document.getElementById('askAiTranscript');
    if (log) log.scrollTop = log.scrollHeight;
}

function askAiAppendQueryTrace(sql) {
    const log = document.getElementById('askAiTranscript');
    if (!log || !sql) return;
    const det = document.createElement('details');
    det.className = 'ai-query';
    const sum = document.createElement('summary');
    sum.textContent = '🔎 ran a query';
    const pre = document.createElement('pre');
    pre.textContent = sql;
    det.appendChild(sum);
    det.appendChild(pre);
    log.appendChild(det);
    log.scrollTop = log.scrollHeight;
}

function askAiAppendNote(text) {
    const log = document.getElementById('askAiTranscript');
    if (!log) return;
    const div = document.createElement('div');
    div.className = 'ai-note';
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
}

function askAiSetBusy(busy) {
    const btn = document.getElementById('askAiSendBtn');
    const input = document.getElementById('askAiInput');
    if (btn) { btn.disabled = busy; btn.textContent = busy ? 'Thinking…' : 'Ask'; }
    if (input) input.disabled = busy;
}

function askAiHandleKey(e) {
    // Enter to send, Shift+Enter for a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        askAiSend();
    }
}

function askAiRenderState() {
    const setup = document.getElementById('askAiSetup');
    const chat = document.getElementById('askAiChat');
    const status = document.getElementById('askAiStatus');
    const modelSel = document.getElementById('askAiModelSelect');
    if (!setup || !chat) return;

    if (modelSel) modelSel.value = askAiModel();

    // Keep the context box populated so the user can review/amend what Claude sees.
    const ctxTa = document.getElementById('askAiContext');
    if (ctxTa && document.activeElement !== ctxTa) ctxTa.value = askAiStoredContext();

    if (askAiIsConfigured()) {
        chat.style.display = '';
        if (status) {
            const modelLabel = askAiModel() === 'claude-opus-4-8' ? 'Opus 4.8' : askAiModel();
            status.innerHTML = `✓ Key saved in this browser · model <strong>${escapeHtml(modelLabel)}</strong>`;
        }
    } else {
        chat.style.display = 'none';
        if (status) status.textContent = 'Not configured yet — add a key below.';
    }
}
