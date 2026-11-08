# p0 — Natural Language SQL Agent

> A forkable template for building an AI agent that turns plain English into SQL queries. Ask questions, get insights and charts from your Postgres database.

Built with Next.js, Claude, and the [Vercel AI SDK](https://sdk.vercel.ai). Inspired by [Vercel's d0 architecture](https://vercel.com/blog/we-removed-80-percent-of-our-agents-tools).

---

## How It Works

Instead of building complex data-transformation tools, the agent gets a filesystem full of well-documented schema files — the **semantic catalog** — and explores it on its own before writing any SQL.

```
  "Show me top 10 products by revenue"
                  │
                  ▼
    ┌──────────────────────────┐
    │     Claude (Opus 4.5)    │
    │                          │
    │  1. Explore catalog      │──▶  ls / cat / grep inside sandbox
    │  2. Read table YAMLs     │──▶  column names, types, joins
    │  3. Write grounded SQL   │──▶  SELECT verified against catalog
    │  4. Execute query        │──▶  read-only Postgres function
    │  5. Visualize results    │──▶  chart config → Recharts
    └──────────────────────────┘
                  │
                  ▼
       Streamed response with
       text, tables, and charts
```

Every column name and join pattern comes from files the agent reads. No hallucinated columns. No wrong joins.

---

## The 3 Tools

The entire agent runs on just three tools:

| Tool                 | What it does                                                                                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`executeCommand`** | Runs shell commands (`ls`, `cat`, `grep`, `find`, `head`, `tail`, `wc`) inside a sandboxed copy of your schema docs. The agent uses this to explore and understand your database before writing SQL. |
| **`executeSQL`**     | Executes read-only `SELECT` queries against Postgres through a safety function. Write operations are blocked.                                                                                        |
| **`generateChart`**  | Returns chart configuration (bar, line, area, pie) that the frontend renders as interactive Recharts visualizations.                                                                                 |

---

## Safety

Four layers of protection:

| Layer                     | Detail                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| **Shell whitelist**       | Only `ls`, `cat`, `grep`, `find`, `head`, `tail`, `wc` can run                               |
| **SQL gateway**           | `execute_readonly_sql()` blocks writes, enforces a 5 s timeout, limits results to 1 000 rows |
| **Zod validation**        | Every tool call requires an `explanation` param — forced chain-of-thought                    |
| **Frontend sanitization** | `rehype-sanitize` strips unsafe HTML from all rendered output                                |

> **Tip:** Point the agent at a read replica, not your primary database.

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/pontiggia/p0-template.git
cd p0-template
pnpm install
```

### 2. Environment variables

```bash
cp .env.local.example .env.local
```

| Variable               | Where to get it                                                                  |
| ---------------------- | -------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`    | [console.anthropic.com](https://console.anthropic.com)                           |
| `DATABASE_URL`         | Your Postgres connection string (`postgresql://user:pass@host:5432/db`)          |
| `VERCEL_SANDBOX_TOKEN` | [Vercel dashboard](https://vercel.com) — or auto-provided via OIDC when deployed |

### 3. Create the SQL safety function

Run the contents of `rpc-function.sql` in your Postgres database. This creates `execute_readonly_sql()` — the gateway through which all agent queries pass.

### 4. The semantic catalog

`semantic-catalog/` documents **Pontimpo's** schema (from its `docs/SCHEMA.md`, `docs/METRICS_SPEC.md` and `src/db/schema/**`): store scoping (`store_id = 1` on every domain table), money as bigint centavos, the `pending`/`paid` inclusion rule, Buenos Aires day/week/month boundaries, and the exact metric formulas the app's `/api/v1/metrics/*` and `/debtors` compute:

```
semantic-catalog/
├── schema-overview.md          # High-level database overview
├── glossary.md                 # Business terms → SQL mappings
├── tables/
│   └── *.yaml                  # One file per table: columns, types, common queries
├── metrics/
│   └── *.yaml                  # Exact metric formulas (venta bruta, ganancia neta/IVA, cobrado, deuda viva…)
├── relationships/
│   └── joins.yaml              # How tables connect, join patterns
├── enums/
│   └── enums.yaml              # Enum values and meanings
└── functions/
    └── functions-overview.yaml # The SQL gateway's rules + date/format expressions
```

Each YAML file includes column definitions, indexes, foreign keys, business rules, and ready-made query patterns. The live suite (`test/live/dev-data.live.test.ts`) asserts the WhatsApp answers against the app's own API figures.

### 5. Customize the system prompt

Edit `src/lib/system-prompt.ts` to match your domain — the prompt defines what kind of analyst the agent is and what workflow it follows.

### 6. Run

```bash
pnpm dev
```

Open [localhost:3000](http://localhost:3000) and start asking questions.

---

## Deploy

```bash
vercel
```

Add your environment variables in the Vercel dashboard. The sandbox token is provided automatically via OIDC when deployed to Vercel.

---

## Project Structure

```
src/
├── app/
│   ├── api/chat/route.ts         # Streaming chat endpoint (AI SDK + Claude)
│   ├── page.tsx                   # Chat UI entry point
│   └── layout.tsx                 # Root layout
├── components/
│   ├── chat-layout.tsx            # Header, message area, input container
│   ├── chat-input.tsx             # Auto-resizing textarea
│   ├── message-bubble.tsx         # Message display + tool call rendering
│   ├── data-chart.tsx             # Recharts wrapper (bar, line, area, pie)
│   ├── data-table.tsx             # Fallback table for large datasets
│   ├── typing-indicator.tsx       # Loading animation
│   └── chat/
│       ├── markdown-renderer.tsx  # react-markdown + GFM + sanitization
│       ├── chart-display.tsx      # Chart state management + validation
│       └── code-block.tsx         # Syntax-highlighted code blocks
├── db/
│   └── client.ts                  # Drizzle ORM + pg connection pool
└── lib/
    ├── system-prompt.ts           # Agent personality and workflow rules
    ├── tools.ts                   # Tool definitions and execution logic
    ├── sandbox.ts                 # Vercel Sandbox singleton + file mounting
    ├── sql-executor.ts            # Query execution via safety function
    ├── semantic-layer.ts          # Recursive catalog file loader
    └── chart/
        ├── config.ts              # Chart Zod schema
        └── downsampling.ts        # Data reduction for large result sets
```

---

## Stack

| Layer      | Technology                                                                                |
| ---------- | ----------------------------------------------------------------------------------------- |
| Framework  | [Next.js 16](https://nextjs.org) with React 19                                            |
| AI         | [Claude Opus 4.5](https://anthropic.com) via [Vercel AI SDK](https://sdk.vercel.ai)       |
| Database   | Postgres with [Drizzle ORM](https://orm.drizzle.team)                                     |
| Sandbox    | [Vercel Sandbox](https://vercel.com/docs/functions/sandbox) for isolated file exploration |
| Charts     | [Recharts](https://recharts.org) with auto table-fallback                                 |
| Styling    | [Tailwind CSS 4](https://tailwindcss.com) + [shadcn/ui](https://ui.shadcn.com)            |
| Validation | [Zod](https://zod.dev)                                                                    |

---

## License

MIT
