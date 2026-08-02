/**
 * Prompt & transaction security
 * =============================
 * Everything that arrives as free text, or comes back from a model, is
 * untrusted. This module is the single trust boundary:
 *
 *   1. `scanForPromptInjection` — reject instruction-override attempts before
 *      any model call, on a normalised copy of the text so that zero-width
 *      characters, homoglyphs, leetspeak and letter-spacing cannot smuggle a
 *      known phrase past the matcher.
 *   2. `parseOwnerCommand` — recognise the wallet owner's own administrative
 *      instructions (raise the budget, allow a payee). These are returned as
 *      *proposals*; nothing here mutates policy.
 *   3. `sanitizeAmount` / `sanitizePayee` / `clampScore` — validate every value
 *      that crosses into the enforcement path, including values invented by the
 *      LLM, which is just another untrusted input.
 *
 * Design rule: an agent can never widen its own authority. Policy changes are
 * only ever *proposed* here and must be confirmed by a human in the UI; the
 * autonomous spend path never calls `parseOwnerCommand` at all.
 */

/** Thrown when a prompt looks like an injection or jailbreak attempt. */
export class MaliciousPromptError extends Error {
  constructor(reason, { category = 'injection', rule = null } = {}) {
    super(reason);
    this.name = 'MaliciousPromptError';
    this.reason = reason;
    this.category = category;
    this.rule = rule;
  }
}

/** Thrown when a spend request fails validation before enforcement. */
export class InvalidRequestError extends Error {
  constructor(reason, { field = null } = {}) {
    super(reason);
    this.name = 'InvalidRequestError';
    this.reason = reason;
    this.field = field;
  }
}

/* ─────────────────────────── Normalisation ─────────────────────────── */

// Invisible characters used to break up a blocked phrase.
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤﻿]/g;

// Digits and symbols standing in for letters ("1gn0re", "byp@ss").
const DELEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '|': 'i' };

/**
 * Light normalisation, safe for *reading values out of* the text: case-folded,
 * invisible characters removed, whitespace collapsed. Digits are left intact.
 */
