// Network policy for the OpenCode dashboard: timeout + retry with backoff.
// No credentials, no parsing — kept separate so it's unit-testable.

const FETCH_TIMEOUT_MS = 15000; // abort a request after this many ms
const MAX_RETRIES = 2; // extra attempts on transient/network failures
const RETRY_DELAY_MS = 300; // base backoff (multiplied per attempt)
const MAX_RETRY_AFTER_MS = 5000; // cap for server-provided Retry-After

/** Promise-based sleep helper for retry backoff. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch() wrapper that applies a timeout and simple retry-with-backoff.
 * Retryable responses (5xx, 429) and network errors are retried; timeouts
 * and hard errors (after exhausting retries) are thrown as friendly errors.
 * If retries are exhausted on a retryable status, the response is returned
 * so the caller can report the HTTP status itself.
 *
 * @param {string} url - Request URL.
 * @param {object} [options] - Passed through to fetch().
 * @param {object} [policy] - Test/override knobs (defaults are production values).
 * @param {number} [policy.timeoutMs] - Per-attempt timeout.
 * @param {number} [policy.maxRetries] - Extra attempts after the first.
 * @param {number} [policy.retryDelayMs] - Base backoff between attempts.
 * @returns {Promise<Response>} A successful (non-retryable) response.
 */
export async function fetchWithRetry(url, options = {}, policy = {}) {
    const { timeoutMs = FETCH_TIMEOUT_MS, maxRetries = MAX_RETRIES, retryDelayMs = RETRY_DELAY_MS } = policy;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const resp = await fetch(url, { ...options, signal: controller.signal });
            // Retryable: 5xx (transient server errors) and 429 (rate-limited).
            if ((resp.status >= 500 || resp.status === 429) && attempt < maxRetries) {
                await sleep(retryDelayFor(resp, attempt, retryDelayMs));
                continue;
            }
            return resp;
        } catch (err) {
            if (err.name === "AbortError") {
                throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
            }
            if (attempt < maxRetries) {
                await sleep(retryDelayMs * (attempt + 1));
                continue;
            }
            throw new Error(`Network error: ${err.message}`);
        } finally {
            clearTimeout(timer);
        }
    }
}

/**
 * Backoff for a retryable response: honour Retry-After when present
 * (capped), otherwise exponential-ish base backoff.
 */
function retryDelayFor(resp, attempt, retryDelayMs) {
    const retryAfter = Number(resp.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
        return Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS);
    }
    return retryDelayMs * (attempt + 1);
}

/**
 * GET a URL with an auth cookie and return the body text.
 *
 * Redirects are NOT followed: the dashboard sends a 3xx to /auth/authorize
 * when the cookie is expired, so a redirect here means an invalid session.
 *
 * @param {string} url - Full URL to fetch.
 * @param {string} authCookie - Auth cookie value (prefixed with `auth=` if needed).
 * @returns {Promise<string>} The response body as text.
 */
export async function fetchPage(url, authCookie) {
    const cookie = authCookie.startsWith("auth=")
        ? authCookie
        : `auth=${authCookie}`;
    const resp = await fetchWithRetry(url, {
        headers: { Cookie: cookie },
        redirect: "manual",
    });
    if (resp.status === 401 || resp.status === 403) {
        throw new Error(
            `Authentication failed (HTTP ${resp.status}): auth cookie may be expired. Re-login to opencode.ai and refresh it.`,
        );
    }
    if (resp.status >= 300 && resp.status < 400) {
        throw new Error(
            `Authentication failed: dashboard redirected (HTTP ${resp.status} → ${resp.headers.get("location") ?? "?"}). The auth cookie may be expired or the workspace id invalid.`,
        );
    }
    if (!resp.ok) {
        throw new Error(`Request failed (HTTP ${resp.status})`);
    }
    return resp.text();
}
