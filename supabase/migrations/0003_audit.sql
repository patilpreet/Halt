-- ============================================================================
-- Halt · 0003_audit.sql
-- Tamper-evident audit log: a SHA-256 hash chain written by triggers.
-- ============================================================================
--
-- Two properties worth stating plainly:
--
--   1. The log is written by the database, inside the same transaction as the
--      event it records. A compromised frontend cannot suppress an entry,
--      because the frontend was never the thing that decided to write one.
--
--   2. Each entry commits to the one before it. Editing, deleting or
--      reordering any row breaks every hash after it, and
--      `verify_audit_chain()` reports the exact entry number where the chain
--      first fails. You cannot quietly rewrite history; you can only break it
--      visibly.
-- ============================================================================

create table if not exists public.audit_log (
  id          bigserial primary key,
  wallet_id   uuid not null references public.wallets(id) on delete cascade,
  seq         bigint not null,

  event       text not null,
  detail      jsonb not null default '{}'::jsonb,

  prev_hash   text not null,
  hash        text not null,

  created_at  timestamptz not null default now()
);

create unique index if not exists audit_log_wallet_seq on public.audit_log(wallet_id, seq);
create index if not exists audit_log_wallet_created on public.audit_log(wallet_id, seq desc);

alter table public.audit_log enable row level security;
revoke all on public.audit_log from anon, authenticated;
grant select on public.audit_log to authenticated;

drop policy if exists audit_owner_read on public.audit_log;
create policy audit_owner_read on public.audit_log
  for select to authenticated
  using (wallet_id in (select id from public.wallets where owner_id = (select auth.uid())));

-- ─────────────────────────── the append ───────────────────────────
--
-- The canonical form that gets hashed is fixed here and mirrored exactly in
-- verify_audit_chain(). If the two ever drift, every chain reads as broken —
-- which is the safe direction for them to drift in.

