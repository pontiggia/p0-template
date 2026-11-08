import { tool } from 'ai';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  getAuditEvents,
  getClient,
  getClientLedger,
  getClients,
  getProducts,
  getSale,
  getSales,
} from './client';
import { resolveLedgerEntryByNumber, resolveSaleByNumber } from './resolve';
import { PAYMENT_METHODS } from './types';
import { formatCentavos, formatUsdCentavos, formatFxRate, usdToArs } from '../money';
import type { PlannedStep } from '../session/types';

/**
 * Pontimpo tool set, built per agent run.
 *
 * Reads + resolvers hit the API/DB immediately (they're safe). The seven
 * mutation tools run in **plan-accumulator** mode: their `execute` does NOT POST
 * — it appends a `PlannedStep` (call, path, body, idempotency key, es-AR
 * summary) to `steps` and returns a description. Nothing is mutated until the
 * staff confirms (the confirmation state machine then replays `steps`).
 *
 * `onBehalfOf` (on every mutation, payments included — API_SPEC "Attribution")
 * and the `corr:<id>` description/reason tags are injected here in code —
 * never supplied by the model.
 */
export interface PontimpoToolsContext {
  /** the staff identity for `on_behalf_of` (corrections) + description tags */
  readonly onBehalfOf: string;
  readonly staffName: string;
  /** correlation id linking the steps of one correction in the audit trail */
  readonly corrId: string;
  /** accumulator the mutation tools append to (the pending plan) */
  readonly steps: PlannedStep[];
}

const methodEnum = z.enum(PAYMENT_METHODS);
const reasoning = z
  .string()
  .min(1)
  .describe('Por qué hacés esto y qué esperás encontrar / lograr');

/** Compose the reason field with the correlation tag for the audit trail. */
function taggedReason(reason: string, ctx: PontimpoToolsContext): string {
  return `${reason} — corr:${ctx.corrId} (en nombre de ${ctx.staffName})`;
}

/** Compose a payment description: staff + correlation (human-readable; attribution is on_behalf_of). */
function paymentDescription(note: string | undefined, ctx: PontimpoToolsContext): string {
  const base = `En nombre de ${ctx.staffName} — corr:${ctx.corrId}`;
  return note ? `${base} — ${note}` : base;
}

