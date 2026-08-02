/**
 * Escalation Enforcement Engine — 3-Layer Cascade (Agent 1 → Agent 2 → Human)
 * ---------------------------------------------------------------------------
 * A spend request flows DOWN through tiers; each tier resolves what it can
 * and escalates only the hard cases. "If one fails, another works" is built in:
 * an unsure tier — or a genuinely offline one — hands the decision to the next.
 *
 *   LAYER 1 · Agent 1 (Frontline / Rule Agent)
 *     Fast, cheap deterministic checks: allowlist + spend limit. Never calls the
 *     LLM and never freezes the wallet — freezing is Layer 2's call.
 *       safe            -> APPROVE
 *       clear violation -> BLOCK
 *       uncertain/risky -> escalate to Layer 2
 *
 *   LAYER 2 · Agent 2 (Reviewer / Risk Agent)
 *     Deep AI analysis: Groq risk scoring + reasoning.
 *       low / medium risk -> APPROVE
 *       high risk         -> escalate to Layer 3
 *       extreme risk      -> FREEZE (kill switch)
 *
 *   LAYER 3 · Human (Human-in-the-loop)
 *     Wallet owner decides via Approve / Reject.
 *
 * ── On scoring honesty ──────────────────────────────────────────────────────
 * Two independent numbers feed every Layer 2 verdict and both are reported:
 *   · aiScore     — what the model (or the heuristic fallback) actually returned
 *   · policyFloor — a deterministic minimum derived from wallet policy alone
 * The effective `riskScore` is the higher of the two. The floor exists so a
 * soft-scoring model cannot wave through a spend that policy considers risky;
 * it is a policy control, NOT a model output, and the trace labels it as such.
 */

import { analyzeSpendWithGroq, computeRiskScore, isPayeeAllowlisted } from './groqEngine';
import { money, moneyShort } from './format';

export const DECISION = {
  APPROVE: 'APPROVE', // money moves
  BLOCK: 'BLOCK',     // money withheld
  FREEZE: 'FREEZE',   // money withheld + wallet locked
  HOLD: 'HOLD',       // awaiting a human
};

// Verdict bands (0–100) — language mirrors the Groq engine.
const FREEZE_AT = 75;      // CRITICAL -> kill switch
const SUSPICIOUS_AT = 40;  // SUSPICIOUS -> wallet owner decides
const ESCALATE_RISK = 30;  // Layer 1 sends anything this risky up for deep review

/**
 * Policy exposure floors. A spend that consumes a large share of the daily
 * limit is treated as risky on policy grounds regardless of what the model
 * says about the payee — a trusted vendor is still a trusted vendor when it
 * is about to take 90% of the wallet.
 */
const EXPOSURE_REVIEW_FRACTION = 0.4;   // >= 40% of the limit -> deep review
const EXPOSURE_REVIEW_FLOOR = 62;       //    ...scored at least SUSPICIOUS
const EXPOSURE_CRITICAL_FRACTION = 0.9; // >= 90% of the limit -> near-total drain
const EXPOSURE_CRITICAL_FLOOR = 80;     //    ...scored at least CRITICAL

function verdictFor(score) {
  if (score >= FREEZE_AT) return 'CRITICAL';
  if (score >= SUSPICIOUS_AT) return 'SUSPICIOUS';
  return 'SAFE';
}

/**
 * Deterministic policy floor for a spend, independent of any model output.
 * Returns { floor, basis } where `basis` explains which control set the floor.
 */
function policyExposureFloor({ amount, policy }) {
  const limit = policy.spend_limit || 0;
  if (limit <= 0) return { floor: 0, basis: null };
  if (amount >= limit * EXPOSURE_CRITICAL_FRACTION) {
    return {
      floor: EXPOSURE_CRITICAL_FLOOR,
      basis: `spend is ≥${Math.round(EXPOSURE_CRITICAL_FRACTION * 100)}% of the daily limit`,
    };
  }
  if (amount >= limit * EXPOSURE_REVIEW_FRACTION) {
    return {
      floor: EXPOSURE_REVIEW_FLOOR,
      basis: `spend is ≥${Math.round(EXPOSURE_REVIEW_FRACTION * 100)}% of the daily limit`,
    };
  }
  return { floor: 0, basis: null };
}

