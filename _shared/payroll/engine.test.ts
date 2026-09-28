/* =====================================================================
 * engine.test.ts - run with:  npm test
 *
 * Fixtures below mirror the JSONB seeded by migrations 002/003 (snake_case),
 * so this suite also proves the adapter -> snapshot -> engine chain.
 * The numbers in fixtures are TEST DATA; the engine itself contains none.
 * ===================================================================== */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculatePayLine, makeRounder, PayrollEngineError } from './engine.ts';
import { buildRuleSetSnapshot, laborRulesFromConfig, type LaborRules } from './snapshot-adapter.ts';
import type { AgencyOption, EarningItem, PayLineInput, RuleSetSnapshot } from './types.ts';

/* ------------------------------ fixtures ------------------------------ */

const sssBrackets = Array.from({ length: 61 }, (_, i) => {
  const msc = 5000 + i * 500;
  return {
    msc,
    comp_from: i === 0 ? 0 : msc - 250,
    comp_to: i === 60 ? null : msc + 249.99,
    regular_msc: Math.min(msc, 20000),
    mpf_msc: Math.max(msc - 20000, 0),
  };
});

function seededRows(overrides: { sssEmployeeRate?: number; birRateScale?: number } = {}) {
  const scale = overrides.birRateScale ?? 1;
  return {
    versionId: 'PH_2026_V2',
    sss: {
      employee_rate: overrides.sssEmployeeRate ?? 0.05,
      employer_rate: 0.1,
      ec: { threshold_msc: 15000, below_amount: 10, at_or_above_amount: 30 },
      brackets: sssBrackets,
    },
    philhealth: {
      premium_rate: 0.05,
      employee_split: 0.5,
      employer_split: 0.5,
      salary_floor: 10000,
      salary_ceiling: 100000,
      min_total_premium: 500,
      max_total_premium: 5000,
    },
    pagibig: {
      employee_rate: 0.02,
      employer_rate: 0.02,
      max_fund_salary: 10000,
      max_employee_contribution: 200,
      max_employer_contribution: 200,
    },
    bir: {
      period: 'MONTHLY',
      rounding: { mode: 'HALF_UP', scale: 2 },
      brackets: [
        { over: 0, up_to: 20833, base_tax: 0, rate: 0, excess_over: 0 },
        { over: 20833, up_to: 33333, base_tax: 0, rate: 0.15 * scale, excess_over: 20833 },
        { over: 33333, up_to: 66667, base_tax: 1875, rate: 0.2 * scale, excess_over: 33333 },
        { over: 66667, up_to: 166667, base_tax: 8541.8, rate: 0.25 * scale, excess_over: 66667 },
        { over: 166667, up_to: 666667, base_tax: 33541.8, rate: 0.3 * scale, excess_over: 166667 },
        { over: 666667, up_to: null, base_tax: 183541.8, rate: 0.35 * scale, excess_over: 666667 },
      ],
      other_benefits_cap: {
        annual_amount: 90000,
        covers: ['THIRTEENTH_MONTH', 'BONUS', 'OTHER_BENEFITS'],
        de_minimis_excess_treatment: 'ADD_TO_OTHER_BENEFITS',
      },
      de_minimis: {
        RICE_SUBSIDY: { limit_type: 'AMOUNT', limit: 2500, period: 'MONTH' },
        CBA_PRODUCTIVITY: { limit_type: 'AMOUNT', limit: 12000, period: 'YEAR', pool: 'CBA_PRODUCTIVITY' },
        ACHIEVEMENT_AWARDS: { limit_type: 'AMOUNT', limit: 12000, period: 'YEAR' },
        LEAVE_MONETIZATION: { limit_type: 'DAYS', limit: 12, period: 'YEAR' },
        OT_NIGHT_MEAL: { limit_type: 'PCT_OF_MIN_WAGE', pct: 0.3, period: 'DAY' },
      },
    },
  };
}

