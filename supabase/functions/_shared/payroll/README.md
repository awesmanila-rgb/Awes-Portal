# Payroll engine (shared)

Pure calculation engine for Philippine payroll. No I/O and no hard-coded rates:
every rate, bracket and multiplier comes from the published `payroll_rules`
rows (migration `20261004_01_payroll_foundation.sql`).

- `engine.ts` — `calculatePayLine(input)` → one employee's pay for one period
- `snapshot-adapter.ts` — `payroll_rules.config` JSONB → `RuleSetSnapshot`
- `types.ts` — shared types (rebuilt for AWES from what the engine and tests use)
- `engine.test.ts` — 21 tests

Phase 3's `payroll-compute` Edge Function imports these files.

Run the tests with Deno (`deno test engine.test.ts`) or Node 22.18+
(`node --test engine.test.ts`).
