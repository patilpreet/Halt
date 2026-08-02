-- ============================================================================
-- Halt · 0002_engine.sql
-- The money engine. Every rule that matters is in this file, inside a
-- transaction, behind a row lock.
-- ============================================================================
--
-- Design rule: the agent's cooperation is never required for a control to hold.
-- Delete the frontend, rewrite the agent, run it from a hostile machine — the
-- checks below still run, because they ARE the transaction that moves the money.
--
-- Payments are authorized then captured, the way card rails work. `gw_authorize`
-- places a hold: it reserves budget without moving money. `gw_capture` settles
-- it. `gw_void` releases it. That window is what makes in-flight revocation a
-- real guarantee rather than a setTimeout in somebody's browser tab.
-- ============================================================================

-- ─────────────────────────── spends ───────────────────────────

create table if not exists public.spends (
  id             uuid primary key default gen_random_uuid(),
  wallet_id      uuid not null references public.wallets(id) on delete cascade,
  agent_id       uuid references public.agents(id) on delete set null,

  host           text not null,
  amount_paise   bigint not null,

  status         text not null,
  reason         text not null default '',

  -- Advisory risk metadata from the AI layer. Kept apart from the decision:
  -- `decided_by` records which control actually governed, so a policy floor is
  -- never displayed as if it were a model judgement.
  risk_score     integer,
  ai_score       integer,
  policy_floor   integer,
  ai_reasoning   text default '',
  decided_by     text not null default 'engine',
  trace          jsonb not null default '[]'::jsonb,

  agent_prompt   text default '',
  nonce          text,

  created_at     timestamptz not null default now(),
  expires_at     timestamptz,
  settled_at     timestamptz,

  constraint spends_amount_positive check (amount_paise > 0),
  constraint spends_status_enum check (status in (
    'held',      -- budget reserved, money has not moved, owner can still recall
    'captured',  -- settled
    'voided',    -- hold released: recalled, frozen, or swept
    'blocked',   -- refused by the engine, no hold was ever placed
    'review',    -- hold retained, waiting on a human
    'rejected'   -- human said no
  ))
);

create index if not exists spends_wallet_created_idx on public.spends(wallet_id, created_at desc);
create index if not exists spends_wallet_status_idx  on public.spends(wallet_id, status);

alter table public.spends enable row level security;
revoke all on public.spends from anon, authenticated;
grant select on public.spends to authenticated;

drop policy if exists spends_owner_read on public.spends;
create policy spends_owner_read on public.spends
  for select to authenticated
  using (wallet_id in (select id from public.wallets where owner_id = (select auth.uid())));

-- ============================================================================
-- Internals
-- ============================================================================

-- Rolling-window exposure: everything reserved or settled inside the window.
--
-- A rolling window is what catches structuring. A calendar-day counter does
-- not: twelve individually-legal payments at 23:58 all pass, and the counter
-- resets two minutes later. This looks back `window_seconds` from *now*, so the
-- thirteenth payment sees the first twelve.
create or replace function public.gw_window_spent(p_wallet uuid, p_window integer)
returns bigint
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(sum(amount_paise), 0)::bigint
  from public.spends
  where wallet_id = p_wallet
    and status in ('held', 'captured', 'review')
    and created_at > now() - make_interval(secs => p_window);
$$;

