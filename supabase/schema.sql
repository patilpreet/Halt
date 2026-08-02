-- Supabase Schema for The Kill Switch (Wallet Enforcement for Autonomous Agents)
-- Run this in your Supabase SQL Editor if using real Supabase backend.

create table if not exists public.kill_switch_policy (
  id text primary key default 'default_policy',
  spend_limit numeric default 50000.00,
  daily_spent numeric default 0.00,
  is_frozen boolean default false,
  updated_at timestamptz default now()
);

create table if not exists public.kill_switch_allowlist (
  id uuid primary key default gen_random_uuid(),
  payee text unique not null,
  added_at timestamptz default now()
);

create table if not exists public.kill_switch_transactions (
  id serial primary key,
  payee text not null,
  amount numeric not null,
  status text not null, -- 'approved' | 'blocked' | 'revoked'
  reason text default '',
  risk_score int default 0,
  ai_reasoning text default '',
  agent_prompt text default '',
  agent_name text default 'Main compute agent',
  decided_by text default 'agent1',
  threat_level text default 'LOW',
  latency_ms integer default 0,
  tx_hash text default '',
  created_at timestamptz default now()
);

-- Enable RLS and permissive policies for anon key usage
alter table public.kill_switch_policy enable row level security;
alter table public.kill_switch_allowlist enable row level security;
alter table public.kill_switch_transactions enable row level security;

drop policy if exists "anon_policy" on public.kill_switch_policy;
create policy "anon_policy" on public.kill_switch_policy for all using (true) with check (true);

drop policy if exists "anon_allowlist" on public.kill_switch_allowlist;
create policy "anon_allowlist" on public.kill_switch_allowlist for all using (true) with check (true);

drop policy if exists "anon_transactions" on public.kill_switch_transactions;
create policy "anon_transactions" on public.kill_switch_transactions for all using (true) with check (true);

-- Seed initial policy if empty
insert into public.kill_switch_policy (id, spend_limit, daily_spent, is_frozen)
values ('default_policy', 50000.00, 0.00, false)
on conflict (id) do nothing;

-- Seed default allowlisted payees
insert into public.kill_switch_allowlist (payee)
values 
  ('vendor-a.com'),
  ('vendor-b.com'),
  ('cloud-compute.io'),
  ('aws.amazon.com'),
  ('github.com')
on conflict (payee) do nothing;