const labor: LaborRules = {
  payFrequencies: {
    WEEKLY: { periodsPerYear: 52 },
    BI_WEEKLY: { periodsPerYear: 26 },
    SEMI_MONTHLY: { periodsPerYear: 24 },
    MONTHLY: { periodsPerYear: 12 },
  },
  premiums: {
    OT_REGULAR: { code: 'OT_REGULAR', name: 'Overtime (Regular Day)', category: 'OVERTIME', multiplier: 1.25 },
    HOLIDAY_REGULAR_WORKED: {
      code: 'HOLIDAY_REGULAR_WORKED',
      name: 'Regular Holiday Worked',
      category: 'HOLIDAY_PAY',
      multiplier: 2,
      monthlyPaidMultiplier: 1,
    },
  },
  nightDifferential: { rate: 0.1 },
  mweExemptCategories: ['BASIC', 'OVERTIME', 'HOLIDAY_PAY', 'NIGHT_DIFFERENTIAL', 'HAZARD_PAY'],
};

const snapshot: RuleSetSnapshot = buildRuleSetSnapshot(seededRows(), labor);

const splitEqual: AgencyOption = { enabled: true, timing: { mode: 'SPLIT_EQUAL' } };

function makeInput(overrides: Partial<PayLineInput> = {}): PayLineInput {
  return {
    ruleSet: snapshot,
    employee: {
      employeeId: 'emp-1',
      isMinimumWageEarner: false,
      compensation: { rateType: 'MONTHLY', baseRate: 30000, workingDaysPerYear: 261, hoursPerDay: 8 },
    },
    payFrequency: 'MONTHLY',
    period: { periodStart: '2026-03-01', periodEnd: '2026-03-31', periodIndexInMonth: 1, periodsInMonth: 1 },
    attendance: { regularHours: 0, absentDays: 0, lateUndertimeHours: 0, premiumHours: [], nightDifferentialHours: [] },
    recurringEarnings: [],
    oneOffEarnings: [],
    recurringDeductions: [],
    oneOffDeductions: [],
    statutory: { sss: splitEqual, philhealth: splitEqual, pagibig: splitEqual, withholdingTax: { enabled: true } },
    monthToDate: { taxableIncome: 0, withholdingTax: 0 },
    yearToDate: { otherBenefitsUsed: 0 },
    deMinimisWindowUsage: {},
    ...overrides,
  };
}

function semiMonthly(index: 1 | 2, overrides: Partial<PayLineInput> = {}): PayLineInput {
  return makeInput({
    payFrequency: 'SEMI_MONTHLY',
    period: { periodStart: '2026-03-01', periodEnd: '2026-03-15', periodIndexInMonth: index, periodsInMonth: 2 },
    ...overrides,
  });
}

const item = (overrides: Partial<EarningItem> & Pick<EarningItem, 'code' | 'amount'>): EarningItem => ({
  name: overrides.code,
  category: 'ALLOWANCE',
  isTaxable: true,
  isDeMinimis: false,
  ...overrides,
});

/* ------------------------------ tests ------------------------------ */

test('monthly pay: SSS, PhilHealth, Pag-IBIG, taxable income, BIR tax, net pay', () => {
  const r = calculatePayLine(makeInput());
  assert.equal(r.totals.grossPay, 30000);
  assert.equal(r.contributions.sss.period.employee, 1500);
  assert.equal(r.contributions.sss.period.employer, 3000);
  assert.equal(r.contributions.sss.period.ec, 30);
  assert.equal(r.contributions.philhealth.period.employee, 750);
  assert.equal(r.contributions.philhealth.period.employer, 750);
  assert.equal(r.contributions.pagibig.period.employee, 200);
  assert.equal(r.contributions.pagibig.period.employer, 200);
  assert.equal(r.totals.employeeMandatoryContributions, 2450);
  assert.equal(r.totals.taxableIncome, 27550);
  assert.equal(r.totals.withholdingTax, 1007.55); // 0.15 * (27,550 - 20,833)
  assert.equal(r.totals.netPay, 26542.45);
  assert.equal(r.totals.employerContributions, 3980);
  assert.equal(r.totals.employerCost, 33980);
  assert.equal(r.tax.method, 'PER_PERIOD_TABLE');
});

