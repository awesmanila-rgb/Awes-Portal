/* =====================================================================
 * types.ts - shared types for the payroll engine (engine.ts) and the
 * rule-snapshot adapter (snapshot-adapter.ts).
 *
 * Rebuilt for AWES from what engine.ts, snapshot-adapter.ts and
 * engine.test.ts use. Types only: no values, no rates.
 * ===================================================================== */

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/* ------------------------------ rule set ------------------------------ */

export type PayFrequency = 'WEEKLY' | 'BI_WEEKLY' | 'SEMI_MONTHLY' | 'MONTHLY';
export type RateType = 'MONTHLY' | 'DAILY' | 'HOURLY';
export type RoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'DOWN' | 'UP';

export interface RoundingRule {
  readonly mode: RoundingMode;
  readonly scale: number;
}

export interface PayFrequencyRule {
  readonly periodsPerYear: number;
}

export type PremiumCategory = 'OVERTIME' | 'HOLIDAY_PAY';

export interface PremiumRule {
  readonly code: string;
  readonly name: string;
  readonly category: PremiumCategory;
  /** Fraction of the hourly rate: 1.25 = 125%. */
  readonly multiplier: number;
  /** For MONTHLY-rated staff, whose salary already covers the first 100%. */
  readonly monthlyPaidMultiplier?: number;
}

export interface NightDifferentialRule {
  readonly rate: number;
}

export interface SssBracket {
  readonly msc: number;
  readonly compFrom: number;
  readonly compTo: number | null;
  readonly regularMsc?: number;
  readonly mpfMsc?: number;
}

export interface SssRule {
  readonly employeeRate: number;
  readonly employerRate: number;
  readonly ec: {
    readonly thresholdMsc: number;
    readonly belowAmount: number;
    readonly atOrAboveAmount: number;
  };
  readonly brackets: readonly SssBracket[];
}

export interface PhilHealthRule {
  readonly premiumRate: number;
  readonly employeeSplit: number;
  readonly employerSplit: number;
  readonly salaryFloor: number;
  readonly salaryCeiling: number;
  readonly minTotalPremium?: number;
  readonly maxTotalPremium?: number;
}

export interface PagibigRule {
  readonly employeeRate: number;
  readonly employerRate: number;
  readonly maxFundSalary: number;
  readonly maxEmployeeContribution?: number;
  readonly maxEmployerContribution?: number;
}

export interface TaxBracket {
  readonly over: number;
  readonly upTo: number | null;
  readonly baseTax: number;
  readonly rate: number;
  readonly excessOver: number;
}

export type DeMinimisLimitType = 'AMOUNT' | 'PCT_OF_MIN_WAGE' | 'DAYS';

export interface DeMinimisRule {
  readonly limitType: DeMinimisLimitType;
  /** Usage window label, e.g. 'DAY' | 'MONTH' | 'YEAR'. */
  readonly period: string;
  readonly limit?: number;
  readonly pct?: number;
  /** Several codes may share one ceiling. */
  readonly pool?: string;
}

export interface OtherBenefitsCapRule {
  readonly annualAmount: number;
  readonly covers: readonly string[];
  readonly deMinimisExcessTreatment: 'ADD_TO_OTHER_BENEFITS' | 'TAXABLE';
}

export interface BirRule {
  /** The pay frequency the bracket table is written for. */
  readonly period: PayFrequency;
  readonly brackets: readonly TaxBracket[];
  readonly deMinimis: Readonly<Record<string, DeMinimisRule>>;
  readonly otherBenefitsCap?: OtherBenefitsCapRule;
  readonly mwe: { readonly exemptCategories: readonly string[] };
}

export interface RuleSetSnapshot {
  readonly versionId: string;
  readonly rounding: RoundingRule;
  readonly payFrequencies: Readonly<Record<PayFrequency, PayFrequencyRule>>;
  readonly premiums: Readonly<Record<string, PremiumRule>>;
  readonly nightDifferential: NightDifferentialRule;
  readonly sss: SssRule;
  readonly philhealth: PhilHealthRule;
  readonly pagibig: PagibigRule;
  readonly bir: BirRule;
}

/* ------------------------------- input -------------------------------- */

