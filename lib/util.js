"use strict";

/**
 * Small, dependency-free helper functions shared across the project.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async function with exponential backoff.
 * Retries on network errors and on HTTP 429 / 5xx (thrown as errors with a .status property).
 */
async function retryWithBackoff(fn, { retries = 5, baseDelayMs = 2000, label = "operation" } = {}) {
  let attempt = 0;
  let lastError;

  while (attempt <= retries) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const status = err && err.status;
      const message = (err && err.message) || "";

      // A daily quota being exhausted won't clear for hours — retrying with
      // backoff would just waste the rest of this run's time budget hitting
      // the same wall repeatedly. Per-MINUTE limits, by contrast, clear
      // within seconds and should still be retried normally below.
      //
      // Match broadly across both providers:
      // - Gemini: "RESOURCE_EXHAUSTED" status, "exceeded your current quota"
      //   message, a quotaId containing "PerDay".
      // - Groq: "...on tokens per day (TPD)..." / "...requests per day
      //   (RPD)...". Deliberately does NOT match Groq's per-MINUTE messages
      //   ("output tokens per minute (OTPM)", "requests per minute (RPM)")
      //   — those are transient and should retry as normal below.
      const isDailyQuota =
        status === 429 &&
        /RESOURCE_EXHAUSTED|exceeded your current quota|PerDay|per day \(TPD\)|per day \(RPD\)|\bTPD\b|\bRPD\b|quota/i.test(message);

      if (isDailyQuota) {
        const quotaErr = new Error(`Daily quota exhausted: ${message}`);
        quotaErr.dailyQuotaExhausted = true;
        throw quotaErr;
      }

      const retriable = !status || status === 429 || status >= 500;

      if (!retriable || attempt === retries) {
        throw err;
      }

      const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
      log(`Retry ${attempt + 1}/${retries} for ${label} after error: ${err.message}. Waiting ${delay}ms...`);
      await sleep(delay);
      attempt += 1;
    }
  }

  throw lastError;
}

function todayDateString() {
  // Local server date, YYYY-MM-DD
  return new Date().toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Very small structured logger. Prints to console (visible in the GitHub Actions
 * run log) and also returns the line so callers can push it into an in-memory
 * buffer that gets written to a log file for the dashboard.
 */
function log(message) {
  const line = `[${new Date().toTimeString().slice(0, 8)}] ${message}`;
  console.log(line);
  return line;
}

/**
 * Append one row to a CSV file, creating it with a header if it does not exist.
 * Values are escaped minimally (wrapped in quotes, internal quotes doubled).
 */
function csvEscape(value) {
  const str = String(value === undefined || value === null ? "" : value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Strip characters that are unsafe/unwanted in generated text, and collapse
 * excess whitespace.
 */
function cleanText(str) {
  if (!str) return "";
  return String(str).replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

/**
 * Truncate a string to a max length without cutting a word in half.
 */
function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str || "";
  const cut = str.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}

module.exports = {
  sleep,
  retryWithBackoff,
  todayDateString,
  nowIso,
  log,
  csvEscape,
  cleanText,
  truncate,
};
