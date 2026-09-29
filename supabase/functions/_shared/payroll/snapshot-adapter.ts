/* =====================================================================
 * snapshot-adapter.ts - turns the snake_case JSONB in payroll_rules.config
 * (migration 20261004_01_payroll_foundation.sql: kinds sss, philhealth,
 * pagibig, bir, labor) into the camelCase, deep-frozen RuleSetSnapshot
 * the engine consumes. Labor rules come from the 'labor' row via
 * laborRulesFromConfig(). Extra keys (e.g. night_differential.start/end,
 * used when building timesheets) are ignored here.
 * ===================================================================== */

import type {
  DeMinimisRule,
  NightDifferentialRule,
  OtherBenefitsCapRule,
  PagibigRule,
  PayFrequency,
  PayFrequencyRule,
  PhilHealthRule,
  PremiumRule,
  RoundingMode,
  RoundingRule,
  RuleSetSnapshot,
  SssBracket,
  SssRule,
  TaxBracket,
} from './types.ts';

export interface LaborRules {
  readonly payFrequencies: Readonly<Record<PayFrequency, PayFrequencyRule>>;
  readonly premiums: Readonly<Record<string, PremiumRule>>;
  readonly nightDifferential: NightDifferentialRule;
  readonly mweExemptCategories: readonly string[];
}

/** The `config` column of each published rule row, plus the bundle label. */
export interface RuleConfigRows {
  readonly versionId: string;
  readonly sss: unknown;
  readonly philhealth: unknown;
  readonly pagibig: unknown;
  readonly bir: unknown;
}

type Json = { readonly [key: string]: unknown };

const ROUNDING_MODES: readonly RoundingMode[] = ['HALF_UP', 'HALF_EVEN', 'DOWN', 'UP'];

function adapterError(path: string, message: string): never {
  throw new Error(`[INVALID_RULE_CONFIG] ${path}: ${message}`);
}

function asObject(value: unknown, path: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) adapterError(path, 'expected an object');
  return value as Json;
}

function asArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) adapterError(path, 'expected an array');
  return value as readonly unknown[];
}

function num(source: Json, key: string, path: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) adapterError(`${path}.${key}`, 'expected a finite number');
  return value;
}

function optNum(source: Json, key: string, path: string): number | undefined {
  return source[key] === undefined || source[key] === null ? undefined : num(source, key, path);
}

function str(source: Json, key: string, path: string): string {
  const value = source[key];
  if (typeof value !== 'string') adapterError(`${path}.${key}`, 'expected a string');
  return value;
}

function optStr(source: Json, key: string, path: string): string | undefined {
  return source[key] === undefined || source[key] === null ? undefined : str(source, key, path);
}

function nullableNum(source: Json, key: string, path: string): number | null {
  return source[key] === undefined || source[key] === null ? null : num(source, key, path);
}

function parseRounding(source: Json, path: string): RoundingRule {
  const rounding = asObject(source.rounding, `${path}.rounding`);
  const mode = str(rounding, 'mode', `${path}.rounding`);
  if (!ROUNDING_MODES.includes(mode as RoundingMode)) adapterError(`${path}.rounding.mode`, `unsupported mode '${mode}'`);
  return { mode: mode as RoundingMode, scale: num(rounding, 'scale', `${path}.rounding`) };
}

