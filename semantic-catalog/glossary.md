# Glosario — términos del negocio → SQL

Siempre: `store_id = 1` en cada tabla de dominio, montos en centavos (÷100 para mostrar),
cortes de día/semana/mes en hora de Buenos Aires. Fórmulas completas en `metrics/`.

## Períodos (hora de Buenos Aires)

Usá `now()` para "hoy" — la base sabe la fecha. `BA` = `'America/Argentina/Buenos_Aires'`.

| Lo que dicen | Rango inclusivo | Límite SQL (`col >= desde AND col < hasta_exclusivo`) |
|---|---|---|
| hoy | hoy | `date_trunc('day', now() AT TIME ZONE BA) AT TIME ZONE BA` … `+ interval '1 day'` |
| ayer | ayer | día de hoy − 1 |
| esta semana | **lunes de esta semana → hoy** | `date_trunc('week', now() AT TIME ZONE BA) AT TIME ZONE BA` … inicio de mañana |
| la semana pasada | lunes → domingo de la semana anterior | `date_trunc('week', …) - interval '7 days'` … `date_trunc('week', …)` |
| este mes | día 1 del mes → hoy | `date_trunc('month', now() AT TIME ZONE BA) AT TIME ZONE BA` … inicio de mañana |
| el mes pasado | mes calendario anterior completo | `date_trunc('month', …) - interval '1 month'` … `date_trunc('month', …)` |
| "en octubre" (sin año) | el octubre más reciente que ya empezó (en noviembre de 2026 → octubre de 2026), mes completo | `TIMESTAMPTZ '2026-10-01 00:00:00-03'` … `TIMESTAMPTZ '2026-11-01 00:00:00-03'` |
| este año | 1 de enero → hoy | `date_trunc('year', …)` … inicio de mañana |

`X AT TIME ZONE BA` sobre un `timestamptz` da la hora local (timestamp sin zona); aplicado de nuevo
sobre ese timestamp local lo vuelve a `timestamptz`. Literal equivalente: `TIMESTAMPTZ 'AAAA-MM-DD 00:00:00-03'`.
Nunca cortes por `date(col)` en UTC: una venta de las 22 h de BA cae en el día siguiente UTC.

## Ventas (reloj: `sale.sale_date`; solo `status IN ('pending','paid')`)

| Término | SQL |
|---|---|
| **Venta bruta / Ventas brutas / "cuánto vendimos" / facturación** | `SUM(sale.total_centavos)` de ventas incluidas en el rango |
| **Cantidad de ventas** | `COUNT(*)` de ventas incluidas (`COUNT(DISTINCT sale.id)` si hay JOIN con `sale_item`) |
| **Ticket promedio** | venta bruta ÷ cantidad de ventas, redondeado a centavo entero |
| **Ganancia neta** (también "ganancia bruta", "margen", "cuánto ganamos") | líneas de producto con costo: `SUM((unit_price_centavos − unit_cost_centavos) × quantity)` **+** líneas de servicio: `SUM(sale_item.total_centavos)` (los servicios son margen puro). Líneas de producto con `unit_cost_centavos IS NULL` se excluyen (12 filas históricas) → ver `metrics/ganancia_neta.yaml` |
| **Ganancia IVA** ("lo que nos ganamos de IVA", "IVA win") | `ROUND(SUM(unit_cost_centavos × quantity) × 0.17)` sobre líneas de **producto** de ventas **no facturadas** (`sale.is_invoiced = false`); nunca servicios → `metrics/ganancia_iva.yaml` |
| **Productos vendidos** (unidades) | `SUM(sale_item.quantity)` solo líneas `kind = 'product'` |
| **Neumáticos / cubiertas vendidas** | igual, solo productos con `product.is_tire = true` |
| **% precio modificado** | líneas de producto con `unit_price_centavos <> list_price_centavos` ÷ líneas de producto |
| **Top productos / más vendidos** | por producto: `SUM(quantity)`, ventas distintas, última venta, stock actual → `metrics/top_productos.yaml` |
| **Venta facturada / con factura** | `sale.is_invoiced = true` ("en blanco"); `false` = sin factura ("en negro") |
| **Vendedor** | `sale.sold_by_user_id → app_user.name` |