function finalize(action, decidedBy, reason, trace, riskScore) {
  return { action, decidedBy, reason, summary: reason, trace, riskScore };
}

/* ───────────── LAYER 1 · Agent 1 — Frontline Rule Agent ─────────────
 * Fast, cheap, deterministic. Only the hard rules live here — it never
 * runs the AI and never freezes; it blocks, approves, or escalates. */
function layer1RuleAgent({ payee, amount, policy }) {
  const ruleRisk = computeRiskScore({ payee, amount, policy });
  const record = {
    layer: 1, name: 'Agent 1 · Frontline Rule Agent', riskScore: ruleRisk,
    status: 'CHECKED', detail: 'allowlist + spend-limit rule checks',
  };

  if (policy.is_frozen) {
    return { terminal: true, decision: DECISION.BLOCK, riskScore: ruleRisk,
      reason: 'BLOCKED at Layer 1 — wallet is frozen by owner lockdown.',
      record: { ...record, status: 'BLOCK', detail: 'wallet is in owner lockdown' } };
  }
  if (!isPayeeAllowlisted(payee, policy)) {
    return { terminal: true, decision: DECISION.BLOCK, riskScore: ruleRisk,
      reason: `BLOCKED at Layer 1 — payee "${payee}" is not on the owner allowlist.`,
      record: { ...record, status: 'BLOCK', detail: 'payee not on allowlist' } };
  }
  if (policy.daily_spent + amount > policy.spend_limit) {
    return { terminal: true, decision: DECISION.BLOCK, riskScore: ruleRisk,
      reason: `BLOCKED at Layer 1 — exceeds daily spend limit (${money(policy.daily_spent)}/${moneyShort(policy.spend_limit)} used).`,
      record: { ...record, status: 'BLOCK', detail: 'exceeds daily spend limit' } };
  }

  // Rules pass. Small & safe → auto-approve (no AI needed). Large exposure / flagged → deep review.
  const { floor } = policyExposureFloor({ amount, policy });
  if (floor > 0 || ruleRisk >= ESCALATE_RISK) {
    return { terminal: false, riskScore: ruleRisk,
      record: { ...record, status: 'ESCALATE',
        detail: floor > 0
          ? 'passes rules but is a large share of the wallet → deep review'
          : 'uncertain / risky → deep review' } };
  }
  return { terminal: true, decision: DECISION.APPROVE, riskScore: ruleRisk,
    reason: `APPROVED at Layer 1 — allowlisted, within limit, small & safe.`,
    record: { ...record, status: 'APPROVE', detail: 'safe — allowlisted, within limit, small spend' } };
}

/* ───────────── LAYER 2 · Agent 2 — Deep Risk Agent ─────────────
 * The Groq risk investigator. Runs only on what Layer 1 couldn't clear.
 * Reports the model's own score and the deterministic policy floor separately
 * so the audit trail never passes a policy control off as a model judgement. */
async function layer2RiskAgent({ payee, amount, policy, agentPrompt, groqApiKey, geminiApiKey, ruleRisk }) {
  const ai = await analyzeSpendWithGroq({ payee, amount, policy, agentPrompt, groqApiKey, geminiApiKey });
  const aiScore = ai.riskScore;

  const exposure = policyExposureFloor({ amount, policy });
  const policyFloor = Math.max(ruleRisk || 0, exposure.floor);
  const effective = Math.max(aiScore, policyFloor);
  const governedBy = effective > aiScore ? 'policy' : 'model';

  const verdict = verdictFor(effective);
  const floorNote = governedBy === 'policy' && exposure.basis
    ? ` Policy floor applied: ${exposure.basis}.`
    : '';
  const scoreNote = governedBy === 'policy'
    ? `risk ${effective}% — model scored ${aiScore}%, policy floor ${policyFloor}%`
    : `risk ${effective}%`;

  const record = {
    layer: 2, name: 'Agent 2 · Deep Risk Agent',
    riskScore: effective, aiScore, policyFloor, governedBy,
    status: 'CHECKED', verdict,
    detail: ai.reasoning, reasoning: ai.reasoning,
  };

  if (effective >= FREEZE_AT) {
    return { decision: DECISION.FREEZE, riskScore: effective, reasoning: ai.reasoning,
      reason: `AUTO-KILL at Layer 2 — verdict CRITICAL (${scoreNote}). Wallet frozen.${floorNote}`,
      record: { ...record, status: 'FREEZE' } };
  }
  if (effective >= SUSPICIOUS_AT) {
    return { decision: DECISION.HOLD, riskScore: effective, reasoning: ai.reasoning,
      reason: `Flagged SUSPICIOUS at Layer 2 — (${scoreNote}). Payee is allowlisted, so it is routed to the wallet owner to approve or reject.${floorNote}`,
      record: { ...record, status: 'ESCALATE', detail: 'SUSPICIOUS → human' } };
  }
  return { decision: DECISION.APPROVE, riskScore: effective, reasoning: ai.reasoning,
    reason: `APPROVED at Layer 2 — Agent 2 verdict SAFE (${scoreNote}).`,
    record: { ...record, status: 'APPROVE' } };
}

