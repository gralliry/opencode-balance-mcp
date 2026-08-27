// Pure parsing + formatting helpers for the OpenCode dashboard SSR/RSC payloads.
// No I/O, no credentials — kept separate so they're unit-testable.

/**
 * Extract a "usage" object from a React Server Component (RSC) HTML payload.
 *
 * The dashboard page embeds usage data in the form:
 *   key:$R[31]={status:"ok",resetInSec:8660,usagePercent:1}
 *
 * @param {string} html - Raw HTML text of the dashboard page.
 * @param {string} key  - The property name to look up (e.g. "rollingUsage").
 * @returns {Object|null} Parsed key/value object, or null if the key was not found.
 */
export function extractRscObject(html, key) {
    // Match `key:` or `key":`/`key':` followed by `$R[<digits>]={ ... }`.
    // The leading `(?:^|[^\w$])` guard prevents matching a larger identifier
    // that merely *contains* the key (e.g. "myRollingUsage"), and the body is
    // captured as a `{...}` without nested braces.
    const m = html.match(
        new RegExp(
            `(?:^|[^\\w$])${key}["']?:\\$R\\[\\d+\\]=\\{([^{}]*)\\}`,
            "i",
        ),
    );
    if (!m) return null;

    const obj = {};
    // Split the `{...}` body on commas into `field:value` pairs.
    for (const pair of m[1].split(",")) {
        const [k, v] = pair.split(":");
        const keyName = k?.trim();
        if (!keyName || v === undefined) continue; // skip empty/malformed fields
        // Strip surrounding double quotes and leading/trailing whitespace.
        const raw = v.replace(/^"|"$/g, "").trim();
        // Numeric-looking strings become numbers, everything else stays a string.
        obj[keyName] =
            raw === "" || Number.isNaN(Number(raw)) ? raw : Number(raw);
    }
    return obj;
}

/**
 * Extract a single scalar value that SolidJS serialises during SSR.
 *
 * Handles all the value shapes SolidJS can emit:
 *   key:value | key:"value" | key:!0 / key:!1 (boolean shorthand) | key:true / key:false | key:null
 *
 * @param {string} html - Raw HTML text of the dashboard page.
 * @param {string} key  - The property name to look up (e.g. "balance").
 * @returns {number|boolean|string|null} Parsed value, or null when absent/`null`.
 */
export function extractScalar(html, key) {
    const re = new RegExp(
        `(?:^|[^\\w$])${key}["']?:\\s*("([^"]*)"|(![01])|(-?\\d+(?:\\.\\d+)?)|(true|false|null))`,
        "i",
    );
    const m = html.match(re);
    if (!m) return null;

    // m[2] = double-quoted string value
    if (m[2] !== undefined) {
        const s = m[2];
        return s === "" || Number.isNaN(Number(s)) ? s : Number(s);
    }
    // m[3] = SolidJS boolean shorthand (!0 / !1)
    if (m[3] !== undefined) return m[3] === "!0";
    // m[4] = signed integer or decimal number
    if (m[4] !== undefined) return Number(m[4]);
    // m[5] = literal true/false/null
    if (m[5] === "true") return true;
    if (m[5] === "false") return false;
    return null; // "null"
}

/**
 * Format a duration (seconds) as a compact "d h m s" string.
 * Returns "resets now" for non-finite or non-positive input.
 *
 * @param {number} sec - Duration in seconds.
 * @returns {string} Human-readable duration.
 */
export function formatDuration(sec) {
    if (!Number.isFinite(sec) || sec <= 0) return "resets now";
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const parts = [];
    if (d) parts.push(`${d}d`);
    if (h) parts.push(`${h}h`);
    if (m) parts.push(`${m}m`);
    if (s) parts.push(`${s}s`);
    return parts.join(" ") || `${sec}s`;
}

/**
 * Normalise one Go usage window into a consistent output shape.
 * Estimated USD spent is derived from usagePercent × the USD limit.
 *
 * @param {Object|null} w - Raw window object, or null if absent.
 * @param {number} limitUsd - The window's USD spending limit.
 * @returns {Object|null} Formatted window, or null when w is null.
 */
export function formatWindow(w, limitUsd) {
    if (!w) return null;
    const pct = Number(w.usagePercent) || 0;
    const resetsInSeconds = Number(w.resetInSec ?? w.resetsInSeconds) || 0;
    return {
        status: w.status ?? "unknown",
        usagePercent: pct,
        limitUsd,
        // estSpent = percent/100 × limit; low uses pct, high uses pct+1.
        estSpentUsdLow: Math.round((pct / 100) * limitUsd * 100) / 100,
        estSpentUsdHigh:
            Math.round(((pct + 1) / 100) * limitUsd * 100) / 100,
        resetsInSeconds,
        resetsIn: formatDuration(resetsInSeconds),
    };
}

// OpenCode stores balances in 1e-8 USD units (the dashboard client renders
// them via formatBalance = amount / 1e8, e.g. balance 1392000000 → $13.92).
const BALANCE_UNIT = 1e8;

/**
 * Assemble the Zen balance output from raw fields extracted from the page.
 * Returns null when the page carried no balance, so callers can decide
 * whether to throw.
 *
 * @param {Object} raw - Fields extracted from the page
 *   ({balanceRaw, reloadAmount, reloadTrigger, reloadAmountMin, reloadTriggerMin}).
 * @param {string} workspaceId - Credentialed workspace id, echoed in the output.
 * @returns {Object|null} Formatted balance object, or null when no balance.
 */
export function formatZen(raw, workspaceId) {
    const balanceRaw = Number(raw?.balanceRaw);
    if (!Number.isFinite(balanceRaw)) return null; // no balance field → not Zen-billed

    const balanceUsd = Math.abs(balanceRaw) / BALANCE_UNIT; // magnitude; sign via balanceRaw + label
    const label = balanceUsd.toFixed(2);
    const sign = balanceRaw < 0 ? -1 : balanceRaw > 0 ? 1 : 0;
    const {
        reloadAmount = null,
        reloadTrigger = null,
        reloadAmountMin = null,
        reloadTriggerMin = null,
    } = raw ?? {};

    return {
        workspaceId,
        plan: "pay-as-you-go",
        balanceRaw,
        balanceUsd,
        // Human-friendly label: $X.XX, optionally annotated with (credit)/(owed).
        // Annotation is omitted for amounts that round to $0.00.
        balanceFormatted: `$${label}${
            label !== "0.00" && sign < 0
                ? " (credit)"
                : label !== "0.00" && sign > 0
                  ? " (owed)"
                  : ""
        }`,
        // Auto-reload is only meaningful when both amount and trigger are set.
        autoReload:
            reloadAmount != null && reloadTrigger != null
                ? {
                      triggerUsd: reloadTrigger,
                      triggerMinUsd: reloadTriggerMin,
                      reloadUsd: reloadAmount,
                      reloadMinUsd: reloadAmountMin,
                  }
                : null,
        reloadAmount, // auto-reload amount in USD
        reloadTrigger, // auto-reload threshold in USD
    };
}
