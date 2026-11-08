// Mints the hermetic test credentials through the Pontimpo app's own
// service — the same createCredential() the /admin/credentials dialog calls,
// as the seeded superadmin, so the credential.created audit event is real.
//
// Runs with the PONTIMPO repo as cwd (its tsconfig resolves "@/…"):
//   cd ../pontimpo-tire-system && DATABASE_URL=… pnpm exec tsx \
//     ../d0-template/scripts/mint-pontimpo-credentials.mts <out-file> <api-url>
//
// Keys go to <out-file> (mode 0600, gitignored) and are never printed.
// Refuses any database that isn't a pontimpo_e2e* hermetic one.

import { writeFileSync } from "node:fs";

const [outFile, apiUrl] = process.argv.slice(2);
if (!outFile || !apiUrl) throw new Error("usage: mint-pontimpo-credentials.mts <out-file> <api-url>");

const dbUrl = new URL(process.env.DATABASE_URL ?? "");
if (!dbUrl.pathname.slice(1).startsWith("pontimpo_e2e")) {
  throw new Error(`refusing to mint outside a pontimpo_e2e* database (got ${dbUrl.pathname.slice(1)})`);
}

const { db, pool } = await import("@/db");
const { appUser, store } = await import("@/db/schema");
const { eq } = await import("drizzle-orm");
const { createCredentialSchema } = await import("@/modules/credential/schemas");
const { createCredential } = await import("@/modules/credential/service");

const [lasFlores] = await db.select().from(store).where(eq(store.slug, "las-flores"));
const [owner] = await db.select().from(appUser).where(eq(appUser.email, "superadmin@test.local"));
if (!lasFlores || !owner) throw new Error("seed first (store las-flores + superadmin@test.local)");

const superadmin = {
  actor: { type: "user" as const, userId: owner.id, role: "superadmin" as const },
  storeId: lasFlores.id,
  canViewMoney: true,
};

async function mint(name: string, scopes: string[]) {
  const input = createCredentialSchema.parse({ name, scopes, storeId: String(lasFlores.id) });
  return (await createCredential(superadmin, input)).key;
}

// API_SPEC §3 Phase-1 agent credential — exactly this set, nothing more.
const PHASE_1 = ["metrics:read", "sales:read", "sales:correct", "payments:write", "clients:read", "ledger:read", "audit:read", "products:read"];

const agentKey = await mint("S6 test — agente WhatsApp (Phase-1)", PHASE_1);
// Lacks every write scope: drives the scope-refusal path.
const metricsKey = await mint("S6 test — solo métricas", ["metrics:read"]);
// Reads the catalog and mutates a sale between plan and confirm ("someone
// else got there first"). Never handed to the agent.
const fixtureKey = await mint("S6 test — fixtures", ["sales:read", "sales:correct", "products:read"]);

writeFileSync(
  outFile,
  [
    "# Written by scripts/pontimpo-test-app.sh — hermetic test app only. Never commit.",
    `PONTIMPO_API_URL=${apiUrl}`,
    `PONTIMPO_STORE_ID=${lasFlores.id}`,
    `PONTIMPO_TEST_DATABASE_URL=${dbUrl.toString()}`,
    `PONTIMPO_TEST_AGENT_KEY=${agentKey}`,
    `PONTIMPO_TEST_METRICS_KEY=${metricsKey}`,
    `PONTIMPO_TEST_FIXTURE_KEY=${fixtureKey}`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);
console.log(`minted 3 credentials for store ${lasFlores.id}; wrote ${outFile} (keys not shown)`);
await pool.end();
