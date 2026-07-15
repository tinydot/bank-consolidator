// §6. UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────
// §6.1. Date & Hash Functions
// ─────────────────────────────────────────────────────────────────────────

function normalizeDate(dateStr, format) {
    if (!dateStr) return null;
    const s = dateStr.trim();

    const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };

    // Parse according to explicit format
    if (format && format !== 'auto') {

        // DD-Mon-YY or DD-Mon-YYYY (e.g. 16-Feb-26 or 16-Feb-2026)
        if (format === 'DD-Mon-YY' || format === 'DD-Mon-YYYY') {
            const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
            if (!m) return null;
            const day   = parseInt(m[1], 10);
            const month = MONTHS[m[2].toLowerCase()];
            let   year  = parseInt(m[3], 10);
            if (!month || day < 1 || day > 31) return null;
            if (year < 100) year = year < 50 ? 2000 + year : 1900 + year;
            return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        }

        let day, month, year;
        const sep = format.includes('/') ? '/' : '-';
        const parts = s.split(sep);
        if (parts.length !== 3) return null;

        const fmt = format.split(sep);
        fmt.forEach((token, i) => {
            const val = parseInt(parts[i], 10);
            if (token === 'DD')   day   = val;
            else if (token === 'MM')   month = val;
            else if (token === 'YYYY') year  = val;
            else if (token === 'YY')   year  = val < 50 ? 2000 + val : 1900 + val;
        });

        // Range-check so a wrong format pick (e.g. MM/DD on DD/MM data) surfaces
        // as a parse error instead of storing a garbage date like "2025-31-01".
        if (!day || !month || !year) return null;
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        const mm = String(month).padStart(2, '0');
        const dd = String(day).padStart(2, '0');
        return `${year}-${mm}-${dd}`;
    }

    // Trailing time / extra text tolerance: many bank exports append a
    // timestamp (e.g. "27/04/2026 10:30:00") or a status word. Strip
    // anything after the first whitespace before running numeric matchers.
    const dateOnly = s.split(/\s+/)[0];

    // Auto-detect: try ISO YYYY-MM-DD first (safe, no timezone shift)
    const isoMatch = dateOnly.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

    // Auto-detect: DD-Mon-YY / DD-Mon-YYYY (e.g. 16-Feb-26)
    const monMatch = dateOnly.match(/^(\d{1,2})-([A-Za-z]{3,})-(\d{2,4})$/);
    if (monMatch) {
        const day   = parseInt(monMatch[1], 10);
        const month = MONTHS[monMatch[2].slice(0, 3).toLowerCase()];
        let   year  = parseInt(monMatch[3], 10);
        if (month) {
            if (year < 100) year = year < 50 ? 2000 + year : 1900 + year;
            return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        }
    }

    // Auto-detect: numeric formats with `/`, `-`, or `.` separators.
    // Handles DD/MM/YYYY, MM/DD/YYYY, DD-MM-YYYY, MM-DD-YYYY, plus 2-digit
    // year variants and YYYY/MM/DD. Locale-independent: we never call
    // `new Date(s)`, which would interpret "01/02/2025" differently per
    // browser locale. For truly ambiguous cases (both parts ≤ 12) we default
    // to DD/MM/YYYY (the international convention). Users with a US-style
    // bank can pin MM/DD/YYYY on the bank profile.
    const numMatch = dateOnly.match(/^(\d{1,4})([/.\-])(\d{1,2})\2(\d{1,4})$/);
    if (numMatch) {
        const a = parseInt(numMatch[1], 10);
        const b = parseInt(numMatch[3], 10);
        const c = parseInt(numMatch[4], 10);
        let day, month, year;

        if (numMatch[1].length === 4) {
            // YYYY-MM-DD style with non-hyphen separator (e.g. 2025/01/31)
            year = a;
            month = b;
            day = c;
        } else {
            year = numMatch[4].length <= 2 && c < 100
                ? (c < 50 ? 2000 + c : 1900 + c)
                : c;
            if (a > 12 && b <= 12) {
                day = a; month = b;          // unambiguous DD/MM
            } else if (b > 12 && a <= 12) {
                day = b; month = a;          // unambiguous MM/DD
            } else if (a <= 12 && b <= 12) {
                day = a; month = b;          // ambiguous → default DD/MM
            } else {
                return null;
            }
        }
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    }

    // Space-separated word-month forms. Use the un-trimmed `s` here because
    // these intentionally contain a space. Three shapes:
    //   "DD Mon YYYY"    e.g. 27 Apr 2026 / 27 April 2026 / 27 Apr 26
    //   "Mon DD YYYY"    e.g. Apr 27 2026 / April 27 2026
    //   "Mon DD, YYYY"   e.g. Apr 27, 2026 / April 27, 2026
    const dmyWord = s.match(/^(\d{1,2})[\s/-]+([A-Za-z]{3,})[\s/-]+(\d{2,4})$/);
    if (dmyWord) {
        const day   = parseInt(dmyWord[1], 10);
        const month = MONTHS[dmyWord[2].slice(0, 3).toLowerCase()];
        let   year  = parseInt(dmyWord[3], 10);
        if (month) {
            if (year < 100) year = year < 50 ? 2000 + year : 1900 + year;
            if (day >= 1 && day <= 31) {
                return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
            }
        }
    }
    const mdyWord = s.match(/^([A-Za-z]{3,})[\s/-]+(\d{1,2}),?[\s/-]+(\d{2,4})$/);
    if (mdyWord) {
        const month = MONTHS[mdyWord[1].slice(0, 3).toLowerCase()];
        const day   = parseInt(mdyWord[2], 10);
        let   year  = parseInt(mdyWord[3], 10);
        if (month) {
            if (year < 100) year = year < 50 ? 2000 + year : 1900 + year;
            if (day >= 1 && day <= 31) {
                return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
            }
        }
    }

    // Unrecognised format. We deliberately do NOT fall back to `new Date(s)`
    // — that parse is locale-dependent and would silently corrupt foreign
    // bank imports. The caller surfaces this via the `parseErrors` count in
    // the import preview; the user can pin an explicit format on the bank
    // profile.
    return null;
}

