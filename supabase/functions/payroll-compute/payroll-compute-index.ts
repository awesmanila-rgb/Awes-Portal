// payroll-compute — SINGLE-FILE build for the Supabase dashboard editor.
// Same code as supabase/functions/payroll-compute/index.ts + ../_shared/payroll/*
// (engine, snapshot adapter, compute) bundled together. Paste this whole file
// into the dashboard function "payroll-compute" and deploy. Keep "Verify JWT" ON.

// index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ../_shared/payroll/engine.ts
var PayrollEngineError = class extends Error {
  code;
  constructor(code, message) {
    super(`[${code}] ${message}`);
    this.name = "PayrollEngineError";
    this.code = code;
  }
};
var IDENTITY_MULTIPLIER = 1;
function fail(code, message) {
  throw new PayrollEngineError(code, message);
}
function makeRounder(rule) {
  const factor = Math.pow(10, rule.scale);
  return (value) => {
    if (!Number.isFinite(value)) {
      return fail("NON_FINITE_VALUE", `Cannot round a non-finite value (${value})`);
    }
    const scaled = Number((value * factor).toPrecision(15));
    const magnitude = Math.abs(scaled);
    const whole = Math.floor(magnitude);
    const fraction = magnitude - whole;
    let rounded;
    switch (rule.mode) {
      case "HALF_UP":
        rounded = fraction >= 0.5 ? whole + 1 : whole;
        break;
      case "HALF_EVEN":
        rounded = fraction > 0.5 ? whole + 1 : fraction < 0.5 ? whole : whole % 2 === 0 ? whole : whole + 1;
        break;
      case "DOWN":
        rounded = whole;
        break;
      case "UP":
        rounded = fraction > 0 ? whole + 1 : whole;
        break;
      default: {
        const unreachable = rule.mode;
        return fail("INVALID_RULE_SET", `Unknown rounding mode ${String(unreachable)}`);
      }
    }
    const result = (scaled < 0 ? -rounded : rounded) / factor;
    return result === 0 ? 0 : result;
  };
}
var tidy = (value) => Number(value.toPrecision(12));
function requireNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    fail("INVALID_INPUT", `${label} must be a finite number >= 0 (got ${value})`);
  }
}
function requirePositive(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    fail("INVALID_INPUT", `${label} must be a finite number > 0 (got ${value})`);
  }
}
function requireIntegerInRange(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail("INVALID_INPUT", `${label} must be an integer between ${min} and ${max} (got ${value})`);
  }
}
function assertRuleSet(rs) {
  const bad = (message) => fail("INVALID_RULE_SET", message);
  if (rs.versionId.length === 0) bad("versionId is required");
  if (!Number.isInteger(rs.rounding.scale) || rs.rounding.scale < 0) bad("rounding.scale must be an integer >= 0");
  const monthly = rs.payFrequencies.MONTHLY;
  if (monthly === void 0) bad("payFrequencies.MONTHLY is required (defines months per year)");
  for (const [frequency, rule] of Object.entries(rs.payFrequencies)) {
    if (!Number.isFinite(rule.periodsPerYear) || rule.periodsPerYear <= 0) {
      bad(`payFrequencies.${frequency}.periodsPerYear must be > 0`);
    }
  }
  if (rs.sss.brackets.length === 0) bad("sss.brackets is empty");
  rs.sss.brackets.forEach((bracket, index) => {
    if (index > 0 && bracket.compFrom <= rs.sss.brackets[index - 1].compFrom) {
      bad("sss.brackets must be sorted ascending by compFrom");
    }
  });
  if (rs.sss.brackets[0].compFrom > 0) bad("sss.brackets must start at compFrom <= 0");
  const ph = rs.philhealth;
  if (ph.salaryFloor > ph.salaryCeiling) bad("philhealth.salaryFloor must be <= salaryCeiling");
  if (Math.abs(ph.employeeSplit + ph.employerSplit - IDENTITY_MULTIPLIER) > Number.EPSILON * 16) {
    bad("philhealth employeeSplit + employerSplit must equal 1");
  }
  if (rs.pagibig.maxFundSalary < 0) bad("pagibig.maxFundSalary must be >= 0");
  const brackets = rs.bir.brackets;
  if (brackets.length === 0) bad("bir.brackets is empty");
  brackets.forEach((bracket, index) => {
    const isLast = index === brackets.length - 1;
    if (isLast && bracket.upTo !== null) bad("last bir bracket must be open-ended (upTo = null)");
    if (!isLast) {
      const next = brackets[index + 1];
      if (bracket.upTo === null || bracket.upTo !== next.over) {
        bad(`bir brackets must be contiguous (bracket ${index} upTo != bracket ${index + 1} over)`);
      }
    }
  });
}
function validateInput(input) {
  const rs = input.ruleSet;
  const { compensation } = input.employee;
  requireNonNegative(compensation.baseRate, "employee.compensation.baseRate");
  requirePositive(compensation.workingDaysPerYear, "employee.compensation.workingDaysPerYear");
  requirePositive(compensation.hoursPerDay, "employee.compensation.hoursPerDay");
  if (rs.payFrequencies[input.payFrequency] === void 0) {
    fail("MISSING_RULE", `Rule set ${rs.versionId} has no pay frequency '${input.payFrequency}'`);
  }
  const { period, attendance, statutory } = input;
  requireIntegerInRange(period.periodsInMonth, 1, Number.MAX_SAFE_INTEGER, "period.periodsInMonth");
  requireIntegerInRange(period.periodIndexInMonth, 1, period.periodsInMonth, "period.periodIndexInMonth");
  requireNonNegative(attendance.regularHours, "attendance.regularHours");
  requireNonNegative(attendance.absentDays, "attendance.absentDays");
  requireNonNegative(attendance.lateUndertimeHours, "attendance.lateUndertimeHours");
  attendance.premiumHours.forEach((entry, i) => requireNonNegative(entry.hours, `attendance.premiumHours[${i}].hours`));
  attendance.nightDifferentialHours.forEach(
    (entry, i) => requireNonNegative(entry.hours, `attendance.nightDifferentialHours[${i}].hours`)
  );
  for (const item of [...input.recurringEarnings, ...input.oneOffEarnings]) {
    requireNonNegative(item.amount, `earning '${item.code}'.amount`);
    if (item.quantity !== void 0) requireNonNegative(item.quantity, `earning '${item.code}'.quantity`);
  }
  for (const item of [...input.recurringDeductions, ...input.oneOffDeductions]) {
    requireNonNegative(item.amount, `deduction '${item.code}'.amount`);
  }
  for (const [agency, option] of [
    ["sss", statutory.sss],
    ["philhealth", statutory.philhealth],
    ["pagibig", statutory.pagibig]
  ]) {
    if (option.timing.mode === "FULL_ON_PERIOD") {
      requireIntegerInRange(option.timing.periodNumber, 1, period.periodsInMonth, `statutory.${agency}.timing.periodNumber`);
    }
    if (option.monthlyCompensationOverride !== void 0) {
      requireNonNegative(option.monthlyCompensationOverride, `statutory.${agency}.monthlyCompensationOverride`);
    }
  }
  requireNonNegative(input.monthToDate.taxableIncome, "monthToDate.taxableIncome");
  requireNonNegative(input.monthToDate.withholdingTax, "monthToDate.withholdingTax");
  requireNonNegative(input.yearToDate.otherBenefitsUsed, "yearToDate.otherBenefitsUsed");
  for (const [key, used] of Object.entries(input.deMinimisWindowUsage)) {
    requireNonNegative(used, `deMinimisWindowUsage['${key}']`);
  }
  if (input.minimumNetPay !== void 0) requireNonNegative(input.minimumNetPay, "minimumNetPay");
}
function createEarningClassifier(input, round) {
  const rs = input.ruleSet;
  const bir = rs.bir;
  const cap = bir.otherBenefitsCap;
  const mweExemptCategories = new Set(bir.mwe.exemptCategories);
  const isMinimumWageEarner = input.employee.isMinimumWageEarner;
  const usageRunning = { ...input.deMinimisWindowUsage };
  const usageDelta = {};
  let capRemaining = cap === void 0 ? 0 : Math.max(0, round(cap.annualAmount - input.yearToDate.otherBenefitsUsed));
  let otherBenefitsAdded = 0;
  const routeToOtherBenefits = (amount) => {
    if (cap === void 0) return { exempt: 0, taxable: amount };
    const exempt = Math.min(amount, capRemaining);
    capRemaining = Math.max(0, round(capRemaining - amount));
    otherBenefitsAdded = round(otherBenefitsAdded + amount);
    return { exempt, taxable: round(amount - exempt) };
  };
  const coveredByCap = (item) => cap !== void 0 && (cap.covers.includes(item.category) || item.customCategory !== void 0 && cap.covers.includes(item.customCategory));
  const classifyDeMinimis = (item) => {
    const code = item.deMinimisCode;
    if (code === void 0) fail("INVALID_INPUT", `Earning '${item.code}' is de minimis but has no deMinimisCode`);
    const rule = bir.deMinimis[code];
    if (rule === void 0) fail("MISSING_RULE", `Rule set ${rs.versionId} has no de minimis rule '${code}'`);
    const key = rule.pool ?? code;
    const usedBefore = usageRunning[key] ?? 0;
    let exempt = 0;
    let consumed = 0;
    let limitApplied = 0;
    switch (rule.limitType) {
      case "AMOUNT": {
        if (rule.limit === void 0) fail("INVALID_RULE_SET", `de minimis '${code}' (AMOUNT) needs a limit`);
        limitApplied = rule.limit;
        exempt = Math.min(item.amount, Math.max(0, round(rule.limit - usedBefore)));
        consumed = exempt;
        break;
      }
      case "PCT_OF_MIN_WAGE": {
        const wage = input.employee.regionalMinimumDailyWage;
        if (rule.pct === void 0) fail("INVALID_RULE_SET", `de minimis '${code}' (PCT_OF_MIN_WAGE) needs pct`);
        if (wage === void 0 || item.quantity === void 0) {
          fail("INVALID_INPUT", `de minimis '${code}' needs employee.regionalMinimumDailyWage and item.quantity`);
        }
        limitApplied = round(rule.pct * wage * item.quantity);
        exempt = Math.min(item.amount, Math.max(0, round(limitApplied - usedBefore)));
        consumed = exempt;
        break;
      }
      case "DAYS": {
        if (rule.limit === void 0) fail("INVALID_RULE_SET", `de minimis '${code}' (DAYS) needs a limit`);
        if (item.quantity === void 0 || item.quantity <= 0) {
          fail("INVALID_INPUT", `de minimis '${code}' (DAYS) needs item.quantity > 0`);
        }
        limitApplied = rule.limit;
        const exemptDays = Math.min(item.quantity, Math.max(0, tidy(rule.limit - usedBefore)));
        exempt = round(item.amount * exemptDays / item.quantity);
        consumed = exemptDays;
        break;
      }
      default: {
        const unreachable = rule.limitType;
        return fail("INVALID_RULE_SET", `Unknown de minimis limitType ${String(unreachable)}`);
      }
    }
    usageRunning[key] = tidy(usedBefore + consumed);
    usageDelta[key] = tidy((usageDelta[key] ?? 0) + consumed);
    const exemptions = [];
    if (exempt > 0) exemptions.push({ reason: "DE_MINIMIS", amount: exempt });
    const excess = round(item.amount - exempt);
    let taxable = excess;
    let treatment = "NONE";
    if (excess > 0) {
      treatment = cap === void 0 ? "TAXABLE" : cap.deMinimisExcessTreatment;
      if (cap !== void 0 && cap.deMinimisExcessTreatment === "ADD_TO_OTHER_BENEFITS") {
        const routed = routeToOtherBenefits(excess);
        taxable = routed.taxable;
        if (routed.exempt > 0) exemptions.push({ reason: "OTHER_BENEFITS_CAP", amount: routed.exempt });
      }
    }
    return {
      taxable,
      exemptions,
      ruleRef: {
        rule: "DE_MINIMIS",
        ruleVersionId: rs.versionId,
        deMinimisCode: code,
        limitKey: key,
        limitType: rule.limitType,
        limit: limitApplied,
        window: rule.period,
        usedBefore,
        exempt,
        excess,
        excessTreatment: treatment
      }
    };
  };
  const classify = (item) => {
    if (item.isDeMinimis) return classifyDeMinimis(item);
    if (isMinimumWageEarner && mweExemptCategories.has(item.category)) {
      return {
        taxable: 0,
        exemptions: item.amount > 0 ? [{ reason: "MWE_EXEMPT", amount: item.amount }] : [],
        ruleRef: { rule: "MWE_EXEMPT", ruleVersionId: rs.versionId, category: item.category }
      };
    }
    if (!item.isTaxable) {
      return {
        taxable: 0,
        exemptions: item.amount > 0 ? [{ reason: "NON_TAXABLE_FLAG", amount: item.amount }] : [],
        ruleRef: { rule: "NON_TAXABLE_FLAG", ruleVersionId: rs.versionId }
      };
    }
    if (coveredByCap(item)) {
      const routed = routeToOtherBenefits(item.amount);
      return {
        taxable: routed.taxable,
        exemptions: routed.exempt > 0 ? [{ reason: "OTHER_BENEFITS_CAP", amount: routed.exempt }] : [],
        ruleRef: {
          rule: "OTHER_BENEFITS_CAP",
          ruleVersionId: rs.versionId,
          annualCap: cap === void 0 ? null : cap.annualAmount,
          usedBeforeThisLine: input.yearToDate.otherBenefitsUsed,
          exempt: routed.exempt
        }
      };
    }
    return { taxable: item.amount, exemptions: [], ruleRef: { rule: "TAXABLE", ruleVersionId: rs.versionId } };
  };
  return {
    classify,
    carryForward: () => ({ deMinimisUsage: { ...usageDelta }, otherBenefitsAdded })
  };
}
function allocateToPeriod(monthly, timing, index, count, round) {
  if (timing.mode === "SPLIT_EQUAL") {
    return round(round(monthly * index / count) - round(monthly * (index - 1) / count));
  }
  return timing.periodNumber === index ? monthly : 0;
}
function appliesInPeriod(timing, index) {
  return timing.mode === "SPLIT_EQUAL" || timing.periodNumber === index;
}
function zeroAmounts() {
  return { employee: 0, employer: 0, ec: 0 };
}
function disabledContribution(agency, enabled, base) {
  return {
    agency,
    enabled,
    appliesThisPeriod: false,
    monthlyCompensationBase: base,
    monthly: zeroAmounts(),
    period: zeroAmounts(),
    detail: {}
  };
}
function toPeriodAmounts(monthly, option, index, count, round) {
  return {
    employee: allocateToPeriod(monthly.employee, option.timing, index, count, round),
    employer: allocateToPeriod(monthly.employer, option.timing, index, count, round),
    ec: allocateToPeriod(monthly.ec, option.timing, index, count, round)
  };
}
function computeSss(rule, base, option, index, count, round) {
  if (!option.enabled || base <= 0) return disabledContribution("SSS", option.enabled, base);
  let bracketIndex = -1;
  rule.brackets.forEach((bracket2, i) => {
    if (base >= bracket2.compFrom) bracketIndex = i;
  });
  if (bracketIndex < 0) fail("NO_MATCHING_BRACKET", `No SSS bracket matches monthly compensation ${base}`);
  const bracket = rule.brackets[bracketIndex];
  const monthly = {
    employee: round(bracket.msc * rule.employeeRate),
    employer: round(bracket.msc * rule.employerRate),
    ec: bracket.msc < rule.ec.thresholdMsc ? rule.ec.belowAmount : rule.ec.atOrAboveAmount
  };
  return {
    agency: "SSS",
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
      employerRate: rule.employerRate
    }
  };
}
function computePhilHealth(rule, base, option, index, count, round) {
  if (!option.enabled || base <= 0) return disabledContribution("PHILHEALTH", option.enabled, base);
  const boundedBase = Math.min(Math.max(base, rule.salaryFloor), rule.salaryCeiling);
  let total = round(boundedBase * rule.premiumRate);
  if (rule.minTotalPremium !== void 0) total = Math.max(total, rule.minTotalPremium);
  if (rule.maxTotalPremium !== void 0) total = Math.min(total, rule.maxTotalPremium);
  const employee = round(total * rule.employeeSplit);
  const monthly = { employee, employer: round(total - employee), ec: 0 };
  return {
    agency: "PHILHEALTH",
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
      salaryCeiling: rule.salaryCeiling
    }
  };
}
function computePagibig(rule, base, option, index, count, round) {
  if (!option.enabled || base <= 0) return disabledContribution("PAGIBIG", option.enabled, base);
  const monthlyFundSalary = Math.min(base, rule.maxFundSalary);
  let employee = round(monthlyFundSalary * rule.employeeRate);
  let employer = round(monthlyFundSalary * rule.employerRate);
  if (rule.maxEmployeeContribution !== void 0) employee = Math.min(employee, rule.maxEmployeeContribution);
  if (rule.maxEmployerContribution !== void 0) employer = Math.min(employer, rule.maxEmployerContribution);
  const monthly = { employee, employer, ec: 0 };
  return {
    agency: "PAGIBIG",
    enabled: true,
    appliesThisPeriod: appliesInPeriod(option.timing, index),
    monthlyCompensationBase: base,
    monthly,
    period: toPeriodAmounts(monthly, option, index, count, round),
    detail: {
      monthlyFundSalary,
      employeeRate: rule.employeeRate,
      employerRate: rule.employerRate,
      maxFundSalary: rule.maxFundSalary
    }
  };
}
function computeBracketTax(brackets, taxable, round) {
  let index = 0;
  brackets.forEach((bracket2, i) => {
    if (taxable > bracket2.over) index = i;
  });
  const bracket = brackets[index];
  const tax = round(bracket.baseTax + bracket.rate * Math.max(0, taxable - bracket.excessOver));
  return { tax, bracket, index };
}
function calculatePayLine(input) {
  const rs = input.ruleSet;
  assertRuleSet(rs);
  validateInput(input);
  const round = makeRounder(rs.rounding);
  const sum = (values) => round(values.reduce((total, value) => total + value, 0));
  const warnings = [];
  const warn = (code, message) => {
    warnings.push({ code, message });
  };
  const { employee, period, attendance } = input;
  const { compensation } = employee;
  const monthsPerYear = rs.payFrequencies.MONTHLY.periodsPerYear;
  const periodsPerYear = rs.payFrequencies[input.payFrequency].periodsPerYear;
  let monthlyRate;
  let dailyRate;
  switch (compensation.rateType) {
    case "MONTHLY":
      monthlyRate = compensation.baseRate;
      dailyRate = compensation.baseRate * monthsPerYear / compensation.workingDaysPerYear;
      break;
    case "DAILY":
      dailyRate = compensation.baseRate;
      monthlyRate = compensation.baseRate * compensation.workingDaysPerYear / monthsPerYear;
      break;
    case "HOURLY":
      dailyRate = compensation.baseRate * compensation.hoursPerDay;
      monthlyRate = dailyRate * compensation.workingDaysPerYear / monthsPerYear;
      break;
    default: {
      const unreachable = compensation.rateType;
      return fail("INVALID_INPUT", `Unknown rateType ${String(unreachable)}`);
    }
  }
  const hourlyRate = compensation.rateType === "HOURLY" ? compensation.baseRate : dailyRate / compensation.hoursPerDay;
  const isMonthlyRated = compensation.rateType === "MONTHLY";
  const scheduledBasicPay = isMonthlyRated ? round(monthlyRate * monthsPerYear / periodsPerYear) : round(attendance.regularHours * hourlyRate);
  const absenceDeduction = isMonthlyRated ? round(attendance.absentDays * dailyRate) : 0;
  const lateUndertimeDeduction = isMonthlyRated ? round(attendance.lateUndertimeHours * hourlyRate) : 0;
  const netBasicPay = Math.max(0, round(scheduledBasicPay - absenceDeduction - lateUndertimeDeduction));
  if (!isMonthlyRated && (attendance.absentDays > 0 || attendance.lateUndertimeHours > 0)) {
    warn("ABSENCE_IGNORED", "absentDays / lateUndertimeHours are ignored for DAILY and HOURLY rated employees; pay is driven by regularHours");
  }
  if (isMonthlyRated && scheduledBasicPay - absenceDeduction - lateUndertimeDeduction < 0) {
    warn("BASIC_PAY_FLOORED", "Absence and tardiness deductions exceeded scheduled basic pay; basic pay floored at zero");
  }
  const basicPay = {
    rateType: compensation.rateType,
    monthlyRate: tidy(monthlyRate),
    dailyRate: tidy(dailyRate),
    hourlyRate: tidy(hourlyRate),
    scheduledBasicPay,
    absenceDeduction,
    lateUndertimeDeduction,
    netBasicPay
  };
  const classifier = createEarningClassifier(input, round);
  let seq = 0;
  const nextSeq = () => {
    seq += 1;
    return seq;
  };
  const earningLines = [];
  const pushEarning = (item, source, extras) => {
    const classification = classifier.classify(item);
    const exemptAmount = sum(classification.exemptions.map((exemption) => exemption.amount));
    earningLines.push({
      seq: nextSeq(),
      kind: "EARNING",
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
      ruleRef: { ...extras.ruleRef, ...classification.ruleRef }
    });
  };
  const systemItem = (code, name, category, amount) => ({
    code,
    name,
    category,
    amount,
    isTaxable: true,
    isDeMinimis: false
  });
  pushEarning(systemItem("BASIC_PAY", "Basic Pay", "BASIC", netBasicPay), "SYSTEM", {
    quantity: isMonthlyRated ? null : attendance.regularHours,
    unit: isMonthlyRated ? null : "HOURS",
    rate: isMonthlyRated ? null : tidy(hourlyRate),
    ruleRef: {
      calc: "BASIC_PAY",
      rateType: compensation.rateType,
      scheduledBasicPay,
      absenceDeduction,
      lateUndertimeDeduction,
      periodsPerYear,
      monthsPerYear
    }
  });
  for (const entry of attendance.premiumHours) {
    if (entry.hours === 0) continue;
    const premium = rs.premiums[entry.premiumCode];
    if (premium === void 0) fail("MISSING_RULE", `Rule set ${rs.versionId} has no premium '${entry.premiumCode}'`);
    const multiplier = isMonthlyRated && premium.monthlyPaidMultiplier !== void 0 ? premium.monthlyPaidMultiplier : premium.multiplier;
    const amount = round(entry.hours * hourlyRate * multiplier);
    pushEarning(systemItem(premium.code, premium.name, premium.category, amount), "SYSTEM", {
      quantity: entry.hours,
      unit: "HOURS",
      rate: tidy(hourlyRate * multiplier),
      ruleRef: { calc: "PREMIUM", premiumCode: premium.code, multiplier, hourlyRate: tidy(hourlyRate) }
    });
  }
  for (const entry of attendance.nightDifferentialHours) {
    if (entry.hours === 0) continue;
    let baseMultiplier = IDENTITY_MULTIPLIER;
    let code = "NIGHT_DIFFERENTIAL";
    if (entry.appliesToPremiumCode !== void 0) {
      const premium = rs.premiums[entry.appliesToPremiumCode];
      if (premium === void 0) {
        fail("MISSING_RULE", `Rule set ${rs.versionId} has no premium '${entry.appliesToPremiumCode}' for night differential`);
      }
      baseMultiplier = isMonthlyRated && premium.monthlyPaidMultiplier !== void 0 ? premium.monthlyPaidMultiplier : premium.multiplier;
      code = `NIGHT_DIFFERENTIAL_${entry.appliesToPremiumCode}`;
    }
    const amount = round(entry.hours * hourlyRate * baseMultiplier * rs.nightDifferential.rate);
    pushEarning(systemItem(code, "Night Differential", "NIGHT_DIFFERENTIAL", amount), "SYSTEM", {
      quantity: entry.hours,
      unit: "HOURS",
      rate: tidy(hourlyRate * baseMultiplier * rs.nightDifferential.rate),
      ruleRef: {
        calc: "NIGHT_DIFFERENTIAL",
        nightDifferentialRate: rs.nightDifferential.rate,
        baseMultiplier,
        hourlyRate: tidy(hourlyRate)
      }
    });
  }
  for (const item of input.recurringEarnings) {
    pushEarning(item, "RECURRING", { quantity: item.quantity ?? null, unit: null, rate: null, ruleRef: { calc: "ITEM" } });
  }
  for (const item of input.oneOffEarnings) {
    pushEarning(item, "ONE_OFF", { quantity: item.quantity ?? null, unit: null, rate: null, ruleRef: { calc: "ITEM" } });
  }
  const grossPay = sum(earningLines.map((line) => line.amount));
  const nonTaxableEarnings = sum(earningLines.map((line) => line.exemptAmount));
  const taxableEarnings = sum(earningLines.map((line) => line.taxableAmount));
  if (round(grossPay - nonTaxableEarnings) !== taxableEarnings) {
    fail("INTERNAL_INVARIANT", "gross - non-taxable != taxable earnings");
  }
  const grossByCategory = {};
  for (const line of earningLines) {
    grossByCategory[line.category] = round((grossByCategory[line.category] ?? 0) + line.amount);
  }
  const { statutory } = input;
  const baseFor = (option) => option.monthlyCompensationOverride ?? monthlyRate;
  const sss = computeSss(rs.sss, round(baseFor(statutory.sss)), statutory.sss, period.periodIndexInMonth, period.periodsInMonth, round);
  const philhealth = computePhilHealth(
    rs.philhealth,
    round(baseFor(statutory.philhealth)),
    statutory.philhealth,
    period.periodIndexInMonth,
    period.periodsInMonth,
    round
  );
  const pagibig = computePagibig(
    rs.pagibig,
    round(baseFor(statutory.pagibig)),
    statutory.pagibig,
    period.periodIndexInMonth,
    period.periodsInMonth,
    round
  );
  for (const contribution of [sss, philhealth, pagibig]) {
    if (contribution.enabled && contribution.monthlyCompensationBase <= 0) {
      warn("NO_COMPENSATION_BASE", `${contribution.agency}: monthly compensation base is zero; no contribution computed`);
    }
  }
  const employeeContributionTotal = sum([sss.period.employee, philhealth.period.employee, pagibig.period.employee]);
  const employerContributionTotal = sum([
    sss.period.employer,
    sss.period.ec,
    philhealth.period.employer,
    pagibig.period.employer
  ]);
  const statutoryLine = (kind, code, name, category, amount, ruleRef) => ({
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
    source: "SYSTEM",
    ruleRef: { ruleVersionId: rs.versionId, ...ruleRef }
  });
  const contributionRef = (result) => ({
    agency: result.agency,
    monthlyCompensationBase: result.monthlyCompensationBase,
    monthlyEmployee: result.monthly.employee,
    monthlyEmployer: result.monthly.employer,
    monthlyEc: result.monthly.ec,
    ...result.detail
  });
  const employeeContributionLines = [];
  const pushEmployeeContribution = (code, name, result) => {
    if (result.period.employee > 0) {
      employeeContributionLines.push(
        statutoryLine("DEDUCTION", code, name, result.agency, result.period.employee, contributionRef(result))
      );
    }
  };
  pushEmployeeContribution("SSS_EE", "SSS Employee Share", sss);
  pushEmployeeContribution("PHILHEALTH_EE", "PhilHealth Employee Share", philhealth);
  pushEmployeeContribution("PAGIBIG_EE", "Pag-IBIG Employee Share", pagibig);
  const taxableIncome = Math.max(0, round(taxableEarnings - employeeContributionTotal));
  const mweExemptEarnings = sum(
    earningLines.flatMap((line) => line.exemptions.filter((e) => e.reason === "MWE_EXEMPT").map((e) => e.amount))
  );
  let tax;
  if (!statutory.withholdingTax.enabled) {
    tax = {
      enabled: false,
      method: "DISABLED",
      isMinimumWageEarner: employee.isMinimumWageEarner,
      mweExemptEarnings,
      taxableIncomeThisPeriod: taxableIncome,
      monthToDateTaxableIncome: input.monthToDate.taxableIncome,
      taxOnBase: 0,
      alreadyWithheldMonthToDate: input.monthToDate.withholdingTax,
      withholdingTax: 0,
      bracket: null,
      bracketIndex: null
    };
  } else if (rs.bir.period === input.payFrequency) {
    const computed = computeBracketTax(rs.bir.brackets, taxableIncome, round);
    tax = {
      enabled: true,
      method: "PER_PERIOD_TABLE",
      isMinimumWageEarner: employee.isMinimumWageEarner,
      mweExemptEarnings,
      taxableIncomeThisPeriod: taxableIncome,
      monthToDateTaxableIncome: taxableIncome,
      taxOnBase: computed.tax,
      alreadyWithheldMonthToDate: 0,
      withholdingTax: computed.tax,
      bracket: computed.bracket,
      bracketIndex: computed.index
    };
  } else if (rs.bir.period === "MONTHLY") {
    const monthToDateTaxable = round(input.monthToDate.taxableIncome + taxableIncome);
    const computed = computeBracketTax(rs.bir.brackets, monthToDateTaxable, round);
    const withholding = Math.max(0, round(computed.tax - input.monthToDate.withholdingTax));
    tax = {
      enabled: true,
      method: "MONTH_TO_DATE_CUMULATIVE",
      isMinimumWageEarner: employee.isMinimumWageEarner,
      mweExemptEarnings,
      taxableIncomeThisPeriod: taxableIncome,
      monthToDateTaxableIncome: monthToDateTaxable,
      taxOnBase: computed.tax,
      alreadyWithheldMonthToDate: input.monthToDate.withholdingTax,
      withholdingTax: withholding,
      bracket: computed.bracket,
      bracketIndex: computed.index
    };
  } else {
    return fail("UNSUPPORTED_TAX_PERIOD", `BIR table period '${rs.bir.period}' cannot be applied to '${input.payFrequency}' pay`);
  }
  const withholdingTaxLine = tax.withholdingTax > 0 ? statutoryLine("DEDUCTION", "WITHHOLDING_TAX", "BIR Withholding Tax", "WITHHOLDING_TAX", tax.withholdingTax, {
    agency: "BIR",
    method: tax.method,
    taxableIncomeThisPeriod: tax.taxableIncomeThisPeriod,
    monthToDateTaxableIncome: tax.monthToDateTaxableIncome,
    taxOnBase: tax.taxOnBase,
    alreadyWithheld: tax.alreadyWithheldMonthToDate,
    bracketIndex: tax.bracketIndex,
    bracketOver: tax.bracket === null ? null : tax.bracket.over,
    bracketBaseTax: tax.bracket === null ? null : tax.bracket.baseTax,
    bracketRate: tax.bracket === null ? null : tax.bracket.rate,
    bracketExcessOver: tax.bracket === null ? null : tax.bracket.excessOver
  }) : null;
  const netBeforeVoluntary = round(grossPay - employeeContributionTotal - tax.withholdingTax);
  let available = Math.max(0, round(netBeforeVoluntary - (input.minimumNetPay ?? 0)));
  const queue = [
    ...input.recurringDeductions.map((item, i) => ({ item, source: "RECURRING", order: i })),
    ...input.oneOffDeductions.map((item, i) => ({ item, source: "ONE_OFF", order: input.recurringDeductions.length + i }))
  ];
  queue.sort((a, b) => {
    const pa = a.item.priority ?? Number.POSITIVE_INFINITY;
    const pb = b.item.priority ?? Number.POSITIVE_INFINITY;
    if (pa < pb) return -1;
    if (pa > pb) return 1;
    return a.order - b.order;
  });
  const deductionResults = [];
  const voluntaryLines = [];
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
      deferredAmount: deferred
    });
    if (deferred > 0) {
      warn("DEDUCTION_DEFERRED", `${item.code}: ${deferred} could not be deducted without breaching minimum net pay`);
    }
    if (applied > 0) {
      voluntaryLines.push({
        seq: nextSeq(),
        kind: "DEDUCTION",
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
          calc: "VOLUNTARY_DEDUCTION",
          ruleVersionId: rs.versionId,
          requested: item.amount,
          applied,
          deferred,
          priority: item.priority ?? null,
          allowPartial: partialAllowed
        }
      });
    }
  }
  const voluntaryTotal = sum(deductionResults.map((result) => result.appliedAmount));
  const deferredTotal = sum(deductionResults.map((result) => result.deferredAmount));
  const employerLines = [];
  const pushEmployer = (code, name, amount, result) => {
    if (amount > 0) employerLines.push(statutoryLine("EMPLOYER_CONTRIBUTION", code, name, result.agency, amount, contributionRef(result)));
  };
  pushEmployer("SSS_ER", "SSS Employer Share", sss.period.employer, sss);
  pushEmployer("SSS_EC", "SSS Employees' Compensation", sss.period.ec, sss);
  pushEmployer("PHILHEALTH_ER", "PhilHealth Employer Share", philhealth.period.employer, philhealth);
  pushEmployer("PAGIBIG_ER", "Pag-IBIG Employer Share", pagibig.period.employer, pagibig);
  const totalDeductions = sum([employeeContributionTotal, tax.withholdingTax, voluntaryTotal]);
  const netPay = round(grossPay - totalDeductions);
  if (netPay < 0) warn("NEGATIVE_NET_PAY", `Net pay is negative (${netPay}); statutory deductions and tax exceed gross pay`);
  const carry = classifier.carryForward();
  const lines = [
    ...earningLines,
    ...employeeContributionLines,
    ...withholdingTaxLine === null ? [] : [withholdingTaxLine],
    ...voluntaryLines,
    ...employerLines
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
      employerTotal: employerContributionTotal
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
      employerCost: round(grossPay + employerContributionTotal)
    },
    breakdown: {
      earnings: earningLines,
      employeeContributions: employeeContributionLines,
      withholdingTax: withholdingTaxLine,
      voluntaryDeductions: voluntaryLines,
      employerContributions: employerLines
    },
    lines,
    grossByCategory,
    carryForward: {
      deMinimisUsage: carry.deMinimisUsage,
      otherBenefitsAdded: carry.otherBenefitsAdded
    },
    warnings
  };
}

