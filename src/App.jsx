import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Loader2 } from 'lucide-react';

import { Header } from './components/Header';
import { Hero } from './components/Hero';
import { KillSwitchButton } from './components/KillSwitchButton';
import { PolicyCard } from './components/PolicyCard';
import { AgentPlayground } from './components/AgentPlayground';
import { TransactionFeed } from './components/TransactionFeed';
import { TransactionModal } from './components/TransactionModal';
import { AutoKillAlert } from './components/AutoKillAlert';
import { EscalationPanel } from './components/EscalationPanel';
import { TrustPanel } from './components/TrustPanel';
import { AuthPage } from './components/AuthPage';

import { getSession, onAuthChange, signOut } from './lib/supabase';
import {
  bootstrapWallet, fetchSnapshot, setFrozen, setPolicy,
  addCounterparty, removeCounterparty, resolveReview, voidHold,
  registerAgent, revokeAgent, verifyChain, sweepExpired, callGateway,
} from './lib/api';
import {
  exportPublicJwk, getStoredAgentId, storeAgentId, forgetAgent,
  signSpendRequest, signTamperedRequest,
} from './lib/agentKey';
import { toPaise, toRupees } from './lib/intent';
import { playFreezeAlert } from './lib/sound';
import { useScrollProgress } from './lib/motion';

/**
 * Halt — owner console.
 *
 * What this component is NOT able to do, by construction:
 *
 *   · decide whether a payment is permitted
 *   · add to the amount spent
 *   · turn the kill switch off
 *
 * All three used to live here. They now live in Postgres, and this file can
 * only ask. Every handler below is a call to a database function that
 * re-derives the wallet from the session and re-checks policy for itself. You
 * could rewrite this entire file to approve everything and nothing about what
 * the agent is able to spend would change.
 */

/** The autonomous agent's scripted run — one spend attempt per tick. */
const SIM_ATTEMPTS = [
  { payee: 'vendor-a.com',       amount: 3500,  prompt: 'Purchase micro tier instance' },
  { payee: 'aws.amazon.com',     amount: 24000, prompt: 'Scale production S3 storage' },
  { payee: 'cloud-compute.io',   amount: 9000,  prompt: 'Renew container registry' },
  { payee: 'unknown-hacker.xyz', amount: 4500,  prompt: 'Download unverified scraper tool' },
  { payee: 'vendor-b.com',       amount: 60000, prompt: 'Renew SaaS analytics sub' },
  { payee: 'shady-endpoint.ru',  amount: 1800,  prompt: 'Obtain proxy IP pool' },
];

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = still checking

  useEffect(() => {
    let alive = true;
    getSession().then((s) => { if (alive) setSession(s); });
    const unsub = onAuthChange((s) => setSession(s));
    return () => { alive = false; unsub(); };
  }, []);

  if (session === undefined) return <Booting label="Restoring session" />;
  if (!session) return <AuthPage />;
  return <Console key={session.user.id} session={session} />;
}

function Booting({ label }) {
  return (
    <div className="min-h-screen grid place-items-center">
      <div className="flex items-center gap-2.5 text-ink-muted">
        <Loader2 className="w-4 h-4 animate-spin text-lime" />
        <span className="font-mono text-[11px] tracking-wide">{label}…</span>
      </div>
    </div>
  );
}

/* ══════════════════════════════ console ══════════════════════════════ */

const threatFor = (risk) =>
  risk >= 75 ? 'EXTREME' : risk >= 50 ? 'HIGH' : risk >= 30 ? 'MEDIUM' : 'LOW';