test('semi-monthly SPLIT_EQUAL: contributions halved, tax settles on cumulative month-to-date', () => {
  const first = calculatePayLine(semiMonthly(1));
  assert.equal(first.totals.grossPay, 15000);
  assert.equal(first.totals.employeeMandatoryContributions, 1225);
  assert.equal(first.totals.withholdingTax, 0);
  assert.equal(first.totals.netPay, 13775);
  assert.equal(first.tax.method, 'MONTH_TO_DATE_CUMULATIVE');

  const second = calculatePayLine(
    semiMonthly(2, { monthToDate: { taxableIncome: first.totals.taxableIncome, withholdingTax: first.totals.withholdingTax } }),
  );
  assert.equal(second.totals.withholdingTax, 1007.55);
  assert.equal(second.totals.netPay, 12767.45);
  // Month total equals the single monthly run.
  assert.equal(first.totals.withholdingTax + second.totals.withholdingTax, 1007.55);
  assert.equal(first.contributions.sss.period.employee + second.contributions.sss.period.employee, 1500);
});

test('semi-monthly FULL_ON_PERIOD: 100% on the 2nd cutoff, nothing on the 1st', () => {
  const opt: AgencyOption = { enabled: true, timing: { mode: 'FULL_ON_PERIOD', periodNumber: 2 } };
  const statutory = { sss: opt, philhealth: opt, pagibig: opt, withholdingTax: { enabled: true } };

  const first = calculatePayLine(semiMonthly(1, { statutory }));
  assert.equal(first.totals.employeeMandatoryContributions, 0);
  assert.equal(first.contributions.sss.appliesThisPeriod, false);
  assert.equal(first.totals.netPay, 15000);

  const second = calculatePayLine(
    semiMonthly(2, {
      statutory,
      monthToDate: { taxableIncome: first.totals.taxableIncome, withholdingTax: first.totals.withholdingTax },
    }),
  );
  assert.equal(second.totals.employeeMandatoryContributions, 2450);
  assert.equal(second.totals.taxableIncome, 12550);
  assert.equal(second.totals.withholdingTax, 1007.55);
  assert.equal(second.totals.netPay, 11542.45);
});

test('SPLIT_EQUAL allocates odd centavos exactly across the month', () => {
  const override = { ...splitEqual, monthlyCompensationOverride: 10001 };
  const statutory = { sss: splitEqual, philhealth: override, pagibig: splitEqual, withholdingTax: { enabled: true } };
  const a = calculatePayLine(semiMonthly(1, { statutory }));
  const b = calculatePayLine(semiMonthly(2, { statutory }));
  const monthly = a.contributions.philhealth.monthly;
  assert.equal(monthly.employee + monthly.employer, 500.05);
  assert.equal(a.contributions.philhealth.period.employee + b.contributions.philhealth.period.employee, monthly.employee);
  assert.equal(a.contributions.philhealth.period.employer + b.contributions.philhealth.period.employer, monthly.employer);
});

test('PhilHealth floor/ceiling and Pag-IBIG fund-salary cap come from the snapshot', () => {
  const low = calculatePayLine(makeInput({
    employee: { employeeId: 'e', isMinimumWageEarner: false, compensation: { rateType: 'MONTHLY', baseRate: 8000, workingDaysPerYear: 261, hoursPerDay: 8 } },
  }));
  assert.equal(low.contributions.philhealth.monthly.employee + low.contributions.philhealth.monthly.employer, 500);

  const high = calculatePayLine(makeInput({
    employee: { employeeId: 'e', isMinimumWageEarner: false, compensation: { rateType: 'MONTHLY', baseRate: 250000, workingDaysPerYear: 261, hoursPerDay: 8 } },
  }));
  assert.equal(high.contributions.philhealth.monthly.employee + high.contributions.philhealth.monthly.employer, 5000);
  assert.equal(high.contributions.pagibig.monthly.employee, 200);
  assert.equal(high.contributions.sss.detail.msc, 35000);
  assert.equal(high.contributions.sss.monthly.ec, 30);
});

test('SSS EC tier below the threshold', () => {
  const r = calculatePayLine(makeInput({
    employee: { employeeId: 'e', isMinimumWageEarner: false, compensation: { rateType: 'MONTHLY', baseRate: 12000, workingDaysPerYear: 261, hoursPerDay: 8 } },
  }));
  assert.equal(r.contributions.sss.detail.msc, 12000);
  assert.equal(r.contributions.sss.period.ec, 10);
});

