# p0 — Natural Language SQL Agent

A forkable template for building an AI agent that converts natural language questions into SQL queries. Ask questions in plain English, get instant answers from your Postgres database.

Built with Next.js, Claude, Drizzle ORM, and the [Vercel AI SDK](https://sdk.vercel.ai). Inspired by [Vercel's d0 architecture](https://vercel.com/blog/we-removed-80-percent-of-our-agents-tools).

## Architecture

The agent runs on **3 tools**:

1. **`executeCommand`** — Runs shell commands (`ls`, `cat`, `grep`) inside a sandbox containing your schema documentation files. The agent uses this to explore and understand your database before writing SQL.

2. **`executeSQL`** — Executes read-only SELECT queries against your Postgres. Write operations are blocked.

3. **`generateChart`** — Returns chart configuration that the frontend renders as interactive visualizations.

The key insight: instead of building complex tools that transform data, give the model a filesystem full of good schema docs and let it explore. The **semantic catalog** — a folder of YAML and Markdown files describing your database — is what makes the agent accurate.

## Quick Start

### 1. Clone and install

```bash
git clone <this-repo>
cd p0
pnpm install
```

### 2. Set up environment variables

```bash
cp .env.local.example .env.local
```

Fill in your keys:

- `ANTHROPIC_API_KEY` — Get from [console.anthropic.com](https://console.anthropic.com)
- `DATABASE_URL` — Your Postgres connection string (`postgresql://user:password@host:5432/dbname`)
- `VERCEL_SANDBOX_TOKEN` — From [Vercel](https://vercel.com) (or use `vercel env pull` when deployed)

### 3. Set up the SQL safety function

Run the contents of `rpc-function.sql` in your Postgres database. This creates the `execute_readonly_sql()` function that the agent uses — it blocks writes, enforces timeouts, and limits results.

### 4. Customize the semantic catalog

Replace the example files in `semantic-catalog/` with your own database documentation:

```
semantic-catalog/
├── schema-overview.md        # High-level database overview
├── glossary.md               # Business terms → SQL mappings
├── tables/
│   ├── your_table.yaml       # Column names, types, descriptions
│   └── another_table.yaml    # Common queries, business rules
├── views/
│   └── your_view.yaml        # View definitions
├── relationships/
│   └── joins.yaml            # How tables connect
├── enums/
│   └── enums.yaml            # Enum values and meanings
└── functions/
    └── functions-overview.yaml
```

The YAML files follow a consistent format — see the included examples for the structure.

### 5. Customize the system prompt

Edit `src/lib/system-prompt.ts` to match your domain. The prompt tells the agent what kind of data analyst it is and what workflow to follow.

### 6. Run

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) and start asking questions.

## Deploy to Vercel

```bash
vercel
```

Add your environment variables in the Vercel dashboard.

## How It Works

When someone asks a question:

1. The agent explores `semantic-catalog/` via the sandbox to understand your schema
2. It reads the relevant YAML files to get exact column names, types, and join patterns
3. It writes SQL grounded in verified schema information
4. It executes the query through the read-only safety function
5. It formats the response (with optional charts)

Every column name and join pattern comes from the catalog files the agent reads. No hallucinated columns. No wrong joins.

## Safety

4 layers of protection:

1. **Shell whitelist** — Only `ls`, `cat`, `grep`, `find`, `head`, `tail`, `wc`
2. **SQL gateway** — `execute_readonly_sql()` blocks writes, enforces 5s timeout, limits to 1000 rows
3. **Zod validation** — Every tool call requires an explanation param (forced chain-of-thought)
4. **Frontend sanitization** — Strips unsafe HTML from all rendered output

**Recommendation**: Point the agent at a read replica, not your primary database.

## Stack

- [Next.js 16](https://nextjs.org) — App framework
- [Vercel AI SDK](https://sdk.vercel.ai) — Agent orchestration
- [Claude](https://anthropic.com) — Language model (via `@ai-sdk/anthropic`)
- [Drizzle ORM](https://orm.drizzle.team) — Database client
- [Vercel Sandbox](https://vercel.com/docs/functions/sandbox) — Isolated file exploration
- [Recharts](https://recharts.org) — Chart visualization