export function normalizeText(input) {
  let s = String(input || '');
  try { s = s.normalize('NFKC'); } catch { /* older engines */ }
  return s.replace(INVISIBLE, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Aggressive normalisation for *pattern scanning only*.
 *
 * This folds digits into the letters they imitate ("byp@ss" → "bypass"), which
 * destroys numbers — "80000" becomes "8ooooo". Never read an amount, a domain
 * or any other value out of this string; use `normalizeText` for that.
 */
export function normalizeForScan(input) {
  return normalizeText(input).replace(/[013457@$|]/g, ch => DELEET[ch] || ch);
}

/** Letters and digits only — defeats "i-g-n-o-r-e" and "i g n o r e". */
export function compactForScan(input) {
  return normalizeForScan(input).replace(/[^a-z0-9]/g, '');
}

/* ─────────────────────────── Injection rules ─────────────────────────── */

/**
 * Each rule runs against the spaced-normalised text. Rules marked `compact`
 * also run against the letters-only form, which is where separator tricks show
 * up — those patterns must not contain spaces.
 */
const INJECTION_RULES = [
  // Instruction override
  { id: 'override-instructions', label: 'Instruction override', compact: true,
    re: /ignore(?:all|any|the|previous|prior|above|earlier)*(?:instruction|rule|direction|prompt)/ },
  { id: 'disregard-rules', label: 'Instruction override', compact: true,
    re: /disregard(?:your|all|the|previous|prior|any)*(?:instruction|rule|policy|polic|constraint|guardrail|limit)/ },
  { id: 'forget-rules', label: 'Instruction override', compact: true,
    re: /forget(?:your|all|any|the|previous|prior)*(?:instruction|rule|policy|polic|constraint|training)/ },
  { id: 'new-instructions', label: 'Instruction override',
    re: /\bnew (instructions?|directive|rules?|policy|system prompt|override)\b/ },
  { id: 'system-prompt', label: 'System prompt probing', compact: true,
    re: /(system(prompt|message)|revealyour(prompt|instruction|system)|printyour(prompt|instruction))/ },

  // Role hijack
  { id: 'role-hijack', label: 'Role hijack',
    re: /\b(you are now|from now on you|act as (a|an|if|though|like)|pretend (you are|to be|that you|you're)|roleplay as)\b/ },
  { id: 'jailbreak', label: 'Role hijack', compact: true,
    re: /(jailbreak|dan mode|developer ?mode|god ?mode|do ?anything ?now)/ },

  // Control-guard evasion — verbs of *defeating* a control, not administering it
  { id: 'bypass-guard', label: 'Guard evasion', compact: true,
    re: /(bypass|circumvent|evade|sidestep|getaround|workaround|defeat|turnoff|switchoff|shutoff|disable|deactivate|suppress|silence|skip)(the|any|all|your|our)*(security|policy|polic|rule|guard|guardrail|allowlist|whitelist|allowlist|killswitch|limit|check|review|approval|escalation|halt)/ },
  { id: 'override-guard', label: 'Guard evasion', compact: true,
    re: /override(the|any|all|your|our)*(policy|polic|rule|security|guard|killswitch|limit|allowlist|approval)/ },
  { id: 'pretend-approved', label: 'Guard evasion', compact: true,
    re: /(markthisas|treatthisas|pretenditis|actasifitis)(approved|safe|allowed|authorized|authorised)/ },
  { id: 'skip-human', label: 'Guard evasion', compact: true,
    re: /(without|no|skip|avoid|bypass)(human|owner|manual)?(review|approval|confirmation|consent)/ },

  // Exfiltration / fund drain
  { id: 'drain-wallet', label: 'Fund drain', compact: true,
    re: /(drain|empty|liquidate|sweep)(the|all|my|our)*(wallet|fund|balance|account|treasury)/ },
  { id: 'transfer-all', label: 'Fund drain', compact: true,
    re: /(transfer|send|move|withdraw|forward)(all|every|the ?entire|remaining|whole)(fund|balance|money|amount|wallet)/ },
  { id: 'exfiltrate', label: 'Exfiltration',
    re: /\b(exfiltrate|leak|dump)\b.*\b(key|token|secret|credential|api|wallet|seed|mnemonic|private)\b/ },
  { id: 'credential-probe', label: 'Exfiltration', compact: true,
    re: /(showme|giveme|whatis|reveal|print)(the|your|our)*(apikey|api ?key|secretkey|privatekey|seedphrase|mnemonic|password|token|credential)/ },

  // Structural / delimiter injection
  { id: 'delimiter-injection', label: 'Delimiter injection',
    re: /(\[\[.*?\]\]|<<.*?>>|<\|.*?\|>|\{\{.*?\}\})/ },
  { id: 'fake-role-turn', label: 'Delimiter injection',
    re: /(^|\n)\s*(system|assistant|developer)\s*:/ },
  { id: 'end-of-prompt', label: 'Delimiter injection', compact: true,
    re: /(endofprompt|endofinstructions|###end|<\/?(system|instructions?)>)/ },

  // Encoded payloads
  { id: 'encoded-payload', label: 'Encoded payload',
    re: /\b(base64|rot13|hex ?decode|atob)\b\s*[:(]/ },
];

/**
 * Scan raw text for injection attempts. Throws `MaliciousPromptError` on the
 * first match. Returns the normalised text when clean, so callers can reuse it.
 */
export function scanForPromptInjection(text) {
  const spaced = normalizeForScan(text);
  const compact = compactForScan(text);
  const raw = String(text || '');

  for (const rule of INJECTION_RULES) {
    const hit = rule.re.test(spaced) || rule.re.test(raw.toLowerCase())
      || (rule.compact && rule.re.test(compact));
    if (hit) {
      const excerpt = raw.slice(0, 90) + (raw.length > 90 ? '…' : '');
      throw new MaliciousPromptError(
        `${rule.label} detected — request refused before it reached the wallet. Input: "${excerpt}"`,
        { category: rule.label, rule: rule.id }
      );
    }
  }

  // Invisible characters have no legitimate use in a spend instruction.
  if (INVISIBLE.test(raw)) {
    INVISIBLE.lastIndex = 0;
    throw new MaliciousPromptError(
      'Hidden control characters detected in the instruction — refused as an obfuscation attempt.',
      { category: 'Obfuscation', rule: 'invisible-characters' }
    );
  }
  INVISIBLE.lastIndex = 0;

  return spaced;
}

/* ─────────────────────────── Value validation ─────────────────────────── */

/** No single transaction may exceed this, whatever the model returns. */
export const MAX_TRANSACTION = 10_000_000;
/** Upper bound on any owner-set daily limit. */
export const MAX_DAILY_LIMIT = 100_000_000;

/**
 * Coerce an amount from any source (user text, model JSON) into a safe number.
 * Rejects NaN, Infinity, negatives, zero and absurd magnitudes rather than
 * letting them reach the policy comparisons, where NaN silently passes every
 * `>` check.
 */
export function sanitizeAmount(value, { max = MAX_TRANSACTION, field = 'amount' } = {}) {
  const n = typeof value === 'string'
    ? Number(value.replace(/[₹,\s]/g, ''))
    : Number(value);

  if (!Number.isFinite(n)) {
    throw new InvalidRequestError(`Amount "${value}" is not a valid number.`, { field });
  }
  if (n <= 0) {
    throw new InvalidRequestError('Amount must be greater than zero.', { field });
  }
  if (n > max) {
    throw new InvalidRequestError(
      `Amount exceeds the ${max.toLocaleString('en-IN')} hard ceiling and was refused.`, { field }
    );
  }
  return Math.round(n * 100) / 100;
}

// Hostname: dot-separated labels, no scheme, no path, no credentials.
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Reduce a payee to a bare hostname and validate it. Strips scheme, credentials,
 * port, path and query so that "https://evil.com@aws.amazon.com/x" cannot be
 * presented as the allowlisted host.
 */
export function sanitizePayee(value) {
  let host = String(value || '').trim().toLowerCase();
  if (!host) throw new InvalidRequestError('Payee is missing.', { field: 'payee' });

  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  host = host.split('@').pop();                        // userinfo
  host = host.split(/[/?#]/)[0];                       // path / query / fragment
  host = host.split(':')[0];                           // port
  host = host.replace(/\.$/, '');                      // trailing root dot

  if (!HOSTNAME.test(host)) {
    throw new InvalidRequestError(
      `Payee "${value}" is not a valid hostname — refused.`, { field: 'payee' }
    );
  }
  return host;
}

/** Clamp a model-supplied score into 0–100. */
export function clampScore(value, fallback = 15) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/** Restrict a model-supplied verdict to the known enum. */
export function safeVerdict(value, fallback = 'SAFE') {
  const v = String(value || '').trim().toUpperCase();
  return ['SAFE', 'SUSPICIOUS', 'CRITICAL'].includes(v) ? v : fallback;
}

/** Trim model prose to something safe to render. */
export function safeReasoning(value, fallback = 'No reasoning returned.') {
  const s = String(value ?? '').replace(INVISIBLE, '').trim();
  if (!s) return fallback;
  return s.length > 400 ? s.slice(0, 400) + '…' : s;
}

/* ─────────────────────────── Owner commands ─────────────────────────── */

// The multiplier must be a whole word — a bare "l" would otherwise turn
// "10000 litres" into ten lakh.
const AMOUNT_IN_TEXT = /(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*\b(k|thousand|lakh|lakhs|cr|crore)?\b/i;

const MULTIPLIER = { k: 1e3, thousand: 1e3, lakh: 1e5, lakhs: 1e5, cr: 1e7, crore: 1e7 };

function readAmount(text) {
  const m = String(text).match(AMOUNT_IN_TEXT);
  if (!m) return null;
  const base = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  const mult = m[2] ? (MULTIPLIER[m[2].toLowerCase()] || 1) : 1;
  return base * mult;
}

// Something that looks like a domain anywhere in the sentence.
const DOMAIN_IN_TEXT = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})\b/i;

/**
 * Recognise an administrative instruction from the wallet owner.
 *
 * Returns a **proposal** — `{ kind, ...fields, label }` — or `null` when the
 * text is an ordinary spend request. Nothing is applied here: the caller must
 * put the proposal in front of a human. Only administrative verbs match;
 * evasion phrasing ("bypass the limit") is caught earlier by the injection
 * scanner and never reaches this function.
 */
export function parseOwnerCommand(text) {
  // Light normalisation only — the scanning variant folds digits into letters
  // and would turn "80,000" into "8o,ooo".
  const s = normalizeText(text);
  if (!s) return null;

  // ── Daily limit ────────────────────────────────────────────────
  const limitSubject = /(daily )?(budget|spend limit|spending limit|limit|cap|allowance)/;
  const raiseVerb = /\b(increase|raise|bump|extend|expand|grow)\b/;
  const setVerb = /\b(set|change|update|make|adjust|configure)\b/;
  const lowerVerb = /\b(decrease|reduce|lower|cut|shrink|drop)\b/;

  if (limitSubject.test(s) && (raiseVerb.test(s) || setVerb.test(s) || lowerVerb.test(s))) {
    const value = readAmount(s);
    if (value != null) {
      // "increase the budget by 10000" is relative; "to 80000" is absolute.
      const relative = /\bby\b\s*(?:₹|rs\.?|inr)?\s*\d/.test(s) && !/\bto\b\s*(?:₹|rs\.?|inr)?\s*\d/.test(s);
      return {
        kind: 'set_limit',
        relative,
        delta: relative ? (lowerVerb.test(s) ? -value : value) : null,
        amount: relative ? null : value,
        label: relative
          ? `${lowerVerb.test(s) ? 'Reduce' : 'Increase'} the daily limit by ₹${value.toLocaleString('en-IN')}`
          : `Set the daily limit to ₹${value.toLocaleString('en-IN')}`,
      };
    }
  }

  // ── Allowlist ──────────────────────────────────────────────────
  const domainMatch = s.match(DOMAIN_IN_TEXT);
  const domain = domainMatch ? domainMatch[1] : null;

  if (domain) {
    const addVerb = /\b(add|allow|allowlist|whitelist|approve|trust|permit|register)\b/;
    const removeVerb = /\b(remove|revoke|delete|drop|block|untrust|deny|disallow)\b/;
    const listSubject = /(allowlist|whitelist|allowed payee|approved payee|payee|vendor)/;

    if (removeVerb.test(s) && (listSubject.test(s) || /\bfrom\b/.test(s))) {
      return { kind: 'remove_payee', payee: domain, label: `Remove ${domain} from the allowlist` };
    }
    if (addVerb.test(s) && (listSubject.test(s) || /\bto\b/.test(s))) {
      return { kind: 'allow_payee', payee: domain, label: `Add ${domain} to the allowlist` };
    }
  }

  // ── Kill switch ────────────────────────────────────────────────
  const walletSubject = /(wallet|account|spending|everything|all spend)/;
  if (/\b(freeze|lock|lockdown|halt|stop|seal)\b/.test(s) && walletSubject.test(s)) {
    return { kind: 'freeze', label: 'Freeze the wallet' };
  }
  if (/\b(unfreeze|unlock|release|resume|reopen|reactivate)\b/.test(s) && walletSubject.test(s)) {
    return { kind: 'unfreeze', label: 'Release the lockdown' };
  }

  return null;
}

/**
 * Turn a proposal into the concrete policy change it would make, given the
 * current policy. Returns `{ ok, summary, apply }` where `apply` is the vetted
 * payload — still not applied until a human confirms.
 */
export function resolveOwnerCommand(command, policy) {
  if (!command) return { ok: false, summary: 'No command.' };

  switch (command.kind) {
    case 'set_limit': {
      const target = command.relative
        ? (policy.spend_limit || 0) + command.delta
        : command.amount;
      let limit;
      try {
        limit = sanitizeAmount(target, { max: MAX_DAILY_LIMIT, field: 'spend_limit' });
      } catch (err) {
        return { ok: false, summary: err.reason };
      }
      if (limit < (policy.daily_spent || 0)) {
        return {
          ok: false,
          summary: `New limit ₹${limit.toLocaleString('en-IN')} is below what has already been spent today (₹${(policy.daily_spent || 0).toLocaleString('en-IN')}).`,
        };
      }
      return {
        ok: true,
        summary: `Daily limit ₹${(policy.spend_limit || 0).toLocaleString('en-IN')} → ₹${limit.toLocaleString('en-IN')}`,
        apply: { kind: 'set_limit', limit },
      };
    }

    case 'allow_payee': {
      let payee;
      try {
        payee = sanitizePayee(command.payee);
      } catch (err) {
        return { ok: false, summary: err.reason };
      }
      if ((policy.allowlist || []).includes(payee)) {
        return { ok: false, summary: `${payee} is already on the allowlist.` };
      }
      return {
        ok: true,
        summary: `Allowlist ${payee} — the agent will be able to pay it up to the daily limit.`,
        apply: { kind: 'allow_payee', payee },
      };
    }

    case 'remove_payee': {
      let payee;
      try {
        payee = sanitizePayee(command.payee);
      } catch (err) {
        return { ok: false, summary: err.reason };
      }
      if (!(policy.allowlist || []).includes(payee)) {
        return { ok: false, summary: `${payee} is not on the allowlist.` };
      }
      return {
        ok: true,
        summary: `Remove ${payee} — every future spend to it will be blocked at Layer 1.`,
        apply: { kind: 'remove_payee', payee },
      };
    }

    case 'freeze':
      if (policy.is_frozen) return { ok: false, summary: 'The wallet is already frozen.' };
      return { ok: true, summary: 'Freeze the wallet — all agent spending stops immediately.', apply: { kind: 'freeze' } };

    case 'unfreeze':
      if (!policy.is_frozen) return { ok: false, summary: 'The wallet is not frozen.' };
      return { ok: true, summary: 'Release the lockdown — the agent may spend within policy again.', apply: { kind: 'unfreeze' } };

    default:
      return { ok: false, summary: 'Unrecognised command.' };
  }
}
