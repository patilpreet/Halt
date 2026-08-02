# Halt — wallet-layer spend enforcement for autonomous agents

> **Hackathon Problem Statement 2: The Kill Switch**
> *Domain: Fintech — Autonomous AI Agent Wallet Enforcement*

An agent asks for money. Something that is not the agent decides.

```
  agent/                supabase/functions/gateway      supabase/migrations
  ────────              ──────────────────────────      ───────────────────
  holds a private   ──► proves WHO is asking        ──► decides WHETHER it may
  key and a URL.        ECDSA P-256 over the            inside one transaction,
  Nothing else.         exact amount.                   under a row lock.
```

The agent has no database URL, no anon key, no session, no route to the tables.
Delete the frontend, rewrite the gateway, run the agent from a machine you do not
control — the rules in `0002_engine.sql` still hold, because they *are* the
transaction that moves the money.

---

## What is actually enforced, and where it lives

| Attack | Where it dies |
|---|---|
| Sign ₹400, submit ₹40,000 | ECDSA verify in the gateway — the signature covers the amount |
| Replay a request that already worked | `primary key (agent_id, nonce)` |
| Spend while the wallet is frozen | `wallets.frozen`, checked under the row lock before anything else |
| Pay an unlisted counterparty | `gw_is_allowlisted`, exact host or a true `.` subdomain |
| `evilaws.amazon.com` posing as `aws.amazon.com` | same — the dot boundary is required |
| `https://evil.com@aws.amazon.com/x` | `gw_normalize_host` takes what follows the **last** `@` |
| Twelve individually-legal payments | rolling-window sum, not a calendar-day counter |
| Twenty requests fired at once | `select … from wallets … for update` serialises them |
| Approving a queued payment after freezing | `owner_resolve_review` re-runs every check at release |
| A revoked agent's requests | `agents.status`, checked before the wallet is even read |
| Editing the audit log afterwards | SHA-256 hash chain + `verify_audit_chain()` |
| Turning the kill switch off from devtools | no browser role holds a write grant on any table |

Money is `bigint` paise throughout. No floats — `0.1 + 0.2 !== 0.3`, and a cap
that drifts by a rounding error is not a cap.

Payments are **authorized then captured**, the way card rails work. `gw_authorize`
places a hold: budget is reserved, money has not moved. `gw_capture` settles it,
`gw_void` releases it. That window is what makes in-flight revocation a real
guarantee — the hold is a database row, so the owner can recall from a phone
while the agent runs on a laptop they have no access to.

---

## The three layers

| Layer | Lives in | Job |
|---|---|---|
| **1 · Engine** | Postgres, inside the transaction | signature, nonce, freeze, allowlist, rolling cap |
| **2 · Deep Risk Agent** | the gateway edge function | Groq scoring on what Layer 1 already permitted |
| **3 · Human** | the owner console | releases what Layer 2 would not clear |

Layer 1 has no health toggle, and that is the point. An earlier version let you
switch the "frontline agent" offline to demonstrate failover — but that agent was
a function in the browser bundle, and a control the client can switch off was
never an enforcement layer to begin with.

Layer 2 degrades rather than disappears: if the Groq call fails, the gateway
falls back to a deterministic scorer, so losing the model makes review stricter
rather than absent. A `policyFloor` derived from wallet policy alone is always
applied, and the audit trail records `aiScore` and `policyFloor` separately so a
policy control is never displayed as if it were a model judgement.

---

## Setup — about 20 minutes

**1 · Supabase project.** Create one; note the URL, anon key, service role key.

**2 · Schema.** SQL Editor, in order:

```
supabase/migrations/0001_identity.sql
supabase/migrations/0002_engine.sql
supabase/migrations/0003_audit.sql
```

**3 · Auth email delivery via Resend.** Supabase's built-in SMTP is rate-limited
to a handful of messages an hour and will silently throttle a live demo.

* Resend → **API Keys** → create one with `Sending access`.
* Resend → **Domains** → verify your domain (or use `onboarding@resend.dev` for
  testing — it only delivers to your own Resend account address).
* Supabase → **Project Settings → Authentication → SMTP Settings** → Enable
  custom SMTP:

  | Field | Value |
  |---|---|
  | Host | `smtp.resend.com` |
  | Port | `465` |
  | Username | `resend` |
  | Password | your Resend API key |
  | Sender email | `noreply@yourdomain.com` |

* Supabase → **Authentication → URL Configuration** → set **Site URL** to your
  deployed origin, and add it under **Redirect URLs**. Without this the
  confirmation link bounces users to `localhost`.

The Resend key is entered into the Supabase dashboard and never appears in this
repository, in `.env`, or in the bundle.

**4 · Gateway.**

```bash
supabase link --project-ref <ref>
supabase secrets set GROQ_API_KEY=gsk_...
supabase secrets set ALLOWED_ORIGIN=https://your-app.vercel.app
supabase functions deploy gateway --no-verify-jwt
```

`--no-verify-jwt` is correct here: the agent authenticates with a signature, not
a Supabase session. It deliberately has no session to present.

