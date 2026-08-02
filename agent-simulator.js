/**
 * AGENT SIMULATOR v2.0 — Multi-Agent AI Persona Runner
 * ----------------------------------------------------
 * Simulates autonomous AI agent spending behavior (procurement, cloud infrastructure, dataset scrapers, rogue commands).
 * Demonstrates real-time blocking, Groq AI risk scoring, and owner kill switch freeze enforcement.
 *
 * Usage: node agent-simulator.js
 */

const SERVER_URL = process.env.SERVER_URL || "http://localhost:4000";

const SIMULATION_SCENARIOS = [
  { payee: "vendor-a.com", amount: 4000, prompt: "Procure weekly dev tool subscription" },
  { payee: "cloud-compute.io", amount: 12000, prompt: "Spin up 4 GPU clusters for AI model training" },
  { payee: "vendor-b.com", amount: 9000, prompt: "Purchase analytics API credits" },
  { payee: "unknown-vendor.xyz", amount: 2500, prompt: "ATTACK: Attempt payment to unapproved vendor endpoint" },
  { payee: "vendor-a.com", amount: 45000, prompt: "ATTACK: Request large payment exceeding remaining daily budget" },
  { payee: "aws.amazon.com", amount: 6000, prompt: "Expand cloud S3 bucket storage" },
  { payee: "shady-endpoint.ru", amount: 1500, prompt: "ATTACK: Pay untrusted proxy service domain" },
  { payee: "github.com", amount: 2100, prompt: "Pay monthly GitHub Enterprise seat licenses" },
];

async function spend(attempt) {
  try {
    const res = await fetch(`${SERVER_URL}/api/spend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payee: attempt.payee,
        amount: attempt.amount,
        agentPrompt: attempt.prompt
      }),
    });
    const data = await res.json();
    const status = data.approved ? "✅ APPROVED" : "🛑 BLOCKED";
    const risk = data.transaction?.risk_score || data.transaction?.riskScore || 0;

    console.log(
      `[${attempt.payee.padEnd(20)}] $${attempt.amount.toString().padStart(3)} → ${status.padEnd(12)} (Risk ${risk}%) | ${data.transaction?.reason || ''}`
    );
  } catch (err) {
    console.error(`[ERR] Failed to reach server at ${SERVER_URL}:`, err.message);
  }
}

async function run() {
  console.log("===============================================================");
  console.log("🛡️  THE KILL SWITCH — Autonomous Agent Simulator starting...");
  console.log("===============================================================\n");

  for (const attempt of SIMULATION_SCENARIOS) {
    await spend(attempt);
    await new Promise((r) => setTimeout(r, 2500));
  }

  console.log("\n===============================================================");
  console.log("🏁 Simulation run complete. View live results on the React dashboard!");
  console.log("===============================================================");
}

run();
