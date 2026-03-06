# Database Schema Overview

## System Purpose
This database powers an **e-commerce analytics system** that tracks users, orders, and products. It provides comprehensive reporting capabilities for sales performance, customer behavior, and product analytics.

## Core Entities

### Primary Tables
- **users** (~10,000 rows) - Customer information including name, email, signup date
- **orders** (~450,000 rows) - All customer orders with line items and payment status
- **products** (~500 rows) - Product catalog with pricing and category information
- **order_items** (~1,200,000 rows) - Individual line items linking orders to products

### Supporting Tables
- **categories** (~20 rows) - Product category lookup table

## Entity Relationships

### Core Data Flow
1. **Users** place **Orders**
2. Each **Order** contains one or more **Order Items**
3. Each **Order Item** references a **Product**
4. **Products** belong to **Categories**

### Key Relationships
- Each **user** has many **orders** (one-to-many)
- Each **order** has many **order_items** (one-to-many)
- Each **order_item** references one **product** (many-to-one)
- Each **product** belongs to one **category** (many-to-one)

## Common Query Patterns

### 1. Get Recent Orders with Customer Info
```sql
SELECT o.*, u.name, u.email
FROM orders o
JOIN users u ON u.id = o.customer_id
ORDER BY o.created_at DESC
LIMIT 20;
```

### 2. Get Top Selling Products
```sql
SELECT
  p.name,
  p.category,
  SUM(oi.quantity) as units_sold,
  SUM(oi.quantity * oi.unit_price) as total_revenue
FROM order_items oi
JOIN products p ON p.id = oi.product_id
JOIN orders o ON o.id = oi.order_id
WHERE o.status NOT IN ('cancelled', 'refunded')
GROUP BY p.id, p.name, p.category
ORDER BY total_revenue DESC;
```

### 3. Get Daily Revenue
```sql
SELECT
  DATE(created_at) as day,
  COUNT(*) as order_count,
  SUM(total_amount) as revenue
FROM orders
WHERE status NOT IN ('cancelled', 'refunded')
GROUP BY DATE(created_at)
ORDER BY day DESC;
```

### 4. Get Customer Lifetime Value
```sql
SELECT
  u.id,
  u.name,
  u.email,
  COUNT(o.id) as total_orders,
  SUM(o.total_amount) as lifetime_value,
  MIN(o.created_at) as first_order,
  MAX(o.created_at) as last_order
FROM users u
JOIN orders o ON o.customer_id = u.id
WHERE o.status NOT IN ('cancelled', 'refunded')
GROUP BY u.id, u.name, u.email
ORDER BY lifetime_value DESC;
```

## Database Patterns

### Audit Columns (All Main Tables)
- `created_at` - When record was first created (default: now())
- `updated_at` - When record was last modified (auto-updated via trigger)

### Unique Constraints
- Users: Unique email address
- Orders: Unique order number
- Products: Unique SKU

### Data Types
| SQL Type | Use Case | Example |
|----------|----------|---------|
| `uuid` | Unique identifiers | `gen_random_uuid()` |
| `varchar` | Variable text | Names, emails |
| `text` | Long text | Descriptions |
| `integer` | Whole numbers | Quantities |
| `numeric(10,2)` | Decimal numbers | Prices, amounts |
| `timestamp with time zone` | Date + time | Order timestamps |
| `date` | Date only | Signup dates |
| `boolean` | True/false | Active flags |

## Reporting Views

### monthly_revenue
Provides monthly aggregated revenue metrics:
- Total orders and revenue per month
- Average order value
- Unique customers
- Month-over-month comparison
