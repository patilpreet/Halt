-- ============================================================================
-- Halt · 0001_identity.sql
-- Owners, wallets, agents, allowlist — and the RLS that makes them private.
-- ============================================================================
--
-- The rule this file establishes: a browser session can READ what it owns and
-- can WRITE nothing. Every mutation goes through a SECURITY DEFINER function in
-- 0002_engine.sql, which is the only code allowed to touch these tables.
--
-- The previous schema granted `for all using (true) with check (true)` to the
-- anon role. Because the anon key ships inside the JavaScript bundle, that made
-- `is_frozen` a publicly writable boolean — anyone could switch the kill switch
-- off with a single HTTP request. Nothing below grants a write to anon.
-- ============================================================================

create extension if not exists pgcrypto;

-- ─────────────────────────── wallets ───────────────────────────
--
-- Money is bigint paise. Never a float: 0.1 + 0.2 <> 0.3 in binary floating
-- point, and a spend limit that can drift by a rounding error is not a limit.

create table if not exists public.wallets (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users(id) on delete cascade,
  label           text not null default 'Primary wallet',

  limit_paise     bigint not null default 5000000,   -- ₹50,000
  window_seconds  integer not null default 86400,    -- rolling window, not calendar day
  hold_seconds    integer not null default 3,        -- authorize → capture delay

  frozen          boolean not null default false,
  frozen_at       timestamptz,
  frozen_reason   text,

  created_at      timestamptz not null default now(),

  constraint wallets_limit_positive check (limit_paise > 0),
  constraint wallets_window_sane    check (window_seconds between 60 and 604800),
  constraint wallets_hold_sane      check (hold_seconds between 1 and 60)
);

create index if not exists wallets_owner_idx on public.wallets(owner_id);

-- One wallet per owner keeps the demo unambiguous and means the dashboard never
-- has to ask "which wallet am I looking at".
create unique index if not exists wallets_one_per_owner on public.wallets(owner_id);

-- ─────────────────────────── agents ───────────────────────────
--
-- An agent is a public key with a spending relationship to a wallet. The
-- private half never exists server-side — the whole point is that holding the
-- key proves identity without granting authority. An agent that goes rogue is
-- revoked here, and the gateway stops accepting its signatures immediately.

create table if not exists public.agents (
  id           uuid primary key default gen_random_uuid(),
  wallet_id    uuid not null references public.wallets(id) on delete cascade,
  label        text not null default 'Autonomous agent',

  -- ECDSA P-256 public key as a JWK. Verified by the gateway edge function,
  -- which is the only thing that ever sees a signature.
  public_jwk   jsonb not null,

  status       text not null default 'active',
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz,

  constraint agents_status_enum check (status in ('active', 'revoked'))
);

create index if not exists agents_wallet_idx on public.agents(wallet_id);

-- ─────────────────────────── allowlist ───────────────────────────

create table if not exists public.counterparties (
  id          uuid primary key default gen_random_uuid(),
  wallet_id   uuid not null references public.wallets(id) on delete cascade,
  host        text not null,
  added_at    timestamptz not null default now(),

  -- Hostnames only: no scheme, no path, no port, no credentials. The gateway
  -- reduces a payee to this shape before comparing, so
  -- "https://evil.com@aws.amazon.com/x" can never present itself as the
  -- allowlisted host.
  constraint counterparties_host_shape
    check (host ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$')
);

create unique index if not exists counterparties_unique
  on public.counterparties(wallet_id, host);

-- ─────────────────────────── replay protection ───────────────────────────
--
-- A signature is only good once. Without this, anyone who observes an approved
-- request can resubmit it verbatim and be charged again — the signature is
-- valid, so signature checking alone does not stop it.

create table if not exists public.agent_nonces (
  agent_id   uuid not null references public.agents(id) on delete cascade,
  nonce      text not null,
  used_at    timestamptz not null default now(),
  primary key (agent_id, nonce)
);

-- ============================================================================
-- Row Level Security
-- ============================================================================
--
-- SELECT is scoped to the owner. INSERT / UPDATE / DELETE are granted to
-- nobody. There is deliberately no `for all` policy anywhere in this file.

alter table public.wallets        enable row level security;
alter table public.agents         enable row level security;
alter table public.counterparties enable row level security;
alter table public.agent_nonces   enable row level security;

-- Belt and braces: RLS is bypassed by the table owner, so also make sure the
-- API roles hold no direct write grants on these tables.
revoke all on public.wallets        from anon, authenticated;
revoke all on public.agents         from anon, authenticated;
revoke all on public.counterparties from anon, authenticated;
revoke all on public.agent_nonces   from anon, authenticated;

grant select on public.wallets        to authenticated;
grant select on public.agents         to authenticated;
grant select on public.counterparties to authenticated;

drop policy if exists wallets_owner_read on public.wallets;
create policy wallets_owner_read on public.wallets
  for select to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists agents_owner_read on public.agents;
create policy agents_owner_read on public.agents
  for select to authenticated
  using (wallet_id in (select id from public.wallets where owner_id = (select auth.uid())));

drop policy if exists counterparties_owner_read on public.counterparties;
create policy counterparties_owner_read on public.counterparties
  for select to authenticated
  using (wallet_id in (select id from public.wallets where owner_id = (select auth.uid())));

-- agent_nonces is internal bookkeeping; no role reads it through the API.

-- ============================================================================
-- Owner provisioning
-- ============================================================================
--
-- Runs on signup. SECURITY DEFINER because it writes tables that the signing-up
-- user has no write grant on — which is exactly the property we want.

create or replace function public.bootstrap_wallet()
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner  uuid := auth.uid();
  v_wallet uuid;
begin
  if v_owner is null then
    raise exception 'not authenticated';
  end if;

  select id into v_wallet from public.wallets where owner_id = v_owner;
  if v_wallet is not null then
    return v_wallet;
  end if;

  insert into public.wallets (owner_id) values (v_owner) returning id into v_wallet;

  insert into public.counterparties (wallet_id, host)
  values
    (v_wallet, 'vendor-a.com'),
    (v_wallet, 'vendor-b.com'),
    (v_wallet, 'cloud-compute.io'),
    (v_wallet, 'aws.amazon.com'),
    (v_wallet, 'github.com')
  on conflict do nothing;

  return v_wallet;
end;
$$;

revoke all on function public.bootstrap_wallet() from public, anon;
grant execute on function public.bootstrap_wallet() to authenticated;