## Cobranza (reloj: `client_ledger_entry.entry_date`)

| Término | SQL |
|---|---|
| **Cobrado / cobranza / "cuánto entró" / "cuánto se cobró"** | `−SUM(amount_centavos)` de entradas `kind = 'payment'` en el rango (da positivo) |
| **Cobrado en efectivo / con cheque / por transferencia / con débito / con crédito (tarjeta)** | lo mismo con `payment_method = 'efectivo' / 'cheque' / 'transferencia' / 'debito' / 'credito'` |
| **Cobrado en dólares** | pagos con `currency = 'USD'`: `amount_centavos` es el equivalente en pesos; `SUM(amount_usd_centavos)` da los US$ (centavos de dólar) |
| **Devuelto / reembolsos** | `SUM(amount_centavos)` de `kind = 'refund'` en el rango |
| **Descuentos / bonificaciones** | `−SUM(amount_centavos)` de `kind = 'discount'` |
| **Retenciones** | `−SUM(amount_centavos)` de `kind = 'tax_withholding'` |

El cobrado NO se mezcla con la venta bruta: una venta de octubre cobrada en noviembre suma a la
venta bruta de octubre y al cobrado de noviembre.

## Deuda (reloj: todas las entradas del ledger hasta la fecha de corte)

| Término | SQL |
|---|---|
| **Deuda de un cliente / saldo** | `SUM(client_ledger_entry.amount_centavos)` del cliente (positivo = debe) |
| **Saldo a favor (crédito del cliente)** | saldo negativo; se muestra en positivo como "a favor" |
| **Deuda viva / deuda total / "cuánto nos deben"** | suma de los saldos **positivos** por cliente (no restar los saldos a favor) → `metrics/deuda_viva.yaml` |
| **Saldo a favor de clientes (total)** | suma de los saldos negativos por cliente |
| **Deudores** | clientes con saldo > 0; "los que más deben" = ordenar por saldo desc, desempate `client.id` |
| **Último pago de un cliente** | `MAX(entry_date)` de sus entradas `kind = 'payment'` |
| **Ventas pendientes de un cliente** | `sale.status = 'pending'` del cliente |
| **Deuda de una venta** | `total − pagado`; para una venta puntual preferí `getSale` (la API ya calcula `debt_centavos`) |

## Caja (`cash_movement`)

| Término | SQL |
|---|---|
| **Saldo de caja (total o por método)** | `SUM(cash_movement.amount_centavos)` (por `method`); es un registro, no una autoridad |
| **Egresos / gastos** | `kind = 'expense'` (montos negativos) |
| **Ingresos manuales** | `kind = 'income'` |

## Clientes, productos, stock

| Término | SQL |
|---|---|
| **Número de cliente / de venta** | `client.local_id` / `sale.local_id` (lo que dice el personal; **no** es el `id` interno) |
| **Stock de un producto** | `product.quantity_on_hand` |
| **Código de producto** | `product.code` (texto, único por sucursal); medida/marca en `product.details` |
| **Neumático / cubierta** | `product.is_tire = true` |
| **Servicio (gomería, mano de obra)** | tabla `service`; en ventas, `sale_item.kind = 'service'` |

## Dólar e inflación

| Término | SQL |
|---|---|
| **Dólar blue / cotización** | `exchange_rate` con `type = 'blue'`; `sell_centavos` = pesos-centavos por US$ 1 (venta) |
| **≈ US$ de una métrica** | métrica ÷ promedio de `sell_centavos` blue de los días del período con dato |
| **Inflación / IPC** | `inflation_rate.cpi_monthly_pct` por `period` ('AAAA-MM'); solo informativo |

## Formato de respuesta

Montos es-AR: `$ 37.316.660,00` (punto de miles, coma decimal, siempre 2 decimales). Para convertir
centavos → texto en SQL usá la expresión `formato_ars` de `functions/functions-overview.yaml`.
