/* =====================================================================
 * engine.ts - pure Philippine payroll calculation engine.
 *
 * Guarantees
 *   - No rate, ceiling, floor, bracket, multiplier or percentage literal lives here.
 *     Every one is read from `input.ruleSet` (the RuleSetSnapshot).
 *     The only numeric literals are arithmetic/rounding mechanics: 0 (empty sum,
 *     lower bound), 1 (identity multiplier), 10 (decimal base), 0.5 and 2 (rounding
 *     midpoint / parity for HALF_UP and HALF_EVEN) and 12 / 15 / 16 (floating-point
 *     noise tolerances). None is a statutory or labor-law value.
 *   - Pure: no I/O, no clock, no randomness, no module state, no input mutation.
 *     Same PayLineInput (which embeds the snapshot) => identical PayLineResult.
 *
 * Pipeline: gross -> exempt/taxable split -> statutory EE/ER -> taxable income
 *           -> BIR withholding -> voluntary deductions -> net pay.
 * ===================================================================== */

import type {
  AgencyOption,
  BasicPayResult,
  BreakdownLine,
  BreakdownSource,
  ContributionAmounts,
  ContributionResult,
  ContributionTiming,
  DeductionItem,
  DeductionResult,
  EarningItem,
  Exemption,
  JsonValue,
  PayLineInput,
  PayLineResult,
  PayLineWarning,
  PagibigRule,
  PhilHealthRule,
  RoundingRule,
  RuleSetSnapshot,
  SssRule,
  TaxBracket,
  TaxResult,
} from './types.ts';

export class PayrollEngineError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'PayrollEngineError';
    this.code = code;
  }
}

type Round = (value: number) => number;
type RuleRef = { [key: string]: JsonValue };

/** Arithmetic identity: "no premium compounding". Not a rate. */
const IDENTITY_MULTIPLIER = 1;

function fail(code: string, message: string): never {
  throw new PayrollEngineError(code, message);
}

/* ---------------------------------------------------------------------
 * Rounding (mode and scale come from the snapshot)
 * --------------------------------------------------------------------- */

export function makeRounder(rule: RoundingRule): Round {
  const factor = Math.pow(10, rule.scale);
  return (value: number): number => {
    if (!Number.isFinite(value)) {
      return fail('NON_FINITE_VALUE', `Cannot round a non-finite value (${value})`);
    }
    // toPrecision(15) strips binary floating-point noise (e.g. 75000.00000000001).
    const scaled = Number((value * factor).toPrecision(15));
    const magnitude = Math.abs(scaled);
    const whole = Math.floor(magnitude);
    const fraction = magnitude - whole;
    let rounded: number;
    switch (rule.mode) {
      case 'HALF_UP':
        rounded = fraction >= 0.5 ? whole + 1 : whole;
        break;
      case 'HALF_EVEN':
        rounded = fraction > 0.5 ? whole + 1 : fraction < 0.5 ? whole : whole % 2 === 0 ? whole : whole + 1;
        break;
      case 'DOWN':
        rounded = whole;
        break;
      case 'UP':
        rounded = fraction > 0 ? whole + 1 : whole;
        break;
      default: {
        const unreachable: never = rule.mode;
        return fail('INVALID_RULE_SET', `Unknown rounding mode ${String(unreachable)}`);
      }
    }
    const result = (scaled < 0 ? -rounded : rounded) / factor;
    return result === 0 ? 0 : result; // normalise -0
  };
}

const tidy = (value: number): number => Number(value.toPrecision(12));

/* ---------------------------------------------------------------------
 * Validation
 * --------------------------------------------------------------------- */

function requireNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    fail('INVALID_INPUT', `${label} must be a finite number >= 0 (got ${value})`);
  }
}

function requirePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    fail('INVALID_INPUT', `${label} must be a finite number > 0 (got ${value})`);
  }
}

function requireIntegerInRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail('INVALID_INPUT', `${label} must be an integer between ${min} and ${max} (got ${value})`);
  }
}

function assertRuleSet(rs: RuleSetSnapshot): void {
  const bad = (message: string): never => fail('INVALID_RULE_SET', message);

  if (rs.versionId.length === 0) bad('versionId is required');
  if (!Number.isInteger(rs.rounding.scale) || rs.rounding.scale < 0) bad('rounding.scale must be an integer >= 0');

  const monthly = rs.payFrequencies.MONTHLY;
  if (monthly === undefined) bad('payFrequencies.MONTHLY is required (defines months per year)');
  for (const [frequency, rule] of Object.entries(rs.payFrequencies)) {
    if (!Number.isFinite(rule.periodsPerYear) || rule.periodsPerYear <= 0) {
      bad(`payFrequencies.${frequency}.periodsPerYear must be > 0`);
    }
  }

  if (rs.sss.brackets.length === 0) bad('sss.brackets is empty');
  rs.sss.brackets.forEach((bracket, index) => {
    if (index > 0 && bracket.compFrom <= rs.sss.brackets[index - 1]!.compFrom) {
      bad('sss.brackets must be sorted ascending by compFrom');
    }
  });
  if (rs.sss.brackets[0]!.compFrom > 0) bad('sss.brackets must start at compFrom <= 0');

  const ph = rs.philhealth;
  if (ph.salaryFloor > ph.salaryCeiling) bad('philhealth.salaryFloor must be <= salaryCeiling');
  if (Math.abs(ph.employeeSplit + ph.employerSplit - IDENTITY_MULTIPLIER) > Number.EPSILON * 16) {
    bad('philhealth employeeSplit + employerSplit must equal 1');
  }

  if (rs.pagibig.maxFundSalary < 0) bad('pagibig.maxFundSalary must be >= 0');

  const brackets = rs.bir.brackets;
  if (brackets.length === 0) bad('bir.brackets is empty');
  brackets.forEach((bracket, index) => {
    const isLast = index === brackets.length - 1;
    if (isLast && bracket.upTo !== null) bad('last bir bracket must be open-ended (upTo = null)');
    if (!isLast) {
      const next = brackets[index + 1]!;
      if (bracket.upTo === null || bracket.upTo !== next.over) {
        bad(`bir brackets must be contiguous (bracket ${index} upTo != bracket ${index + 1} over)`);
      }
    }
  });
}