// ── Money helpers ────────────────────────────────────────────────────────
// All persisted amounts are integer cents to avoid float drift. SQL aggregates
// (SUM, ABS, comparisons) work unchanged on integers; only the display
// boundary needs to divide by 100. `parseAmount` is the input-parsing helper
// for CSV / form values that arrive as decimal strings or numbers.

function toCents(val) {
    if (val === null || val === undefined || val === '') return 0;
    const n = typeof val === 'number' ? val : parseFloat(String(val).replace(/,/g, ''));
    if (!isFinite(n)) return 0;
    return centsRound(n);
}

// n * 100 in floating point can land just below the true value
// (1.005 * 100 === 100.49999…), which Math.round would then truncate to the
// wrong cent. Re-quantize before rounding.
function centsRound(n) {
    return Math.round(parseFloat((n * 100).toPrecision(12)));
}

function fromCents(cents) {
    return (cents || 0) / 100;
}

function fmtMoney(cents) {
    return (Math.abs(cents || 0) / 100).toFixed(2);
}

function fmtMoneySigned(cents) {
    const c = cents || 0;
    return c >= 0 ? `+$${fmtMoney(c)}` : `-$${fmtMoney(c)}`;
}

function fmtMoneyLocale(cents, locale = 'en-US') {
    return (Math.abs(cents || 0) / 100).toLocaleString(locale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

// Parse a CSV money cell into integer cents, or null when the cell cannot be
// understood as a number — the import preview surfaces nulls as amount errors
// instead of silently recording $0.00. Tolerates currency symbols/codes
// ("$1,234.56", "SGD 12.30"), accounting negatives "(123.45)", trailing sign
// "123.45-", and both 1,234.56 and 1.234,56 separator conventions.
function parseAmount(val) {
    if (val === null || val === undefined) return null;
    if (typeof val === 'number') return isFinite(val) ? centsRound(val) : null;

    let s = String(val).trim();
    if (s === '') return null;

    let negative = false;
    const paren = s.match(/^\((.*)\)$/);
    if (paren) { negative = true; s = paren[1].trim(); }
    // A minus sign anywhere before the first digit ("-12.34", "$-12.34") or
    // trailing ("12.34-") marks a negative.
    if (/^[^\d]*-/.test(s) || /-\s*$/.test(s)) negative = true;

    // Drop currency symbols, codes, signs, and spaces; keep digits and separators.
    s = s.replace(/[^\d.,]/g, '');
    if (!/\d/.test(s)) return null;

    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    if (lastDot !== -1 && lastComma !== -1) {
        // Both present: the later one is the decimal separator.
        if (lastDot > lastComma) s = s.replace(/,/g, '');                  // 1,234.56
        else s = s.replace(/\./g, '').replace(',', '.');                   // 1.234,56
    } else if (lastComma !== -1) {
        const commas = (s.match(/,/g) || []).length;
        const digitsAfter = s.length - lastComma - 1;
        // A single comma not followed by a 3-digit group is a decimal comma
        // (12,34); otherwise commas are thousands separators (1,234 / 1,234,567).
        if (commas === 1 && digitsAfter !== 3) s = s.replace(',', '.');
        else s = s.replace(/,/g, '');
    } else if (lastDot !== -1 && (s.match(/\./g) || []).length > 1) {
        s = s.replace(/\./g, '');                                          // 1.234.567
    }

    const n = parseFloat(s);
    if (!isFinite(n)) return null;
    return centsRound(n) * (negative ? -1 : 1);
}

function categorizeTransaction(description) {
    // No longer auto-categorizing with hardcoded rules
    // Use Transaction Rules (Rules tab) to set up auto-categorization
    // This ensures all categorization logic is in one place and user-controlled
    // Default to "Uncategorized" so users can see what needs manual review
    return 'Uncategorized';
}


// ═══════════════════════════════════════════════════════════════════════════
