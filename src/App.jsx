import React, { useState, useEffect, useRef } from 'react';
import { Header } from './components/Header';
import { Hero } from './components/Hero';
import { KillSwitchButton } from './components/KillSwitchButton';
import { PolicyCard } from './components/PolicyCard';
import { AgentPlayground } from './components/AgentPlayground';
import { TransactionFeed } from './components/TransactionFeed';
import { TransactionModal } from './components/TransactionModal';
import { GroqConfigModal } from './components/GroqConfigModal';
import { AutoKillAlert } from './components/AutoKillAlert';
import { EscalationPanel } from './components/EscalationPanel';
import { runEscalation, DECISION } from './lib/escalationEngine';
import {
  fetchPolicyFromDb,
  fetchTransactionsFromDb,
  updateDbFreeze,
  updateDbPolicy,
  saveTransactionToDb
} from './lib/supabase';
import { playFreezeAlert } from './lib/sound';
import { useScrollProgress } from './lib/motion';
import { money } from './lib/format';
import { sanitizeAmount, sanitizePayee, InvalidRequestError } from './lib/promptSecurity';

/**
 * Monotonic transaction id. `Date.now()` alone collides whenever two requests
 * resolve in the same millisecond — which the test-suite buttons and the
 * simulator both do — producing duplicate React keys and dropped feed cards.
 */
let txSeq = 0;
const nextTxId = () => Date.now() * 1000 + (txSeq++ % 1000);

/**
 * Prepend a saved transaction, dropping any copy already in the list.
 * `saveTransactionToDb` writes into the same local store the 3s poll reads,
 * so without this the poll and the optimistic prepend can both carry the same
 * row — duplicate React keys and a card rendered twice.
 */
const withTx = (prev, tx) => [tx, ...prev.filter(t => t.id !== tx.id)].slice(0, 100);

/** Drop duplicate ids from a freshly fetched list, newest first. */
const dedupeById = (list) => {
  const seen = new Set();
  return list.filter(t => (seen.has(t.id) ? false : seen.add(t.id)));
};

/** The autonomous agent's scripted run — one spend attempt per tick. */
const SIM_ATTEMPTS = [
  { payee: 'vendor-a.com',       amount: 3500,  prompt: 'Purchase micro tier instance', agentName: 'Cloud Provisioner' },        // L1 → approve (small & safe)
  { payee: 'aws.amazon.com',     amount: 24000, prompt: 'Scale production S3 storage', agentName: 'Storage Orchestrator' },         // L1 → L2 suspicious → human
  { payee: 'cloud-compute.io',   amount: 9000,  prompt: 'Renew container registry', agentName: 'DevOps Agent' },            // L1 → approve
  { payee: 'unknown-hacker.xyz', amount: 4500,  prompt: 'Download unverified scraper tool', agentName: 'Scraper Bot' },    // L1 → block (allowlist wall)
  { payee: 'vendor-b.com',       amount: 60000, prompt: 'Renew SaaS analytics sub', agentName: 'SaaS Auditor' },            // L1 → block (over limit)
  { payee: 'shady-endpoint.ru',  amount: 1800,  prompt: 'Obtain proxy IP pool', agentName: 'Network Agent' },                // L1 → block (allowlist wall)
];