function Console({ session }) {
  const [snapshot, setSnapshot] = useState(null);
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState(null);
  const [selectedTx, setSelectedTx] = useState(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const [autoKillEvent, setAutoKillEvent] = useState(null);
  const [lastResult, setLastResult] = useState(null);
  const [agentId, setAgentId] = useState(getStoredAgentId());
  const [chain, setChain] = useState(null);
  const [busy, setBusy] = useState(false);

  const scrollProgress = useScrollProgress();
  const simulationRef = useRef(null);
  const simStepRef = useRef(0);
  const sendRef = useRef(null);

  /* ── snapshot ─────────────────────────────────────────────── */

  const refresh = useCallback(async () => {
    try {
      const snap = await fetchSnapshot();
      setSnapshot(snap);
      return snap;
    } catch (err) {
      setFatal(err.message);
      return null;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await bootstrapWallet();
        if (!alive) return;
        await refresh();
      } catch (err) {
        if (alive) setFatal(err.message);
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => { alive = false; };
  }, [refresh]);

  // A 2s poll rather than per-table realtime: the snapshot RPC is one round
  // trip and returns a self-consistent view, whereas separate realtime events
  // can arrive in an order that renders a spend before the wallet total that
  // accounts for it.
  useEffect(() => {
    if (!ready) return;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [ready, refresh]);

  const wallet = snapshot?.wallet ?? null;
  const walletId = wallet?.id ?? null;

  // Release holds a dead gateway left reserved. Runs on the console's heartbeat
  // so a crashed edge function cannot permanently eat the owner's budget.
  useEffect(() => {
    if (!walletId) return;
    const t = setInterval(() => { sweepExpired(walletId).catch(() => {}); }, 15000);
    return () => clearInterval(t);
  }, [walletId]);

  /* ── derived view models ──────────────────────────────────── */

  // The engine speaks integer paise; the UI speaks rupees. Convert once, here.
  const policy = wallet
    ? {
        spend_limit: toRupees(wallet.limit_paise),
        daily_spent: toRupees(wallet.spent_paise),
        allowlist: snapshot.allowlist ?? [],
        is_frozen: wallet.frozen,
        window_seconds: wallet.window_seconds,
        hold_seconds: wallet.hold_seconds,
      }
    : {
        spend_limit: 0, daily_spent: 0, allowlist: [],
        is_frozen: false, window_seconds: 86400, hold_seconds: 3,
      };

  const spends = snapshot?.spends ?? [];
  const agents = snapshot?.agents ?? [];
  const activeAgent = agents.find((a) => a.id === agentId && a.status === 'active') ?? null;

  const toTx = (s) => {
    const risk = s.risk_score ?? 0;
    return {
      id: s.id,
      payee: s.host,
      amount: toRupees(s.amount_paise),
      status: s.status,
      reason: s.reason,
      riskScore: risk,
      aiScore: s.ai_score,
      policyFloor: s.policy_floor,
      aiReasoning: s.ai_reasoning || s.reason,
      threatLevel: threatFor(risk),
      decidedBy: s.decided_by,
      trace: s.trace ?? [],
      agentPrompt: s.agent_prompt,
      agentName: s.agent_label || 'Unregistered agent',
      timestamp: s.created_at,
      expiresAt: s.expires_at,
      settledAt: s.settled_at,
    };
  };

  // Settled history, in-flight holds, and the human queue are three views of
  // one table — which is why they can never disagree with each other. The old
  // build kept them in three separate pieces of React state and they did.
  const transactions = spends.filter((s) => !['held', 'review'].includes(s.status)).map(toTx);
  const pendingTxs = spends.filter((s) => s.status === 'held').map(toTx);
  const humanQueue = spends.filter((s) => s.status === 'review').map(toTx);

  /* ── agent identity ───────────────────────────────────────── */

  const ensureAgent = useCallback(async () => {
    const stored = getStoredAgentId();
    const live = (snapshot?.agents ?? []).find((a) => a.id === stored);
    if (stored && live?.status === 'active') return stored;

    // Either this browser has no agent, or the owner revoked the one it had.
    // A revoked agent never silently comes back: discard the keypair so the
    // revocation is permanent for that identity and a fresh one is registered.
    if (stored && live && live.status !== 'active') await forgetAgent();

    const jwk = await exportPublicJwk();
    const res = await registerAgent('Browser demo agent', jwk);
    if (!res?.agent_id) throw new Error('Agent registration failed.');
    storeAgentId(res.agent_id);
    setAgentId(res.agent_id);
    await refresh();
    return res.agent_id;
  }, [snapshot, refresh]);

  /* ── the spend path ───────────────────────────────────────── */

  const sendSpend = useCallback(async ({ payee, amount, agentPrompt, tamper }) => {
    const id = await ensureAgent();
    const paise = toPaise(amount);

    // The agent signs, the gateway verifies, the engine decides. This function
    // does none of those three things.
    const signed = tamper
      ? await signTamperedRequest({
          agentId: id,
          host: payee,
          signedAmountPaise: toPaise(tamper.signedAmount),
          sentAmountPaise: paise,
          prompt: agentPrompt,
        })
      : await signSpendRequest({ agentId: id, host: payee, amountPaise: paise, prompt: agentPrompt });

    const result = await callGateway(signed);
    setLastResult(result);

    if (result.decision === 'frozen') {
      playFreezeAlert();
      setIsSimulating(false);
      setAutoKillEvent({
        payee,
        amount,
        riskScore: result.risk_score,
        aiReasoning: result.reasoning || result.reason,
        timestamp: new Date().toISOString(),
      });
    }

    await refresh();
    return result;
  }, [ensureAgent, refresh]);

  useEffect(() => { sendRef.current = sendSpend; });

  /* ── owner actions ────────────────────────────────────────── */

  const guard = async (fn) => {
    setBusy(true);
    try {
      return await fn();
    } catch (err) {
      setFatal(err.message);
      return null;
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const handleToggleFreeze = () => guard(async () => {
    const next = !policy.is_frozen;
    const res = await setFrozen(next, next ? 'Owner pressed the kill switch.' : null);
    if (next) playFreezeAlert();
    else setAutoKillEvent(null);
    return res;
  });

  const handleUpdatePolicy = (newLimitRupees, newAllowlist) => guard(async () => {
    if (Number(newLimitRupees) !== policy.spend_limit) {
      await setPolicy(toPaise(newLimitRupees));
    }
    const before = new Set(policy.allowlist);
    const after = new Set(newAllowlist);
    for (const host of after) if (!before.has(host)) await addCounterparty(host);
    for (const host of before) if (!after.has(host)) await removeCounterparty(host);
  });

  const handleHumanDecision = (spendId, decision) =>
    guard(() => resolveReview(spendId, decision === 'approve'));

  const handleRecall = (spendId) => guard(() => voidHold(spendId));

  const handleRevokeAgent = (id) => guard(async () => {
    await revokeAgent(id);
    if (id === agentId) {
      await forgetAgent();
      setAgentId(null);
    }
  });

  // Registering an agent requires an owner session. An agent can mint itself a
  // keypair all day; only the owner can grant one the right to be listened to.
  const handleRegisterExternal = async (label, jwk) => {
    const res = await registerAgent(label, jwk);
    await refresh();
    return res;
  };

  const handleVerifyChain = () => guard(async () => {
    const res = await verifyChain();
    setChain(res);
    return res;
  });

  /**
   * Owner policy changes proposed by the console parser.
   *
   * Reachable only from the owner's confirmation click. The autonomous spend
   * path has no route into here, so an agent — or a prompt injected into one —
   * cannot widen its own limit or allowlist a payee. The database enforces the
   * same thing independently: these RPCs require a session, and the agent has
   * none.
   */
  const handleOwnerCommand = async (apply) => {
    if (!apply) return;
    switch (apply.kind) {
      case 'set_limit':    return handleUpdatePolicy(apply.limit, policy.allowlist);
      case 'allow_payee':  return guard(() => addCounterparty(apply.payee));
      case 'remove_payee': return guard(() => removeCounterparty(apply.payee));
      case 'freeze':       return policy.is_frozen ? null : handleToggleFreeze();
      case 'unfreeze':     return policy.is_frozen ? handleToggleFreeze() : null;
      default:             return null;
    }
  };

  /* ── simulator ────────────────────────────────────────────── */

  useEffect(() => {
    if (!isSimulating) {
      if (simulationRef.current) clearInterval(simulationRef.current);
      return;
    }
    simulationRef.current = setInterval(() => {
      const item = SIM_ATTEMPTS[simStepRef.current % SIM_ATTEMPTS.length];
      simStepRef.current += 1;
      sendRef.current?.(item).catch(() => {});
    }, 3500);
    return () => { if (simulationRef.current) clearInterval(simulationRef.current); };
  }, [isSimulating]);

  const handleSignOut = async () => {
    setIsSimulating(false);
    await signOut();
  };

  if (!ready) return <Booting label="Opening wallet" />;

  /* ── render ───────────────────────────────────────────────── */

  return (
    <div className="relative min-h-screen">
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
          dbConnected={!fatal}
          email={session.user.email}
          transactions={transactions}
          onSignOut={handleSignOut}
        />

        <main className="max-w-7xl mx-auto flex flex-col">
          <Hero isFrozen={policy.is_frozen} />

          {fatal && (
            <div className="anim-fade mb-4 px-4 py-3 rounded-xl border border-danger/35 bg-danger/[0.06] flex items-center justify-between gap-3">
              <span className="text-[11px] text-ink-2 leading-relaxed">
                <span className="label !text-danger mr-2">Engine refused</span>
                {fatal}
              </span>
              <button onClick={() => setFatal(null)} className="btn btn-ghost !py-1 !px-2.5 !text-[10px] flex-shrink-0">
                Dismiss
              </button>
            </div>
          )}

          <SectionRule label="Live Enforcement Console" index="01" />

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 pb-8">
            <div className="lg:col-span-5 flex flex-col gap-5">
              <KillSwitchButton
                isFrozen={policy.is_frozen}
                policy={policy}
                onToggleFreeze={handleToggleFreeze}
              />
              <PolicyCard policy={policy} onUpdatePolicy={handleUpdatePolicy} />
              <TrustPanel
                agents={agents}
                activeAgentId={agentId}
                chain={chain}
                auditCount={snapshot?.audit_count ?? 0}
                onVerifyChain={handleVerifyChain}
                onRevokeAgent={handleRevokeAgent}
                onRegisterExternal={handleRegisterExternal}
                busy={busy}
              />
              <EscalationPanel
                humanQueue={humanQueue}
                onHumanDecision={handleHumanDecision}
                lastResult={lastResult}
                busy={busy}
              />
            </div>

            <div className="lg:col-span-7 flex flex-col gap-5">
              <AgentPlayground
                policy={policy}
                onOwnerCommand={handleOwnerCommand}
                isFrozen={policy.is_frozen}
                isSimulating={isSimulating}
                onToggleSimulation={() => setIsSimulating(!isSimulating)}
                onSendSpendRequest={sendSpend}
                agentRegistered={Boolean(activeAgent)}
              />

              <TransactionFeed
                transactions={transactions}
                pendingTxs={pendingTxs}
                holdSeconds={policy.hold_seconds}
                onRecall={handleRecall}
                onSelectTransaction={setSelectedTx}
              />
            </div>
          </div>

          <Footer />
        </main>
      </div>

      <AutoKillAlert
        event={autoKillEvent}
        isFrozen={policy.is_frozen}
        onUnfreeze={handleToggleFreeze}
        onDismiss={() => setAutoKillEvent(null)}
      />

      {selectedTx && <TransactionModal transaction={selectedTx} onClose={() => setSelectedTx(null)} />}
    </div>
  );
}

/* ─────────────────────────── chrome ─────────────────────────── */

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
  'Enforced in Postgres',
  'ECDSA agent identity',
  'Single-use nonces',
  'Rolling-window cap',
  'Authorize → hold → capture',
  'In-flight recall',
  'SHA-256 audit chain',
  'Owner-scoped RLS',
];

function Footer() {
  return (
    <footer className="border-t border-hair pt-8 pb-10 flex flex-col gap-7">
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
          <span className="badge badge-muted">Postgres</span>
          <span className="badge badge-ok">Groq AI</span>
        </div>

        <div className="font-mono text-[10px] text-ink-faint">© 2026 ByteX</div>
      </div>
    </footer>
  );
}