-- Hostname reduction. Mirrors sanitizePayee() on the client, because a control
-- that only exists on the client is not a control.
create or replace function public.gw_normalize_host(p_raw text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  h text := lower(btrim(coalesce(p_raw, '')));
begin
  h := regexp_replace(h, '^[a-z][a-z0-9+.-]*://', '');   -- scheme
  h := split_part(h, '/', 1);                            -- path
  h := split_part(h, '?', 1);                            -- query
  h := split_part(h, '#', 1);                            -- fragment
  -- userinfo: take what follows the LAST '@', so evil.com@aws.amazon.com
  -- resolves to the real host rather than the label in front of it.
  if position('@' in h) > 0 then
    h := regexp_replace(h, '^.*@', '');
  end if;
  h := split_part(h, ':', 1);                            -- port
  h := regexp_replace(h, '\.$', '');                     -- trailing root dot

  if h !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' then
    return null;
  end if;
  return h;
end;
$$;

-- Allowlist match: exact host, or a true subdomain on a '.' boundary.
-- A bare suffix match would let "evilaws.amazon.com" impersonate the
-- allowlisted "aws.amazon.com".
create or replace function public.gw_is_allowlisted(p_wallet uuid, p_host text)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.counterparties c
    where c.wallet_id = p_wallet
      and (p_host = c.host or p_host like ('%.' || c.host))
  );
$$;

-- ============================================================================
-- gw_authorize — the only way money is ever reserved
-- ============================================================================
--
-- Called by the gateway edge function AFTER it has verified the agent's ECDSA
-- signature. Execute is granted to service_role only: a browser cannot reach
-- this function, with or without a session.
--
-- Order matters. Frozen is checked first and holds the wallet row lock for the
-- rest of the transaction, so a freeze landing mid-flight cannot be overtaken
-- by an authorize that started a moment earlier.