export function createPontimpoTools(ctx: PontimpoToolsContext) {
  const stage = (step: Omit<PlannedStep, 'idempotencyKey'>): PlannedStep => {
    const full: PlannedStep = { ...step, idempotencyKey: randomUUID() };
    ctx.steps.push(full);
    return full;
  };

  // ── B. Targeting reads ────────────────────────────────────────────────────

  const findClients = tool({
    description:
      'Buscar clientes por nombre o por número de cliente. Devuelve coincidencias con su deuda derivada.',
    inputSchema: z.object({ search: z.string().min(1), reasoning }),
    execute: async ({ search }) => {
      const res = await getClients(search);
      return {
        success: true,
        clients: res.data.map((c) => ({
          id: c.id,
          numero: c.local_id,
          nombre: c.name,
          deuda: formatCentavos(c.debt_centavos),
          deuda_centavos: c.debt_centavos,
        })),
      };
    },
  });

  const getClientTool = tool({
    description:
      'Detalle de un cliente por su id INTERNO (el campo id de findClients), con deuda/crédito derivados. El "número de cliente" que dice el staff NO es el id interno: buscalo primero con findClients.',
    inputSchema: z.object({ clientId: z.number().int(), reasoning }),
    execute: async ({ clientId }) => {
      const c = await getClient(clientId);
      return { success: true, client: { ...c, deuda: formatCentavos(c.debt_centavos) } };
    },
  });

  const getClientLedgerTool = tool({
    description:
      'Movimientos de la cuenta de un cliente (para encontrar un pago a revertir). Más recientes primero.',
    inputSchema: z.object({ clientId: z.number().int(), reasoning }),
    execute: async ({ clientId }) => {
      const res = await getClientLedger(clientId);
      return {
        success: true,
        entries: res.data.map((e) => ({
          id: e.id,
          kind: e.kind,
          monto: formatCentavos(e.amount_centavos),
          metodo: e.payment_method,
          fecha: e.entry_date,
          venta_numero: e.sale_local_id,
          descripcion: e.description,
        })),
      };
    },
  });

  const findSales = tool({
    description:
      'Buscar ventas por filtros (status, cliente, rango de fechas, vendedor). NO acepta número de venta — para un número usá resolveSaleByNumber.',
    inputSchema: z.object({
      status: z.enum(['pending', 'paid', 'cancelled', 'refunded']).optional(),
      clientId: z.number().int().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      soldBy: z.string().optional(),
      reasoning,
    }),
    execute: async ({ status, clientId, from, to, soldBy }) => {
      const res = await getSales({ status, clientId, from, to, soldBy });
      return {
        success: true,
        sales: res.data.map((s) => ({
          id: s.id,
          numero: s.local_id,
          fecha: s.sale_date,
          status: s.status,
          cliente: s.client_name,
          total: formatCentavos(s.total_centavos),
          deuda: formatCentavos(s.debt_centavos),
        })),
      };
    },
  });

  const getSaleTool = tool({
    description:
      'Detalle de una venta por id interno: items, entradas de ledger y deuda derivada. Usalo antes de cualquier corrección para ver el estado real.',
    inputSchema: z.object({ saleId: z.number().int(), reasoning }),
    execute: async ({ saleId }) => {
      const s = await getSale(saleId);
      return {
        success: true,
        sale: {
          id: s.id,
          numero: s.local_id,
          status: s.status,
          cliente: s.client_name,
          total: formatCentavos(s.total_centavos),
          total_centavos: s.total_centavos,
          pagado: formatCentavos(s.paid_centavos),
          deuda: formatCentavos(s.debt_centavos),
          deuda_centavos: s.debt_centavos,
          items: s.items.map((i) => ({
            sale_item_id: i.id,
            kind: i.kind,
            product_id: i.product_id,
            descripcion: i.display_description ?? i.description,
            cantidad: i.quantity,
            precio_unitario: formatCentavos(i.unit_price_centavos),
            precio_unitario_centavos: i.unit_price_centavos,
          })),
          ledger: s.ledger.map((e) => ({
            id: e.id,
            kind: e.kind,
            monto: formatCentavos(e.amount_centavos),
            metodo: e.payment_method,
            ya_revertido: e.reversed_by_entry_id != null,
          })),
        },
      };
    },
  });

  const getAuditEventsTool = tool({
    description: 'Auditoría: eventos por entidad/acción (para dar la referencia de una corrección).',
    inputSchema: z.object({
      entityType: z.string().optional(),
      entityId: z.number().int().optional(),
      action: z.string().optional(),
      reasoning,
    }),
    execute: async ({ entityType, entityId, action }) => {
      const res = await getAuditEvents({ entityType, entityId, action });
      return { success: true, events: res.data };
    },
  });

  const findProducts = tool({
    description:
      'Buscar productos por código, nombre o detalle (medida/marca). Devuelve id interno, precio y stock. Usalo para encontrar el producto correcto antes de swapSaleLine (R12).',
    inputSchema: z.object({ search: z.string().min(1), reasoning }),
    execute: async ({ search }) => {
      const res = await getProducts(search);
      return {
        success: true,
        products: res.data.slice(0, 20).map((p) => ({
          id: p.id,
          codigo: p.code,
          nombre: p.name,
          detalle: p.details,
          precio: formatCentavos(p.price_centavos),
          precio_centavos: p.price_centavos,
          stock: p.quantity_on_hand,
          activo: p.is_active,
        })),
      };
    },
  });

  // ── C. Number → PK resolvers ──────────────────────────────────────────────

  const resolveSaleByNumberTool = tool({
    description:
      'Convertir un número de venta (el que dice el staff, ej. "venta 4123") al id interno. Usalo SIEMPRE antes de leer/corregir una venta por número.',
    inputSchema: z.object({ saleNumber: z.number().int(), reasoning }),
    execute: async ({ saleNumber }) => {
      const id = await resolveSaleByNumber(saleNumber);
      return id == null
        ? { success: false, error: `No existe la venta #${saleNumber} en esta sucursal.` }
        : { success: true, saleId: id };
    },
  });

  const resolveLedgerEntryByNumberTool = tool({
    description:
      'Convertir un número de pago al id interno de la entrada de ledger (kind=payment). Para revertir un pago identificado por su número.',
    inputSchema: z.object({ paymentNumber: z.number().int(), reasoning }),
    execute: async ({ paymentNumber }) => {
      const id = await resolveLedgerEntryByNumber(paymentNumber);
      return id == null
        ? { success: false, error: `No existe el pago #${paymentNumber} en esta sucursal.` }
        : { success: true, ledgerEntryId: id };
    },
  });

  // ── D. Mutations (plan-accumulator mode — NO POST here) ───────────────────

  const cancelSale = tool({
    description:
      'PLANIFICAR anular una venta IMPAGA (R5). Si la venta tiene pagos, el server responde SALE_HAS_PAYMENTS → usá refundSale.',
    inputSchema: z.object({ saleId: z.number().int(), reason: z.string().min(1), reasoning }),
    execute: async ({ saleId, reason }) => {
      const step = stage({
        call: 'cancelSale',
        path: `/sales/${saleId}/cancel`,
        body: { reason: taggedReason(reason, ctx), on_behalf_of: ctx.onBehalfOf },
        summary: `Anular la venta (id ${saleId}).`,
      });
      return { success: true, staged: step.summary };
    },
  });

  const refundSale = tool({
    description: 'PLANIFICAR reembolsar una venta PAGADA (R6). Devuelve el dinero y (por defecto) repone stock.',
    inputSchema: z.object({
      saleId: z.number().int(),
      method: methodEnum,
      restock: z.array(z.object({ saleItemId: z.number().int(), restock: z.boolean() })).optional(),
      reason: z.string().min(1),
      reasoning,
    }),
    execute: async ({ saleId, method, restock, reason }) => {
      const step = stage({
        call: 'refundSale',
        path: `/sales/${saleId}/refund`,
        body: {
          method,
          ...(restock ? { restock: restock.map((r) => ({ sale_item_id: r.saleItemId, restock: r.restock })) } : {}),
          reason: taggedReason(reason, ctx),
          on_behalf_of: ctx.onBehalfOf,
        },
        summary: `Reembolsar la venta (id ${saleId}) por ${method}.`,
      });
      return { success: true, staged: step.summary };
    },
  });

  const correctSaleAmount = tool({
    description:
      'PLANIFICAR corregir PRECIOS de una venta (R7). Solo montos, no cantidades ni productos. Requiere expectedCurrentTotalCentavos de un getSale fresco.',
    inputSchema: z.object({
      saleId: z.number().int(),
      expectedCurrentTotalCentavos: z.number().int(),
      lines: z.array(z.object({ saleItemId: z.number().int(), unitPriceCentavos: z.number().int() })).min(1),
      reason: z.string().min(1),
      reasoning,
    }),
    execute: async ({ saleId, expectedCurrentTotalCentavos, lines, reason }) => {
      const step = stage({
        call: 'correctSaleAmount',
        path: `/sales/${saleId}/corrections`,
        body: {
          expected_current_total_centavos: expectedCurrentTotalCentavos,
          lines: lines.map((l) => ({ sale_item_id: l.saleItemId, unit_price_centavos: l.unitPriceCentavos })),
          reason: taggedReason(reason, ctx),
          on_behalf_of: ctx.onBehalfOf,
        },
        expectedTotalSnapshot: expectedCurrentTotalCentavos,
        summary: `Corregir precios de la venta (id ${saleId}): ${lines
          .map((l) => `item ${l.saleItemId} → ${formatCentavos(l.unitPriceCentavos)}`)
          .join(', ')}.`,
      });
      return { success: true, staged: step.summary };
    },
  });

  const reversePayment = tool({
    description:
      'PLANIFICAR revertir un pago registrado por error (R11). La venta vuelve a pendiente. NO se puede revertir dos veces (verificá ya_revertido con getSale primero).',
    inputSchema: z.object({ ledgerEntryId: z.number().int(), reason: z.string().min(1), reasoning }),
    execute: async ({ ledgerEntryId, reason }) => {
      const step = stage({
        call: 'reversePayment',
        path: `/ledger-entries/${ledgerEntryId}/reverse`,
        body: { reason: taggedReason(reason, ctx), on_behalf_of: ctx.onBehalfOf },
        summary: `Revertir el pago (entrada de ledger id ${ledgerEntryId}).`,
      });
      return { success: true, staged: step.summary };
    },
  });

  const swapSaleLine = tool({
    description:
      'PLANIFICAR cambiar el PRODUCTO de una línea de venta (R12). Corrige stock en ambos productos. Requiere expectedCurrentTotalCentavos de un getSale fresco.',
    inputSchema: z.object({
      saleId: z.number().int(),
      saleItemId: z.number().int(),
      newProductId: z.number().int(),
      newUnitPriceCentavos: z.number().int().optional(),
      expectedCurrentTotalCentavos: z.number().int(),
      reason: z.string().min(1),
      reasoning,
    }),
    execute: async ({ saleId, saleItemId, newProductId, newUnitPriceCentavos, expectedCurrentTotalCentavos, reason }) => {
      const step = stage({
        call: 'swapSaleLine',
        path: `/sales/${saleId}/line-swaps`,
        body: {
          sale_item_id: saleItemId,
          new_product_id: newProductId,
          ...(newUnitPriceCentavos != null ? { new_unit_price_centavos: newUnitPriceCentavos } : {}),
          expected_current_total_centavos: expectedCurrentTotalCentavos,
          reason: taggedReason(reason, ctx),
          on_behalf_of: ctx.onBehalfOf,
        },
        expectedTotalSnapshot: expectedCurrentTotalCentavos,
        summary: `Cambiar producto en la línea ${saleItemId} de la venta (id ${saleId}) por el producto ${newProductId}${
          newUnitPriceCentavos != null ? ` a ${formatCentavos(newUnitPriceCentavos)}` : ' (mismo precio)'
        }.`,
      });
      return { success: true, staged: step.summary };
    },
  });

  const registerSalePayment = tool({
    description:
      'PLANIFICAR registrar un pago sobre una venta (R2). Para pagar el total usá full=true (solo ARS). Para USD enviá amountUsdCentavos (+ fxRateCentavos opcional, default blue).',
    inputSchema: z.object({
      saleId: z.number().int(),
      paymentMethod: methodEnum,
      full: z.boolean().optional(),
      amountCentavos: z.number().int().positive().optional(),
      currency: z.enum(['ARS', 'USD']).optional(),
      amountUsdCentavos: z.number().int().positive().optional(),
      fxRateCentavos: z.number().int().positive().optional(),
      note: z.string().optional(),
      reasoning,
    }),
    execute: async (input) => {
      const { saleId, paymentMethod, full, amountCentavos, currency, amountUsdCentavos, fxRateCentavos, note } = input;
      const body: Record<string, unknown> = {
        payment_method: paymentMethod,
        description: paymentDescription(note, ctx),
        on_behalf_of: ctx.onBehalfOf,
      };
      let summary: string;
      if (currency === 'USD' || amountUsdCentavos != null) {
        if (amountUsdCentavos == null) return { success: false, error: 'Para USD enviá amountUsdCentavos.' };
        body.currency = 'USD';
        body.amount_usd_centavos = amountUsdCentavos;
        if (fxRateCentavos != null) body.fx_rate_centavos = fxRateCentavos;
        const arsApprox = fxRateCentavos != null ? ` ≈ ${formatCentavos(usdToArs(amountUsdCentavos, fxRateCentavos))}` : '';
        summary = `Registrar pago de ${formatUsdCentavos(amountUsdCentavos)}${
          fxRateCentavos != null ? ` @ ${formatFxRate(fxRateCentavos)}` : ''
        }${arsApprox} (${paymentMethod}) en la venta (id ${saleId}).`;
      } else if (full) {
        body.full = true;
        summary = `Registrar pago del total pendiente (${paymentMethod}) en la venta (id ${saleId}).`;
      } else if (amountCentavos != null) {
        body.amount_centavos = amountCentavos;
        summary = `Registrar pago de ${formatCentavos(amountCentavos)} (${paymentMethod}) en la venta (id ${saleId}).`;
      } else {
        return { success: false, error: 'Indicá full=true, amountCentavos, o un monto en USD.' };
      }
      const step = stage({ call: 'registerSalePayment', path: `/sales/${saleId}/payments`, body, summary });
      return { success: true, staged: step.summary };
    },
  });

  const registerClientPayment = tool({
    description:
      'PLANIFICAR registrar un pago a nivel cliente (R4), no atado a una venta. ARS por amountCentavos, o USD por amountUsdCentavos (+ fxRateCentavos opcional).',
    inputSchema: z.object({
      clientId: z.number().int(),
      paymentMethod: methodEnum,
      amountCentavos: z.number().int().positive().optional(),
      currency: z.enum(['ARS', 'USD']).optional(),
      amountUsdCentavos: z.number().int().positive().optional(),
      fxRateCentavos: z.number().int().positive().optional(),
      note: z.string().optional(),
      reasoning,
    }),
    execute: async (input) => {
      const { clientId, paymentMethod, amountCentavos, currency, amountUsdCentavos, fxRateCentavos, note } = input;
      const body: Record<string, unknown> = {
        payment_method: paymentMethod,
        description: paymentDescription(note, ctx),
        on_behalf_of: ctx.onBehalfOf,
      };
      let summary: string;
      if (currency === 'USD' || amountUsdCentavos != null) {
        if (amountUsdCentavos == null) return { success: false, error: 'Para USD enviá amountUsdCentavos.' };
        body.currency = 'USD';
        body.amount_usd_centavos = amountUsdCentavos;
        if (fxRateCentavos != null) body.fx_rate_centavos = fxRateCentavos;
        const arsApprox = fxRateCentavos != null ? ` ≈ ${formatCentavos(usdToArs(amountUsdCentavos, fxRateCentavos))}` : '';
        summary = `Registrar pago de cliente de ${formatUsdCentavos(amountUsdCentavos)}${
          fxRateCentavos != null ? ` @ ${formatFxRate(fxRateCentavos)}` : ''
        }${arsApprox} (${paymentMethod}) al cliente (id ${clientId}).`;
      } else if (amountCentavos != null) {
        body.amount_centavos = amountCentavos;
        summary = `Registrar pago de cliente de ${formatCentavos(amountCentavos)} (${paymentMethod}) al cliente (id ${clientId}).`;
      } else {
        return { success: false, error: 'Indicá amountCentavos o un monto en USD.' };
      }
      const step = stage({ call: 'registerClientPayment', path: `/clients/${clientId}/payments`, body, summary });
      return { success: true, staged: step.summary };
    },
  });

  return {
    findClients,
    getClient: getClientTool,
    getClientLedger: getClientLedgerTool,
    findSales,
    getSale: getSaleTool,
    getAuditEvents: getAuditEventsTool,
    findProducts,
    resolveSaleByNumber: resolveSaleByNumberTool,
    resolveLedgerEntryByNumber: resolveLedgerEntryByNumberTool,
    cancelSale,
    refundSale,
    correctSaleAmount,
    reversePayment,
    swapSaleLine,
    registerSalePayment,
    registerClientPayment,
  } as const;
}

export type PontimpoTools = ReturnType<typeof createPontimpoTools>;
