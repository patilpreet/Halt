# Halt — Autonomous AI Agent Wallet Security Engine

> **Hackathon Problem Statement 2: The Kill Switch**
> *Domain: Fintech — Autonomous AI Agent Wallet Enforcement*

Halt is a real-time wallet security layer that enforces spend limits, allowlisted payees, and an owner-controlled kill switch **independently of the agent's own logic** — so a compromised, buggy, or overly aggressive AI agent cannot drain funds faster than a human can react.

---

## 🛡️ How It Addresses The Problem Statement

| Requirement | Halt Implementation |
|---|---|
| **Wallet Layer Enforcement** | `index.js` Express server acts as the enforcement gateway — all agent spend requests pass through it. Rules are evaluated server-side, never in the agent's own code. |
| **Allowlisted Counterparties** | Owner-managed allowlist stored in Supabase. Agent can only transact with pre-approved payee domains. Any unlisted payee is blocked instantly. |
| **Owner Kill Switch** | One-click freeze button halts all agent spending. State persisted to Supabase so it survives server restarts. Also triggered automatically when AI risk score ≥ 75. |
| **Live Demo** | Built-in simulator fires autonomous spend attempts every 3.5s including attacks — all blocked in real-time on the live dashboard. |
| **In-Flight Revocation (Bonus)** | Every spend has a 3-second processing window. If the owner freezes mid-window, the transaction is **cancelled mid-execution** and logged as `REVOKED`. |

---

## 🧭 3-Layer Escalation Pipeline (Agent 1 → Agent 2 → Human)

Every spend decision runs through a tiered cascade instead of a single engine.
Each tier resolves what it can and escalates only the hard cases — and if a tier
is unavailable, the request falls through to the next one ("if one fails, another works").

| Layer | Guardian | Job | Routes |
|---|---|---|---|
| **Layer 1** | **Agent 1 — Frontline Rule Agent** | Fast, cheap deterministic checks (allowlist + spend limit). | `small & safe → approve` · `frozen / unlisted / over-limit → block` · `big chunk → Layer 2` |
| **Layer 2** | **Agent 2 — Deep Risk Agent** | Deep Groq AI risk scoring + reasoning on the uncertain cases. | `SAFE → approve` · `SUSPICIOUS → Layer 3` · `CRITICAL → freeze` |
| **Layer 3** | **Human-in-the-loop** | Wallet owner is the final authority. | `Approve / Reject` |

**Design principle — *easy to freeze, hard to approve*:** blocking or freezing can happen
at any tier (including a single frontline reflex), but *releasing funds* on a risky spend
requires a person. Large releases to trusted payees, agent disagreement, or an agent outage
all land in the **Human Review Queue**, where funds stay withheld until the owner decides.

**Failover:** each agent has a health toggle in the Escalation panel. Take **Agent 2** offline
and risky spends route straight to the human; take **Agent 1** offline and every spend gets
deep-reviewed at Layer 2. The pipeline never silently approves when a guardian is down.

---

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite |
| Styling | Tailwind CSS |
| AI Risk Engine | Groq API — LLaMA-3.3-70B Versatile |
| Database | Supabase (PostgreSQL) with local in-memory fallback |
| Enforcement Server | Node.js + Express (`index.js`) |
| Prompt Security | 20+ regex injection/jailbreak pattern scanner |

---

## 🚀 Run Locally

```bash
# 1. Install dependencies
npm install

# 2. Add your Groq API key to .env (optional — built-in fallback works without it)
# VITE_GROQ_API_KEY=gsk_...

# 3. Start the React frontend (Vite dev server)
npm run dev

# 4. (Optional) Start the Express enforcement server
node index.js

# 5. (Optional) Run the autonomous agent simulator against the server
node agent-simulator.js
```

---

## 🎯 Demo Script (For Judges)