create or replace function public.audit_append(
  p_wallet uuid,
  p_event  text,
  p_detail jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_seq  bigint;
  v_prev text;
  v_hash text;
begin
  if p_wallet is null then return; end if;

  -- Serialise appends for this wallet. The money functions already hold the
  -- wallet row lock, but gw_review does not, and two concurrent appends racing
  -- for the same seq would produce a chain that verifies as broken through no
  -- fault of an attacker.
  perform pg_advisory_xact_lock(hashtext(p_wallet::text));

  select coalesce(max(seq), 0) into v_seq from public.audit_log where wallet_id = p_wallet;
  v_seq := v_seq + 1;

  if v_seq = 1 then
    v_prev := repeat('0', 64);
  else
    select hash into v_prev from public.audit_log where wallet_id = p_wallet and seq = v_seq - 1;
  end if;

  v_hash := encode(digest(
    v_prev || '|' || v_seq::text || '|' || p_event || '|' || coalesce(p_detail::text, '{}'),
    'sha256'), 'hex');

  insert into public.audit_log (wallet_id, seq, event, detail, prev_hash, hash)
  values (p_wallet, v_seq, p_event, coalesce(p_detail, '{}'::jsonb), v_prev, v_hash);
end;
$$;

revoke all on function public.audit_append(uuid, text, jsonb) from public, anon, authenticated;

-- ─────────────────────────── triggers ───────────────────────────

create or replace function public.trg_audit_spend()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event text;
begin
  if TG_OP = 'INSERT' then
    v_event := 'spend.' || NEW.status;
  elsif OLD.status is distinct from NEW.status then
    v_event := 'spend.' || NEW.status;
  else
    return NEW;   -- metadata-only edit, nothing decision-relevant changed
  end if;

  perform public.audit_append(NEW.wallet_id, v_event, jsonb_build_object(
    'spend_id',     NEW.id,
    'agent_id',     NEW.agent_id,
    'host',         NEW.host,
    'amount_paise', NEW.amount_paise,
    'status',       NEW.status,
    'reason',       NEW.reason,
    'risk_score',   NEW.risk_score,
    'decided_by',   NEW.decided_by
  ));
  return NEW;
end;
$$;

drop trigger if exists audit_spend on public.spends;
create trigger audit_spend
  after insert or update on public.spends
  for each row execute function public.trg_audit_spend();

create or replace function public.trg_audit_wallet()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if TG_OP = 'INSERT' then
    perform public.audit_append(NEW.id, 'wallet.created', jsonb_build_object(
      'limit_paise', NEW.limit_paise, 'window_seconds', NEW.window_seconds));
    return NEW;
  end if;

  if OLD.frozen is distinct from NEW.frozen then
    perform public.audit_append(NEW.id,
      case when NEW.frozen then 'wallet.frozen' else 'wallet.released' end,
      jsonb_build_object('reason', NEW.frozen_reason));
  end if;

  if OLD.limit_paise is distinct from NEW.limit_paise
     or OLD.window_seconds is distinct from NEW.window_seconds then
    perform public.audit_append(NEW.id, 'wallet.policy_changed', jsonb_build_object(
      'limit_paise_from', OLD.limit_paise, 'limit_paise_to', NEW.limit_paise,
      'window_from', OLD.window_seconds,   'window_to', NEW.window_seconds));
  end if;

  return NEW;
end;
$$;

drop trigger if exists audit_wallet on public.wallets;
create trigger audit_wallet
  after insert or update on public.wallets
  for each row execute function public.trg_audit_wallet();

create or replace function public.trg_audit_counterparty()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if TG_OP = 'INSERT' then
    perform public.audit_append(NEW.wallet_id, 'allowlist.added', jsonb_build_object('host', NEW.host));
    return NEW;
  end if;
  perform public.audit_append(OLD.wallet_id, 'allowlist.removed', jsonb_build_object('host', OLD.host));
  return OLD;
end;
$$;

drop trigger if exists audit_counterparty on public.counterparties;
create trigger audit_counterparty
  after insert or delete on public.counterparties
  for each row execute function public.trg_audit_counterparty();

create or replace function public.trg_audit_agent()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if TG_OP = 'INSERT' then
    perform public.audit_append(NEW.wallet_id, 'agent.registered',
      jsonb_build_object('agent_id', NEW.id, 'label', NEW.label));
  elsif OLD.status is distinct from NEW.status then
    perform public.audit_append(NEW.wallet_id, 'agent.' || NEW.status,
      jsonb_build_object('agent_id', NEW.id, 'label', NEW.label));
  end if;
  return NEW;
end;
$$;

drop trigger if exists audit_agent on public.agents;
create trigger audit_agent
  after insert or update on public.agents
  for each row execute function public.trg_audit_agent();

-- ─────────────────────────── verification ───────────────────────────
--
-- Recomputes every hash from the first entry forward. Returns the first seq
-- where the recomputed value diverges, or ok = true when the chain is intact.

create or replace function public.verify_audit_chain(p_wallet uuid default null)
returns table (ok boolean, entries bigint, broken_at bigint, detail text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_wallet uuid;
  r        record;
  v_prev   text := repeat('0', 64);
  v_calc   text;
  v_n      bigint := 0;
begin
  v_wallet := coalesce(p_wallet, (select id from public.wallets where owner_id = auth.uid()));
  if v_wallet is null then
    return query select false, 0::bigint, null::bigint, 'No wallet in scope.'::text;
    return;
  end if;
  if not exists (select 1 from public.wallets where id = v_wallet and owner_id = auth.uid()) then
    raise exception 'not your wallet';
  end if;

  for r in
    select * from public.audit_log where wallet_id = v_wallet order by seq asc
  loop
    v_n := v_n + 1;

    if r.seq <> v_n then
      return query select false, v_n, r.seq,
        format('Entry %s is missing — sequence jumps to %s. A row was deleted.', v_n, r.seq)::text;
      return;
    end if;

    if r.prev_hash <> v_prev then
      return query select false, v_n, r.seq,
        format('Entry %s does not link to the previous entry.', r.seq)::text;
      return;
    end if;

    v_calc := encode(digest(
      r.prev_hash || '|' || r.seq::text || '|' || r.event || '|' || coalesce(r.detail::text, '{}'),
      'sha256'), 'hex');

    if v_calc <> r.hash then
      return query select false, v_n, r.seq,
        format('Entry %s has been altered — its contents no longer match its hash.', r.seq)::text;
      return;
    end if;

    v_prev := r.hash;
  end loop;

  return query select true, v_n, null::bigint,
    format('Chain intact — %s entries verified from genesis.', v_n)::text;
end;
$$;

revoke all on function public.verify_audit_chain(uuid) from public, anon;
grant execute on function public.verify_audit_chain(uuid) to authenticated;

-- ─────────────────────────── dashboard snapshot ───────────────────────────
--
-- One round trip for everything the console renders, so the UI never has to
-- assemble state from four separate queries that can disagree with each other.

create or replace function public.owner_snapshot()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_wallet public.wallets%rowtype;
begin
  select * into v_wallet from public.wallets where owner_id = auth.uid();
  if not found then
    return jsonb_build_object('wallet', null);
  end if;

  return jsonb_build_object(
    'wallet', jsonb_build_object(
      'id', v_wallet.id,
      'label', v_wallet.label,
      'limit_paise', v_wallet.limit_paise,
      'window_seconds', v_wallet.window_seconds,
      'hold_seconds', v_wallet.hold_seconds,
      'frozen', v_wallet.frozen,
      'frozen_at', v_wallet.frozen_at,
      'frozen_reason', v_wallet.frozen_reason,
      'spent_paise', public.gw_window_spent(v_wallet.id, v_wallet.window_seconds)
    ),
    'allowlist', coalesce((select jsonb_agg(host order by host) from public.counterparties where wallet_id = v_wallet.id), '[]'::jsonb),
    'agents', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'label', label, 'status', status, 'created_at', created_at))
      from public.agents where wallet_id = v_wallet.id), '[]'::jsonb),
    'spends', coalesce((select jsonb_agg(to_jsonb(s) order by s.created_at desc) from (
        select sp.id, sp.host, sp.amount_paise, sp.status, sp.reason, sp.risk_score, sp.ai_score,
               sp.policy_floor, sp.ai_reasoning, sp.decided_by, sp.trace, sp.agent_prompt,
               sp.agent_id, ag.label as agent_label, sp.created_at, sp.expires_at, sp.settled_at
        from public.spends sp
        left join public.agents ag on ag.id = sp.agent_id
        where sp.wallet_id = v_wallet.id
        order by sp.created_at desc limit 100) s), '[]'::jsonb),
    'audit_count', (select count(*) from public.audit_log where wallet_id = v_wallet.id)
  );
end;
$$;

revoke all on function public.owner_snapshot() from public, anon;
grant execute on function public.owner_snapshot() to authenticated;
