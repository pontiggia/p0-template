// Creates test clients + sales in the hermetic Pontimpo DB through the app's
// real recipes (createClient, R1 createSale) as the seeded superadmin — the
// same way pontimpo's own seed builds its second store. Needed because
// POST /api/v1/sales is FORBIDDEN for every API credential (createSale
// requires a user actor: sale.sold_by is NOT NULL).
//
// Runs with the PONTIMPO repo as cwd (its tsconfig resolves "@/…"):
//   DATABASE_URL=… pnpm exec tsx ../d0-template/scripts/pontimpo-fixtures.mts '<json specs>'
// specs: [{ "product": "1001", "quantity": 1, "paid": false }, { }]   ({} = client only)
// Prints JSON ids on stdout. Refuses any database that isn't pontimpo_e2e*.

import { randomUUID } from "node:crypto";

const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
if (!dbName.startsWith("pontimpo_e2e")) throw new Error(`refusing non-e2e database ${dbName}`);

type Spec = { product?: string; quantity?: number; paid?: boolean };
const specs = JSON.parse(process.argv[2] ?? "[]") as Spec[];

const { db, pool } = await import("@/db");
const { appUser, product, store } = await import("@/db/schema");
const { and, eq } = await import("drizzle-orm");
const { clientInputSchema } = await import("@/modules/client/schemas");
const { createClient } = await import("@/modules/client/service");
const { saleCreateSchema } = await import("@/modules/sale/schemas");
const { createSale } = await import("@/modules/sale/service");

const [lasFlores] = await db.select().from(store).where(eq(store.slug, "las-flores"));
const [owner] = await db.select().from(appUser).where(eq(appUser.email, "superadmin@test.local"));
const ctx = {
  actor: { type: "user" as const, userId: owner.id, role: "superadmin" as const },
  storeId: lasFlores.id,
  canViewMoney: true,
};

const out = [];
for (const spec of specs) {
  const c = await createClient(ctx, clientInputSchema.parse({ name: `S6 Cliente ${randomUUID().slice(0, 8)}` }));
  if (!spec.product) {
    out.push({ clientId: c.id, clientLocalId: c.localId, clientName: c.name });
    continue;
  }
  const [p] = await db.select().from(product)
    .where(and(eq(product.storeId, lasFlores.id), eq(product.code, spec.product)));
  const sale = await createSale(ctx, saleCreateSchema.parse({
    saleDate: null, isInvoiced: false, notes: null, clientId: c.id,
    lines: [{ kind: "product", productId: p.id, quantity: spec.quantity ?? 1, unitPriceCentavos: null }],
    payment: spec.paid ? { method: "efectivo", description: null } : null,
  }));
  out.push({ clientId: c.id, clientLocalId: c.localId, clientName: c.name, saleId: sale.id, saleLocalId: sale.localId });
}
process.stdout.write(JSON.stringify(out));
await pool.end();