function validateInput(input: PayLineInput): void {
  const rs = input.ruleSet;
  const { compensation } = input.employee;
  requireNonNegative(compensation.baseRate, 'employee.compensation.baseRate');
  requirePositive(compensation.workingDaysPerYear, 'employee.compensation.workingDaysPerYear');
  requirePositive(compensation.hoursPerDay, 'employee.compensation.hoursPerDay');
  if (rs.payFrequencies[input.payFrequency] === undefined) {
    fail('MISSING_RULE', `Rule set ${rs.versionId} has no pay frequency '${input.payFrequency}'`);
  }

  const { period, attendance, statutory } = input;
  requireIntegerInRange(period.periodsInMonth, 1, Number.MAX_SAFE_INTEGER, 'period.periodsInMonth');
  requireIntegerInRange(period.periodIndexInMonth, 1, period.periodsInMonth, 'period.periodIndexInMonth');

  requireNonNegative(attendance.regularHours, 'attendance.regularHours');
  requireNonNegative(attendance.absentDays, 'attendance.absentDays');
  requireNonNegative(attendance.lateUndertimeHours, 'attendance.lateUndertimeHours');
  attendance.premiumHours.forEach((entry, i) => requireNonNegative(entry.hours, `attendance.premiumHours[${i}].hours`));
  attendance.nightDifferentialHours.forEach((entry, i) =>
    requireNonNegative(entry.hours, `attendance.nightDifferentialHours[${i}].hours`),
  );

  for (const item of [...input.recurringEarnings, ...input.oneOffEarnings]) {
    requireNonNegative(item.amount, `earning '${item.code}'.amount`);
    if (item.quantity !== undefined) requireNonNegative(item.quantity, `earning '${item.code}'.quantity`);
  }
  for (const item of [...input.recurringDeductions, ...input.oneOffDeductions]) {
    requireNonNegative(item.amount, `deduction '${item.code}'.amount`);
  }

  for (const [agency, option] of [
    ['sss', statutory.sss],
    ['philhealth', statutory.philhealth],
    ['pagibig', statutory.pagibig],
  ] as const) {
    if (option.timing.mode === 'FULL_ON_PERIOD') {
      requireIntegerInRange(option.timing.periodNumber, 1, period.periodsInMonth, `statutory.${agency}.timing.periodNumber`);
    }
    if (option.monthlyCompensationOverride !== undefined) {
      requireNonNegative(option.monthlyCompensationOverride, `statutory.${agency}.monthlyCompensationOverride`);
    }
  }

  requireNonNegative(input.monthToDate.taxableIncome, 'monthToDate.taxableIncome');
  requireNonNegative(input.monthToDate.withholdingTax, 'monthToDate.withholdingTax');
  requireNonNegative(input.yearToDate.otherBenefitsUsed, 'yearToDate.otherBenefitsUsed');
  for (const [key, used] of Object.entries(input.deMinimisWindowUsage)) {
    requireNonNegative(used, `deMinimisWindowUsage['${key}']`);
  }
  if (input.minimumNetPay !== undefined) requireNonNegative(input.minimumNetPay, 'minimumNetPay');
}

/* ---------------------------------------------------------------------
 * Earning classification: taxable vs exempt (de minimis, MWE, cap, flag)
 * --------------------------------------------------------------------- */

interface Classification {
  readonly taxable: number;
  readonly exemptions: Exemption[];
  readonly ruleRef: RuleRef;
}

