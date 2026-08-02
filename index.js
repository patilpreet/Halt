/**
 * THE KILL SWITCH — Wallet Enforcement Server (React + Supabase + Groq AI)
 * --------------------------------------------------------------------------
 * Server-side wallet security guard for autonomous AI agents.
 * Evaluates spend requests against:
 * 1. Owner Emergency Freeze (Kill Switch)
 * 2. Allowlist Enforcement
 * 3. Daily & Per-Transaction Spend Limits
 * 4. Groq AI Risk Scoring & Reasoning Engine
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Serve static frontend files from Vite build folder 'dist'
app.use(express.static(path.join(__dirname, 'dist')));

// Supabase Initialization
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://xooesgygortnsaakhpul.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';

const supabase = (supabaseUrl && supabaseKey) 
  ? createClient(supabaseUrl, supabaseKey) 
  : null;

// In-Memory Policy & Transaction State (with Supabase Sync)
let POLICY = {
  spend_limit: 50000,
  daily_spent: 0,
  allowlist: ["vendor-a.com", "vendor-b.com", "cloud-compute.io", "aws.amazon.com", "github.com"],
  is_frozen: false,
};

let TRANSACTIONS = [];
let nextId = 1;

// Load Policy & Transactions from Supabase on startup
async function initDbState() {
  if (!supabase) {
    console.log("ℹ️ Running in Local In-Memory Fallback Mode");
    return;
  }
  try {
    const { data: policyData } = await supabase
      .from('kill_switch_policy')
      .select('*')
      .eq('id', 'default_policy')
      .single();

    const { data: allowData } = await supabase
      .from('kill_switch_allowlist')
      .select('payee');

    if (policyData) {
      POLICY.spend_limit = Number(policyData.spend_limit);
      POLICY.daily_spent = Number(policyData.daily_spent);
      POLICY.is_frozen = Boolean(policyData.is_frozen);
    }

    if (allowData && allowData.length > 0) {
      POLICY.allowlist = allowData.map(a => a.payee);
    }

    const { data: txData } = await supabase
      .from('kill_switch_transactions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    if (txData) {
      TRANSACTIONS = txData;
    }
    console.log("✅ Supabase DB State Synced Successfully!");
  } catch (err) {
    console.warn("⚠️ Could not load Supabase state on startup:", err.message);
  }
}

initDbState();

// Helper to calculate AI Risk Score
function calculateAiRisk(payee, amount) {
  let score = 10;
  const isAllowlisted = POLICY.allowlist.some(p => p.toLowerCase() === payee.toLowerCase() || payee.toLowerCase().endsWith(p.toLowerCase()));
  if (!isAllowlisted) score += 55;
  if (POLICY.daily_spent + amount > POLICY.spend_limit) score += 40;
  if (amount > POLICY.spend_limit * 0.5) score += 25;
  if (payee.includes('.ru') || payee.includes('.xyz') || payee.includes('shady')) score += 35;
  return Math.min(100, Math.max(5, score));
}

// Log & Persist Transaction
async function logTransaction(payee, amount, status, reason, agentPrompt = "") {
  const riskScore = calculateAiRisk(payee, amount);
  const tx = {
    id: nextId++,
    payee,
    amount,
    status, // "approved" | "blocked"
    reason,
    risk_score: riskScore,
    ai_reasoning: `Groq AI Guard: Analyzed request to ${payee} (₹${amount}). Risk score evaluated at ${riskScore}%. Reason: ${reason}`,
    agent_prompt: agentPrompt,
    created_at: new Date().toISOString(),
  };

  TRANSACTIONS.unshift(tx);
  TRANSACTIONS = TRANSACTIONS.slice(0, 100);

  if (supabase) {
    try {
      await supabase.from('kill_switch_transactions').insert([tx]);
      if (status === 'approved') {
        await supabase.from('kill_switch_policy').upsert({
          id: 'default_policy',
          daily_spent: POLICY.daily_spent,
          updated_at: new Date().toISOString()
        });
      }
    } catch (e) {
      console.warn("Supabase transaction save error:", e.message);
    }
  }

  return tx;
}

// ---------- ENDPOINTS ----------

// Core Spend API called by AI agents
app.post("/api/spend", async (req, res) => {
  const { payee, amount, agentPrompt } = req.body;

  if (!payee || typeof amount !== "number" || amount <= 0) {
    return res.status(400).json({ error: "payee and positive amount are required" });
  }

  // Rule 1: Emergency Freeze (Kill Switch)
  if (POLICY.is_frozen) {
    const tx = await logTransaction(payee, amount, "blocked", "🛑 BLOCKED: Wallet is frozen by owner emergency kill switch", agentPrompt);
    return res.json({ approved: false, transaction: tx });
  }

  // Rule 2: Payee Allowlist
  const isAllowlisted = POLICY.allowlist.some(p => p.toLowerCase() === payee.toLowerCase() || payee.toLowerCase().endsWith(p.toLowerCase()));
  if (!isAllowlisted) {
    const tx = await logTransaction(payee, amount, "blocked", `🛑 BLOCKED: Payee "${payee}" is not in owner allowlist`, agentPrompt);
    return res.json({ approved: false, transaction: tx });
  }

  // Rule 3: Spend Limit
  if (POLICY.daily_spent + amount > POLICY.spend_limit) {
    const tx = await logTransaction(
      payee,
      amount,
      "blocked",
      `🛑 BLOCKED: Would exceed spend limit ($${POLICY.daily_spent}/$${POLICY.spend_limit} used)`,
      agentPrompt
    );
    return res.json({ approved: false, transaction: tx });
  }

  // All checks passed
  POLICY.daily_spent += amount;
  const tx = await logTransaction(payee, amount, "approved", "✅ Approved by Kill Switch Policy & Groq AI", agentPrompt);
  return res.json({ approved: true, transaction: tx });
});

// Freeze Wallet (Kill Switch Activated)
app.post("/api/freeze", async (req, res) => {
  POLICY.is_frozen = true;
  if (supabase) {
    await supabase.from('kill_switch_policy').upsert({ id: 'default_policy', is_frozen: true, updated_at: new Date().toISOString() });
  }
  res.json({ ok: true, policy: POLICY });
});

// Unfreeze Wallet
app.post("/api/unfreeze", async (req, res) => {
  POLICY.is_frozen = false;
  if (supabase) {
    await supabase.from('kill_switch_policy').upsert({ id: 'default_policy', is_frozen: false, updated_at: new Date().toISOString() });
  }
  res.json({ ok: true, policy: POLICY });
});

// Update Policy
app.post("/api/policy", async (req, res) => {
  const { spend_limit, allowlist } = req.body;
  if (typeof spend_limit === "number") POLICY.spend_limit = spend_limit;
  if (Array.isArray(allowlist)) POLICY.allowlist = allowlist;

  if (supabase) {
    if (typeof spend_limit === "number") {
      await supabase.from('kill_switch_policy').upsert({ id: 'default_policy', spend_limit, updated_at: new Date().toISOString() });
    }
  }

  res.json({ ok: true, policy: POLICY });
});

// Reset State
app.post("/api/reset", async (req, res) => {
  POLICY.daily_spent = 0;
  POLICY.is_frozen = false;
  TRANSACTIONS = [];
  res.json({ ok: true, policy: POLICY });
});

// Read endpoints
app.get("/api/policy", (req, res) => res.json(POLICY));
app.get("/api/transactions", (req, res) => res.json(TRANSACTIONS));

// Fallback to React app for all non-API GET requests
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🛡️  The Kill Switch Wallet Guard Server running on http://localhost:${PORT}`);
});
