# Dependency upgrades — S6 (Pontimpo GOAL decision F: everything to latest)

2026-11-07, branch `feat/s6-upgrade`. Every dependency is on latest; `pnpm outdated` is empty.
Gate: `pnpm typecheck && pnpm lint && pnpm build && pnpm test` → 0.

| Package | From | To | Kind | What changed here |
|---|---|---|---|---|
| **ai** | 6.0.116 | **7.0.165** | major | `system` → `instructions`; `stepCountIs` → `isStepCount`; the chat route's `{role:'system'}` message (v7 rejects system messages inside `messages`) moved to `instructions` with its cache breakpoint; `result.toUIMessageStreamResponse()` → `createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream }) })`. **Behavioural fix:** in v7 `result.response.messages` is the *final step only*, so the WhatsApp thread history now persists `result.responseMessages` (all steps) — otherwise tool calls/results of earlier steps silently fell out of the stored history. `result.text` is still final-step text. |
| **@ai-sdk/anthropic** | 3.0.58 | **4.0.99** | major | Matches ai 7. Model ids unchanged (`claude-opus-4-8` WhatsApp, `claude-opus-4-5-20251101` web chat). |
| **@ai-sdk/react** | 3.0.118 | **4.0.169** | major | `useChat` call in `src/app/page.tsx` unchanged; typechecks. |
| **zod** | 3.25.76 | **4.6.7** | major | `z.record(v)` → `z.record(z.string(), v)` (3 sites). |
| **@vercel/sandbox** | 1.8.0 | **3.9.1** | major | `Sandbox.create / writeFiles / runCommand / stop` signatures unchanged for our use. |
| **recharts** | 2.15.4 | **3.10.1** | major | `src/components/ui/chart.tsx` replaced with shadcn's recharts-3 chart (the file the Pontimpo app uses), keeping this repo's container classes (`aspect-[4/3] sm:aspect-video`, `text-xs`). |
| **typescript** | 5.9.3 | **7.0.2** | major | See the lint pin below. `tsconfig` now `"strict": true` — required, not cosmetic: under `strict: false` ai 7's `tool()` infers every tool's input as `any`, so the zod schemas stopped typing `execute`. With `strict` the code compiles unchanged and a wrongly-typed tool input is a type error again. |
| **eslint** | 9.39.3 | **10.14.0** | major | Flat config unchanged. |
| **@types/node** | 20.19.37 | **26.6.6** | major | ai 7 requires Node ≥ 22 (runtime is 22.21). |
| next / eslint-config-next | 16.1.6 | 16.4.5 | minor | |
| react / react-dom | 19.2.3 | 19.3.1 | minor | |
| @types/react / @types/react-dom | 19.2.x | 19.3.0 | minor | |
| drizzle-orm | 0.44.7 | 0.45.4 | minor | |
| pg / @types/pg | 8.20.0 / 8.18.0 | 8.23.1 | minor | |
| @upstash/redis | 1.38.0 | 1.41.0 | minor | |
| @vercel/functions | 3.7.1 | 3.11.0 | minor | |
| tailwindcss / @tailwindcss/postcss | 4.2.1 | 4.3.5 | minor | |
| tailwind-merge | 3.5.0 | 3.7.0 | minor | |
| **vitest** | — | 5.1.0 | new (dev) | Hermetic test harness (below). |

## Pins (not at latest, with the upstream reason)

| Pin | Version | Why |
|---|---|---|
| typescript *inside the typescript-eslint stack only* | 6.0.3 | TS 7 (native) ships no classic JS compiler API, and `typescript-eslint` latest (8.72.1, via `eslint-config-next`) declares peer `typescript <6.1.0` and crashes on 7. `.pnpmfile.cjs` (copied from the Pontimpo repo, same trick) gives only `@typescript-eslint/*` / `typescript-eslint` / `ts-api-utils` TS 6.0.3 as a dependency. The project itself compiles with TS 7. Delete the hook when typescript-eslint supports TS 7. |

## Peer-range lag (runs, upstream hasn't widened `peerDependencies`)

Same as the Pontimpo repo: `eslint-plugin-react` 7.37.5 (`… ^9.7`), `eslint-plugin-import` 2.32.0 (`… ^9`), `eslint-plugin-jsx-a11y` 6.10.2 (`… ^9`) come in through `eslint-config-next` 16.4.5 and declare ESLint ≤ 9; they run under ESLint 10 (`pnpm lint` passes and reports).

## Tests

| Command | What | Needs |
|---|---|---|
| `pnpm pontimpo:up` | Fresh `pontimpo_e2e_s6` DB (migrate + seed + this repo's `rpc-function.sql`), Pontimpo production build on `:3091`, three credentials minted through the app's own `createCredential` service as the seeded superadmin (Phase-1 agent / metrics-only / fixtures) → `.env.test.local` (0600, gitignored, never printed) | local Postgres, `../pontimpo-tire-system` |
| `pnpm test` | Hermetic suite: no LLM (scripted `MockLanguageModelV4`), Kapso = local stub, loopback-only fetch guard | `pnpm pontimpo:up` |
| `pnpm test:live` | The seven mutating recipes through the real agent loop | `ANTHROPIC_API_KEY` (skipped without it) + `pnpm pontimpo:up` |
| `pnpm pontimpo:down` | Stop the server, drop the DB, delete `.env.test.local` | |