/**
 * Run the full cascade for one spend request.
 * @param agentHealth { agent1: boolean, agent2: boolean } — false = offline; the
 *        request then falls through to the next tier ("if one fails, another works").
 */
export async function runEscalation({
  payee, amount, policy, agentPrompt = '', groqApiKey = '', geminiApiKey = '',
  agentHealth = { agent1: true, agent2: true },
}) {
  // Defence in depth: the caller validates too, but a non-finite amount would
  // silently pass every `>` comparison below, so it is refused outright here.
  if (!Number.isFinite(amount) || amount <= 0) {
    return finalize(
      DECISION.BLOCK, 'agent1',
      `BLOCKED at Layer 1 — malformed amount "${amount}" refused before evaluation.`,
      [{ layer: 1, name: 'Agent 1 · Frontline Rule Agent', status: 'BLOCK', riskScore: 100,
         detail: 'malformed amount' }],
      100
    );
  }

  const trace = [];
  let ruleRisk = 0;

  // ── LAYER 1 ──────────────────────────────────────────────
  if (agentHealth.agent1) {
    const l1 = layer1RuleAgent({ payee, amount, policy });
    trace.push(l1.record);
    ruleRisk = l1.riskScore;
    if (l1.terminal) return finalize(l1.decision, 'agent1', l1.reason, trace, l1.riskScore);
    // else fall through to Layer 2
  } else {
    // Frontline offline: Layer 2 still needs the deterministic baseline to floor
    // against, otherwise losing Agent 1 would quietly lower the bar, not raise it.
    ruleRisk = computeRiskScore({ payee, amount, policy });
    trace.push({ layer: 1, name: 'Agent 1 · Frontline Rule Agent', status: 'OFFLINE', riskScore: ruleRisk,
      detail: 'frontline agent offline → every request sent for deep review' });
  }

  // ── LAYER 2 ──────────────────────────────────────────────
  if (agentHealth.agent2) {
    try {
      const l2 = await layer2RiskAgent({ payee, amount, policy, agentPrompt, groqApiKey, geminiApiKey, ruleRisk });
      trace.push(l2.record);
      if (l2.decision === DECISION.FREEZE) return finalize(DECISION.FREEZE, 'agent2', l2.reason, trace, l2.riskScore);
      if (l2.decision === DECISION.APPROVE) return finalize(DECISION.APPROVE, 'agent2', l2.reason, trace, l2.riskScore);
      // high risk → Layer 3
      return finalize(DECISION.HOLD, 'human-pending', l2.reason, trace, l2.riskScore);
    } catch (err) {
      // Agent 2 failed mid-analysis → escalate to human (fail-closed).
      trace.push({ layer: 2, name: 'Agent 2 · Deep Risk Agent', status: 'ERROR',
        detail: `deep review unavailable (${err.message}) → escalated to human` });
      return finalize(DECISION.HOLD, 'human-pending',
        'Agent 2 unavailable — escalated to the wallet owner (fail-closed).', trace, ruleRisk);
    }
  }

  // Agent 2 offline → straight to human.
  trace.push({ layer: 2, name: 'Agent 2 · Deep Risk Agent', status: 'OFFLINE',
    detail: 'deep-review agent offline → escalated to human' });
  return finalize(DECISION.HOLD, 'human-pending',
    'Deep-review agent offline — escalated to the wallet owner.', trace, ruleRisk);
}