test('minimum wage earner: basic, OT and night diff are exempt; withholding tax is zero', () => {
  const mwe = (flag: boolean): PayLineInput =>
    semiMonthly(1, {
      employee: {
        employeeId: 'e',
        isMinimumWageEarner: flag,
        compensation: { rateType: 'DAILY', baseRate: 645, workingDaysPerYear: 261, hoursPerDay: 8 },
      },
      attendance: {
        regularHours: 88,
        absentDays: 0,
        lateUndertimeHours: 0,
        premiumHours: [{ premiumCode: 'OT_REGULAR', hours: 2 }],
        nightDifferentialHours: [{ hours: 4 }],
      },
    });

  const exempt = calculatePayLine(mwe(true));
  assert.equal(exempt.basicPay.netBasicPay, 7095); // 88h x 80.625
  assert.equal(exempt.totals.taxableEarnings, 0);
  assert.equal(exempt.totals.nonTaxableEarnings, exempt.totals.grossPay);
  assert.equal(exempt.totals.withholdingTax, 0);
  assert.equal(exempt.tax.mweExemptEarnings, exempt.totals.grossPay);
  assert.ok(exempt.breakdown.earnings.every((l) => l.exemptions.some((e) => e.reason === 'MWE_EXEMPT')));

  const regular = calculatePayLine(mwe(false));
  assert.equal(regular.totals.taxableEarnings, regular.totals.grossPay);
  assert.equal(regular.totals.grossPay, exempt.totals.grossPay);
});

test('overtime, holiday and night differential premiums (monthly-paid multiplier override)', () => {
  const r = calculatePayLine(makeInput({
    employee: { employeeId: 'e', isMinimumWageEarner: false, compensation: { rateType: 'MONTHLY', baseRate: 26100, workingDaysPerYear: 261, hoursPerDay: 8 } },
    attendance: {
      regularHours: 0,
      absentDays: 0,
      lateUndertimeHours: 0,
      premiumHours: [
        { premiumCode: 'OT_REGULAR', hours: 4 },
        { premiumCode: 'HOLIDAY_REGULAR_WORKED', hours: 8 },
      ],
      nightDifferentialHours: [{ hours: 2, appliesToPremiumCode: 'OT_REGULAR' }],
    },
  }));
  // daily = 26100*12/261 = 1200, hourly = 150
  assert.equal(r.basicPay.hourlyRate, 150);
  assert.equal(r.grossByCategory.OVERTIME, 750); // 4 x 150 x 1.25
  assert.equal(r.grossByCategory.HOLIDAY_PAY, 1200); // monthly-paid: 8 x 150 x 1.0
  assert.equal(r.grossByCategory.NIGHT_DIFFERENTIAL, 37.5); // 2 x 150 x 1.25 x 0.10
});

test('absences and tardiness reduce basic pay for monthly-rated staff', () => {
  const r = calculatePayLine(makeInput({
    employee: { employeeId: 'e', isMinimumWageEarner: false, compensation: { rateType: 'MONTHLY', baseRate: 26100, workingDaysPerYear: 261, hoursPerDay: 8 } },
    attendance: { regularHours: 0, absentDays: 2, lateUndertimeHours: 1.5, premiumHours: [], nightDifferentialHours: [] },
  }));
  assert.equal(r.basicPay.absenceDeduction, 2400);
  assert.equal(r.basicPay.lateUndertimeDeduction, 225);
  assert.equal(r.basicPay.netBasicPay, 23475);
  // Contributions still key off the contractual monthly rate, not the reduced pay.
  assert.equal(r.contributions.sss.monthlyCompensationBase, 26100);
});