create or replace function public.gw_authorize(
  p_agent_id     uuid,
  p_nonce        text,
  p_host         text,
  p_amount_paise bigint,
  p_prompt       text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_agent    public.agents%rowtype;
  v_wallet   public.wallets%rowtype;
  v_host     text;
  v_spent    bigint;
  v_spend_id uuid;
  v_reason   text;
begin
  -- ── agent identity ──────────────────────────────────────────
  select * into v_agent from public.agents where id = p_agent_id;
  if not found then
    return jsonb_build_object('decision', 'blocked', 'reason', 'Unknown agent.');
  end if;
  if v_agent.status <> 'active' then
    return jsonb_build_object('decision', 'blocked', 'reason', 'Agent has been revoked by the owner.');
  end if;

  -- ── serialise everything else against this wallet ───────────
  -- Twenty concurrent requests queue here instead of all reading the same
  -- pre-update balance. This is what makes the limit hold under a race.
  select * into v_wallet from public.wallets where id = v_agent.wallet_id for update;
  if not found then
    return jsonb_build_object('decision', 'blocked', 'reason', 'Wallet not found.');
  end if;

  -- ── amount sanity, before any comparison ────────────────────
  if p_amount_paise is null or p_amount_paise <= 0 then
    return jsonb_build_object('decision', 'blocked', 'reason', 'Amount must be a positive integer number of paise.');
  end if;
  if p_amount_paise > 1000000000 then  -- ₹1,00,00,000 hard ceiling
    return jsonb_build_object('decision', 'blocked', 'reason', 'Amount exceeds the hard per-transaction ceiling.');
  end if;

  -- ── replay ──────────────────────────────────────────────────
  -- A valid signature replayed is still a valid signature. The nonce is what
  -- makes it single-use.
  if p_nonce is null or length(p_nonce) < 8 then
    return jsonb_build_object('decision', 'blocked', 'reason', 'Missing or too-short nonce.');
  end if;
  begin
    insert into public.agent_nonces (agent_id, nonce) values (p_agent_id, p_nonce);
  exception when unique_violation then
    return jsonb_build_object('decision', 'blocked', 'reason', 'Replayed request — this nonce has already been used.');
  end;

  -- ── kill switch ─────────────────────────────────────────────
  if v_wallet.frozen then
    insert into public.spends (wallet_id, agent_id, host, amount_paise, status, reason, decided_by, agent_prompt, nonce, risk_score, trace)
    values (v_wallet.id, p_agent_id, coalesce(public.gw_normalize_host(p_host), left(p_host, 120)), p_amount_paise,
            'blocked', 'BLOCKED — wallet is frozen by the owner kill switch.', 'engine', p_prompt, p_nonce, 100,
            jsonb_build_array(jsonb_build_object('layer', 0, 'name', 'Engine · Postgres', 'status', 'BLOCK', 'detail', 'wallet is in owner lockdown')))
    returning id into v_spend_id;
    return jsonb_build_object('decision', 'blocked', 'spend_id', v_spend_id,
                              'reason', 'BLOCKED — wallet is frozen by the owner kill switch.');
  end if;

  -- ── payee ───────────────────────────────────────────────────
  v_host := public.gw_normalize_host(p_host);
  if v_host is null then
    insert into public.spends (wallet_id, agent_id, host, amount_paise, status, reason, decided_by, agent_prompt, nonce, risk_score, trace)
    values (v_wallet.id, p_agent_id, left(coalesce(p_host, 'unparseable'), 120), p_amount_paise,
            'blocked', 'BLOCKED — payee is not a valid hostname.', 'engine', p_prompt, p_nonce, 100,
            jsonb_build_array(jsonb_build_object('layer', 0, 'name', 'Engine · Postgres', 'status', 'BLOCK', 'detail', 'payee is not a valid hostname')))
    returning id into v_spend_id;
    return jsonb_build_object('decision', 'blocked', 'spend_id', v_spend_id,
                              'reason', 'BLOCKED — payee is not a valid hostname.');
  end if;

  if not public.gw_is_allowlisted(v_wallet.id, v_host) then
    insert into public.spends (wallet_id, agent_id, host, amount_paise, status, reason, decided_by, agent_prompt, nonce, risk_score, trace)
    values (v_wallet.id, p_agent_id, v_host, p_amount_paise,
            'blocked', format('BLOCKED — payee "%s" is not on the owner allowlist.', v_host), 'engine', p_prompt, p_nonce, 90,
            jsonb_build_array(jsonb_build_object('layer', 0, 'name', 'Engine · Postgres', 'status', 'BLOCK', 'detail', 'payee not on allowlist')))
    returning id into v_spend_id;
    return jsonb_build_object('decision', 'blocked', 'spend_id', v_spend_id,
                              'reason', format('BLOCKED — payee "%s" is not on the owner allowlist.', v_host));
  end if;

  -- ── rolling-window spend cap ────────────────────────────────
  v_spent := public.gw_window_spent(v_wallet.id, v_wallet.window_seconds);
  if v_spent + p_amount_paise > v_wallet.limit_paise then
    v_reason := format('BLOCKED — would exceed the rolling %ss cap (%s of %s paise already committed).',
                       v_wallet.window_seconds, v_spent, v_wallet.limit_paise);
    insert into public.spends (wallet_id, agent_id, host, amount_paise, status, reason, decided_by, agent_prompt, nonce, risk_score, trace)
    values (v_wallet.id, p_agent_id, v_host, p_amount_paise, 'blocked', v_reason, 'engine', p_prompt, p_nonce, 85,
            jsonb_build_array(jsonb_build_object('layer', 0, 'name', 'Engine · Postgres', 'status', 'BLOCK', 'detail', 'exceeds rolling spend cap')))
    returning id into v_spend_id;
    return jsonb_build_object('decision', 'blocked', 'spend_id', v_spend_id, 'reason', v_reason);
  end if;

  -- ── hold ────────────────────────────────────────────────────
  -- Budget is reserved from this moment. No money has moved yet.
  insert into public.spends (wallet_id, agent_id, host, amount_paise, status, reason, decided_by, agent_prompt, nonce, expires_at, trace)
  values (v_wallet.id, p_agent_id, v_host, p_amount_paise, 'held',
          'HELD — authorized against policy, awaiting capture.', 'engine', p_prompt, p_nonce,
          now() + make_interval(secs => v_wallet.hold_seconds),
          jsonb_build_array(jsonb_build_object('layer', 0, 'name', 'Engine · Postgres', 'status', 'HOLD', 'detail', 'allowlisted, within rolling cap')))
  returning id into v_spend_id;

  return jsonb_build_object(
    'decision', 'held',
    'spend_id', v_spend_id,
    'wallet_id', v_wallet.id,
    'host', v_host,
    'amount_paise', p_amount_paise,
    'hold_seconds', v_wallet.hold_seconds,
    'window_spent_paise', v_spent + p_amount_paise,
    'limit_paise', v_wallet.limit_paise,
    'reason', 'HELD — authorized against policy, awaiting capture.'
  );
end;
$$;

-- ============================================================================
-- capture / void / review
-- ============================================================================

-- Settle a hold. Re-checks the freeze under the row lock: a kill switch thrown
-- during the hold window must beat a capture that arrives a millisecond later.
create or replace function public.gw_capture(
  p_spend_id uuid,
  p_risk     integer default null,
  p_ai_score integer default null,
  p_floor    integer default null,
  p_reason   text default null,
  p_trace    jsonb default null,
  p_decided  text default 'engine'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_spend  public.spends%rowtype;
  v_wallet public.wallets%rowtype;
begin
  select * into v_spend from public.spends where id = p_spend_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'Unknown spend.');
  end if;
  if v_spend.status not in ('held', 'review') then
    return jsonb_build_object('ok', false, 'reason', format('Spend is %s, not capturable.', v_spend.status));
  end if;

  select * into v_wallet from public.wallets where id = v_spend.wallet_id for update;

  if v_wallet.frozen then
    update public.spends
       set status = 'voided',
           reason = 'VOIDED — wallet was frozen before this hold could settle.',
           settled_at = now(),
           decided_by = 'engine'
     where id = p_spend_id;
    return jsonb_build_object('ok', false, 'voided', true,
                              'reason', 'VOIDED — wallet was frozen before this hold could settle.');
  end if;

  -- The status predicate is repeated here on purpose. The check above happened
  -- before the wallet lock was taken; two captures racing for the same hold
  -- would both pass it. Only one can satisfy this WHERE clause.
  update public.spends
     set status       = 'captured',
         reason       = coalesce(p_reason, 'CAPTURED — settled within policy.'),
         risk_score   = coalesce(p_risk, risk_score),
         ai_score     = coalesce(p_ai_score, ai_score),
         policy_floor = coalesce(p_floor, policy_floor),
         trace        = coalesce(p_trace, trace),
         decided_by   = p_decided,
         settled_at   = now()
   where id = p_spend_id
     and status in ('held', 'review');

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'Hold was resolved by someone else first.');
  end if;

  return jsonb_build_object('ok', true, 'spend_id', p_spend_id, 'status', 'captured');
