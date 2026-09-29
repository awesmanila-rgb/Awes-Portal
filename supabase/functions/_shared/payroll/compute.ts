/* =====================================================================
 * compute.ts - turns payroll_run_inputs() (20261006_01_payroll_runs.sql)
 * into one PayLineInput per person, runs the engine, and returns the
 * lines payroll_run_store() saves. No I/O, so it is tested directly.
 *
 * Mapping (locked timesheet totals → engine attendance):
 *   DAILY / HOURLY paid   regularHours = worked regular hours
 *                           + (paid leave days + unworked regular holidays) × hours a day
 *   MONTHLY paid          salary covers the period; absentDays = absences + unpaid leave,
 *                         lateUndertimeHours = late + undertime
 *   premium / OT hours    keyed by the labor premium codes (REST_DAY, OT_REGULAR …)
 *   night differential    '' = ordinary time, otherwise stacked on that premium code
 *   month-to-date tax, the ₱90k cap and de minimis windows come from the person's
 *   earlier approved / released lines this year.
 * ===================================================================== */

import { calculatePayLine } from './engine.ts';
import { buildRuleSetSnapshot, laborRulesFromConfig } from './snapshot-adapter.ts';
import type { DeductionItem, EarningCategory, EarningItem, PayFrequency, PayLineInput, PayLineResult, RuleSetSnapshot } from './types.ts';

type Row = Record<string, any>;

export interface RunInputs {
  run: { id: string; status: string };
  period: Row;
  settings: Row;
  rules: Record<'sss' | 'philhealth' | 'pagibig' | 'bir' | 'labor', { id: string; label: string; config: Row }>;
  employees: Array<{ profile_id: string; name: string; employee: Row; totals: Row | null; recurring: Row[]; adjustments: Row[]; history: Row[] }>;
}

export interface ComputedLine { profile_id: string; name: string; input: PayLineInput; result: PayLineResult }
export interface ComputeOutcome { lines: ComputedLine[]; errors: Array<{ profile_id: string; name: string; message: string }>; ruleIds: Record<string, { id: string; label: string }> }

const EARNING_CATS = new Set(['BASIC','OVERTIME','HOLIDAY_PAY','NIGHT_DIFFERENTIAL','HAZARD_PAY','ALLOWANCE','THIRTEENTH_MONTH','BONUS','OTHER_BENEFITS','COMMISSION','LEAVE_CONVERSION','ADJUSTMENT','OTHER','REIMBURSEMENT']);
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const iso = (d: Date): string => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number): string => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

export function buildRuleSet(rules: RunInputs['rules']): RuleSetSnapshot {
  const labor = laborRulesFromConfig(rules.labor.config as never);
  return buildRuleSetSnapshot({
    versionId: ['sss', 'philhealth', 'pagibig', 'bir', 'labor'].map((k) => (rules as Row)[k].label || (rules as Row)[k].id).join(' · '),
    sss: rules.sss.config, philhealth: rules.philhealth.config, pagibig: rules.pagibig.config, bir: rules.bir.config,
  } as never, labor as never);
}

/** Which pay period of the month this is (by the month the period ends in). */
export function periodPosition(freq: PayFrequency, start: string, end: string): { index: number; count: number } {
  if (freq === 'MONTHLY') return { index: 1, count: 1 };
  if (freq === 'SEMI_MONTHLY') return { index: Number(start.slice(8, 10)) <= 15 ? 1 : 2, count: 2 };
  const step = freq === 'WEEKLY' ? 7 : 14, month = end.slice(0, 7);
  let index = 1, count = 1;
  for (let d = addDays(end, -step); d.slice(0, 7) === month; d = addDays(d, -step)) { index++; count++; }
  for (let d = addDays(end, step); d.slice(0, 7) === month; d = addDays(d, step)) count++;
  return { index, count };
}

function windowStart(period: string, end: string): string | null {
  const y = end.slice(0, 4), m = Number(end.slice(5, 7));
  if (period === 'MONTH') return end.slice(0, 8) + '01';
  if (period === 'YEAR') return y + '-01-01';
  if (period === 'SEMESTER') return y + (m <= 6 ? '-01-01' : '-07-01');
  return null;                           // DAY limits are per day and use quantity
}