1. **Start Simulator** — Watch autonomous agent fire spend requests every 3.5s
2. **Watch attacks get blocked** — `unknown-hacker.xyz`, `shady-endpoint.ru` hit the allowlist wall
3. **In-Flight Revocation**: Submit a manual spend → immediately hit **FREEZE** → watch it log as `REVOKED` mid-execution *(Bonus metric)*
4. **Auto-Kill**: Use "Malicious $450 Spend" preset → EXTREME risk score fires → wallet auto-freezes, alert banner appears
5. **Prompt Injection**: Use "🚨 Injection Attack" preset → scanner blocks before submission, textarea shakes red
6. **Audit Trail**: Click any transaction card → view full Groq AI reasoning, risk score, and agent intent
7. **Live Policy Edit**: Add/remove allowlist entries and change spend limit in real-time
8. **Layer 3 — Human Review**: Instruct a large spend to a trusted payee (e.g. `Reserve annual capacity on aws.amazon.com for $320`) → Agent 1 escalates → Agent 2 flags it high → it lands in the **Human Review Queue** with **Approve / Reject** buttons
9. **Failover ("if one fails, another works")**: In the Escalation panel, take **Agent 2** offline → risky spends now route straight to you; take **Agent 1** offline → every spend gets deep-reviewed at Layer 2

---

## 🔐 Security Layers (Attack Resistance)

| Attack Vector | Defense |
|---|---|
| Unlisted payee | Allowlist check (server + client) |
| Over-limit spend | Daily spend cap enforced at server |
| Prompt injection / jailbreak | 20+ regex patterns scanned before any API call |
| High risk AI payee | Groq AI risk score ≥ 75 → auto-freeze |
| Wallet drain attempt | In-flight revocation + kill switch |
| "Asking the agent nicely" | All rules enforced **outside** agent logic |

---

## 📁 Project Structure

```
Halt/
├── index.js                  ← Enforcement server (Express — the core guardrail)
├── agent-simulator.js        ← Autonomous agent simulator for demo
├── index.html                ← App entry point
├── src/
│   ├── App.jsx               ← Main app state, spend enforcement logic
│   ├── index.css             ← "Signal" design system: tokens, HUD, dial, motion
│   ├── components/
│   │   ├── Hero.jsx          ← Scroll micro-interaction: dial fills, callouts type in
│   │   ├── SecurityDial.jsx  ← The dial primitive + bracketed HUD callouts
│   │   ├── Header.jsx        ← System status, threat counters
│   │   ├── KillSwitchButton.jsx  ← Owner freeze control (built on the dial)
│   │   ├── PolicyCard.jsx    ← Live allowlist + spend limit editor
│   │   ├── AgentPlayground.jsx  ← Agent prompt console + attack presets
│   │   ├── TransactionFeed.jsx  ← Live audit feed with in-flight section
│   │   ├── AutoKillAlert.jsx ← Auto-freeze notification banner
│   │   ├── EscalationPanel.jsx ← 3-layer cascade view + Human Review Queue
│   │   ├── TransactionModal.jsx ← Full audit details modal (incl. escalation path)
│   │   └── GroqConfigModal.jsx  ← Groq API key config
│   └── lib/
│       ├── escalationEngine.js ← 3-layer cascade: Agent 1 → Agent 2 → Human
│       ├── groqEngine.js     ← AI risk scoring + prompt injection scanner
│       ├── motion.js         ← Scroll reveal, count-up, typewriter, pulse hooks
│       └── supabase.js       ← DB persistence with local fallback
```

---

## 🎛️ Interface — "Signal"

Near-black instrument panel, acid-lime signal, machined hardware detailing.
The **dial** is the organising idea: a brushed-metal disc under a lime progress
torus ringed by 60 radial ticks. It appears twice —

- **Hero** — fills as you scroll, lighting each guardian in turn while bracketed
  HUD callouts type themselves in and enforcement coverage counts to 100%.
- **Kill switch** — the same dial, interactive. The torus reads budget headroom
  and drains as the agent spends; freezing turns the whole assembly red and
  locks the hub.

