// ═══════════════════════════════════════════════════════════════════════════
// §12. GOOGLE DRIVE SYNC (optional, user-initiated)
// ═══════════════════════════════════════════════════════════════════════════
//
// Backs up / restores the single exported SQLite blob (db.export()) to a
// visible "bank_statements.db" file inside a "BankConsolidator" folder in the
// user's Google Drive. Uses Google Identity Services (token model) with the
// minimal `drive.file` scope — the app can only see files it created.
//
// CONSTRAINTS (surfaced in the UI):
//  • Google OAuth refuses `file://` origins. Drive sync only works when the app
//    is served over HTTPS (e.g. GitHub Pages) or from http://localhost. The
//    local Download/Import .db buttons remain the offline-first fallback.
//  • The user supplies their own OAuth Client ID (Settings → Backup & Sync).
//    Client IDs are not secret, but the serving origin must be whitelisted in
//    the Google Cloud Console under "Authorized JavaScript origins".

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_FOLDER_NAME = 'BankConsolidator';
const DRIVE_FILE_NAME = 'bank_statements.db';
const DRIVE_MIME = 'application/x-sqlite3';
const GIS_SRC = 'https://accounts.google.com/gsi/client';

// Built-in OAuth Client ID so end users can connect without any Google Cloud
// setup. Client IDs are not secrets; abuse is prevented by the "Authorized
// JavaScript origins" whitelist on the OAuth client. Power users can override
// this with their own ID via the Advanced field in Settings (stored locally).
const DEFAULT_CLIENT_ID = '519641800486-cmfn2q8po3ihqdmov00h77tir2tmq7f8.apps.googleusercontent.com';

// localStorage keys
const DS_CLIENT_ID = 'driveSync_clientId';
const DS_ACCOUNT = 'driveSync_account';
const DS_FOLDER_ID = 'driveSync_folderId';
const DS_FILE_ID = 'driveSync_fileId';
const DS_LAST_SYNCED = 'driveSync_lastSynced';     // local ISO time of last push/pull
const DS_DRIVE_MODIFIED = 'driveSync_driveModified'; // Drive modifiedTime we last saw

// In-memory token state (never persisted)
let _gisLoaded = false;
let _tokenClient = null;
let _accessToken = null;
let _tokenExpiry = 0;
let _pendingResolve = null;
let _pendingReject = null;

function driveIsFileProtocol() {
    return location.protocol === 'file:';
}

// The user's own override, if they set one (Advanced field).
function driveStoredClientId() {
    return (localStorage.getItem(DS_CLIENT_ID) || '').trim();
}

// Effective Client ID: user override if present, otherwise the built-in default.
function driveClientId() {
    return driveStoredClientId() || DEFAULT_CLIENT_ID;
}

function driveIsConnected() {
    return !!localStorage.getItem(DS_ACCOUNT);
}

// ── GIS / token plumbing ───────────────────────────────────────────────────

function driveLoadGis() {
    return new Promise((resolve, reject) => {
        if (_gisLoaded && window.google && google.accounts && google.accounts.oauth2) {
            return resolve();
        }
        let s = document.getElementById('gis-script');
        if (s) {
            s.addEventListener('load', () => { _gisLoaded = true; resolve(); });
            s.addEventListener('error', () => reject(new Error('Failed to load Google sign-in library')));
            return;
        }
        s = document.createElement('script');
        s.id = 'gis-script';
        s.src = GIS_SRC;
        s.async = true;
        s.defer = true;
        s.onload = () => { _gisLoaded = true; resolve(); };
        s.onerror = () => reject(new Error('Failed to load Google sign-in library (check your connection)'));
        document.head.appendChild(s);
    });
}

// Resolves with a valid access token, requesting one via GIS when needed.
// `interactive` controls whether a consent popup may be shown.
async function driveEnsureToken(interactive) {
    if (_accessToken && Date.now() < _tokenExpiry - 60000) return _accessToken;

    const cid = driveClientId();
    if (!cid) throw new Error('Enter your Google OAuth Client ID first.');

    await driveLoadGis();

    if (!_tokenClient || _tokenClient._cid !== cid) {
        _tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: cid,
            scope: DRIVE_SCOPE,
            callback: (resp) => {
                if (resp && resp.error) {
                    if (_pendingReject) _pendingReject(new Error(resp.error_description || resp.error));
                } else {
                    _accessToken = resp.access_token;
                    _tokenExpiry = Date.now() + (parseInt(resp.expires_in, 10) || 3600) * 1000;
                    if (_pendingResolve) _pendingResolve(_accessToken);
                }
                _pendingResolve = _pendingReject = null;
            },
            error_callback: (err) => {
                if (_pendingReject) _pendingReject(new Error((err && err.message) || 'Google authorization was cancelled.'));
                _pendingResolve = _pendingReject = null;
            },
        });
        _tokenClient._cid = cid;
    }

    return new Promise((resolve, reject) => {
        _pendingResolve = resolve;
        _pendingReject = reject;
        try {
            _tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
        } catch (e) {
            _pendingResolve = _pendingReject = null;
            reject(e);
        }
    });
}