test('de minimis: within limit is exempt; excess flows into the other-benefits cap', () => {
  const r = calculatePayLine(makeInput({
    recurringEarnings: [item({ code: 'RICE_SUBSIDY', amount: 3000, isDeMinimis: true, deMinimisCode: 'RICE_SUBSIDY', isTaxable: false })],
  }));
  const line = r.breakdown.earnings.find((l) => l.code === 'RICE_SUBSIDY')!;
  assert.deepEqual(line.exemptions.map((e) => [e.reason, e.amount]), [['DE_MINIMIS', 2500], ['OTHER_BENEFITS_CAP', 500]]);
  assert.equal(line.taxableAmount, 0);
  assert.deepEqual(r.carryForward.deMinimisUsage, { RICE_SUBSIDY: 2500 });
  assert.equal(r.carryForward.otherBenefitsAdded, 500);
});

test('de minimis excess becomes taxable once the annual cap is exhausted', () => {
  const r = calculatePayLine(makeInput({
    yearToDate: { otherBenefitsUsed: 89800 },
    deMinimisWindowUsage: { RICE_SUBSIDY: 2000 },
    recurringEarnings: [item({ code: 'RICE_SUBSIDY', amount: 1000, isDeMinimis: true, deMinimisCode: 'RICE_SUBSIDY', isTaxable: false })],
  }));
  const line = r.breakdown.earnings.find((l) => l.code === 'RICE_SUBSIDY')!;
  // 500 fits the monthly limit; the 500 excess has only 200 of cap left.
  assert.deepEqual(line.exemptions.map((e) => [e.reason, e.amount]), [['DE_MINIMIS', 500], ['OTHER_BENEFITS_CAP', 200]]);
  assert.equal(line.taxableAmount, 300);
});

test('13th month pay is exempt only up to the cap in the snapshot', () => {
  const r = calculatePayLine(makeInput({
    oneOffEarnings: [item({ code: 'THIRTEENTH_MONTH', amount: 100000, category: 'THIRTEENTH_MONTH' })],
  }));
  const line = r.breakdown.earnings.find((l) => l.code === 'THIRTEENTH_MONTH')!;
  assert.equal(line.exemptAmount, 90000);
  assert.equal(line.taxableAmount, 10000);
  assert.equal(r.totals.taxableEarnings, 40000);
});

test('pooled de minimis limits (CBA + productivity share one ceiling); DAYS and PCT_OF_MIN_WAGE types', () => {
  const r = calculatePayLine(makeInput({
    employee: {
      employeeId: 'e',
      isMinimumWageEarner: false,
      compensation: { rateType: 'MONTHLY', baseRate: 30000, workingDaysPerYear: 261, hoursPerDay: 8 },
      regionalMinimumDailyWage: 645,
    },
    oneOffEarnings: [
      item({ code: 'CBA_INCENTIVE', amount: 8000, isDeMinimis: true, deMinimisCode: 'CBA_PRODUCTIVITY' }),
      item({ code: 'PRODUCTIVITY', amount: 8000, isDeMinimis: true, deMinimisCode: 'CBA_PRODUCTIVITY' }),
      item({ code: 'VL_CONVERSION', amount: 5000, quantity: 10, category: 'LEAVE_CONVERSION', isDeMinimis: true, deMinimisCode: 'LEAVE_MONETIZATION' }),
      item({ code: 'MEALS', amount: 1000, quantity: 4, isDeMinimis: true, deMinimisCode: 'OT_NIGHT_MEAL' }),
    ],
    deMinimisWindowUsage: { LEAVE_MONETIZATION: 6 },
  }));
  const byCode = (code: string) => r.breakdown.earnings.find((l) => l.code === code)!;
  assert.equal(byCode('CBA_INCENTIVE').exemptions[0]!.amount, 8000);
  assert.equal(byCode('PRODUCTIVITY').exemptions[0]!.amount, 4000); // pool has 4,000 left
  // 12-day limit, 6 used, item has 10 days -> 6 exempt days = 3,000
  assert.equal(byCode('VL_CONVERSION').exemptions[0]!.amount, 3000);
  // 0.30 x 645 x 4 meals = 774 exempt
  assert.equal(byCode('MEALS').exemptions[0]!.amount, 774);
  assert.equal(r.carryForward.deMinimisUsage.CBA_PRODUCTIVITY, 12000);
  assert.equal(r.carryForward.deMinimisUsage.LEAVE_MONETIZATION, 6);
});