function parseSss(raw: unknown): SssRule {
  const path = 'sss';
  const config = asObject(raw, path);
  const ec = asObject(config.ec, `${path}.ec`);
  const brackets: SssBracket[] = asArray(config.brackets, `${path}.brackets`).map((entry, i) => {
    const bracketPath = `${path}.brackets[${i}]`;
    const bracket = asObject(entry, bracketPath);
    const regularMsc = optNum(bracket, 'regular_msc', bracketPath);
    const mpfMsc = optNum(bracket, 'mpf_msc', bracketPath);
    return {
      msc: num(bracket, 'msc', bracketPath),
      compFrom: num(bracket, 'comp_from', bracketPath),
      compTo: nullableNum(bracket, 'comp_to', bracketPath),
      ...(regularMsc === undefined ? {} : { regularMsc }),
      ...(mpfMsc === undefined ? {} : { mpfMsc }),
    };
  });
  return {
    employeeRate: num(config, 'employee_rate', path),
    employerRate: num(config, 'employer_rate', path),
    ec: {
      thresholdMsc: num(ec, 'threshold_msc', `${path}.ec`),
      belowAmount: num(ec, 'below_amount', `${path}.ec`),
      atOrAboveAmount: num(ec, 'at_or_above_amount', `${path}.ec`),
    },
    brackets,
  };
}

function parsePhilHealth(raw: unknown): PhilHealthRule {
  const path = 'philhealth';
  const config = asObject(raw, path);
  const minTotalPremium = optNum(config, 'min_total_premium', path);
  const maxTotalPremium = optNum(config, 'max_total_premium', path);
  return {
    premiumRate: num(config, 'premium_rate', path),
    employeeSplit: num(config, 'employee_split', path),
    employerSplit: num(config, 'employer_split', path),
    salaryFloor: num(config, 'salary_floor', path),
    salaryCeiling: num(config, 'salary_ceiling', path),
    ...(minTotalPremium === undefined ? {} : { minTotalPremium }),
    ...(maxTotalPremium === undefined ? {} : { maxTotalPremium }),
  };
}

function parsePagibig(raw: unknown): PagibigRule {
  const path = 'pagibig';
  const config = asObject(raw, path);
  const maxEmployeeContribution = optNum(config, 'max_employee_contribution', path);
  const maxEmployerContribution = optNum(config, 'max_employer_contribution', path);
  return {
    employeeRate: num(config, 'employee_rate', path),
    employerRate: num(config, 'employer_rate', path),
    maxFundSalary: num(config, 'max_fund_salary', path),
    ...(maxEmployeeContribution === undefined ? {} : { maxEmployeeContribution }),
    ...(maxEmployerContribution === undefined ? {} : { maxEmployerContribution }),
  };
}

function parseTaxBrackets(source: Json): readonly TaxBracket[] {
  return asArray(source.brackets, 'bir.brackets').map((entry, i) => {
    const path = `bir.brackets[${i}]`;
    const bracket = asObject(entry, path);
    return {
      over: num(bracket, 'over', path),
      upTo: nullableNum(bracket, 'up_to', path),
      baseTax: num(bracket, 'base_tax', path),
      rate: num(bracket, 'rate', path),
      excessOver: num(bracket, 'excess_over', path),
    };
  });
}

function parseDeMinimis(source: Json): Readonly<Record<string, DeMinimisRule>> {
  if (source.de_minimis === undefined) return {};
  const table = asObject(source.de_minimis, 'bir.de_minimis');
  const result: Record<string, DeMinimisRule> = {};
  for (const [code, entry] of Object.entries(table)) {
    const path = `bir.de_minimis.${code}`;
    const rule = asObject(entry, path);
    const limitType = str(rule, 'limit_type', path);
    if (limitType !== 'AMOUNT' && limitType !== 'PCT_OF_MIN_WAGE' && limitType !== 'DAYS') {
      adapterError(`${path}.limit_type`, `unsupported limit_type '${limitType}'`);
    }
    const limit = optNum(rule, 'limit', path);
    const pct = optNum(rule, 'pct', path);
    const pool = optStr(rule, 'pool', path);
    result[code] = {
      limitType,
      period: str(rule, 'period', path),
      ...(limit === undefined ? {} : { limit }),
      ...(pct === undefined ? {} : { pct }),
      ...(pool === undefined ? {} : { pool }),
    };
  }
  return result;
}

