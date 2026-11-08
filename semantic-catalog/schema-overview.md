# Pontimpo — resumen del esquema (gomería, Postgres)

Pontimpo es el sistema de una gomería argentina (sucursal principal: **Las Flores, `store_id = 1`**).
Registra ventas de neumáticos/repuestos y servicios, la cuenta corriente de cada cliente (un
*ledger* de deuda), la caja, el stock y la auditoría. Fuente de verdad de las fórmulas:
`metrics/*.yaml` (copia exacta de `METRICS_SPEC.md` y de lo que calcula la API `/api/v1/metrics/*`).

## Las 6 reglas de oro (TODA consulta las cumple)

1. **Sucursal**: la base es multi-sucursal. TODA consulta filtra `store_id = 1` (la sucursal de la
   credencial) en CADA tabla de dominio que toque (`sale`, `sale_item`, `client`, `product`,
   `service`, `client_ledger_entry`, `cash_movement`, `stock_movement`). Sin excepción, aunque haya JOIN.
   Solo `exchange_rate` e `inflation_rate` son globales (no tienen `store_id`).
2. **Plata = BIGINT en centavos** (sufijo `_centavos`). `$148.500,00` = `14850000`. Para mostrar:
   dividí por 100 y formateá es-AR (`$ 148.500,00`: punto de miles, coma decimal). Nunca uses float
   para sumar: sumá centavos y dividí al final.
3. **Ventas anuladas/reembolsadas NO cuentan**: toda métrica de ventas usa
   `sale.status IN ('pending','paid')`. `cancelled` y `refunded` se excluyen siempre.
4. **Zona horaria Buenos Aires** (`America/Argentina/Buenos_Aires`, UTC−3 fijo, sin horario de verano).
   Días, semanas y meses se cortan en hora local. Rango inclusivo [desde, hasta] →
   `col >= TIMESTAMPTZ 'desde 00:00:00-03' AND col < TIMESTAMPTZ '(hasta+1 día) 00:00:00-03'`.
5. **Dos relojes distintos**:
   - métricas de VENTA (venta bruta, ganancia, unidades) → fecha de negocio `sale.sale_date`;
   - métricas de COBRANZA (cobrado, devuelto, descuentos) → `client_ledger_entry.entry_date`
     (la plata cuenta cuando se movió, no cuando se vendió).
6. **Deuda = suma del ledger**: no hay columna de saldo. Deuda de un cliente =
   `SUM(client_ledger_entry.amount_centavos)` (positivo = debe, negativo = saldo a favor).

## Entidades

| Tabla | Qué es | Filas aprox. (sucursal 1) |
|---|---|---|
| `store` | sucursales (1 = Las Flores) | 2 |
| `client` | clientes; `local_id` = "número de cliente" que usa el personal | ~1.300 |
| `sale` | ventas (cabecera); `local_id` = "número de venta"; `total_centavos` | ~4.900 |
| `sale_item` | líneas de venta (producto o servicio), precio, costo congelado | ~4.900 |
| `product` | catálogo de productos (neumáticos, cámaras, repuestos), stock actual | ~770 |
| `service` | servicios (mano de obra), sin costo ni stock | 6 |
| `client_ledger_entry` | **cuenta corriente** (append-only): ventas +, pagos −, etc. | ~12.000 |
| `cash_movement` | registro de caja (append-only): cobros, egresos, ingresos | ~8.300 |
| `stock_movement` | movimientos de stock por producto | ~800 |
| `product_price_history` | historial de precio/costo por producto | ~770 |
| `exchange_rate` | cotización diaria del dólar blue (global) | — |
| `inflation_rate` | IPC mensual (global) | — |
| `audit_event` | auditoría (quién hizo qué; agente + `on_behalf_of`) | — |
| `app_user` / `store_membership` | personal y su rol por sucursal | 5 |

Las tablas de autenticación y credenciales (`auth_*`, `api_credential`, `idempotency_key`)
**no están disponibles** para analítica.

## Flujo del negocio

1. Una **venta** (`sale` + 1..n `sale_item`) genera en el ledger una entrada `kind='sale'` por `+total`.
2. Los **pagos** son entradas `kind='payment'` con monto **negativo** y `payment_method`
   (efectivo, credito, debito, transferencia, cheque). Cada pago genera además un
   `cash_movement(kind='payment_received', +monto)`.
3. Estado de la venta: `pending` (debe algo) → `paid` (deuda 0). `cancelled` (anulada sin pagos) y
   `refunded` (reembolsada) quedan fuera de toda métrica.
4. Las correcciones nunca borran: se agregan entradas inversas (`adjustment`, `cancellation`, `refund`).

## Patrones frecuentes (copiá y adaptá)

Venta bruta de octubre de 2026:
```sql
SELECT coalesce(sum(s.total_centavos), 0) AS venta_bruta_centavos, count(*) AS cantidad_ventas
FROM sale s
WHERE s.store_id = 1
  AND s.status IN ('pending', 'paid')
  AND s.sale_date >= TIMESTAMPTZ '2026-10-01 00:00:00-03'
  AND s.sale_date <  TIMESTAMPTZ '2026-11-01 00:00:00-03'
```

Cobrado por método esta semana (lunes a hoy, hora BA):
```sql
SELECT l.payment_method, -sum(l.amount_centavos) AS cobrado_centavos
FROM client_ledger_entry l
WHERE l.store_id = 1
  AND l.kind = 'payment'
  AND l.entry_date >= (date_trunc('week', now() AT TIME ZONE 'America/Argentina/Buenos_Aires') AT TIME ZONE 'America/Argentina/Buenos_Aires')
  AND l.entry_date <  ((date_trunc('day', now() AT TIME ZONE 'America/Argentina/Buenos_Aires') + interval '1 day') AT TIME ZONE 'America/Argentina/Buenos_Aires')
GROUP BY l.payment_method
ORDER BY cobrado_centavos DESC
```

Top deudores:
```sql
SELECT c.local_id AS numero_cliente, c.name, sum(l.amount_centavos) AS deuda_centavos
FROM client_ledger_entry l
JOIN client c ON c.id = l.client_id AND c.store_id = 1
WHERE l.store_id = 1
GROUP BY c.id, c.local_id, c.name
HAVING sum(l.amount_centavos) > 0
ORDER BY deuda_centavos DESC, c.id
LIMIT 5
```

Más métricas exactas (ganancia neta, ganancia IVA, deuda viva, ticket promedio, top productos,
caja…) en `metrics/`. Términos de negocio → SQL en `glossary.md`. Joins en `relationships/joins.yaml`.
