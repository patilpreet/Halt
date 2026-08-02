/**
 * Natural language → spend intent, entirely in the browser.
 *
 * This replaces the model-backed parser that used to live in `groqEngine.js`.
 * That version called Groq and Gemini directly from the page, which meant the
 * API keys had to be `VITE_` variables — and Vite inlines those into the
 * bundle, so both keys shipped to every visitor. One of them was live.
 *
 * The fix is structural rather than careful: there is no key in the browser to
 * leak, because the browser no longer talks to a model. Risk scoring happens in
 * the gateway, where the key is a server-side secret. Parsing "pay aws ₹12,000"
 * into `{host, amount}` never needed a model to begin with.
 */

import { sanitizeAmount, sanitizePayee, InvalidRequestError, scanForPromptInjection } from './promptSecurity';

/** Keyword fallbacks, used only when no explicit domain appears in the text. */
const PAYEE_HINTS = [
  [/\b(aws|amazon)\b/, 'aws.amazon.com'],
  [/\bgithub\b/, 'github.com'],
  [/\bvendor[- ]?a\b/, 'vendor-a.com'],
  [/\bvendor[- ]?b\b/, 'vendor-b.com'],
  [/\b(cloud|compute|gpu)\b/, 'cloud-compute.io'],
  [/\b(hacker|shady|untrusted|proxy)\b/, 'shady-endpoint.ru'],
];

const DOMAIN_IN_TEXT = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})\b/i;
const AMOUNT_IN_TEXT = /(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*\b(k|thousand|lakh|lakhs|cr|crore)?\b/i;
const MULTIPLIER = { k: 1e3, thousand: 1e3, lakh: 1e5, lakhs: 1e5, cr: 1e7, crore: 1e7 };

/**
 * Parse a free-text instruction into `{ payee, amount }` in rupees.
 *
 * The injection scan runs first, so a hostile instruction is refused before any
 * value is read out of it.
 *
 * @throws {MaliciousPromptError} on an injection attempt
 * @throws {InvalidRequestError}  when no payee or a bad amount can be read
 */
export function parseSpendIntent(promptText) {
  scanForPromptInjection(promptText);

  const text = String(promptText || '');

  let amount = null;
  const amountMatch = text.match(AMOUNT_IN_TEXT);
  if (amountMatch) {
    const base = Number(amountMatch[1].replace(/,/g, ''));
    const mult = amountMatch[2] ? MULTIPLIER[amountMatch[2].toLowerCase()] || 1 : 1;
    if (Number.isFinite(base)) amount = base * mult;
  }
  if (amount == null) {
    throw new InvalidRequestError(
      'No amount could be read from the request. Name a figure, e.g. "₹12,000".',
      { field: 'amount' },
    );
  }

  // A full URL wins and is resolved through sanitizePayee, so
  // "https://evil.com@aws.amazon.com/x" yields the real host rather than the
  // userinfo in front of the "@". Then a bare domain, then a keyword hint.
  let payee = null;

  const urlMatch = text.match(/\bhttps?:\/\/\S+/i);
  if (urlMatch) {
    try {
      payee = sanitizePayee(urlMatch[0]);
    } catch {
      /* fall through to the other strategies */
    }
  }
  if (!payee) {
    const domainMatch = text.match(DOMAIN_IN_TEXT);
    if (domainMatch) payee = domainMatch[1];
  }
  if (!payee) {
    const hit = PAYEE_HINTS.find(([re]) => re.test(text.toLowerCase()));
    if (hit) payee = hit[1];
  }

  // Never invent a payee. Defaulting to a house vendor would mean a request
  // naming an unparseable recipient quietly gets paid to a different one.
  if (!payee) {
    throw new InvalidRequestError(
      'No payee could be identified in the request. Name a hostname, e.g. "aws.amazon.com".',
      { field: 'payee' },
    );
  }

  return { payee: sanitizePayee(payee), amount: sanitizeAmount(amount) };
}

/* ─────────────────────── money conversion ─────────────────────── */

/**
 * Rupees → paise, as an integer.
 *
 * The engine speaks only in integer paise. Floats are fine for display and
 * catastrophic for arithmetic: 0.1 + 0.2 !== 0.3 in binary floating point, and
 * a spend cap that drifts by a rounding error is not a cap. Conversion happens
 * here, once, at the boundary.
 */
export const toPaise = (rupees) => Math.round(Number(rupees) * 100);
export const toRupees = (paise) => Number(paise || 0) / 100;