async function driveFetch(url, opts = {}) {
    const token = await driveEnsureToken(false);
    const headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + token });
    const resp = await fetch(url, Object.assign({}, opts, { headers }));
    if (!resp.ok) {
        let detail = '';
        try { detail = (await resp.json()).error.message; } catch (e) { /* ignore */ }
        throw new Error(`Drive API ${resp.status}${detail ? ': ' + detail : ''}`);
    }
    return resp;
}

// ── Drive file/folder resolution ───────────────────────────────────────────

async function driveFindFolder() {
    const q = encodeURIComponent(
        `name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
    );
    const resp = await driveFetch(
        `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`
    );
    const { files } = await resp.json();
    return files && files.length ? files[0].id : null;
}

async function driveEnsureFolder() {
    let id = localStorage.getItem(DS_FOLDER_ID);
    if (id) return id;
    id = await driveFindFolder();
    if (!id) {
        const resp = await driveFetch('https://www.googleapis.com/drive/v3/files?fields=id', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: DRIVE_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
        });
        id = (await resp.json()).id;
    }
    localStorage.setItem(DS_FOLDER_ID, id);
    return id;
}

async function driveFindFile(folderId) {
    const q = encodeURIComponent(
        `name='${DRIVE_FILE_NAME}' and '${folderId}' in parents and trashed=false`
    );
    const resp = await driveFetch(
        `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name,modifiedTime)`
    );
    const { files } = await resp.json();
    return files && files.length ? files[0] : null;
}

// Resolve the backup file's metadata { id, modifiedTime }, or null if none yet.
async function driveResolveFile() {
    const folderId = await driveEnsureFolder();
    const fileId = localStorage.getItem(DS_FILE_ID);
    if (fileId) {
        try {
            const resp = await driveFetch(
                `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,modifiedTime,trashed`
            );
            const meta = await resp.json();
            if (!meta.trashed) return meta;
        } catch (e) { /* stale id — fall through to search */ }
    }
    const found = await driveFindFile(folderId);
    if (found) localStorage.setItem(DS_FILE_ID, found.id);
    return found;
}

// ── Public actions ─────────────────────────────────────────────────────────

async function driveConnect() {
    if (driveIsFileProtocol()) return;
    // Optional Advanced override — only persist it if the user typed one.
    const input = document.getElementById('driveClientId');
    if (input) {
        const val = input.value.trim();
        if (val) localStorage.setItem(DS_CLIENT_ID, val);
        else localStorage.removeItem(DS_CLIENT_ID);
    }
    if (!driveClientId()) { showMessage('error', 'No Google OAuth Client ID configured.'); return; }

    try {
        await driveEnsureToken(true); // interactive consent
        const resp = await driveFetch(
            'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)'
        );
        const { user } = await resp.json();
        localStorage.setItem(DS_ACCOUNT, (user && user.emailAddress) || (user && user.displayName) || 'Google account');
        showMessage('success', 'Connected to Google Drive.');
        driveRenderState();
        driveCheckConflict();
    } catch (e) {
        showMessage('error', 'Could not connect to Google Drive: ' + e.message);
    }
}

function driveDisconnect() {
    if (_accessToken && window.google && google.accounts && google.accounts.oauth2) {
        try { google.accounts.oauth2.revoke(_accessToken, () => {}); } catch (e) { /* ignore */ }
    }
    _accessToken = null;
    _tokenExpiry = 0;
    localStorage.removeItem(DS_ACCOUNT);
    // Keep client ID + file/folder ids so reconnecting reuses the same backup.
    showMessage('success', 'Disconnected from Google Drive (local data untouched).');
    driveRenderState();
}

async function driveBackup() {
    try {
        const folderId = await driveEnsureFolder();
        const existing = await driveResolveFile();
        const bytes = db.export();
        const blobBytes = new Blob([bytes], { type: DRIVE_MIME });

        let resp;
        if (existing) {
            resp = await driveFetch(
                `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media&fields=id,modifiedTime`,
                { method: 'PATCH', headers: { 'Content-Type': DRIVE_MIME }, body: blobBytes }
            );
        } else {
            const boundary = '-------bcsync' + Date.now();
            const metadata = { name: DRIVE_FILE_NAME, parents: [folderId], mimeType: DRIVE_MIME };
            const body = new Blob([
                `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
                JSON.stringify(metadata),
                `\r\n--${boundary}\r\nContent-Type: ${DRIVE_MIME}\r\n\r\n`,
                blobBytes,
                `\r\n--${boundary}--`,
            ]);
            resp = await driveFetch(
                'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime',
                { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body }
            );
        }
        const meta = await resp.json();
        localStorage.setItem(DS_FILE_ID, meta.id);
        localStorage.setItem(DS_DRIVE_MODIFIED, meta.modifiedTime || '');
        localStorage.setItem(DS_LAST_SYNCED, new Date().toISOString());
        showMessage('success', 'Database backed up to Google Drive.');
        driveRenderState();
    } catch (e) {
        showMessage('error', 'Backup to Drive failed: ' + e.message);
    }
}