end;
$$;

-- Release a hold. This is in-flight revocation: the money never moved, and the
-- reserved budget goes back immediately.
create or replace function public.gw_void(
  p_spend_id uuid,
  p_reason   text default 'VOIDED — hold released.',
  p_decided  text default 'engine'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_spend public.spends%rowtype;
begin
  select * into v_spend from public.spends where id = p_spend_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'Unknown spend.');
  end if;
  if v_spend.status not in ('held', 'review') then
    return jsonb_build_object('ok', false, 'reason', format('Spend is %s, not voidable.', v_spend.status));
  end if;

  update public.spends
     set status = 'voided', reason = p_reason, decided_by = p_decided, settled_at = now()
   where id = p_spend_id;

  return jsonb_build_object('ok', true, 'spend_id', p_spend_id, 'status', 'voided');
end;
$$;

-- Park a hold in front of a human. The budget stays reserved while it waits, so
-- a queue of pending reviews cannot be used to overshoot the cap.
create or replace function public.gw_review(
  p_spend_id uuid,
  p_risk     integer,
  p_ai_score integer,
  p_floor    integer,
  p_reason   text,
  p_reasoning text default '',
  p_trace    jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.spends
     set status = 'review', reason = p_reason, risk_score = p_risk, ai_score = p_ai_score,
         policy_floor = p_floor, ai_reasoning = p_reasoning,
         trace = coalesce(p_trace, trace), decided_by = 'human-pending'
   where id = p_spend_id and status = 'held';

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'Spend is no longer held.');
  end if;
  return jsonb_build_object('ok', true, 'spend_id', p_spend_id, 'status', 'review');