Shared vocabulary: corner-bracket frames (`.hud`), hairline panels (`.panel`),
tick rails, outlined numerals that fill (`.numeral-outline`), and a scroll-reveal
layer driven by `lib/motion.js`. Everything collapses gracefully under
`prefers-reduced-motion`.

---

## 🔐 Trust boundary

`src/lib/promptSecurity.js` is the single place untrusted text is handled.
Free-text input and model output are both treated as hostile.

**1 · Injection scanning runs before any network call.** Text is matched against
a categorised rule set on three normalised views: as written, case-folded with
invisible characters stripped, and letters-only. That last pass is what catches
`i g n o r e   a l l   r u l e s`; the de-leeting pass catches `byp@ss`. Rules
cover instruction override, role hijack, guard evasion, fund drain,
exfiltration, delimiter injection and encoded payloads. Zero-width characters
anywhere in a spend instruction are refused outright.

**2 · Owner commands are proposals, never actions.** The console understands
administrative instructions — *"increase the daily budget to ₹80,000"*,
*"add api.openai.com to the allowlist"*, *"freeze the wallet"* — but
`parseOwnerCommand` only ever returns a proposal. It is rendered as a
confirmation card that a human must click. The autonomous spend path has no
route into `handleOwnerCommand`, so **an agent cannot widen its own authority**,
and an injected instruction is refused by step 1 before it can be read as a
command at all.

Note the deliberate asymmetry: administrative verbs (*increase, set, allow,
remove*) parse as owner commands; evasion verbs (*bypass, disable, override,
skip review*) are blocked. "Raise the limit to ₹80,000" is a legitimate request.
"Bypass the limit" is an attack.

**3 · Every value crossing into enforcement is validated.**

| Input | Guard |
|---|---|
| Amount (typed or model-returned) | finite, > 0, ≤ ₹1,00,00,000 — a `NaN` would silently pass every `>` comparison |
| Payee | reduced to a bare hostname; scheme, credentials, port and path stripped, so `https://evil.com@aws.amazon.com/x` resolves to `aws.amazon.com` |
| Unparseable payee | refused — never defaulted to a house vendor, which would pay someone the request never named |
| Model `risk_score` | clamped 0–100 |
| Model `verdict` / `threat_level` | restricted to the known enum |
| Model reasoning | control characters stripped, length capped |

Rejected requests are written to the audit feed as `IN` (input validator)
entries rather than discarded — a refused request is still a security event.

**4 · The agent's own prompt is fenced when shown to the reviewing model**, and
labelled as data that must be described rather than obeyed.

### On the risk numbers

Layer 2 reports **two** figures and the audit trail keeps them apart:

| Field | Meaning |
|---|---|
| `aiScore` | what the model (or heuristic fallback) actually returned |
| `policyFloor` | deterministic minimum from wallet policy alone |
| `riskScore` | the higher of the two — what the decision uses |

The transaction inspector labels which one governed, so a policy control is
never displayed as if it were a model judgement.

---

## 🌐 Deploy

**Frontend (Vercel/Netlify):**
```bash
npm run build
# Deploy the dist/ folder
```

**Backend (`index.js` → Render/Railway):**
```
Build: npm install
Start: node index.js
```

Set env vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_GROQ_API_KEY`

---

## 👥 Team & Contribution Roles

We collaborated as a team to design, build, and document Halt:

* **Parth Raut** (Team Leader & Product Manager)
  - Designed the pitch strategy, defined requirement criteria, and coordinated the project presentation and documentation.
* **Preet Patil** (Lead Full-Stack Developer)
  - Built the Express gateway server, set up Supabase synchronization, and integrated the Groq LLaMA and Gemini AI engines.
* **Krupali Raut** (UI/UX Developer)
  - Designed the "Signal" HUD interface dashboard, styled the interactive dials, and developed the visual status indicators.
* **Archit Patil** (AI Security Analyst & Quality Assurance)
  - Developed the input sanitization filters (regex scanner), mapped out attack presets, and verified threat scenarios.

---

*Halt © 2026 — Built for Fintech Hackathon Problem Statement 2: The Kill Switch*