async function driveRestore() {
    try {
        const file = await driveResolveFile();
        if (!file) { showMessage('error', 'No backup found in Google Drive yet — back up first.'); return; }
        if (!confirm('Restore from Google Drive?\n\nThis REPLACES the database currently on this device with the Drive copy. Download a local backup first if unsure.')) {
            return;
        }
        const resp = await driveFetch(
            `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`
        );
        const buf = await resp.arrayBuffer();
        db = new SQL.Database(new Uint8Array(buf));
        await saveDatabaseToIndexedDB();

        // Mirror handleDatabaseImport's full reload.
        await loadBankProfiles();
        await loadCategories();
        await loadRules();
        await loadTransactions();
        refreshFilters();
        await loadImportHistory();
        await updateAnalytics();
        await loadBudget();
        await loadPlanner();

        localStorage.setItem(DS_DRIVE_MODIFIED, file.modifiedTime || '');
        localStorage.setItem(DS_LAST_SYNCED, new Date().toISOString());
        showMessage('success', 'Database restored from Google Drive.');
        driveRenderState();
    } catch (e) {
        showMessage('error', 'Restore from Drive failed: ' + e.message);
    }
}

// Best-effort: warn when the Drive copy changed since we last synced (i.e. it
// was edited from another device). Silent on any failure — never prompts.
async function driveCheckConflict() {
    const line = document.getElementById('driveConflictLine');
    if (!line || !driveIsConnected()) return;
    try {
        const file = await driveResolveFile();
        const lastSeen = localStorage.getItem(DS_DRIVE_MODIFIED) || '';
        if (file && lastSeen && file.modifiedTime && file.modifiedTime !== lastSeen) {
            const when = new Date(file.modifiedTime).toLocaleString();
            line.textContent = `⚠️ The Drive copy changed elsewhere (edited ${when}). Restore to pull it in, or back up to overwrite it.`;
            line.style.display = '';
        } else {
            line.style.display = 'none';
        }
    } catch (e) {
        line.style.display = 'none';
    }
}

// ── Rendering ──────────────────────────────────────────────────────────────

function driveRenderState() {
    const fileHint = document.getElementById('driveFileOnlyHint');
    const setup = document.getElementById('driveSetup');
    const disconnected = document.getElementById('driveDisconnected');
    const connected = document.getElementById('driveConnected');
    if (!fileHint || !setup || !disconnected || !connected) return;

    if (driveIsFileProtocol()) {
        setup.style.display = 'none';
        disconnected.style.display = 'none';
        connected.style.display = 'none';
        fileHint.textContent = '☁️ Google Drive sync needs the app served over HTTPS (e.g. GitHub Pages) or http://localhost — it cannot run from a file:// page. Use the local file backup below instead.';
        fileHint.style.display = '';
        return;
    }
    fileHint.style.display = 'none';

    // Only reflect the user's own override here — never the built-in default.
    const cidInput = document.getElementById('driveClientId');
    if (cidInput && !cidInput.value) cidInput.value = driveStoredClientId();

    if (driveIsConnected()) {
        setup.style.display = 'none';
        disconnected.style.display = 'none';
        connected.style.display = '';
        const acct = localStorage.getItem(DS_ACCOUNT) || '';
        const last = localStorage.getItem(DS_LAST_SYNCED);
        const lastTxt = last ? `Last synced ${new Date(last).toLocaleString()}` : 'Not synced yet';
        document.getElementById('driveAccountLine').innerHTML =
            `✓ Connected as <strong>${escapeHtml(acct)}</strong> · ${escapeHtml(lastTxt)}`;
    } else {
        setup.style.display = '';
        disconnected.style.display = '';
        connected.style.display = 'none';
    }
}

function driveSyncInit() {
    driveRenderState();
    // Best-effort silent conflict check if we appear connected.
    if (!driveIsFileProtocol() && driveIsConnected()) {
        driveCheckConflict();
    }
}