// ../_shared/payroll/snapshot-adapter.ts
var ROUNDING_MODES = ["HALF_UP", "HALF_EVEN", "DOWN", "UP"];
function adapterError(path, message) {
  throw new Error(`[INVALID_RULE_CONFIG] ${path}: ${message}`);
}
function asObject(value, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) adapterError(path, "expected an object");
  return value;
}
function asArray(value, path) {
  if (!Array.isArray(value)) adapterError(path, "expected an array");
  return value;
}
function num(source, key, path) {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) adapterError(`${path}.${key}`, "expected a finite number");
  return value;
}
function optNum(source, key, path) {
  return source[key] === void 0 || source[key] === null ? void 0 : num(source, key, path);
}
function str(source, key, path) {
  const value = source[key];
  if (typeof value !== "string") adapterError(`${path}.${key}`, "expected a string");
  return value;
}
function optStr(source, key, path) {
  return source[key] === void 0 || source[key] === null ? void 0 : str(source, key, path);
}
function nullableNum(source, key, path) {
  return source[key] === void 0 || source[key] === null ? null : num(source, key, path);
}
function parseRounding(source, path) {
  const rounding = asObject(source.rounding, `${path}.rounding`);
  const mode = str(rounding, "mode", `${path}.rounding`);
  if (!ROUNDING_MODES.includes(mode)) adapterError(`${path}.rounding.mode`, `unsupported mode '${mode}'`);
  return { mode, scale: num(rounding, "scale", `${path}.rounding`) };
}
function parseSss(raw) {
  const path = "sss";
  const config = asObject(raw, path);
  const ec = asObject(config.ec, `${path}.ec`);
  const brackets = asArray(config.brackets, `${path}.brackets`).map((entry, i) => {
    const bracketPath = `${path}.brackets[${i}]`;
    const bracket = asObject(entry, bracketPath);
    const regularMsc = optNum(bracket, "regular_msc", bracketPath);
    const mpfMsc = optNum(bracket, "mpf_msc", bracketPath);
    return {
      msc: num(bracket, "msc", bracketPath),
      compFrom: num(bracket, "comp_from", bracketPath),
      compTo: nullableNum(bracket, "comp_to", bracketPath),
      ...regularMsc === void 0 ? {} : { regularMsc },
      ...mpfMsc === void 0 ? {} : { mpfMsc }
    };
  });
  return {
    employeeRate: num(config, "employee_rate", path),
    employerRate: num(config, "employer_rate", path),
    ec: {
      thresholdMsc: num(ec, "threshold_msc", `${path}.ec`),
      belowAmount: num(ec, "below_amount", `${path}.ec`),
      atOrAboveAmount: num(ec, "at_or_above_amount", `${path}.ec`)
    },
    brackets
  };
}
function parsePhilHealth(raw) {
  const path = "philhealth";
  const config = asObject(raw, path);
  const minTotalPremium = optNum(config, "min_total_premium", path);
  const maxTotalPremium = optNum(config, "max_total_premium", path);
  return {
    premiumRate: num(config, "premium_rate", path),
    employeeSplit: num(config, "employee_split", path),
    employerSplit: num(config, "employer_split", path),
    salaryFloor: num(config, "salary_floor", path),
    salaryCeiling: num(config, "salary_ceiling", path),
    ...minTotalPremium === void 0 ? {} : { minTotalPremium },
    ...maxTotalPremium === void 0 ? {} : { maxTotalPremium }
  };
}
function parsePagibig(raw) {
  const path = "pagibig";
  const config = asObject(raw, path);
  const maxEmployeeContribution = optNum(config, "max_employee_contribution", path);
  const maxEmployerContribution = optNum(config, "max_employer_contribution", path);
  return {
    employeeRate: num(config, "employee_rate", path),
    employerRate: num(config, "employer_rate", path),
    maxFundSalary: num(config, "max_fund_salary", path),
    ...maxEmployeeContribution === void 0 ? {} : { maxEmployeeContribution },
    ...maxEmployerContribution === void 0 ? {} : { maxEmployerContribution }
  };
}
function parseTaxBrackets(source) {
  return asArray(source.brackets, "bir.brackets").map((entry, i) => {
    const path = `bir.brackets[${i}]`;
    const bracket = asObject(entry, path);
    return {
      over: num(bracket, "over", path),
      upTo: nullableNum(bracket, "up_to", path),
      baseTax: num(bracket, "base_tax", path),
      rate: num(bracket, "rate", path),
      excessOver: num(bracket, "excess_over", path)
    };
  });
}
function parseDeMinimis(source) {
  if (source.de_minimis === void 0) return {};
  const table = asObject(source.de_minimis, "bir.de_minimis");
  const result = {};
  for (const [code, entry] of Object.entries(table)) {
    const path = `bir.de_minimis.${code}`;
    const rule = asObject(entry, path);
    const limitType = str(rule, "limit_type", path);
    if (limitType !== "AMOUNT" && limitType !== "PCT_OF_MIN_WAGE" && limitType !== "DAYS") {
      adapterError(`${path}.limit_type`, `unsupported limit_type '${limitType}'`);
    }
    const limit = optNum(rule, "limit", path);
    const pct = optNum(rule, "pct", path);
    const pool = optStr(rule, "pool", path);
    result[code] = {
      limitType,
      period: str(rule, "period", path),
      ...limit === void 0 ? {} : { limit },
      ...pct === void 0 ? {} : { pct },
      ...pool === void 0 ? {} : { pool }
    };
  }
  return result;
}
function parseOtherBenefitsCap(source) {
  if (source.other_benefits_cap === void 0) return void 0;
  const path = "bir.other_benefits_cap";
  const cap = asObject(source.other_benefits_cap, path);
  const treatment = str(cap, "de_minimis_excess_treatment", path);
  if (treatment !== "ADD_TO_OTHER_BENEFITS" && treatment !== "TAXABLE") {
    adapterError(`${path}.de_minimis_excess_treatment`, `unsupported treatment '${treatment}'`);
  }
  return {
    annualAmount: num(cap, "annual_amount", path),
    covers: asArray(cap.covers, `${path}.covers`).map((value, i) => {
      if (typeof value !== "string") adapterError(`${path}.covers[${i}]`, "expected a string");
      return value;
    }),
    deMinimisExcessTreatment: treatment
  };
}
function deepFreeze(value) {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
function laborRulesFromConfig(raw) {
  const config = asObject(raw, "labor");
  const frequencyTable = asObject(config.pay_frequencies, "labor.pay_frequencies");
  const payFrequencies = {};
  for (const key of ["WEEKLY", "BI_WEEKLY", "SEMI_MONTHLY", "MONTHLY"]) {
    const path = `labor.pay_frequencies.${key}`;
    payFrequencies[key] = { periodsPerYear: num(asObject(frequencyTable[key], path), "periods_per_year", path) };
  }
  const premiums = {};
  for (const [code, entry] of Object.entries(asObject(config.premiums, "labor.premiums"))) {
    const path = `labor.premiums.${code}`;
    const premium = asObject(entry, path);
    const category = str(premium, "category", path);
    if (category !== "OVERTIME" && category !== "HOLIDAY_PAY") adapterError(`${path}.category`, `unsupported category '${category}'`);
    const monthlyPaidMultiplier = optNum(premium, "monthly_paid_multiplier", path);
    premiums[code] = {
      code,
      name: str(premium, "name", path),
      category,
      multiplier: num(premium, "multiplier", path),
      ...monthlyPaidMultiplier === void 0 ? {} : { monthlyPaidMultiplier }
    };
  }
  const mwe = asObject(config.mwe, "labor.mwe");
  return {
    payFrequencies,
    premiums,
    nightDifferential: { rate: num(asObject(config.night_differential, "labor.night_differential"), "rate", "labor.night_differential") },
    mweExemptCategories: asArray(mwe.exempt_categories, "labor.mwe.exempt_categories").map((value, i) => {
      if (typeof value !== "string") adapterError(`labor.mwe.exempt_categories[${i}]`, "expected a string");
      return value;
    })
  };
}
function buildRuleSetSnapshot(rows, labor) {
  const birConfig = asObject(rows.bir, "bir");
  const period = str(birConfig, "period", "bir");
  if (!(period in labor.payFrequencies)) adapterError("bir.period", `'${period}' is not a known pay frequency`);
  const cap = parseOtherBenefitsCap(birConfig);
  const snapshot = {
    versionId: rows.versionId,
    rounding: parseRounding(birConfig, "bir"),
    payFrequencies: labor.payFrequencies,
    premiums: labor.premiums,
    nightDifferential: labor.nightDifferential,
    sss: parseSss(rows.sss),
    philhealth: parsePhilHealth(rows.philhealth),
    pagibig: parsePagibig(rows.pagibig),
    bir: {
      period,
      brackets: parseTaxBrackets(birConfig),
      deMinimis: parseDeMinimis(birConfig),
      ...cap === void 0 ? {} : { otherBenefitsCap: cap },
      mwe: { exemptCategories: labor.mweExemptCategories }
    }
  };
  return deepFreeze(snapshot);
}

// ../_shared/payroll/compute.ts
var EARNING_CATS = /* @__PURE__ */ new Set(["BASIC", "OVERTIME", "HOLIDAY_PAY", "NIGHT_DIFFERENTIAL", "HAZARD_PAY", "ALLOWANCE", "THIRTEENTH_MONTH", "BONUS", "OTHER_BENEFITS", "COMMISSION", "LEAVE_CONVERSION", "ADJUSTMENT", "OTHER", "REIMBURSEMENT"]);
var num2 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
var iso = (d) => d.toISOString().slice(0, 10);
var addDays = (s, n) => {
  const d = /* @__PURE__ */ new Date(s + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
function buildRuleSet(rules) {
  const labor = laborRulesFromConfig(rules.labor.config);
  return buildRuleSetSnapshot({
    versionId: ["sss", "philhealth", "pagibig", "bir", "labor"].map((k) => rules[k].label || rules[k].id).join(" \xB7 "),
    sss: rules.sss.config,
    philhealth: rules.philhealth.config,
    pagibig: rules.pagibig.config,
    bir: rules.bir.config
  }, labor);
}
function periodPosition(freq, start, end) {
  if (freq === "MONTHLY") return { index: 1, count: 1 };
  if (freq === "SEMI_MONTHLY") return { index: Number(start.slice(8, 10)) <= 15 ? 1 : 2, count: 2 };
  const step = freq === "WEEKLY" ? 7 : 14, month = end.slice(0, 7);
  let index = 1, count = 1;
  for (let d = addDays(end, -step); d.slice(0, 7) === month; d = addDays(d, -step)) {
    index++;
    count++;
  }
  for (let d = addDays(end, step); d.slice(0, 7) === month; d = addDays(d, step)) count++;
  return { index, count };
}
function windowStart(period, end) {
  const y = end.slice(0, 4), m = Number(end.slice(5, 7));
  if (period === "MONTH") return end.slice(0, 8) + "01";
  if (period === "YEAR") return y + "-01-01";
  if (period === "SEMESTER") return y + (m <= 6 ? "-01-01" : "-07-01");
  return null;
}
function buildInput(inp, emp, ruleSet) {
  const per = inp.period, e = emp.employee, t = emp.totals || {};
  const freq = per.pay_frequency;
  const hpd = num2(e.hours_per_day) || 8;
  const pos = periodPosition(freq, per.period_start, per.period_end);
  const timing = inp.settings?.contribution_timing === "FIRST_CUTOFF" ? { mode: "FULL_ON_PERIOD", periodNumber: 1 } : inp.settings?.contribution_timing === "LAST_CUTOFF" ? { mode: "FULL_ON_PERIOD", periodNumber: pos.count } : { mode: "SPLIT_EQUAL" };
  const monthly = e.rate_type === "MONTHLY";
  const paidDays = num2(t.days_paid_leave) + num2(t.unworked_regular_holidays);
  const regularHours = monthly ? 0 : num2(t.regular_hours) + paidDays * hpd;
  const premiumHours = [];
  for (const src of [t.premium_hours || {}, t.ot_hours || {}]) {
    for (const [code, h] of Object.entries(src)) {
      if (num2(h) <= 0) continue;
      if (!ruleSet.premiums[code]) throw new Error(`Labor premium ${code} isn't in the published Labor Premiums rule.`);
      premiumHours.push({ premiumCode: code, hours: num2(h) });
    }
  }
  const nightDifferentialHours = Object.entries(t.nd_hours || {}).filter(([, h]) => num2(h) > 0).map(([code, h]) => code ? { hours: num2(h), appliesToPremiumCode: code } : { hours: num2(h) });
  const earning = (r) => {
    const cat = String(r.category || "ALLOWANCE").toUpperCase();
    return {
      code: r.code,
      name: r.name,
      category: EARNING_CATS.has(cat) ? cat === "REIMBURSEMENT" ? "OTHER" : cat : "OTHER",
      ...cat === "REIMBURSEMENT" || !EARNING_CATS.has(cat) ? { customCategory: cat } : {},
      amount: num2(r.amount),
      ...r.quantity != null ? { quantity: num2(r.quantity) } : {},
      isTaxable: !!r.is_taxable,
      isDeMinimis: !!r.is_de_minimis,
      ...r.is_de_minimis && r.de_minimis_code ? { deMinimisCode: String(r.de_minimis_code) } : {}
    };
  };
  const deduction = (r) => ({
    code: r.code,
    name: r.name,
    category: String(r.category || "OTHER").toUpperCase(),
    amount: r.balance != null ? Math.min(num2(r.amount), num2(r.balance)) : num2(r.amount),
    ...r.priority != null ? { priority: num2(r.priority) } : {},
    allowPartial: r.allow_partial !== false,
    isTaxable: false,
    isDeMinimis: false
  });
  const hist = emp.history || [];
  const month = String(per.period_end).slice(0, 7);
  const mtd = hist.filter((h) => String(h.period_end).slice(0, 7) === month && h.pay_frequency === freq);
  const usage = {};
  for (const [code, rule] of Object.entries(ruleSet.bir.deMinimis)) {
    const key = rule.pool ?? code;
    const from = windowStart(rule.period, per.period_end);
    if (!from || key in usage) continue;
    usage[key] = hist.filter((h) => h.period_end >= from).reduce((a, h) => a + num2(h.carry_forward?.deMinimisUsage?.[key]), 0);
  }
  return {
    ruleSet,
    employee: {
      employeeId: emp.profile_id,
      isMinimumWageEarner: !!e.is_mwe,
      ...e.regional_min_daily_wage != null ? { regionalMinimumDailyWage: num2(e.regional_min_daily_wage) } : {},
      compensation: { rateType: e.rate_type, baseRate: num2(e.base_rate), workingDaysPerYear: num2(e.working_days_per_year), hoursPerDay: hpd }
    },
    payFrequency: freq,
    period: { periodStart: per.period_start, periodEnd: per.period_end, periodIndexInMonth: pos.index, periodsInMonth: pos.count },
    attendance: {
      regularHours,
      absentDays: monthly ? num2(t.days_absent) + num2(t.days_unpaid_leave) : 0,
      lateUndertimeHours: monthly ? num2(t.late_hours) + num2(t.undertime_hours) : 0,
      premiumHours,
      nightDifferentialHours
    },
    recurringEarnings: emp.recurring.filter((r) => r.kind === "earning").map(earning),
    oneOffEarnings: emp.adjustments.filter((r) => r.kind === "earning").map(earning),
    recurringDeductions: emp.recurring.filter((r) => r.kind === "deduction").map(deduction),
    oneOffDeductions: emp.adjustments.filter((r) => r.kind === "deduction").map(deduction),
    statutory: {
      sss: { enabled: !!e.sss_enabled, timing },
      philhealth: { enabled: !!e.philhealth_enabled, timing },
      pagibig: { enabled: !!e.pagibig_enabled, timing },
      withholdingTax: { enabled: !!e.tax_enabled }
    },
    monthToDate: {
      taxableIncome: mtd.reduce((a, h) => a + num2(h.taxable_income), 0),
      withholdingTax: mtd.reduce((a, h) => a + num2(h.withholding_tax), 0)
    },
    yearToDate: { otherBenefitsUsed: hist.reduce((a, h) => a + num2(h.carry_forward?.otherBenefitsAdded), 0) },
    deMinimisWindowUsage: usage,
    minimumNetPay: num2(inp.settings?.minimum_net_pay)
  };
}
function computeRun(inp) {
  const ruleSet = buildRuleSet(inp.rules);
  const out = { lines: [], errors: [], ruleIds: {} };
  for (const k of Object.keys(inp.rules)) out.ruleIds[k] = { id: inp.rules[k].id, label: inp.rules[k].label };
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

// index.ts
var ALLOWED_ORIGINS = ["https://awesmanila-rgb.github.io", "http://localhost:8000", "http://127.0.0.1:8000"];
function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin"
  };
}
Deno.serve(async (req) => {
  const h = cors(req.headers.get("origin"));
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...h, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });
  if (req.method !== "POST") return reply({ error: "POST only" }, 405);
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return reply({ error: "Sign in again.", code: "no_auth" }, 401);
  let runId = "";
  try {
    runId = String((await req.json()).runId || "");
  } catch {
  }
  if (!/^[0-9a-f-]{36}$/i.test(runId)) return reply({ error: "Missing pay run." }, 400);
  const asUser = createClient(url, anon, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: me } = await asUser.auth.getUser();
  if (!me?.user) return reply({ error: "Sign in again.", code: "no_auth" }, 401);
  const { data: inputs, error: inErr } = await asUser.rpc("payroll_run_inputs", { p_run: runId });
  if (inErr) return reply({ error: inErr.message, code: inErr.code === "42501" ? "forbidden" : "inputs" }, inErr.code === "42501" ? 403 : 400);
  let outcome;
  try {
    outcome = computeRun(inputs);
  } catch (e) {
    return reply({ error: "The payroll rules couldn\u2019t be read: " + (e instanceof Error ? e.message : String(e)), code: "rules" }, 400);
  }
  if (outcome.errors.length) {
    return reply({ error: outcome.errors.length + " person(s) couldn\u2019t be computed \u2014 nothing was saved.", code: "people", errors: outcome.errors }, 422);
  }
  const admin = createClient(url, service, { auth: { persistSession: false } });
  const lines = outcome.lines.map((l) => ({ profile_id: l.profile_id, input: l.input, result: l.result }));
  const { error: stErr } = await admin.rpc("payroll_run_store", { p_run: runId, p_lines: lines, p_rules: outcome.ruleIds, p_actor: me.user.id });
  if (stErr) return reply({ error: stErr.message, code: "store" }, 400);
  const totalNet = outcome.lines.reduce((a, l) => a + l.result.totals.netPay, 0);
  return reply({ ok: true, people: lines.length, totalNet: Math.round(totalNet * 100) / 100 });
});