function createEarningClassifier(input: PayLineInput, round: Round) {
  const rs = input.ruleSet;
  const bir = rs.bir;
  const cap = bir.otherBenefitsCap;
  const mweExemptCategories = new Set<string>(bir.mwe.exemptCategories);
  const isMinimumWageEarner = input.employee.isMinimumWageEarner;

  const usageRunning: Record<string, number> = { ...input.deMinimisWindowUsage };
  const usageDelta: Record<string, number> = {};
  let capRemaining = cap === undefined ? 0 : Math.max(0, round(cap.annualAmount - input.yearToDate.otherBenefitsUsed));
  let otherBenefitsAdded = 0;

  const routeToOtherBenefits = (amount: number): { exempt: number; taxable: number } => {
    if (cap === undefined) return { exempt: 0, taxable: amount };
    const exempt = Math.min(amount, capRemaining);
    capRemaining = Math.max(0, round(capRemaining - amount));
    otherBenefitsAdded = round(otherBenefitsAdded + amount);
    return { exempt, taxable: round(amount - exempt) };
  };

  const coveredByCap = (item: EarningItem): boolean =>
    cap !== undefined &&
    (cap.covers.includes(item.category) || (item.customCategory !== undefined && cap.covers.includes(item.customCategory)));

  const classifyDeMinimis = (item: EarningItem): Classification => {
    const code = item.deMinimisCode;
    if (code === undefined) fail('INVALID_INPUT', `Earning '${item.code}' is de minimis but has no deMinimisCode`);
    const rule = bir.deMinimis[code];
    if (rule === undefined) fail('MISSING_RULE', `Rule set ${rs.versionId} has no de minimis rule '${code}'`);

    const key = rule.pool ?? code;
    const usedBefore = usageRunning[key] ?? 0;
    let exempt = 0;
    let consumed = 0;
    let limitApplied = 0;

    switch (rule.limitType) {
      case 'AMOUNT': {
        if (rule.limit === undefined) fail('INVALID_RULE_SET', `de minimis '${code}' (AMOUNT) needs a limit`);
        limitApplied = rule.limit;
        exempt = Math.min(item.amount, Math.max(0, round(rule.limit - usedBefore)));
        consumed = exempt;
        break;
      }
      case 'PCT_OF_MIN_WAGE': {
        const wage = input.employee.regionalMinimumDailyWage;
        if (rule.pct === undefined) fail('INVALID_RULE_SET', `de minimis '${code}' (PCT_OF_MIN_WAGE) needs pct`);
        if (wage === undefined || item.quantity === undefined) {
          fail('INVALID_INPUT', `de minimis '${code}' needs employee.regionalMinimumDailyWage and item.quantity`);
        }
        limitApplied = round(rule.pct * wage * item.quantity);
        exempt = Math.min(item.amount, Math.max(0, round(limitApplied - usedBefore)));
        consumed = exempt;
        break;
      }
      case 'DAYS': {
        if (rule.limit === undefined) fail('INVALID_RULE_SET', `de minimis '${code}' (DAYS) needs a limit`);
        if (item.quantity === undefined || item.quantity <= 0) {
          fail('INVALID_INPUT', `de minimis '${code}' (DAYS) needs item.quantity > 0`);
        }
        limitApplied = rule.limit;
        const exemptDays = Math.min(item.quantity, Math.max(0, tidy(rule.limit - usedBefore)));
        exempt = round((item.amount * exemptDays) / item.quantity);
        consumed = exemptDays;
        break;
      }
      default: {
        const unreachable: never = rule.limitType;
        return fail('INVALID_RULE_SET', `Unknown de minimis limitType ${String(unreachable)}`);
      }
    }

    usageRunning[key] = tidy(usedBefore + consumed);
    usageDelta[key] = tidy((usageDelta[key] ?? 0) + consumed);

    const exemptions: Exemption[] = [];
    if (exempt > 0) exemptions.push({ reason: 'DE_MINIMIS', amount: exempt });

    const excess = round(item.amount - exempt);
    let taxable = excess;
    let treatment: string = 'NONE';
    if (excess > 0) {
      treatment = cap === undefined ? 'TAXABLE' : cap.deMinimisExcessTreatment;
      if (cap !== undefined && cap.deMinimisExcessTreatment === 'ADD_TO_OTHER_BENEFITS') {
        const routed = routeToOtherBenefits(excess);
        taxable = routed.taxable;
        if (routed.exempt > 0) exemptions.push({ reason: 'OTHER_BENEFITS_CAP', amount: routed.exempt });
      }
    }

    return {
      taxable,
      exemptions,
      ruleRef: {
        rule: 'DE_MINIMIS',
        ruleVersionId: rs.versionId,
        deMinimisCode: code,
        limitKey: key,
        limitType: rule.limitType,
        limit: limitApplied,
        window: rule.period,
        usedBefore,
        exempt,
        excess,
        excessTreatment: treatment,
      },
    };
  };

  const classify = (item: EarningItem): Classification => {
    if (item.isDeMinimis) return classifyDeMinimis(item);

    if (isMinimumWageEarner && mweExemptCategories.has(item.category)) {
      return {
        taxable: 0,
        exemptions: item.amount > 0 ? [{ reason: 'MWE_EXEMPT', amount: item.amount }] : [],
        ruleRef: { rule: 'MWE_EXEMPT', ruleVersionId: rs.versionId, category: item.category },
      };
    }
    if (!item.isTaxable) {
      return {
        taxable: 0,
        exemptions: item.amount > 0 ? [{ reason: 'NON_TAXABLE_FLAG', amount: item.amount }] : [],
        ruleRef: { rule: 'NON_TAXABLE_FLAG', ruleVersionId: rs.versionId },
      };
    }
    if (coveredByCap(item)) {
      const routed = routeToOtherBenefits(item.amount);
      return {
        taxable: routed.taxable,
        exemptions: routed.exempt > 0 ? [{ reason: 'OTHER_BENEFITS_CAP', amount: routed.exempt }] : [],
        ruleRef: {
          rule: 'OTHER_BENEFITS_CAP',
          ruleVersionId: rs.versionId,
          annualCap: cap === undefined ? null : cap.annualAmount,
          usedBeforeThisLine: input.yearToDate.otherBenefitsUsed,
          exempt: routed.exempt,
        },
      };
    }
    return { taxable: item.amount, exemptions: [], ruleRef: { rule: 'TAXABLE', ruleVersionId: rs.versionId } };
  };

  return {
    classify,
    carryForward: () => ({ deMinimisUsage: { ...usageDelta }, otherBenefitsAdded }),
  };
}