export function buildInput(inp: RunInputs, emp: RunInputs['employees'][number], ruleSet: RuleSetSnapshot): PayLineInput {
  const per = inp.period, e = emp.employee, t = emp.totals || {};
  const freq = per.pay_frequency as PayFrequency;
  const hpd = num(e.hours_per_day) || 8;
  const pos = periodPosition(freq, per.period_start, per.period_end);
  const timing = inp.settings?.contribution_timing === 'FIRST_CUTOFF' ? { mode: 'FULL_ON_PERIOD' as const, periodNumber: 1 }
    : inp.settings?.contribution_timing === 'LAST_CUTOFF' ? { mode: 'FULL_ON_PERIOD' as const, periodNumber: pos.count }
    : { mode: 'SPLIT_EQUAL' as const };

  const monthly = e.rate_type === 'MONTHLY';
  const paidDays = num(t.days_paid_leave) + num(t.unworked_regular_holidays);
  const regularHours = monthly ? 0 : num(t.regular_hours) + paidDays * hpd;

  const premiumHours: { premiumCode: string; hours: number }[] = [];
  for (const src of [t.premium_hours || {}, t.ot_hours || {}]) {
    for (const [code, h] of Object.entries(src as Row)) {
      if (num(h) <= 0) continue;
      if (!ruleSet.premiums[code]) throw new Error(`Labor premium ${code} isn't in the published Labor Premiums rule.`);
      premiumHours.push({ premiumCode: code, hours: num(h) });
    }
  }
  const nightDifferentialHours = Object.entries((t.nd_hours || {}) as Row).filter(([, h]) => num(h) > 0)
    .map(([code, h]) => (code ? { hours: num(h), appliesToPremiumCode: code } : { hours: num(h) }));

  const earning = (r: Row): EarningItem => {
    const cat = String(r.category || 'ALLOWANCE').toUpperCase();
    return {
      code: r.code, name: r.name,
      category: (EARNING_CATS.has(cat) ? (cat === 'REIMBURSEMENT' ? 'OTHER' : cat) : 'OTHER') as EarningCategory,
      ...(cat === 'REIMBURSEMENT' || !EARNING_CATS.has(cat) ? { customCategory: cat } : {}),
      amount: num(r.amount),
      ...(r.quantity != null ? { quantity: num(r.quantity) } : {}),
      isTaxable: !!r.is_taxable, isDeMinimis: !!r.is_de_minimis,
      ...(r.is_de_minimis && r.de_minimis_code ? { deMinimisCode: String(r.de_minimis_code) } : {}),
    };
  };
  const deduction = (r: Row): DeductionItem => ({
    code: r.code, name: r.name, category: String(r.category || 'OTHER').toUpperCase(),
    amount: r.balance != null ? Math.min(num(r.amount), num(r.balance)) : num(r.amount),
    ...(r.priority != null ? { priority: num(r.priority) } : {}),
    allowPartial: r.allow_partial !== false, isTaxable: false, isDeMinimis: false,
  });

  // earlier approved / released pay this year
  const hist = emp.history || [];
  const month = String(per.period_end).slice(0, 7);
  const mtd = hist.filter((h) => String(h.period_end).slice(0, 7) === month && h.pay_frequency === freq);
  const usage: Record<string, number> = {};
  for (const [code, rule] of Object.entries(ruleSet.bir.deMinimis)) {
    const key = rule.pool ?? code;
    const from = windowStart(rule.period, per.period_end);
    if (!from || key in usage) continue;
    usage[key] = hist.filter((h) => h.period_end >= from).reduce((a, h) => a + num(h.carry_forward?.deMinimisUsage?.[key]), 0);
  }

  return {
    ruleSet,
    employee: {
      employeeId: emp.profile_id,
      isMinimumWageEarner: !!e.is_mwe,
      ...(e.regional_min_daily_wage != null ? { regionalMinimumDailyWage: num(e.regional_min_daily_wage) } : {}),
      compensation: { rateType: e.rate_type, baseRate: num(e.base_rate), workingDaysPerYear: num(e.working_days_per_year), hoursPerDay: hpd },
    },
    payFrequency: freq,
    period: { periodStart: per.period_start, periodEnd: per.period_end, periodIndexInMonth: pos.index, periodsInMonth: pos.count },
    attendance: {
      regularHours,
      absentDays: monthly ? num(t.days_absent) + num(t.days_unpaid_leave) : 0,
      lateUndertimeHours: monthly ? num(t.late_hours) + num(t.undertime_hours) : 0,
      premiumHours, nightDifferentialHours,
    },
    recurringEarnings: emp.recurring.filter((r) => r.kind === 'earning').map(earning),
    oneOffEarnings: emp.adjustments.filter((r) => r.kind === 'earning').map(earning),
    recurringDeductions: emp.recurring.filter((r) => r.kind === 'deduction').map(deduction),
    oneOffDeductions: emp.adjustments.filter((r) => r.kind === 'deduction').map(deduction),
    statutory: {
      sss: { enabled: !!e.sss_enabled, timing },
      philhealth: { enabled: !!e.philhealth_enabled, timing },
      pagibig: { enabled: !!e.pagibig_enabled, timing },
      withholdingTax: { enabled: !!e.tax_enabled },
    },
    monthToDate: {
      taxableIncome: mtd.reduce((a, h) => a + num(h.taxable_income), 0),
      withholdingTax: mtd.reduce((a, h) => a + num(h.withholding_tax), 0),
    },
    yearToDate: { otherBenefitsUsed: hist.reduce((a, h) => a + num(h.carry_forward?.otherBenefitsAdded), 0) },
    deMinimisWindowUsage: usage,
    minimumNetPay: num(inp.settings?.minimum_net_pay),
  };
}

export function computeRun(inp: RunInputs): ComputeOutcome {
  const ruleSet = buildRuleSet(inp.rules);
  const out: ComputeOutcome = { lines: [], errors: [], ruleIds: {} };
  for (const k of Object.keys(inp.rules)) out.ruleIds[k] = { id: (inp.rules as Row)[k].id, label: (inp.rules as Row)[k].label };
  for (const emp of inp.employees) {
    try {
      const input = buildInput(inp, emp, ruleSet);
      out.lines.push({ profile_id: emp.profile_id, name: emp.name, input, result: calculatePayLine(input) });
    } catch (e) {
      out.errors.push({ profile_id: emp.profile_id, name: emp.name, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
