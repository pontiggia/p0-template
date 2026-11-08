// Mints the S6 live-run credentials against the LOCAL pontimpo_dev (migrated
// real data) through the Pontimpo app's own service — the same
// createCredential() the /admin/credentials dialog calls, as the seeded
// superadmin@test.local, so the credential.created audit events are real.
//
// Runs with the PONTIMPO repo as cwd (its tsconfig resolves "@/…"):
//   cd ../pontimpo-tire-system && DATABASE_URL=postgres://localhost:5432/pontimpo_dev \
//     pnpm exec tsx ../d0-template/scripts/mint-pontimpo-dev-credentials.mts <env-file>
//
// Appends the keys to <env-file> (must already exist, gitignored, 0600) and
// never prints them. Refuses any database but pontimpo_dev, and refuses to
// mint twice into the same env file.

import { appendFileSync, readFileSync, statSync } from "node:fs";

const [envFile] = process.argv.slice(2);
if (!envFile) throw new Error("usage: mint-pontimpo-dev-credentials.mts <env-file>");
if ((statSync(envFile).mode & 0o077) !== 0) throw new Error(`${envFile} must be mode 0600`);
if (/^PONTIMPO_API_KEY=/m.test(readFileSync(envFile, "utf8"))) throw new Error(`${envFile} already holds a key`);

const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
if (dbName !== "pontimpo_dev") throw new Error(`refusing: expected pontimpo_dev, got ${dbName}`);

const { db, pool } = await import("@/db");
const { appUser, store } = await import("@/db/schema");
const { eq } = await import("drizzle-orm");
const { createCredentialSchema } = await import("@/modules/credential/schemas");
const { createCredential } = await import("@/modules/credential/service");

const [lasFlores] = await db.select().from(store).where(eq(store.slug, "las-flores"));
const [owner] = await db.select().from(appUser).where(eq(appUser.email, "superadmin@test.local"));
if (!lasFlores || !owner) throw new Error("store las-flores / superadmin@test.local missing");

const superadmin = {
  actor: { type: "user" as const, userId: owner.id, role: "superadmin" as const },
  storeId: lasFlores.id,
  canViewMoney: true,
};

async function mint(name: string, scopes: string[]) {
  const input = createCredentialSchema.parse({ name, scopes, storeId: String(lasFlores.id) });
  const created = await createCredential(superadmin, input);
  return created;
}

// API_SPEC §3 Phase-1 agent credential — exactly this set, nothing more.
const PHASE_1 = [
  "metrics:read", "sales:read", "sales:correct", "payments:write",
  "clients:read", "ledger:read", "audit:read", "products:read",
];

const agent = await mint("S6 dev — agente WhatsApp (Phase-1)", PHASE_1);
// Mutates a sale "behind the agent's back" for the CONFLICT check. Never
// handed to the agent.
const fixture = await mint("S6 dev — harness (conflict fixture)", ["sales:read", "sales:correct"]);

appendFileSync(envFile, [
  "# Minted by scripts/mint-pontimpo-dev-credentials.mts (store las-flores).",
  `PONTIMPO_API_KEY=${agent.key}`,
  `PONTIMPO_DEV_FIXTURE_KEY=${fixture.key}`,
  "",
].join("\n"));
console.log(`minted agent credential (store ${lasFlores.id}, scopes ${PHASE_1.join(",")}) + fixture credential; keys appended to ${envFile} (not shown)`);
await pool.end();