/* ---------------------------------------------------------------------
 * Statutory contributions
 * --------------------------------------------------------------------- */

/** Allocates a monthly amount to one period; SPLIT_EQUAL is exact to the centavo across the month. */
function allocateToPeriod(monthly: number, timing: ContributionTiming, index: number, count: number, round: Round): number {
  if (timing.mode === 'SPLIT_EQUAL') {
    return round(round((monthly * index) / count) - round((monthly * (index - 1)) / count));
  }
  return timing.periodNumber === index ? monthly : 0;
}

function appliesInPeriod(timing: ContributionTiming, index: number): boolean {
  return timing.mode === 'SPLIT_EQUAL' || timing.periodNumber === index;
}

function zeroAmounts(): ContributionAmounts {
  return { employee: 0, employer: 0, ec: 0 };
}

function disabledContribution(agency: ContributionResult['agency'], enabled: boolean, base: number): ContributionResult {
  return {
    agency,
    enabled,
    appliesThisPeriod: false,
    monthlyCompensationBase: base,
    monthly: zeroAmounts(),
    period: zeroAmounts(),
    detail: {},
  };
}

function toPeriodAmounts(
  monthly: ContributionAmounts,
  option: AgencyOption,
  index: number,
  count: number,
  round: Round,
): ContributionAmounts {
  return {
    employee: allocateToPeriod(monthly.employee, option.timing, index, count, round),
    employer: allocateToPeriod(monthly.employer, option.timing, index, count, round),
    ec: allocateToPeriod(monthly.ec, option.timing, index, count, round),
  };
}

function computeSss(rule: SssRule, base: number, option: AgencyOption, index: number, count: number, round: Round): ContributionResult {
  if (!option.enabled || base <= 0) return disabledContribution('SSS', option.enabled, base);

  let bracketIndex = -1;
  rule.brackets.forEach((bracket, i) => {
    if (base >= bracket.compFrom) bracketIndex = i;
  });
  if (bracketIndex < 0) fail('NO_MATCHING_BRACKET', `No SSS bracket matches monthly compensation ${base}`);
  const bracket = rule.brackets[bracketIndex]!;

  const monthly: ContributionAmounts = {
    employee: round(bracket.msc * rule.employeeRate),
    employer: round(bracket.msc * rule.employerRate),
    ec: bracket.msc < rule.ec.thresholdMsc ? rule.ec.belowAmount : rule.ec.atOrAboveAmount,
  };

  return {
    agency: 'SSS',
    enabled: true,
    appliesThisPeriod: appliesInPeriod(option.timing, index),
    monthlyCompensationBase: base,
    monthly,
    period: toPeriodAmounts(monthly, option, index, count, round),
    detail: {
      msc: bracket.msc,
      bracketCompFrom: bracket.compFrom,
      bracketCompTo: bracket.compTo,
      regularMsc: bracket.regularMsc ?? null,
      mpfMsc: bracket.mpfMsc ?? null,
      employeeRate: rule.employeeRate,
      employerRate: rule.employerRate,
    },
  };
}

function computePhilHealth(
  rule: PhilHealthRule,
  base: number,
  option: AgencyOption,
  index: number,
  count: number,
  round: Round,
): ContributionResult {
  if (!option.enabled || base <= 0) return disabledContribution('PHILHEALTH', option.enabled, base);

  const boundedBase = Math.min(Math.max(base, rule.salaryFloor), rule.salaryCeiling);
  let total = round(boundedBase * rule.premiumRate);
  if (rule.minTotalPremium !== undefined) total = Math.max(total, rule.minTotalPremium);
  if (rule.maxTotalPremium !== undefined) total = Math.min(total, rule.maxTotalPremium);
  const employee = round(total * rule.employeeSplit);
  const monthly: ContributionAmounts = { employee, employer: round(total - employee), ec: 0 };

  return {
    agency: 'PHILHEALTH',
    enabled: true,
    appliesThisPeriod: appliesInPeriod(option.timing, index),
    monthlyCompensationBase: base,
    monthly,
    period: toPeriodAmounts(monthly, option, index, count, round),
    detail: {
      boundedBase,
      premiumRate: rule.premiumRate,
      totalPremium: total,
      salaryFloor: rule.salaryFloor,
      salaryCeiling: rule.salaryCeiling,
    },
  };
}

function computePagibig(rule: PagibigRule, base: number, option: AgencyOption, index: number, count: number, round: Round): ContributionResult {
  if (!option.enabled || base <= 0) return disabledContribution('PAGIBIG', option.enabled, base);

  const monthlyFundSalary = Math.min(base, rule.maxFundSalary);
  let employee = round(monthlyFundSalary * rule.employeeRate);
  let employer = round(monthlyFundSalary * rule.employerRate);
  if (rule.maxEmployeeContribution !== undefined) employee = Math.min(employee, rule.maxEmployeeContribution);
  if (rule.maxEmployerContribution !== undefined) employer = Math.min(employer, rule.maxEmployerContribution);
  const monthly: ContributionAmounts = { employee, employer, ec: 0 };

  return {
    agency: 'PAGIBIG',
    enabled: true,
    appliesThisPeriod: appliesInPeriod(option.timing, index),
    monthlyCompensationBase: base,
    monthly,
    period: toPeriodAmounts(monthly, option, index, count, round),
    detail: {
      monthlyFundSalary,
      employeeRate: rule.employeeRate,
      employerRate: rule.employerRate,
      maxFundSalary: rule.maxFundSalary,
    },
  };
}