export type EarningCategory =
  | 'BASIC'
  | 'OVERTIME'
  | 'HOLIDAY_PAY'
  | 'NIGHT_DIFFERENTIAL'
  | 'HAZARD_PAY'
  | 'ALLOWANCE'
  | 'THIRTEENTH_MONTH'
  | 'BONUS'
  | 'OTHER_BENEFITS'
  | 'COMMISSION'
  | 'LEAVE_CONVERSION'
  | 'ADJUSTMENT'
  | 'OTHER';

export interface EarningItem {
  readonly code: string;
  readonly name: string;
  readonly category: EarningCategory;
  readonly customCategory?: string;
  readonly amount: number;
  /** Days, meals, etc. Needed by DAYS and PCT_OF_MIN_WAGE de minimis rules. */
  readonly quantity?: number;
  readonly isTaxable: boolean;
  readonly isDeMinimis: boolean;
  readonly deMinimisCode?: string;
}

export interface DeductionItem {
  readonly code: string;
  readonly name: string;
  readonly category: string;
  readonly customCategory?: string;
  readonly amount: number;
  /** Lower runs first; undefined runs last, in input order. */
  readonly priority?: number;
  /** Default true. false = all-or-nothing. */
  readonly allowPartial?: boolean;
  readonly isTaxable: boolean;
  readonly isDeMinimis: boolean;
}

export type ContributionTiming =
  | { readonly mode: 'SPLIT_EQUAL' }
  | { readonly mode: 'FULL_ON_PERIOD'; readonly periodNumber: number };

export interface AgencyOption {
  readonly enabled: boolean;
  readonly timing: ContributionTiming;
  readonly monthlyCompensationOverride?: number;
}

export interface PremiumHoursEntry {
  readonly premiumCode: string;
  readonly hours: number;
}

export interface NightDifferentialEntry {
  readonly hours: number;
  /** Night hours that fall inside a premium (e.g. OT) stack on its multiplier. */
  readonly appliesToPremiumCode?: string;
}

export interface Attendance {
  readonly regularHours: number;
  readonly absentDays: number;
  readonly lateUndertimeHours: number;
  readonly premiumHours: readonly PremiumHoursEntry[];
  readonly nightDifferentialHours: readonly NightDifferentialEntry[];
}

export interface PayPeriod {
  readonly periodStart: string;
  readonly periodEnd: string;
  /** 1-based position of this period inside its month. */
  readonly periodIndexInMonth: number;
  readonly periodsInMonth: number;
}

export interface EmployeeInput {
  readonly employeeId: string;
  readonly isMinimumWageEarner: boolean;
  readonly regionalMinimumDailyWage?: number;
  readonly compensation: {
    readonly rateType: RateType;
    readonly baseRate: number;
    readonly workingDaysPerYear: number;
    readonly hoursPerDay: number;
  };
}

export interface PayLineInput {
  readonly ruleSet: RuleSetSnapshot;
  readonly employee: EmployeeInput;
  readonly payFrequency: PayFrequency;
  readonly period: PayPeriod;
  readonly attendance: Attendance;
  readonly recurringEarnings: readonly EarningItem[];
  readonly oneOffEarnings: readonly EarningItem[];
  readonly recurringDeductions: readonly DeductionItem[];
  readonly oneOffDeductions: readonly DeductionItem[];
  readonly statutory: {
    readonly sss: AgencyOption;
    readonly philhealth: AgencyOption;
    readonly pagibig: AgencyOption;
    readonly withholdingTax: { readonly enabled: boolean };
  };
  readonly monthToDate: { readonly taxableIncome: number; readonly withholdingTax: number };
  readonly yearToDate: { readonly otherBenefitsUsed: number };
  /** Usage so far inside each de minimis window, keyed by pool (or code). */
  readonly deMinimisWindowUsage: Readonly<Record<string, number>>;
  readonly minimumNetPay?: number;
}

/* ------------------------------- result ------------------------------- */

export type ExemptionReason = 'DE_MINIMIS' | 'MWE_EXEMPT' | 'NON_TAXABLE_FLAG' | 'OTHER_BENEFITS_CAP';

export interface Exemption {
  readonly reason: ExemptionReason;
  readonly amount: number;
}

export type BreakdownSource = 'SYSTEM' | 'RECURRING' | 'ONE_OFF';
export type BreakdownKind = 'EARNING' | 'DEDUCTION' | 'EMPLOYER_CONTRIBUTION';