test('voluntary deductions: priority order, partial application, all-or-nothing, minimum net pay', () => {
  const loan = (code: string, amount: number, priority: number, allowPartial = true) => ({
    code,
    name: code,
    category: 'LOAN' as const,
    amount,
    priority,
    allowPartial,
    isTaxable: false,
    isDeMinimis: false,
  });
  const r = calculatePayLine(makeInput({
    minimumNetPay: 5000,
    recurringDeductions: [loan('SLOW', 20000, 2), loan('FIRST', 10000, 1)],
    oneOffDeductions: [loan('ALL_OR_NOTHING', 3000, 3, false)],
  }));
  // net before voluntary = 26,542.45 -> 21,542.45 available above the floor
  const by = (c: string) => r.voluntaryDeductions.find((d) => d.code === c)!;
  assert.equal(by('FIRST').appliedAmount, 10000);
  assert.equal(by('SLOW').appliedAmount, 11542.45);
  assert.equal(by('SLOW').deferredAmount, 8457.55);
  assert.equal(by('ALL_OR_NOTHING').appliedAmount, 0);
  assert.equal(r.totals.netPay, 5000);
  assert.deepEqual(r.warnings.map((w) => w.code), ['DEDUCTION_DEFERRED', 'DEDUCTION_DEFERRED']);
});

test('NO HARDCODED RULES: changing the snapshot changes the result accordingly', () => {
  const baseline = calculatePayLine(makeInput());

  const noTax = buildRuleSetSnapshot(seededRows({ birRateScale: 0 }), labor);
  assert.equal(calculatePayLine(makeInput({ ruleSet: noTax })).totals.withholdingTax, 0);

  const richerSss = buildRuleSetSnapshot(seededRows({ sssEmployeeRate: 0.1 }), labor);
  const changed = calculatePayLine(makeInput({ ruleSet: richerSss }));
  assert.equal(changed.contributions.sss.period.employee, baseline.contributions.sss.period.employee * 2);
});

test('rounding mode and scale are read from the snapshot', () => {
  const half = makeRounder({ mode: 'HALF_UP', scale: 2 });
  assert.equal(half(1.005), 1.01); // survives binary floating point
  assert.equal(half(-1.005), -1.01);
  assert.equal(makeRounder({ mode: 'HALF_EVEN', scale: 2 })(2.345), 2.34);
  assert.equal(makeRounder({ mode: 'DOWN', scale: 0 })(9.99), 9);
  assert.equal(makeRounder({ mode: 'UP', scale: 1 })(9.01), 9.1);
});

test('purity: identical inputs give identical outputs and frozen inputs are never mutated', () => {
  const deepFreeze = <T>(value: T): T => {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
      Object.freeze(value);
      Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    }
    return value;
  };
  const input = deepFreeze(makeInput({
    attendance: { regularHours: 0, absentDays: 1, lateUndertimeHours: 0.5, premiumHours: [{ premiumCode: 'OT_REGULAR', hours: 3 }], nightDifferentialHours: [] },
    oneOffEarnings: [item({ code: 'BONUS', amount: 5000, category: 'BONUS' })],
  }));
  const first = calculatePayLine(input);
  const second = calculatePayLine(input);
  assert.deepEqual(first, second);
});

test('breakdown tree reconciles: lines sum to gross, deductions and net', () => {
  const r = calculatePayLine(makeInput({
    attendance: { regularHours: 0, absentDays: 0, lateUndertimeHours: 0, premiumHours: [{ premiumCode: 'OT_REGULAR', hours: 5 }], nightDifferentialHours: [] },
    recurringEarnings: [item({ code: 'RICE', amount: 2000, isDeMinimis: true, deMinimisCode: 'RICE_SUBSIDY', isTaxable: false })],
    recurringDeductions: [{ code: 'DUES', name: 'Union Dues', category: 'UNION_DUES', amount: 300, isTaxable: false, isDeMinimis: false }],
  }));
  const sum = (kind: string) => Math.round(r.lines.filter((l) => l.kind === kind).reduce((t, l) => t + l.amount * 100, 0)) / 100;
  assert.equal(sum('EARNING'), r.totals.grossPay);
  assert.equal(sum('DEDUCTION'), r.totals.totalDeductions);
  assert.equal(sum('EMPLOYER_CONTRIBUTION'), r.totals.employerContributions);
  assert.equal(Math.round((r.totals.grossPay - r.totals.totalDeductions) * 100) / 100, r.totals.netPay);
  assert.deepEqual(r.lines.map((l) => l.seq), r.lines.map((_, i) => i + 1));
  r.breakdown.earnings.forEach((l) => assert.equal(Math.round((l.taxableAmount + l.exemptAmount) * 100) / 100, l.amount));
});