end;
$$;

-- Auto-kill, thrown by the gateway when Layer 2 returns CRITICAL.
--
-- Freezing and reversing the in-flight holds happen in ONE transaction. Doing
-- it as two round trips from the gateway leaves a window in which the wallet is
-- frozen but a hold placed a moment earlier still settles.
create or replace function public.gw_freeze(p_wallet uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_voided integer := 0;
begin
  update public.wallets
     set frozen = true, frozen_at = now(), frozen_reason = p_reason
   where id = p_wallet;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'Unknown wallet.');
  end if;

  with reversed as (
    update public.spends
       set status = 'voided', decided_by = 'agent2', settled_at = now(),
           reason = 'VOIDED — auto-kill froze the wallet while this payment was in flight.'
     where wallet_id = p_wallet and status in ('held', 'review')
    returning 1
  )
  select count(*) into v_voided from reversed;

  return jsonb_build_object('ok', true, 'holds_reversed', v_voided);
end;
$$;

revoke all on function public.gw_freeze(uuid, text) from public, anon, authenticated;

-- A gateway that dies mid-flight must not reserve budget forever. Holds older
-- than ten times the hold window are released. Fail-open on stale reservations
-- is safe; fail-open on the cap itself is not.
create or replace function public.gw_sweep_expired(p_wallet uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  -- This is SECURITY DEFINER and callable by any signed-in user, so it must
  -- prove the caller owns the wallet id they passed. Without this, one tenant
  -- could sweep another tenant's holds by guessing a uuid.
  if not exists (
    select 1 from public.wallets where id = p_wallet and owner_id = auth.uid()
  ) then
    raise exception 'not your wallet';
  end if;

  with swept as (
    update public.spends s
       set status = 'voided',
           reason = 'VOIDED — hold expired without capture (gateway did not settle).',
           settled_at = now()
      from public.wallets w
     where s.wallet_id = w.id
       and w.id = p_wallet
       and s.status = 'held'
       and s.expires_at < now() - make_interval(secs => w.hold_seconds * 10)
    returning 1
  )
  select count(*) into v_count from swept;
  return v_count;
end;
$$;

-- Only the gateway (service_role) may touch the money path.
--
-- Postgres grants EXECUTE on a new function to PUBLIC by default, so revoking
-- from PUBLIC removes it from every role — including service_role. The explicit
-- grants below are not decoration: without them the gateway gets
-- "permission denied for function gw_authorize" on its first request.
revoke all on function public.gw_authorize(uuid, text, text, bigint, text) from public, anon, authenticated;
revoke all on function public.gw_capture(uuid, integer, integer, integer, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.gw_void(uuid, text, text) from public, anon, authenticated;
revoke all on function public.gw_review(uuid, integer, integer, integer, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.gw_freeze(uuid, text) from public, anon, authenticated;

grant execute on function public.gw_authorize(uuid, text, text, bigint, text) to service_role;
grant execute on function public.gw_capture(uuid, integer, integer, integer, text, jsonb, text) to service_role;
grant execute on function public.gw_void(uuid, text, text) to service_role;
grant execute on function public.gw_review(uuid, integer, integer, integer, text, text, jsonb) to service_role;
grant execute on function public.gw_freeze(uuid, text) to service_role;

revoke all on function public.gw_sweep_expired(uuid) from public, anon;
grant execute on function public.gw_sweep_expired(uuid) to authenticated;

-- Helpers take a wallet id as an argument, so leaving them executable would let
-- a signed-in tenant probe another tenant's allowlist or spend total given a
-- guessed uuid. Nothing outside the engine needs to call them.
revoke all on function public.gw_window_spent(uuid, integer) from public, anon, authenticated;
revoke all on function public.gw_is_allowlisted(uuid, text)  from public, anon, authenticated;

-- ============================================================================
-- Owner controls
-- ============================================================================
--
-- These ARE callable from the browser, but only with a session, and every one
-- of them re-derives the wallet from auth.uid() rather than trusting an id
-- passed in from the client.

create or replace function public.owner_wallet()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select id from public.wallets where owner_id = auth.uid();
$$;

-- The kill switch. Freezing voids every outstanding hold in the same
-- transaction — in-flight payments reverse rather than settling after the fact.
create or replace function public.owner_set_frozen(p_frozen boolean, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_wallet public.wallets%rowtype;
  v_voided integer := 0;
begin
  select * into v_wallet from public.wallets where owner_id = auth.uid() for update;
  if not found then
    raise exception 'no wallet for this owner';
  end if;

  update public.wallets
     set frozen = p_frozen,
         frozen_at = case when p_frozen then now() else null end,
         frozen_reason = case when p_frozen then p_reason else null end
   where id = v_wallet.id;

  if p_frozen then
    with reversed as (
      update public.spends
         set status = 'voided',
             reason = 'VOIDED — kill switch thrown while this payment was in flight.',
             decided_by = 'owner',
             settled_at = now()
       where wallet_id = v_wallet.id
         and status in ('held', 'review')
      returning 1
    )
    select count(*) into v_voided from reversed;
  end if;

  return jsonb_build_object('ok', true, 'frozen', p_frozen, 'holds_reversed', v_voided);
end;
$$;

create or replace function public.owner_set_policy(p_limit_paise bigint, p_window_seconds integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_wallet uuid;
begin
  select id into v_wallet from public.wallets where owner_id = auth.uid();
  if v_wallet is null then raise exception 'no wallet for this owner'; end if;

  if p_limit_paise is null or p_limit_paise <= 0 or p_limit_paise > 10000000000 then
    raise exception 'limit must be between 1 and 10000000000 paise';
  end if;

  update public.wallets
     set limit_paise = p_limit_paise,
         window_seconds = coalesce(p_window_seconds, window_seconds)
   where id = v_wallet;

  return jsonb_build_object('ok', true, 'limit_paise', p_limit_paise);
end;
$$;

create or replace function public.owner_add_counterparty(p_host text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_wallet uuid;
  v_host   text;
begin
  select id into v_wallet from public.wallets where owner_id = auth.uid();
  if v_wallet is null then raise exception 'no wallet for this owner'; end if;

  v_host := public.gw_normalize_host(p_host);
  if v_host is null then
    raise exception 'payee "%" is not a valid hostname', p_host;
  end if;

  insert into public.counterparties (wallet_id, host) values (v_wallet, v_host)
  on conflict (wallet_id, host) do nothing;

  return jsonb_build_object('ok', true, 'host', v_host);
end;
$$;

create or replace function public.owner_remove_counterparty(p_host text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_wallet uuid;
begin
  select id into v_wallet from public.wallets where owner_id = auth.uid();
  if v_wallet is null then raise exception 'no wallet for this owner'; end if;

  delete from public.counterparties where wallet_id = v_wallet and host = lower(btrim(p_host));
  return jsonb_build_object('ok', true, 'host', lower(btrim(p_host)));
end;
$$;

-- Resolve a spend parked at Layer 3.
--
-- This re-runs the full engine check before releasing anything. The previous
-- build added the amount straight to the day's total on approval, which meant
-- an owner could freeze the wallet and then release a queued payment anyway —
-- the kill switch was bypassable by clicking Approve. Freezing, revoking the
-- agent, de-allowlisting the payee, or lowering the cap while an item waits in
-- the queue all now cause the release to fail.
create or replace function public.owner_resolve_review(p_spend_id uuid, p_approve boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_spend  public.spends%rowtype;
  v_wallet public.wallets%rowtype;
  v_spent  bigint;
  v_agent  public.agents%rowtype;
begin
  select w.* into v_wallet from public.wallets w where w.owner_id = auth.uid() for update;
  if not found then raise exception 'no wallet for this owner'; end if;

  select * into v_spend from public.spends where id = p_spend_id and wallet_id = v_wallet.id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'Unknown spend.');
  end if;
  if v_spend.status <> 'review' then
    return jsonb_build_object('ok', false, 'reason', format('Spend is %s, not awaiting review.', v_spend.status));
  end if;

  if not p_approve then
    update public.spends
       set status = 'rejected', decided_by = 'owner', settled_at = now(),
           reason = 'REJECTED at Layer 3 — denied by the wallet owner. Hold released.'
     where id = p_spend_id;
    return jsonb_build_object('ok', true, 'status', 'rejected');
  end if;

  -- ── the release path re-checks everything ──────────────────
  if v_wallet.frozen then
    update public.spends
       set status = 'voided', decided_by = 'engine', settled_at = now(),
           reason = 'VOIDED — release refused, the wallet is frozen.'
     where id = p_spend_id;
    return jsonb_build_object('ok', false, 'reason', 'Wallet is frozen — release refused and the hold was voided.');
  end if;

  if v_spend.agent_id is not null then
    select * into v_agent from public.agents where id = v_spend.agent_id;
    if found and v_agent.status <> 'active' then
      update public.spends
         set status = 'voided', decided_by = 'engine', settled_at = now(),
             reason = 'VOIDED — release refused, the requesting agent has been revoked.'
       where id = p_spend_id;
      return jsonb_build_object('ok', false, 'reason', 'Agent has been revoked — release refused.');
    end if;
  end if;

  if not public.gw_is_allowlisted(v_wallet.id, v_spend.host) then
    update public.spends
       set status = 'voided', decided_by = 'engine', settled_at = now(),
           reason = 'VOIDED — release refused, the payee is no longer allowlisted.'
     where id = p_spend_id;
    return jsonb_build_object('ok', false, 'reason', 'Payee is no longer allowlisted — release refused.');
  end if;

  -- The spend is already counted in the window while it is 'review', so
  -- exclude it from the total before comparing.
  v_spent := public.gw_window_spent(v_wallet.id, v_wallet.window_seconds) - v_spend.amount_paise;
  if v_spent + v_spend.amount_paise > v_wallet.limit_paise then
    update public.spends
       set status = 'voided', decided_by = 'engine', settled_at = now(),
           reason = 'VOIDED — release refused, the rolling cap no longer has room.'
     where id = p_spend_id;
    return jsonb_build_object('ok', false, 'reason', 'Rolling cap no longer has room — release refused.');
  end if;

  update public.spends
     set status = 'captured', decided_by = 'owner', settled_at = now(),
         reason = 'CAPTURED at Layer 3 — released by the wallet owner after human review.',
         trace = trace || jsonb_build_array(jsonb_build_object(
                   'layer', 3, 'name', 'Human · Wallet Owner', 'status', 'APPROVE',
                   'detail', 'released by the human-in-the-loop, re-checked against live policy'))
   where id = p_spend_id;

  return jsonb_build_object('ok', true, 'status', 'captured');
end;
$$;

-- Recall a single payment while it is still in flight.
--
-- This is the per-transaction version of the kill switch: the hold is released,
-- the reserved budget returns, and no money ever moved. It works because the
-- hold is a row in this database rather than a promise inside whichever browser
-- tab happened to start the request — so the owner can recall from a phone
-- while the agent runs on a machine they have no access to.
create or replace function public.owner_void_hold(p_spend_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_wallet uuid;
begin
  select id into v_wallet from public.wallets where owner_id = auth.uid();
  if v_wallet is null then raise exception 'no wallet for this owner'; end if;

  update public.spends
     set status = 'voided', decided_by = 'owner', settled_at = now(),
         reason = 'RECALLED — the owner voided this payment while it was in flight.'
   where id = p_spend_id and wallet_id = v_wallet and status in ('held', 'review');

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'That payment is no longer in flight.');
  end if;
  return jsonb_build_object('ok', true, 'status', 'voided');
end;
$$;

revoke all on function public.owner_void_hold(uuid) from public, anon;
grant execute on function public.owner_void_hold(uuid) to authenticated;

-- ─────────────────────────── agent registration ───────────────────────────

create or replace function public.owner_register_agent(p_label text, p_public_jwk jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_wallet uuid;
  v_agent  uuid;
begin
  select id into v_wallet from public.wallets where owner_id = auth.uid();
  if v_wallet is null then raise exception 'no wallet for this owner'; end if;

  if p_public_jwk->>'kty' <> 'EC' or p_public_jwk->>'crv' <> 'P-256'
     or p_public_jwk->>'x' is null or p_public_jwk->>'y' is null then
    raise exception 'public_jwk must be an EC P-256 public key with x and y';
  end if;
  if p_public_jwk ? 'd' then
    raise exception 'that is a PRIVATE key — register the public half only';
  end if;

  insert into public.agents (wallet_id, label, public_jwk)
  values (v_wallet, coalesce(nullif(btrim(p_label), ''), 'Autonomous agent'), p_public_jwk)
  returning id into v_agent;

  return jsonb_build_object('ok', true, 'agent_id', v_agent);
end;
$$;

-- Revoking an agent is the per-agent kill switch: its signatures stop being
-- accepted, and any hold it left in flight is released.
create or replace function public.owner_revoke_agent(p_agent_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_wallet uuid;
  v_voided integer := 0;
begin
  select id into v_wallet from public.wallets where owner_id = auth.uid();
  if v_wallet is null then raise exception 'no wallet for this owner'; end if;

  update public.agents set status = 'revoked', revoked_at = now()
   where id = p_agent_id and wallet_id = v_wallet;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'Unknown agent.');
  end if;

  with reversed as (
    update public.spends
       set status = 'voided', decided_by = 'owner', settled_at = now(),
           reason = 'VOIDED — the requesting agent was revoked mid-flight.'
     where wallet_id = v_wallet and agent_id = p_agent_id and status in ('held', 'review')
    returning 1
  )
  select count(*) into v_voided from reversed;

  return jsonb_build_object('ok', true, 'holds_reversed', v_voided);
end;
$$;

revoke all on function public.owner_set_frozen(boolean, text)          from public, anon;
revoke all on function public.owner_set_policy(bigint, integer)        from public, anon;
revoke all on function public.owner_add_counterparty(text)             from public, anon;
revoke all on function public.owner_remove_counterparty(text)          from public, anon;
revoke all on function public.owner_resolve_review(uuid, boolean)      from public, anon;
revoke all on function public.owner_register_agent(text, jsonb)        from public, anon;
revoke all on function public.owner_revoke_agent(uuid)                 from public, anon;
revoke all on function public.owner_wallet()                           from public, anon;

grant execute on function public.owner_set_frozen(boolean, text)       to authenticated;
grant execute on function public.owner_set_policy(bigint, integer)     to authenticated;
grant execute on function public.owner_add_counterparty(text)          to authenticated;
grant execute on function public.owner_remove_counterparty(text)       to authenticated;
grant execute on function public.owner_resolve_review(uuid, boolean)   to authenticated;
grant execute on function public.owner_register_agent(text, jsonb)     to authenticated;
grant execute on function public.owner_revoke_agent(uuid)              to authenticated;
grant execute on function public.owner_wallet()                        to authenticated;