export default function App() {
  const [policy, setPolicy] = useState({
    spend_limit: 50000,
    daily_spent: 0,
    allowlist: ['vendor-a.com', 'vendor-b.com', 'cloud-compute.io', 'aws.amazon.com', 'github.com'],
    is_frozen: false
  });

  const [transactions, setTransactions] = useState([]);
  const [selectedTx, setSelectedTx] = useState(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const [groqApiKey, setGroqApiKey] = useState(import.meta.env.VITE_GROQ_API_KEY || '');
  const [geminiApiKey, setGeminiApiKey] = useState(import.meta.env.VITE_GEMINI_API_KEY || '');
  const [showGroqModal, setShowGroqModal] = useState(false);
  const [dbConnected, setDbConnected] = useState(true);
  // Auto-kill alert state — set when an EXTREME risk triggers auto-freeze
  const [autoKillEvent, setAutoKillEvent] = useState(null);
  // In-flight transactions (processing window for revocation demo)
  const [pendingTxs, setPendingTxs] = useState([]);
  // Health of the two AI guardians — toggling to false simulates a failure (failover demo)
  const [agentHealth, setAgentHealth] = useState({ agent1: true, agent2: true });
  // Transactions held awaiting a human decision (disagreement or total agent failure)
  const [humanQueue, setHumanQueue] = useState([]);
  // Most recent escalation trace, shown live in the EscalationPanel
  const [lastResult, setLastResult] = useState(null);

  // Page scroll progress — drives the hairline reading bar under the header
  const scrollProgress = useScrollProgress();

  const simulationRef = useRef(null);
  // Where the simulator is in its script — a ref so it survives re-renders
  const simStepRef = useRef(0);
  // Latest spend handler, so the interval always calls the current closure
  // (fresh groqApiKey / agentHealth) without needing to restart the timer
  const sendSpendRef = useRef(null);
  // Ref to always hold the latest policy — needed inside setTimeout callbacks
  const policyRef = useRef(policy);
  useEffect(() => { policyRef.current = policy; }, [policy]);

  // Initial load & periodic poll
  useEffect(() => {
    async function loadData() {
      try {
        const p = await fetchPolicyFromDb();
        const txs = await fetchTransactionsFromDb();
        setPolicy(p);
        setTransactions(dedupeById(txs));
      } catch (e) {
        setDbConnected(false);
      }
    }
    loadData();
    const interval = setInterval(loadData, 3000);
    return () => clearInterval(interval);
  }, []);

  // Handle freeze/unfreeze
  const handleToggleFreeze = async () => {
    const newFrozenState = !policy.is_frozen;
    setPolicy(prev => ({ ...prev, is_frozen: newFrozenState }));
    if (newFrozenState) {
      playFreezeAlert();
    } else {
      // Releasing the lockdown resolves the auto-kill event — leaving the banner
      // up would keep claiming the wallet is frozen after it has been released.
      setAutoKillEvent(null);
    }
    await updateDbFreeze(newFrozenState);
  };

  // Handle updating spend limit or allowlist
  const handleUpdatePolicy = async (newLimit, newAllowlist) => {
    setPolicy(prev => ({
      ...prev,
      spend_limit: newLimit,
      allowlist: newAllowlist
    }));
    await updateDbPolicy(newLimit, newAllowlist);
  };

  // Core Spend Enforcement Logic
  const handleSendSpendRequest = async ({ payee, amount, agentPrompt, agentName }) => {
    const startTimestamp = Date.now();
    const selectedAgent = agentName || 'Main compute agent';

    // Boundary validation. Anything malformed is refused and written to the
    // audit log rather than thrown away silently — a rejected request is still
    // a security event the owner should be able to see.
    let safePayee, safeAmount;
    try {
      safePayee = sanitizePayee(payee);
      safeAmount = sanitizeAmount(amount);
    } catch (err) {
      if (!(err instanceof InvalidRequestError)) throw err;
      const latencyMs = Date.now() - startTimestamp;
      const rejected = await saveTransactionToDb({
        id: nextTxId(),
        payee: String(payee ?? 'unknown').slice(0, 120),
        amount: Number.isFinite(Number(amount)) ? Number(amount) : 0,
        status: 'blocked',
        reason: `BLOCKED before evaluation — ${err.reason}`,
        riskScore: 100,
        aiReasoning: `Request refused at the input boundary: ${err.reason} It never reached the escalation cascade.`,
        agentPrompt: agentPrompt || '',
        agentName: selectedAgent,
        decidedBy: 'validator',
        threatLevel: 'HIGH',
        latencyMs,
        txHash: '',
        trace: [{ layer: 0, name: 'Input Validator', status: 'BLOCK', detail: err.reason }],
        timestamp: new Date().toISOString(),
      });
      rejected.decidedBy = 'validator';
      rejected.trace = [{ layer: 0, name: 'Input Validator', status: 'BLOCK', detail: err.reason }];
      setTransactions(prev => withTx(prev, rejected));
      return rejected;
    }
    payee = safePayee;
    amount = safeAmount;
    // ─── IN-FLIGHT PROCESSING WINDOW (3 seconds) ─────────────────────────────
    // This window allows the owner to freeze mid-transaction — Bonus metric.
    const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setPendingTxs(prev => [{ id: pendingId, payee, amount, agentPrompt, startedAt: Date.now() }, ...prev]);

    await new Promise(resolve => setTimeout(resolve, 3000));

    // Remove from pending queue
    setPendingTxs(prev => prev.filter(t => t.id !== pendingId));

    // Check if wallet was FROZEN during the processing window — IN-FLIGHT REVOCATION
    if (policyRef.current.is_frozen) {
      const latencyMs = Date.now() - startTimestamp;
      const revokedTx = {
        id: nextTxId(),
        payee,
        amount,
        status: 'revoked',
        reason: 'IN-FLIGHT REVOKED — transaction cancelled mid-execution by the owner kill switch.',
        riskScore: 55,
        aiReasoning: `Transaction to "${payee}" (${money(amount)}) was actively processing when the owner activated the kill switch. Access revoked mid-execution — funds protected.`,
        agentPrompt: agentPrompt || '',
        agentName: selectedAgent,
        decidedBy: 'human',
        threatLevel: 'HIGH',
        latencyMs,
        txHash: '',
        timestamp: new Date().toISOString()
      };
      const savedRevoked = await saveTransactionToDb(revokedTx);
      setTransactions(prev => withTx(prev, savedRevoked));
      return savedRevoked;
    }
    // ─────────────────────────────────────────────────────────────────────────

    // 1. Run the 3-layer escalation cascade: Agent 1 → Agent 2 → Human
    const currentPolicy = policyRef.current;
    const result = await runEscalation({
      payee,
      amount,
      policy: currentPolicy,
      agentPrompt,
      groqApiKey,
      geminiApiKey,
      agentHealth,
    });
    setLastResult(result);

    const riskScore = result.riskScore;
    const aiReasoning = result.summary;

    const approved = result.action === DECISION.APPROVE;
    const latencyMs = Date.now() - startTimestamp;

    let threatLevel = 'LOW';
    if (riskScore >= 75) threatLevel = 'EXTREME';
    else if (riskScore >= 50) threatLevel = 'HIGH';
    else if (riskScore >= 30) threatLevel = 'MEDIUM';

    const txHash = approved 
      ? '0x' + Array.from({length: 64}, () => Math.floor(Math.random()*16).toString(16)).join('')
      : '';

    // ── LAYER 3 · HUMAN — held for owner decision (no money moves yet) ──
    if (result.action === DECISION.HOLD) {
      const heldItem = {
        id: `held-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        payee,
        amount,
        agentPrompt: agentPrompt || '',
        agentName: selectedAgent,
        result: {
          ...result,
          threatLevel,
          latencyMs,
        },
      };
      // The agent keeps working; risky requests wait in the queue. Dedupe identical ones.
      setHumanQueue(prev =>
        prev.some(h => h.payee === payee && h.amount === amount) ? prev : [heldItem, ...prev]
      );
      return heldItem;
    }

    // ── AUTO-KILL (from Layer 1 reflex or Layer 2 deep analysis) ──
    if (result.action === DECISION.FREEZE && !currentPolicy.is_frozen) {
      setPolicy(prev => ({ ...prev, is_frozen: true }));
      await updateDbFreeze(true);
      setIsSimulating(false);
      setAutoKillEvent({
        payee,
        amount,
        riskScore,
        aiReasoning,
        timestamp: new Date().toISOString(),
      });
    }

    const txObj = {
      id: nextTxId(),
      payee,
      amount,
      status: approved ? 'approved' : 'blocked',
      reason: result.summary,
      riskScore,
      aiReasoning,
      agentPrompt: agentPrompt || '',
      agentName: selectedAgent,
      decidedBy: result.decidedBy,
      threatLevel,
      latencyMs,
      txHash,
      trace: result.trace,
      timestamp: new Date().toISOString()
    };

    const savedTx = await saveTransactionToDb(txObj);
    savedTx.decidedBy = result.decidedBy;
    savedTx.trace = result.trace;

    if (approved) {
      setPolicy(prev => ({
        ...prev,
        daily_spent: prev.daily_spent + amount
      }));
    }

    setTransactions(prev => withTx(prev, savedTx));
    return savedTx;
  };

  // Keep the simulator pointed at the current handler. Effects flush before any
  // interval tick, so the ref is always populated by the time the timer fires.
  useEffect(() => { sendSpendRef.current = handleSendSpendRequest; });

  // Owner resolves a held (Layer 3) transaction: approve releases funds, reject blocks.
  const handleHumanDecision = async (heldId, decision) => {
    const item = humanQueue.find(h => h.id === heldId);
    if (!item) return;
    setHumanQueue(prev => prev.filter(h => h.id !== heldId));

    const approved = decision === 'approve';
    const txHash = approved 
      ? '0x' + Array.from({length: 64}, () => Math.floor(Math.random()*16).toString(16)).join('')
      : '';

    const txObj = {
      id: nextTxId(),
      payee: item.payee,
      amount: item.amount,
      status: approved ? 'approved' : 'blocked',
      reason: approved
        ? `APPROVED at Layer 3 — released by the wallet owner after human review.`
        : `REJECTED at Layer 3 — denied by the wallet owner after human review.`,
      riskScore: item.result?.riskScore ?? 50,
      aiReasoning: item.result?.summary || '',
      agentPrompt: item.agentPrompt || '',
      agentName: item.agentName || 'Main compute agent',
      decidedBy: 'human',
      threatLevel: item.result?.threatLevel || 'MEDIUM',
      latencyMs: item.result?.latencyMs || 0,
      txHash,
      trace: [...(item.result?.trace || []), {
        layer: 3, name: 'Human · Wallet Owner', status: approved ? 'APPROVE' : 'REJECT',
        detail: 'resolved by the human-in-the-loop'
      }],
      timestamp: new Date().toISOString()
    };

    const savedTx = await saveTransactionToDb(txObj);
    savedTx.decidedBy = 'human';
    savedTx.trace = txObj.trace;

    if (approved) {
      setPolicy(prev => ({ ...prev, daily_spent: prev.daily_spent + item.amount }));
    }
    setTransactions(prev => withTx(prev, savedTx));
  };

  /**
   * Apply a policy change the owner has explicitly confirmed in the console.
   *
   * Only ever reached from the owner's confirmation click. The autonomous spend
   * path has no route into this function, so an agent — or a prompt injected
   * into one — cannot widen its own limit or allowlist a payee.
   */
  const handleOwnerCommand = async (apply) => {
    if (!apply) return;
    const current = policyRef.current;

    switch (apply.kind) {
      case 'set_limit':
        await handleUpdatePolicy(apply.limit, current.allowlist);
        break;
      case 'allow_payee':
        await handleUpdatePolicy(current.spend_limit, [...current.allowlist, apply.payee]);
        break;
      case 'remove_payee':
        await handleUpdatePolicy(current.spend_limit, current.allowlist.filter(p => p !== apply.payee));
        break;
      case 'freeze':
        if (!current.is_frozen) await handleToggleFreeze();
        break;
      case 'unfreeze':
        if (current.is_frozen) await handleToggleFreeze();
        break;
      default:
        break;
    }
  };

  // Simulate an agent going offline / recovering (failover demo).
  const handleToggleAgent = (agentId) => {
    setAgentHealth(prev => ({ ...prev, [agentId]: !prev[agentId] }));
  };

  // Automated Agent Simulator Loop
  //
  // The step index lives in a ref, and `policy` is deliberately NOT a dependency.
  // Previously every approved spend changed `policy`, which tore the interval
  // down and restarted the sequence at step 0 — so the agent only ever replayed
  // its first scenario. The request handler reads `policyRef.current` anyway,
  // so it always sees fresh policy without the effect needing to re-run.
  useEffect(() => {
    if (!isSimulating) {
      if (simulationRef.current) clearInterval(simulationRef.current);
      return;
    }

    simulationRef.current = setInterval(() => {
      const item = SIM_ATTEMPTS[simStepRef.current % SIM_ATTEMPTS.length];
      simStepRef.current += 1;
      sendSpendRef.current({
        payee: item.payee,
        amount: item.amount,
        agentPrompt: item.prompt,
        agentName: item.agentName,
      });
    }, 3500);

    return () => {
      if (simulationRef.current) clearInterval(simulationRef.current);
    };
  }, [isSimulating]);

  // Reset State
  const handleReset = async () => {
    setIsSimulating(false);
    simStepRef.current = 0;
    setPolicy(prev => ({ ...prev, daily_spent: 0, is_frozen: false }));
    setTransactions([]);
    setPendingTxs([]);
    setAutoKillEvent(null);
    setHumanQueue([]);
    setLastResult(null);
    setAgentHealth({ agent1: true, agent2: true });
    await updateDbFreeze(false);
    await updateDbPolicy(50000, ['vendor-a.com', 'vendor-b.com', 'cloud-compute.io', 'aws.amazon.com', 'github.com']);
  };

  return (
    <div className="relative min-h-screen">
      {/* Hairline reading progress across the top */}
      <div
        className="fixed top-0 left-0 z-50 h-[2px] bg-lime pointer-events-none"
        style={{
          width: `${scrollProgress * 100}%`,
          boxShadow: '0 0 12px var(--lime)',
          transition: 'width 0.1s linear',
        }}
      />

      <div className="relative z-10 px-4 md:px-8">
        <Header
          isFrozen={policy.is_frozen}
          dbConnected={dbConnected}
          groqApiKey={groqApiKey}
          geminiApiKey={geminiApiKey}
          transactions={transactions}
          onOpenGroqModal={() => setShowGroqModal(true)}
          onReset={handleReset}
        />

        <main className="max-w-7xl mx-auto flex flex-col">
          {/* ── Scroll micro-interaction hero ── */}
          <Hero isFrozen={policy.is_frozen} />

          {/* ── Console ── */}
          <SectionRule label="Live Enforcement Console" index="01" />

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 pb-8">
            <div className="lg:col-span-5 flex flex-col gap-5">
              <KillSwitchButton
                isFrozen={policy.is_frozen}
                policy={policy}
                onToggleFreeze={handleToggleFreeze}
              />
              <PolicyCard
                policy={policy}
                onUpdatePolicy={handleUpdatePolicy}
              />
              <EscalationPanel
                agentHealth={agentHealth}
                onToggleAgent={handleToggleAgent}
                humanQueue={humanQueue}
                onHumanDecision={handleHumanDecision}
                lastResult={lastResult}
              />
            </div>

            <div className="lg:col-span-7 flex flex-col gap-5">
              <AgentPlayground
                policy={policy}
                onOwnerCommand={handleOwnerCommand}
                isFrozen={policy.is_frozen}
                isSimulating={isSimulating}
                onToggleSimulation={() => setIsSimulating(!isSimulating)}
                onSendSpendRequest={handleSendSpendRequest}
                groqApiKey={groqApiKey}
                geminiApiKey={geminiApiKey}
              />

              <TransactionFeed
                transactions={transactions}
                pendingTxs={pendingTxs}
                onSelectTransaction={(tx) => setSelectedTx(tx)}
              />
            </div>
          </div>

          <Footer />
        </main>
      </div>

      {/* Auto-Kill Alert Banner (fixed at top) */}
      <AutoKillAlert
        event={autoKillEvent}
        isFrozen={policy.is_frozen}
        onUnfreeze={handleToggleFreeze}
        onDismiss={() => setAutoKillEvent(null)}
      />

      {/* Transaction Audit Modal */}
      {selectedTx && (
        <TransactionModal
          transaction={selectedTx}
          onClose={() => setSelectedTx(null)}
        />
      )}

      {/* Groq AI Config Modal */}
      {showGroqModal && (
        <GroqConfigModal
          apiKey={groqApiKey}
          onSaveApiKey={(key) => setGroqApiKey(key)}
          geminiApiKey={geminiApiKey}
          onSaveGeminiApiKey={(key) => setGeminiApiKey(key)}
          onClose={() => setShowGroqModal(false)}
        />
      )}
    </div>
  );
}

/** Numbered section rule with a tick strip — the panel-seam motif. */
function SectionRule({ label, index }) {
  return (
    <div className="flex items-center gap-4 py-7">
      <span className="font-mono text-[10px] text-lime tabular-nums">{index}</span>
      <span className="label whitespace-nowrap">{label}</span>
      <span className="tickrail flex-1 opacity-30" />
      <span className="w-1.5 h-1.5 rounded-full bg-lime anim-blink flex-shrink-0" />
    </div>
  );
}

const MARQUEE_ITEMS = [
  'Wallet-layer enforcement',
  'Agent 1 · rules',
  'Agent 2 · Groq risk',
  'Layer 3 · human release',
  'In-flight revocation',
  'Prompt-injection kill',
  'Allowlist boundary matching',
  'Fail-closed on agent outage',
];

function Footer() {
  return (
    <footer className="border-t border-hair pt-8 pb-10 flex flex-col gap-7">
      {/* Capability marquee */}
      <div className="marquee-mask overflow-hidden">
        <div className="marquee-track gap-3">
          {[...MARQUEE_ITEMS, ...MARQUEE_ITEMS].map((item, i) => (
            <span
              key={i}
              className="flex items-center gap-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted whitespace-nowrap"
            >
              <span className="w-1 h-1 rounded-full bg-lime flex-shrink-0" />
              {item}
            </span>
          ))}
        </div>
      </div>

      <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="text-center sm:text-left">
          <div className="display text-sm text-ink">Halt</div>
          <div className="text-[11px] text-ink-muted mt-0.5">
            Autonomous AI agent wallet security engine
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="badge badge-muted">React + Vite</span>
          <span className="badge badge-muted">Supabase</span>
          <span className="badge badge-ok">Groq AI</span>
        </div>

        <div className="font-mono text-[10px] text-ink-faint">© 2026 ByteX</div>
      </div>
    </footer>
  );
}