test('weekly pay uses the monthly table cumulatively (frequency table drives periods per year)', () => {
  const r = calculatePayLine(makeInput({
    payFrequency: 'WEEKLY',
    period: { periodStart: '2026-03-02', periodEnd: '2026-03-08', periodIndexInMonth: 1, periodsInMonth: 4 },
  }));
  assert.equal(r.basicPay.scheduledBasicPay, 6923.08); // 30,000 x 12 / 52
  assert.equal(r.tax.method, 'MONTH_TO_DATE_CUMULATIVE');
});

test('fails loudly on missing rules and bad input instead of guessing', () => {
  assert.throws(
    () => calculatePayLine(makeInput({
      attendance: { regularHours: 0, absentDays: 0, lateUndertimeHours: 0, premiumHours: [{ premiumCode: 'NOPE', hours: 1 }], nightDifferentialHours: [] },
    })),
    (e: unknown) => e instanceof PayrollEngineError && e.code === 'MISSING_RULE',
  );
  assert.throws(
    () => calculatePayLine(makeInput({ oneOffEarnings: [item({ code: 'X', amount: 1, isDeMinimis: true, deMinimisCode: 'UNKNOWN' })] })),
    (e: unknown) => e instanceof PayrollEngineError && e.code === 'MISSING_RULE',
  );
  assert.throws(
    () => calculatePayLine(makeInput({ oneOffEarnings: [item({ code: 'X', amount: -5 })] })),
    (e: unknown) => e instanceof PayrollEngineError && e.code === 'INVALID_INPUT',
  );
  assert.throws(
    () => calculatePayLine(makeInput({ statutory: { sss: { enabled: true, timing: { mode: 'FULL_ON_PERIOD', periodNumber: 3 } }, philhealth: splitEqual, pagibig: splitEqual, withholdingTax: { enabled: true } } })),
    (e: unknown) => e instanceof PayrollEngineError && e.code === 'INVALID_INPUT',
  );
});

test('labor rules load from the editable labor_rules.config JSONB and drive the result', () => {
  const config = {
    pay_frequencies: { WEEKLY: { periods_per_year: 52 }, BI_WEEKLY: { periods_per_year: 26 }, SEMI_MONTHLY: { periods_per_year: 24 }, MONTHLY: { periods_per_year: 12 } },
    night_differential: { rate: 0.12 },
    mwe: { exempt_categories: ['BASIC'] },
    premiums: { OT_REGULAR: { name: 'Overtime', category: 'OVERTIME', multiplier: 1.5 } },
  };
  const parsed = laborRulesFromConfig(config);
  assert.equal(parsed.nightDifferential.rate, 0.12);
  const rules = buildRuleSetSnapshot(seededRows(), parsed);
  const r = calculatePayLine(makeInput({
    ruleSet: rules,
    employee: { employeeId: 'e', isMinimumWageEarner: false, compensation: { rateType: 'MONTHLY', baseRate: 26100, workingDaysPerYear: 261, hoursPerDay: 8 } },
    attendance: { regularHours: 0, absentDays: 0, lateUndertimeHours: 0, premiumHours: [{ premiumCode: 'OT_REGULAR', hours: 2 }], nightDifferentialHours: [{ hours: 2 }] },
  }));
  assert.equal(r.grossByCategory.OVERTIME, 450); // 2 x 150 x 1.5 (edited from 1.25)
  assert.equal(r.grossByCategory.NIGHT_DIFFERENTIAL, 36); // 2 x 150 x 0.12 (edited from 0.10)
});