export interface BreakdownLine {
  readonly seq: number;
  readonly kind: BreakdownKind;
  readonly code: string;
  readonly name: string;
  readonly category: string;
  readonly customCategory: string | null;
  readonly quantity: number | null;
  readonly unit: string | null;
  readonly rate: number | null;
  readonly amount: number;
  readonly taxableAmount: number;
  readonly exemptAmount: number;
  readonly exemptions: readonly Exemption[];
  readonly isTaxableSnapshot: boolean | null;
  readonly isDeMinimisSnapshot: boolean | null;
  readonly deMinimisCode: string | null;
  readonly source: BreakdownSource;
  readonly ruleRef: { readonly [key: string]: JsonValue };
}

export interface BasicPayResult {
  readonly rateType: RateType;
  readonly monthlyRate: number;
  readonly dailyRate: number;
  readonly hourlyRate: number;
  readonly scheduledBasicPay: number;
  readonly absenceDeduction: number;
  readonly lateUndertimeDeduction: number;
  readonly netBasicPay: number;
}

export interface ContributionAmounts {
  readonly employee: number;
  readonly employer: number;
  readonly ec: number;
}

export interface ContributionResult {
  readonly agency: 'SSS' | 'PHILHEALTH' | 'PAGIBIG';
  readonly enabled: boolean;
  readonly appliesThisPeriod: boolean;
  readonly monthlyCompensationBase: number;
  readonly monthly: ContributionAmounts;
  readonly period: ContributionAmounts;
  readonly detail: { readonly [key: string]: JsonValue };
}

export interface TaxResult {
  readonly enabled: boolean;
  readonly method: 'DISABLED' | 'PER_PERIOD_TABLE' | 'MONTH_TO_DATE_CUMULATIVE';
  readonly isMinimumWageEarner: boolean;
  readonly mweExemptEarnings: number;
  readonly taxableIncomeThisPeriod: number;
  readonly monthToDateTaxableIncome: number;
  readonly taxOnBase: number;
  readonly alreadyWithheldMonthToDate: number;
  readonly withholdingTax: number;
  readonly bracket: TaxBracket | null;
  readonly bracketIndex: number | null;
}

export interface DeductionResult {
  readonly code: string;
  readonly name: string;
  readonly category: string;
  readonly requestedAmount: number;
  readonly appliedAmount: number;
  readonly deferredAmount: number;
}

export interface PayLineWarning {
  readonly code: string;
  readonly message: string;
}

export interface PayLineTotals {
  readonly grossPay: number;
  readonly nonTaxableEarnings: number;
  readonly taxableEarnings: number;
  readonly employeeMandatoryContributions: number;
  readonly taxableIncome: number;
  readonly withholdingTax: number;
  readonly voluntaryDeductions: number;
  readonly deferredDeductions: number;
  readonly totalDeductions: number;
  readonly netPay: number;
  readonly employerContributions: number;
  readonly employerCost: number;
}

export interface PayLineResult {
  readonly ruleVersionId: string;
  readonly employeeId: string;
  readonly payFrequency: PayFrequency;
  readonly period: PayPeriod;
  readonly basicPay: BasicPayResult;
  readonly contributions: {
    readonly sss: ContributionResult;
    readonly philhealth: ContributionResult;
    readonly pagibig: ContributionResult;
    readonly employeeTotal: number;
    readonly employerTotal: number;
  };
  readonly tax: TaxResult;
  readonly voluntaryDeductions: readonly DeductionResult[];
  readonly totals: PayLineTotals;
  readonly breakdown: {
    readonly earnings: readonly BreakdownLine[];
    readonly employeeContributions: readonly BreakdownLine[];
    readonly withholdingTax: BreakdownLine | null;
    readonly voluntaryDeductions: readonly BreakdownLine[];
    readonly employerContributions: readonly BreakdownLine[];
  };
  readonly lines: readonly BreakdownLine[];
  readonly grossByCategory: Readonly<Record<string, number>>;
  readonly carryForward: {
    /** What this line consumed in each de minimis window; add it to the running usage. */
    readonly deMinimisUsage: Readonly<Record<string, number>>;
    readonly otherBenefitsAdded: number;
  };
  readonly warnings: readonly PayLineWarning[];
}