function parseOtherBenefitsCap(source: Json): OtherBenefitsCapRule | undefined {
  if (source.other_benefits_cap === undefined) return undefined;
  const path = 'bir.other_benefits_cap';
  const cap = asObject(source.other_benefits_cap, path);
  const treatment = str(cap, 'de_minimis_excess_treatment', path);
  if (treatment !== 'ADD_TO_OTHER_BENEFITS' && treatment !== 'TAXABLE') {
    adapterError(`${path}.de_minimis_excess_treatment`, `unsupported treatment '${treatment}'`);
  }
  return {
    annualAmount: num(cap, 'annual_amount', path),
    covers: asArray(cap.covers, `${path}.covers`).map((value, i) => {
      if (typeof value !== 'string') adapterError(`${path}.covers[${i}]`, 'expected a string');
      return value as string;
    }),
    deMinimisExcessTreatment: treatment,
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Maps labor_rules.config (migration 004, snake_case JSONB) to the LaborRules the snapshot needs. */
export function laborRulesFromConfig(raw: unknown): LaborRules {
  const config = asObject(raw, 'labor');
  const frequencyTable = asObject(config.pay_frequencies, 'labor.pay_frequencies');
  const payFrequencies = {} as Record<PayFrequency, PayFrequencyRule>;
  for (const key of ['WEEKLY', 'BI_WEEKLY', 'SEMI_MONTHLY', 'MONTHLY'] as const) {
    const path = `labor.pay_frequencies.${key}`;
    payFrequencies[key] = { periodsPerYear: num(asObject(frequencyTable[key], path), 'periods_per_year', path) };
  }

  const premiums: Record<string, PremiumRule> = {};
  for (const [code, entry] of Object.entries(asObject(config.premiums, 'labor.premiums'))) {
    const path = `labor.premiums.${code}`;
    const premium = asObject(entry, path);
    const category = str(premium, 'category', path);
    if (category !== 'OVERTIME' && category !== 'HOLIDAY_PAY') adapterError(`${path}.category`, `unsupported category '${category}'`);
    const monthlyPaidMultiplier = optNum(premium, 'monthly_paid_multiplier', path);
    premiums[code] = {
      code,
      name: str(premium, 'name', path),
      category,
      multiplier: num(premium, 'multiplier', path),
      ...(monthlyPaidMultiplier === undefined ? {} : { monthlyPaidMultiplier }),
    };
  }

  const mwe = asObject(config.mwe, 'labor.mwe');
  return {
    payFrequencies,
    premiums,
    nightDifferential: { rate: num(asObject(config.night_differential, 'labor.night_differential'), 'rate', 'labor.night_differential') },
    mweExemptCategories: asArray(mwe.exempt_categories, 'labor.mwe.exempt_categories').map((value, i) => {
      if (typeof value !== 'string') adapterError(`labor.mwe.exempt_categories[${i}]`, 'expected a string');
      return value as string;
    }),
  };
}

export function buildRuleSetSnapshot(rows: RuleConfigRows, labor: LaborRules): RuleSetSnapshot {
  const birConfig = asObject(rows.bir, 'bir');
  const period = str(birConfig, 'period', 'bir');
  if (!(period in labor.payFrequencies)) adapterError('bir.period', `'${period}' is not a known pay frequency`);
  const cap = parseOtherBenefitsCap(birConfig);

  const snapshot: RuleSetSnapshot = {
    versionId: rows.versionId,
    rounding: parseRounding(birConfig, 'bir'),
    payFrequencies: labor.payFrequencies,
    premiums: labor.premiums,
    nightDifferential: labor.nightDifferential,
    sss: parseSss(rows.sss),
    philhealth: parsePhilHealth(rows.philhealth),
    pagibig: parsePagibig(rows.pagibig),
    bir: {
      period: period as PayFrequency,
      brackets: parseTaxBrackets(birConfig),
      deMinimis: parseDeMinimis(birConfig),
      ...(cap === undefined ? {} : { otherBenefitsCap: cap }),
      mwe: { exemptCategories: labor.mweExemptCategories },
    },
  };
  return deepFreeze(snapshot);
}
