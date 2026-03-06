# Business Glossary

## Key Business Concepts

### "Active Users"

Users who placed at least one order in the last 30 days.

**SQL:**
```sql
WHERE id IN (
  SELECT customer_id FROM orders
  WHERE created_at > NOW() - INTERVAL '30 days'
    AND status NOT IN ('cancelled', 'refunded')
)
```

---

### "Revenue"

Sum of total_amount from non-cancelled orders. Always in USD.

**SQL:**
```sql
SUM(total_amount) WHERE status NOT IN ('cancelled', 'refunded')
```

---

### "Churn Rate"

Users active last month but not this month.

**SQL:**
```sql
-- Users who ordered last month but not this month
SELECT COUNT(DISTINCT last_month.customer_id)::numeric / COUNT(DISTINCT last_month.customer_id)
FROM (
  SELECT DISTINCT customer_id FROM orders
  WHERE created_at BETWEEN DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
    AND DATE_TRUNC('month', CURRENT_DATE)
    AND status NOT IN ('cancelled', 'refunded')
) last_month
LEFT JOIN (
  SELECT DISTINCT customer_id FROM orders
  WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE)
    AND status NOT IN ('cancelled', 'refunded')
) this_month ON this_month.customer_id = last_month.customer_id
WHERE this_month.customer_id IS NULL;
```

---

## Business Terms and SQL Equivalents

### User Terms

| Business Term | SQL Equivalent | Description |
|---------------|----------------|-------------|
| **Customer** | `users` table | A registered user who can place orders |
| **Name** | `users.name` | Full name of the customer |
| **Email** | `users.email` | Email address (unique per user) |
| **Signup Date** | `users.created_at` | When the user registered |
| **Country** | `users.country` | User's country |

### Order Terms

| Business Term | SQL Equivalent | Description |
|---------------|----------------|-------------|
| **Order** | `orders` table | A customer purchase with one or more items |
| **Order Total** | `orders.total_amount` | Total order value in USD |
| **Order Status** | `orders.status` | Current order state |
| **Order Date** | `orders.created_at` | When the order was placed |
| **Shipping Address** | `orders.shipping_address` | Delivery address |

### Product Terms

| Business Term | SQL Equivalent | Description |
|---------------|----------------|-------------|
| **Product** | `products` table | An item available for purchase |
| **SKU** | `products.sku` | Unique product identifier |
| **Product Price** | `products.price` | Current list price in USD |
| **Category** | `products.category` | Product category (Electronics, Clothing, etc.) |
| **In Stock** | `products.in_stock` | Whether product is available |

### Revenue & Metrics Terms

| Business Term | SQL Equivalent | Description |
|---------------|----------------|-------------|
| **Revenue** | `SUM(orders.total_amount)` | Total sales excluding cancelled/refunded |
| **AOV** | `AVG(orders.total_amount)` | Average Order Value |
| **Units Sold** | `SUM(order_items.quantity)` | Total product units sold |
| **Conversion Rate** | Orders / Visits | Percentage of visits resulting in orders |
| **Customer Lifetime Value** | `SUM(total_amount) per customer` | Total spend per customer |
| **Repeat Rate** | Users with >1 order / Total users | Percentage of repeat customers |

---

## Common Value Enumerations

### Order Status (orders.status)
- `pending` - Order placed, awaiting processing
- `confirmed` - Order confirmed and being prepared
- `shipped` - Order shipped, in transit
- `delivered` - Order delivered to customer
- `cancelled` - Order cancelled (EXCLUDE from revenue)
- `refunded` - Order refunded (EXCLUDE from revenue)

### Product Categories (products.category)
- `Electronics`
- `Clothing`
- `Home & Garden`
- `Books`
- `Sports`
- `Food & Beverage`
- `Health & Beauty`
- `Toys`

---

## Query Patterns

### Aggregation Functions
- `COUNT(*)` - Count rows
- `SUM(column)` - Sum values
- `AVG(column)` - Average value
- `MIN(column)` - Minimum value
- `MAX(column)` - Maximum value

### Window Functions
- `ROW_NUMBER()` - Assign sequential number
- `RANK()` - Rank with gaps
- `LAG()` - Previous row value
- `SUM() OVER()` - Running total

### Date Functions
- `NOW()` - Current timestamp
- `CURRENT_DATE` - Current date
- `DATE_TRUNC('day', timestamp)` - Round to day
- `INTERVAL '1 day'` - Time interval

### String Functions
- `ILIKE` - Case-insensitive pattern match
- `LOWER()` - Convert to lowercase
- `TRIM()` - Remove whitespace