**5 · Frontend.**

```bash
cp .env.example .env    # VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY only
npm install
npm run dev
```

**6 · Deploy.** `vercel --prod`, then set the same two `VITE_` variables in the
Vercel dashboard. Only those two — see the warning in `.env.example`.

**7 · The external agent** (optional, and the most convincing part of the demo):

```bash
node agent/keygen.mjs                       # prints a public JWK
# Owner console → Registered Agents → + → paste the JWK
# paste the returned agent id into agent/agent.key.json
export HALT_GATEWAY_URL=https://<ref>.supabase.co/functions/v1/gateway
node agent/agent.mjs run
```

---

## The demo — 90 seconds

1. **Sign in.** The wallet, allowlist and kill switch belong to an account now.
2. **Start the simulator.** Payments cross the console unsupervised. Nobody
   approves any of them.
3. **Recall one mid-flight.** Hit **Recall** on a held payment before it captures.
   Then reload the page mid-hold — it is still there, still recallable, because
   it is a row and not a timer.
4. **Test Suite → Tamper.** Signs ₹400, submits ₹40,000. Dies at the gateway.
5. **Test Suite → Race ×20.** Twenty at once. Watch the cap hold.
6. **FREEZE** while payments are in flight. Every hold reverses, and the response
   tells you how many.
7. **The one that lands:** open devtools and run

   ```js
   await supabase.from('wallets').update({ frozen: false }).eq('frozen', true)
   ```

   Nothing happens. Then call `owner_set_frozen` — that works, because you are
   the owner. The client can ask; it cannot write.
8. **Verify chain integrity** → intact. Edit one `audit_log` row in the SQL
   editor, verify again → broken, with the exact entry number.

Run `node agent/agent.mjs attack race` from a second laptop if you have one. It
makes the separation obvious in a way no slide does.

---

## Layout

```
supabase/migrations/0001_identity.sql   owners, wallets, agents, allowlist, RLS
supabase/migrations/0002_engine.sql     authorize/capture/void, kill switch, owner RPCs
supabase/migrations/0003_audit.sql      SHA-256 hash chain + verify + snapshot
supabase/functions/gateway/             ECDSA verification, Groq risk, server-side keys
agent/keygen.mjs                        mint an agent identity
agent/agent.mjs                         the untrusted agent, with 5 attack modes
src/lib/api.js                          every owner action, as an RPC call
src/lib/agentKey.js                     browser agent keypair, non-extractable
src/lib/promptSecurity.js               injection scanning + value validation
src/components/AuthPage.jsx             sign in / sign up / reset
```

---

## What changed in v3, and why

This started as a browser-side enforcement demo. The rewrite was not cosmetic:

- **Enforcement moved from the bundle into Postgres.** The old build evaluated
  every rule in `App.jsx` and added to the day's total with `setPolicy`. The
  Express server in `index.js` *did* implement server-side checks, but the
  deployed frontend never called it — there is no `/api/spend` anywhere in the
  shipped JavaScript. That file is gone; the database is the server now.
- **RLS was `for all using (true) with check (true)`** on every table, with the
  anon key public in the bundle. `is_frozen` was a publicly writable boolean:
  one HTTP request from anywhere on the internet turned the kill switch off. No
  browser role holds a write grant any more.
- **A live Groq key shipped in the bundle**, because it was a `VITE_` variable
  and Vite inlines those at build time. All model calls moved to the gateway.
  The browser now holds no model key at all, so there is none to leak.
- **The human review queue bypassed the kill switch.** Approving a queued item
  added to the spend total with no re-check — freeze the wallet, click Approve,
  money moved. Release now re-runs the whole policy check in the database.
- **The spend cap had a time-of-check/time-of-use race.** A 3-second `setTimeout`
  sat between reading the total and comparing against it, so concurrent requests
  all read the same stale value. The row lock in `gw_authorize` removes it.
- **In-flight revocation was a `setTimeout` in one browser tab.** Reload and the
  payment vanished with no audit record. It is a hold with an expiry now.
- **The transaction inspector displayed a fabricated receipt hash** generated
  with `Math.random()`. Removed — it referred to nothing.
- **There was no owner.** Anyone who opened the URL could freeze, unfreeze, raise
  the cap and release held payments.

Two gaps worth naming in the pitch before a judge names them for you:

- **The counterparty is a ledger row, not a bank.** Production swaps `gw_capture`
  for a payout API call or an on-chain transfer; the state machine already has
  the right shape, because `held` is exactly where you would await settlement.
- **The Layer 2 thresholds (75 / 40, and the 40%/90% exposure floors) are chosen,
  not fitted.** Say so. "We would fit these against decline data we do not have
  yet" is a better answer than pretending otherwise.

---

## Team

* **Parth Raut** — Team Leader & Presentation Lead
* **Krupali Raut** — UI/UX Designer
* **Preet Patil** — Lead Developer
* **Archit Patil** — Full-Stack Developer

---

*Halt © 2026 — Built for Fintech Hackathon Problem Statement 2: The Kill Switch*