/* ---------------------------------------------------------------------
 * BIR withholding
 * --------------------------------------------------------------------- */

function computeBracketTax(brackets: readonly TaxBracket[], taxable: number, round: Round): { tax: number; bracket: TaxBracket; index: number } {
  let index = 0;
  brackets.forEach((bracket, i) => {
    if (taxable > bracket.over) index = i;
  });
  const bracket = brackets[index]!;
  const tax = round(bracket.baseTax + bracket.rate * Math.max(0, taxable - bracket.excessOver));
  return { tax, bracket, index };
}

/* ---------------------------------------------------------------------
 * Main entry point
 * --------------------------------------------------------------------- */

export function calculatePayLine(input: PayLineInput): PayLineResult {
  const rs: RuleSetSnapshot = input.ruleSet;
  assertRuleSet(rs);
  validateInput(input);

  const round = makeRounder(rs.rounding);
  const sum = (values: readonly number[]): number => round(values.reduce((total, value) => total + value, 0));
  const warnings: PayLineWarning[] = [];
  const warn = (code: string, message: string): void => {
    warnings.push({ code, message });
  };

  const { employee, period, attendance } = input;
  const { compensation } = employee;

  /* ---- rates derived from the snapshot's frequency table ---- */
  const monthsPerYear = rs.payFrequencies.MONTHLY.periodsPerYear;
  const periodsPerYear = rs.payFrequencies[input.payFrequency].periodsPerYear;

  let monthlyRate: number;
  let dailyRate: number;
  switch (compensation.rateType) {
    case 'MONTHLY':
      monthlyRate = compensation.baseRate;
      dailyRate = (compensation.baseRate * monthsPerYear) / compensation.workingDaysPerYear;
      break;
    case 'DAILY':
      dailyRate = compensation.baseRate;
      monthlyRate = (compensation.baseRate * compensation.workingDaysPerYear) / monthsPerYear;
      break;
    case 'HOURLY':
      dailyRate = compensation.baseRate * compensation.hoursPerDay;
      monthlyRate = (dailyRate * compensation.workingDaysPerYear) / monthsPerYear;
      break;
    default: {
      const unreachable: never = compensation.rateType;
      return fail('INVALID_INPUT', `Unknown rateType ${String(unreachable)}`);
    }
  }
  const hourlyRate = compensation.rateType === 'HOURLY' ? compensation.baseRate : dailyRate / compensation.hoursPerDay;
  const isMonthlyRated = compensation.rateType === 'MONTHLY';

  /* ---- (a) basic pay ---- */
  const scheduledBasicPay = isMonthlyRated
    ? round((monthlyRate * monthsPerYear) / periodsPerYear)
    : round(attendance.regularHours * hourlyRate);
  const absenceDeduction = isMonthlyRated ? round(attendance.absentDays * dailyRate) : 0;
  const lateUndertimeDeduction = isMonthlyRated ? round(attendance.lateUndertimeHours * hourlyRate) : 0;
  const netBasicPay = Math.max(0, round(scheduledBasicPay - absenceDeduction - lateUndertimeDeduction));

  if (!isMonthlyRated && (attendance.absentDays > 0 || attendance.lateUndertimeHours > 0)) {
    warn('ABSENCE_IGNORED', 'absentDays / lateUndertimeHours are ignored for DAILY and HOURLY rated employees; pay is driven by regularHours');
  }
  if (isMonthlyRated && scheduledBasicPay - absenceDeduction - lateUndertimeDeduction < 0) {
    warn('BASIC_PAY_FLOORED', 'Absence and tardiness deductions exceeded scheduled basic pay; basic pay floored at zero');
  }

  const basicPay: BasicPayResult = {
    rateType: compensation.rateType,
    monthlyRate: tidy(monthlyRate),
    dailyRate: tidy(dailyRate),
    hourlyRate: tidy(hourlyRate),
    scheduledBasicPay,
    absenceDeduction,
    lateUndertimeDeduction,
    netBasicPay,
  };

  /* ---- (a, b) earning lines, classified taxable vs exempt ---- */
  const classifier = createEarningClassifier(input, round);
  let seq = 0;
  const nextSeq = (): number => {
    seq += 1;
    return seq;
  };

  const earningLines: BreakdownLine[] = [];
  const pushEarning = (
    item: EarningItem,
    source: BreakdownSource,
    extras: { quantity: number | null; unit: string | null; rate: number | null; ruleRef: RuleRef },
  ): void => {
    const classification = classifier.classify(item);
    const exemptAmount = sum(classification.exemptions.map((exemption) => exemption.amount));
    earningLines.push({
      seq: nextSeq(),
      kind: 'EARNING',
      code: item.code,
      name: item.name,
      category: item.category,
      customCategory: item.customCategory ?? null,
      quantity: extras.quantity,
      unit: extras.unit,
      rate: extras.rate,
      amount: item.amount,
      taxableAmount: classification.taxable,
      exemptAmount,
      exemptions: classification.exemptions,
      isTaxableSnapshot: item.isTaxable,
      isDeMinimisSnapshot: item.isDeMinimis,
      deMinimisCode: item.deMinimisCode ?? null,
      source,
      ruleRef: { ...extras.ruleRef, ...classification.ruleRef },
    });
  };

  const systemItem = (code: string, name: string, category: EarningItem['category'], amount: number): EarningItem => ({
    code,
    name,
    category,
    amount,
    isTaxable: true,
    isDeMinimis: false,
  });

  pushEarning(systemItem('BASIC_PAY', 'Basic Pay', 'BASIC', netBasicPay), 'SYSTEM', {
    quantity: isMonthlyRated ? null : attendance.regularHours,
    unit: isMonthlyRated ? null : 'HOURS',
    rate: isMonthlyRated ? null : tidy(hourlyRate),
    ruleRef: {
      calc: 'BASIC_PAY',
      rateType: compensation.rateType,
      scheduledBasicPay,
      absenceDeduction,
      lateUndertimeDeduction,
      periodsPerYear,
      monthsPerYear,
    },
  });

  for (const entry of attendance.premiumHours) {
    if (entry.hours === 0) continue;
    const premium = rs.premiums[entry.premiumCode];
    if (premium === undefined) fail('MISSING_RULE', `Rule set ${rs.versionId} has no premium '${entry.premiumCode}'`);
    const multiplier = isMonthlyRated && premium.monthlyPaidMultiplier !== undefined ? premium.monthlyPaidMultiplier : premium.multiplier;
    const amount = round(entry.hours * hourlyRate * multiplier);
    pushEarning(systemItem(premium.code, premium.name, premium.category, amount), 'SYSTEM', {
      quantity: entry.hours,
      unit: 'HOURS',
      rate: tidy(hourlyRate * multiplier),
      ruleRef: { calc: 'PREMIUM', premiumCode: premium.code, multiplier, hourlyRate: tidy(hourlyRate) },
    });
  }

  for (const entry of attendance.nightDifferentialHours) {
    if (entry.hours === 0) continue;
    let baseMultiplier = IDENTITY_MULTIPLIER;
    let code = 'NIGHT_DIFFERENTIAL';
    if (entry.appliesToPremiumCode !== undefined) {
      const premium = rs.premiums[entry.appliesToPremiumCode];
      if (premium === undefined) {
        fail('MISSING_RULE', `Rule set ${rs.versionId} has no premium '${entry.appliesToPremiumCode}' for night differential`);
      }
      baseMultiplier = isMonthlyRated && premium.monthlyPaidMultiplier !== undefined ? premium.monthlyPaidMultiplier : premium.multiplier;
      code = `NIGHT_DIFFERENTIAL_${entry.appliesToPremiumCode}`;
    }
    const amount = round(entry.hours * hourlyRate * baseMultiplier * rs.nightDifferential.rate);
    pushEarning(systemItem(code, 'Night Differential', 'NIGHT_DIFFERENTIAL', amount), 'SYSTEM', {
      quantity: entry.hours,
      unit: 'HOURS',
      rate: tidy(hourlyRate * baseMultiplier * rs.nightDifferential.rate),
      ruleRef: {
        calc: 'NIGHT_DIFFERENTIAL',
        nightDifferentialRate: rs.nightDifferential.rate,
        baseMultiplier,
        hourlyRate: tidy(hourlyRate),
      },
    });
  }

  for (const item of input.recurringEarnings) {
    pushEarning(item, 'RECURRING', { quantity: item.quantity ?? null, unit: null, rate: null, ruleRef: { calc: 'ITEM' } });
  }
  for (const item of input.oneOffEarnings) {
    pushEarning(item, 'ONE_OFF', { quantity: item.quantity ?? null, unit: null, rate: null, ruleRef: { calc: 'ITEM' } });
  }

  const grossPay = sum(earningLines.map((line) => line.amount));
  const nonTaxableEarnings = sum(earningLines.map((line) => line.exemptAmount));
  const taxableEarnings = sum(earningLines.map((line) => line.taxableAmount));
  if (round(grossPay - nonTaxableEarnings) !== taxableEarnings) {
    fail('INTERNAL_INVARIANT', 'gross - non-taxable != taxable earnings');
  }

  const grossByCategory: Record<string, number> = {};
  for (const line of earningLines) {
    grossByCategory[line.category] = round((grossByCategory[line.category] ?? 0) + line.amount);
  }

  /* ---- (c) statutory contributions ---- */
  const { statutory } = input;
  const baseFor = (option: AgencyOption): number => option.monthlyCompensationOverride ?? monthlyRate;
  const sss = computeSss(rs.sss, round(baseFor(statutory.sss)), statutory.sss, period.periodIndexInMonth, period.periodsInMonth, round);
  const philhealth = computePhilHealth(
    rs.philhealth,
    round(baseFor(statutory.philhealth)),
    statutory.philhealth,
    period.periodIndexInMonth,
    period.periodsInMonth,
    round,
  );
  const pagibig = computePagibig(
    rs.pagibig,
    round(baseFor(statutory.pagibig)),
    statutory.pagibig,
    period.periodIndexInMonth,
    period.periodsInMonth,
    round,
  );
  for (const contribution of [sss, philhealth, pagibig]) {
    if (contribution.enabled && contribution.monthlyCompensationBase <= 0) {
      warn('NO_COMPENSATION_BASE', `${contribution.agency}: monthly compensation base is zero; no contribution computed`);
    }
  }

  const employeeContributionTotal = sum([sss.period.employee, philhealth.period.employee, pagibig.period.employee]);
  const employerContributionTotal = sum([
    sss.period.employer,
    sss.period.ec,
    philhealth.period.employer,
    pagibig.period.employer,
  ]);

  const statutoryLine = (
    kind: 'DEDUCTION' | 'EMPLOYER_CONTRIBUTION',
    code: string,
    name: string,
    category: string,
    amount: number,
    ruleRef: RuleRef,
  ): BreakdownLine => ({
    seq: nextSeq(),
    kind,
    code,
    name,
    category,
    customCategory: null,
    quantity: null,
    unit: null,
    rate: null,
    amount,
    taxableAmount: 0,
    exemptAmount: 0,
    exemptions: [],
    isTaxableSnapshot: null,
    isDeMinimisSnapshot: null,
    deMinimisCode: null,
    source: 'SYSTEM',
    ruleRef: { ruleVersionId: rs.versionId, ...ruleRef },
  });

  const contributionRef = (result: ContributionResult): RuleRef => ({
    agency: result.agency,
    monthlyCompensationBase: result.monthlyCompensationBase,
    monthlyEmployee: result.monthly.employee,
    monthlyEmployer: result.monthly.employer,
    monthlyEc: result.monthly.ec,
    ...result.detail,
  });

  const employeeContributionLines: BreakdownLine[] = [];
  const pushEmployeeContribution = (code: string, name: string, result: ContributionResult): void => {
    if (result.period.employee > 0) {
      employeeContributionLines.push(
        statutoryLine('DEDUCTION', code, name, result.agency, result.period.employee, contributionRef(result)),
      );
    }
  };
  pushEmployeeContribution('SSS_EE', 'SSS Employee Share', sss);
  pushEmployeeContribution('PHILHEALTH_EE', 'PhilHealth Employee Share', philhealth);
  pushEmployeeContribution('PAGIBIG_EE', 'Pag-IBIG Employee Share', pagibig);

  /* ---- (d) taxable income ---- */
  const taxableIncome = Math.max(0, round(taxableEarnings - employeeContributionTotal));

  /* ---- (e) BIR withholding tax ---- */
  const mweExemptEarnings = sum(
    earningLines.flatMap((line) => line.exemptions.filter((e) => e.reason === 'MWE_EXEMPT').map((e) => e.amount)),
  );
  let tax: TaxResult;
  if (!statutory.withholdingTax.enabled) {
    tax = {
      enabled: false,
      method: 'DISABLED',
      isMinimumWageEarner: employee.isMinimumWageEarner,
      mweExemptEarnings,
      taxableIncomeThisPeriod: taxableIncome,
      monthToDateTaxableIncome: input.monthToDate.taxableIncome,
      taxOnBase: 0,
      alreadyWithheldMonthToDate: input.monthToDate.withholdingTax,
      withholdingTax: 0,
      bracket: null,
      bracketIndex: null,
    };
  } else if (rs.bir.period === input.payFrequency) {
    const computed = computeBracketTax(rs.bir.brackets, taxableIncome, round);
    tax = {
      enabled: true,
      method: 'PER_PERIOD_TABLE',
      isMinimumWageEarner: employee.isMinimumWageEarner,
      mweExemptEarnings,
      taxableIncomeThisPeriod: taxableIncome,
      monthToDateTaxableIncome: taxableIncome,
      taxOnBase: computed.tax,
      alreadyWithheldMonthToDate: 0,
      withholdingTax: computed.tax,
      bracket: computed.bracket,
      bracketIndex: computed.index,
    };
  } else if (rs.bir.period === 'MONTHLY') {
    const monthToDateTaxable = round(input.monthToDate.taxableIncome + taxableIncome);
    const computed = computeBracketTax(rs.bir.brackets, monthToDateTaxable, round);
    const withholding = Math.max(0, round(computed.tax - input.monthToDate.withholdingTax));
    tax = {
      enabled: true,
      method: 'MONTH_TO_DATE_CUMULATIVE',
      isMinimumWageEarner: employee.isMinimumWageEarner,
      mweExemptEarnings,
      taxableIncomeThisPeriod: taxableIncome,
      monthToDateTaxableIncome: monthToDateTaxable,
      taxOnBase: computed.tax,
      alreadyWithheldMonthToDate: input.monthToDate.withholdingTax,
      withholdingTax: withholding,
      bracket: computed.bracket,
      bracketIndex: computed.index,
    };
  } else {
    return fail('UNSUPPORTED_TAX_PERIOD', `BIR table period '${rs.bir.period}' cannot be applied to '${input.payFrequency}' pay`);
  }

  const withholdingTaxLine: BreakdownLine | null =
    tax.withholdingTax > 0
      ? statutoryLine('DEDUCTION', 'WITHHOLDING_TAX', 'BIR Withholding Tax', 'WITHHOLDING_TAX', tax.withholdingTax, {
          agency: 'BIR',
          method: tax.method,
          taxableIncomeThisPeriod: tax.taxableIncomeThisPeriod,
          monthToDateTaxableIncome: tax.monthToDateTaxableIncome,
          taxOnBase: tax.taxOnBase,
          alreadyWithheld: tax.alreadyWithheldMonthToDate,
          bracketIndex: tax.bracketIndex,
          bracketOver: tax.bracket === null ? null : tax.bracket.over,
          bracketBaseTax: tax.bracket === null ? null : tax.bracket.baseTax,
          bracketRate: tax.bracket === null ? null : tax.bracket.rate,
          bracketExcessOver: tax.bracket === null ? null : tax.bracket.excessOver,
        })
      : null;

  /* ---- (f) voluntary / other deductions, by priority, within available net pay ---- */
  const netBeforeVoluntary = round(grossPay - employeeContributionTotal - tax.withholdingTax);
  let available = Math.max(0, round(netBeforeVoluntary - (input.minimumNetPay ?? 0)));

  interface QueuedDeduction {
    readonly item: DeductionItem;
    readonly source: BreakdownSource;
    readonly order: number;
  }
  const queue: QueuedDeduction[] = [
    ...input.recurringDeductions.map((item, i) => ({ item, source: 'RECURRING' as const, order: i })),
    ...input.oneOffDeductions.map((item, i) => ({ item, source: 'ONE_OFF' as const, order: input.recurringDeductions.length + i })),
  ];
  queue.sort((a, b) => {
    const pa = a.item.priority ?? Number.POSITIVE_INFINITY;
    const pb = b.item.priority ?? Number.POSITIVE_INFINITY;
    if (pa < pb) return -1;
    if (pa > pb) return 1;
    return a.order - b.order;
  });

  const deductionResults: DeductionResult[] = [];
  const voluntaryLines: BreakdownLine[] = [];
  for (const { item, source } of queue) {
    const partialAllowed = item.allowPartial !== false;
    const applied = partialAllowed ? Math.min(item.amount, available) : item.amount <= available ? item.amount : 0;
    available = Math.max(0, round(available - applied));
    const deferred = round(item.amount - applied);
    deductionResults.push({
      code: item.code,
      name: item.name,
      category: item.category,
      requestedAmount: item.amount,
      appliedAmount: applied,
      deferredAmount: deferred,
    });
    if (deferred > 0) {
      warn('DEDUCTION_DEFERRED', `${item.code}: ${deferred} could not be deducted without breaching minimum net pay`);
    }
    if (applied > 0) {
      voluntaryLines.push({
        seq: nextSeq(),
        kind: 'DEDUCTION',
        code: item.code,
        name: item.name,
        category: item.category,
        customCategory: item.customCategory ?? null,
        quantity: null,
        unit: null,
        rate: null,
        amount: applied,
        taxableAmount: 0,
        exemptAmount: 0,
        exemptions: [],
        isTaxableSnapshot: item.isTaxable,
        isDeMinimisSnapshot: item.isDeMinimis,
        deMinimisCode: null,
        source,
        ruleRef: {
          calc: 'VOLUNTARY_DEDUCTION',
          ruleVersionId: rs.versionId,
          requested: item.amount,
          applied,
          deferred,
          priority: item.priority ?? null,
          allowPartial: partialAllowed,
        },
      });
    }
  }
  const voluntaryTotal = sum(deductionResults.map((result) => result.appliedAmount));
  const deferredTotal = sum(deductionResults.map((result) => result.deferredAmount));

  /* ---- employer-side lines ---- */
  const employerLines: BreakdownLine[] = [];
  const pushEmployer = (code: string, name: string, amount: number, result: ContributionResult): void => {
    if (amount > 0) employerLines.push(statutoryLine('EMPLOYER_CONTRIBUTION', code, name, result.agency, amount, contributionRef(result)));
  };
  pushEmployer('SSS_ER', 'SSS Employer Share', sss.period.employer, sss);
  pushEmployer('SSS_EC', "SSS Employees' Compensation", sss.period.ec, sss);
  pushEmployer('PHILHEALTH_ER', 'PhilHealth Employer Share', philhealth.period.employer, philhealth);
  pushEmployer('PAGIBIG_ER', 'Pag-IBIG Employer Share', pagibig.period.employer, pagibig);

  /* ---- (g) net pay ---- */
  const totalDeductions = sum([employeeContributionTotal, tax.withholdingTax, voluntaryTotal]);
  const netPay = round(grossPay - totalDeductions);
  if (netPay < 0) warn('NEGATIVE_NET_PAY', `Net pay is negative (${netPay}); statutory deductions and tax exceed gross pay`);

  const carry = classifier.carryForward();
  const lines: BreakdownLine[] = [
    ...earningLines,
    ...employeeContributionLines,
    ...(withholdingTaxLine === null ? [] : [withholdingTaxLine]),
    ...voluntaryLines,
    ...employerLines,
  ];

  return {
    ruleVersionId: rs.versionId,
    employeeId: employee.employeeId,
    payFrequency: input.payFrequency,
    period,
    basicPay,
    contributions: {
      sss,
      philhealth,
      pagibig,
      employeeTotal: employeeContributionTotal,
      employerTotal: employerContributionTotal,
    },
    tax,
    voluntaryDeductions: deductionResults,
    totals: {
      grossPay,
      nonTaxableEarnings,
      taxableEarnings,
      employeeMandatoryContributions: employeeContributionTotal,
      taxableIncome,
      withholdingTax: tax.withholdingTax,
      voluntaryDeductions: voluntaryTotal,
      deferredDeductions: deferredTotal,
      totalDeductions,
      netPay,
      employerContributions: employerContributionTotal,
      employerCost: round(grossPay + employerContributionTotal),
    },
    breakdown: {
      earnings: earningLines,
      employeeContributions: employeeContributionLines,
      withholdingTax: withholdingTaxLine,
      voluntaryDeductions: voluntaryLines,
      employerContributions: employerLines,
    },
    lines,
    grossByCategory,
    carryForward: {
      deMinimisUsage: carry.deMinimisUsage,
      otherBenefitsAdded: carry.otherBenefitsAdded,
    },
    warnings,
  };
}
