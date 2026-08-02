import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://xooesgygortnsaakhpul.supabase.co';
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const supabase = (supabaseUrl && supabaseKey) 
  ? createClient(supabaseUrl, supabaseKey) 
  : null;

// Local fallback state in case Supabase table/network fails
let localPolicy = {
  spend_limit: 50000,
  daily_spent: 0,
  allowlist: ['vendor-a.com', 'vendor-b.com', 'cloud-compute.io', 'aws.amazon.com', 'github.com'],
  is_frozen: false
};

let localTransactions = [];
let nextId = 1;

export async function fetchPolicyFromDb() {
  if (!supabase) return localPolicy;
  try {
    const { data: policyData, error: policyErr } = await supabase
      .from('kill_switch_policy')
      .select('*')
      .eq('id', 'default_policy')
      .single();

    const { data: allowData, error: allowErr } = await supabase
      .from('kill_switch_allowlist')
      .select('payee');

    if (policyErr || !policyData) return localPolicy;

    const allowlist = allowData && allowData.length > 0 
      ? allowData.map(a => a.payee) 
      : localPolicy.allowlist;

    localPolicy = {
      spend_limit: Number(policyData.spend_limit),
      daily_spent: Number(policyData.daily_spent),
      is_frozen: Boolean(policyData.is_frozen),
      allowlist
    };
    return localPolicy;
  } catch (err) {
    console.warn('Using local policy fallback:', err.message);
    return localPolicy;
  }
}

export async function fetchTransactionsFromDb() {
  if (!supabase) return localTransactions;
  try {
    const { data, error } = await supabase
      .from('kill_switch_transactions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error || !data) return localTransactions;
    return data;
  } catch (err) {
    console.warn('Using local transactions fallback:', err.message);
    return localTransactions;
  }
}

export async function updateDbFreeze(isFrozen) {
  localPolicy.is_frozen = isFrozen;
  if (!supabase) return true;
  try {
    await supabase
      .from('kill_switch_policy')
      .upsert({ id: 'default_policy', is_frozen: isFrozen, updated_at: new Date().toISOString() });
    return true;
  } catch (err) {
    console.error('Supabase freeze update failed:', err);
    return false;
  }
}

export async function updateDbPolicy(spendLimit, newAllowlist) {
  if (typeof spendLimit === 'number') localPolicy.spend_limit = spendLimit;
  if (Array.isArray(newAllowlist)) localPolicy.allowlist = newAllowlist;

  if (!supabase) return true;
  try {
    if (typeof spendLimit === 'number') {
      await supabase
        .from('kill_switch_policy')
        .upsert({ id: 'default_policy', spend_limit: spendLimit, updated_at: new Date().toISOString() });
    }
    if (Array.isArray(newAllowlist)) {
      // Refresh allowlist entries
      await supabase.from('kill_switch_allowlist').delete().neq('payee', '___dummy___');
      const inserts = newAllowlist.map(p => ({ payee: p }));
      if (inserts.length > 0) {
        await supabase.from('kill_switch_allowlist').insert(inserts);
      }
    }
    return true;
  } catch (err) {
    console.error('Supabase policy update failed:', err);
    return false;
  }
}

export async function saveTransactionToDb(tx) {
  const transactionObj = {
    id: tx.id || nextId++,
    payee: tx.payee,
    amount: tx.amount,
    status: tx.status,
    reason: tx.reason || '',
    risk_score: tx.riskScore ?? tx.risk_score ?? 0,
    ai_reasoning: tx.aiReasoning ?? tx.ai_reasoning ?? '',
    agent_prompt: tx.agentPrompt ?? tx.agent_prompt ?? '',
    agent_name: tx.agentName ?? tx.agent_name ?? 'Main compute agent',
    decided_by: tx.decidedBy ?? tx.decided_by ?? 'agent1',
    threat_level: tx.threatLevel ?? tx.threat_level ?? 'LOW',
    latency_ms: tx.latencyMs ?? tx.latency_ms ?? 0,
    tx_hash: tx.txHash ?? tx.tx_hash ?? '',
    created_at: tx.timestamp ?? tx.created_at ?? new Date().toISOString()
  };

  localTransactions.unshift(transactionObj);
  localTransactions = localTransactions.slice(0, 100);

  if (tx.status === 'approved') {
    localPolicy.daily_spent += tx.amount;
  }

  if (!supabase) return transactionObj;

  try {
    const { data, error } = await supabase.from('kill_switch_transactions').insert([transactionObj]).select();
    if (!error && data && data.length > 0) {
      transactionObj.id = data[0].id;
    }
    if (tx.status === 'approved') {
      await supabase
        .from('kill_switch_policy')
        .upsert({ 
          id: 'default_policy', 
          daily_spent: localPolicy.daily_spent, 
          updated_at: new Date().toISOString() 
        });
    }
  } catch (err) {
    console.warn('Supabase save transaction failed, kept in local state:', err.message);
  }

  return transactionObj;
}
