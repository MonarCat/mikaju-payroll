/**
 * Kenya (KE) — Statutory Payroll Engine
 *
 * Deductions (all pre-tax except PAYE, which is computed after the three below):
 *   1. NSSF  — Tier I/II, 6% each side, versioned LEL/UEL table
 *   2. SHIF  — 2.75% of gross, min KES 300
 *   3. AHL   — Affordable Housing Levy, 1.5% employee + 1.5% employer
 *   4. PAYE  — Graduated bands on (gross - NSSF - SHIF - AHL), personal relief KES 2,400/mo
 *
 * Sources verified June 2026: NSSF Act 2013 (Year 4 phase), Social Health
 * Insurance Act 2023, Affordable Housing Act 2024, Income Tax Act Cap 470
 * as amended by Finance Act 2023 / Tax Laws (Amendment) Act 2024.
 */

// ── NSSF ────────────────────────────────────────────────────────────────────
const NSSF_RATES = [
  { effectiveFrom: '2025-02-01', lel: 8000,  uel: 72000,  rate: 0.06 },
  { effectiveFrom: '2026-02-01', lel: 9000,  uel: 108000, rate: 0.06 },
];

function calcNSSF(pensionablePay, onDate) {
  const r = resolveRate(NSSF_RATES, onDate, 'NSSF');
  const t1Base = Math.min(pensionablePay, r.lel);
  const t2Base = Math.max(0, Math.min(pensionablePay, r.uel) - r.lel);
  const t1Emp = r2(t1Base * r.rate);
  const t2Emp = r2(t2Base * r.rate);
  return {
    label: 'NSSF',
    tier1Employee: t1Emp, tier1Employer: t1Emp,
    tier2Employee: t2Emp, tier2Employer: t2Emp,
    totalEmployee: r2(t1Emp + t2Emp),
    totalEmployer: r2(t1Emp + t2Emp),
    rateSnapshot: r,
  };
}

// ── SHIF ────────────────────────────────────────────────────────────────────
const SHIF_RATES = [
  { effectiveFrom: '2024-10-01', rate: 0.0275, minimum: 300 },
];

function calcSHIF(grossPay, onDate) {
  const r = resolveRate(SHIF_RATES, onDate, 'SHIF');
  return {
    label: 'SHIF',
    employee: r2(Math.max(grossPay * r.rate, r.minimum)),
    employer: 0,
    rateSnapshot: r,
  };
}

// ── Affordable Housing Levy ──────────────────────────────────────────────────
const AHL_RATES = [
  { effectiveFrom: '2024-03-01', employeeRate: 0.015, employerRate: 0.015 },
];

function calcAHL(grossPay, onDate) {
  const r = resolveRate(AHL_RATES, onDate, 'AHL');
  return {
    label: 'Affordable Housing Levy',
    employee: r2(grossPay * r.employeeRate),
    employer: r2(grossPay * r.employerRate),
    rateSnapshot: r,
  };
}

// ── PAYE ────────────────────────────────────────────────────────────────────
const PAYE_BANDS = [
  {
    effectiveFrom: '2024-01-01',
    bands: [
      { upTo: 24000,   rate: 0.10 },
      { upTo: 32333,   rate: 0.25 },
      { upTo: 500000,  rate: 0.30 },
      { upTo: 800000,  rate: 0.325 },
      { upTo: Infinity,rate: 0.35 },
    ],
  },
];

const PAYE_RELIEFS = [
  {
    effectiveFrom: '2024-12-27',
    personalRelief: 2400,
    insuranceReliefRate: 0.15,
    insuranceReliefCap: 5000,
    pwdExemptionCap: 150000,
  },
];

function calcPAYE(taxablePay, { insurancePremium = 0, isPWD = false } = {}, onDate) {
  const bands  = resolveRate(PAYE_BANDS,   onDate, 'PAYE bands');
  const relief = resolveRate(PAYE_RELIEFS, onDate, 'PAYE relief');
  const pwdExemption = isPWD ? Math.min(taxablePay, relief.pwdExemptionCap) : 0;
  const taxable = taxablePay - pwdExemption;
  const gross   = r2(applyBands(taxable, bands.bands));
  const insRelief = r2(Math.min(insurancePremium * relief.insuranceReliefRate, relief.insuranceReliefCap));
  const net = Math.max(0, r2(gross - relief.personalRelief - insRelief));
  return {
    label: 'PAYE',
    taxableIncome: r2(taxable),
    grossTax: gross,
    personalRelief: relief.personalRelief,
    insuranceRelief: insRelief,
    employee: net,
    employer: 0,
    rateSnapshot: { bands, relief },
  };
}

// ── Unified country calculate() ──────────────────────────────────────────────
function calculate(input) {
  const {
    grossPay,
    pensionablePay = grossPay,
    insurancePremium = 0,
    isPWD = false,
    otherDeductions = [],
    onDate = new Date(),
  } = input;

  const nssf = calcNSSF(pensionablePay, onDate);
  const shif = calcSHIF(grossPay, onDate);
  const ahl  = calcAHL(grossPay, onDate);

  const taxablePay = r2(grossPay - nssf.totalEmployee - shif.employee - ahl.employee);
  const paye = calcPAYE(taxablePay, { insurancePremium, isPWD }, onDate);

  const otherTotal = r2(otherDeductions.reduce((s, d) => s + (d.amount || 0), 0));
  const totalEmployee = r2(nssf.totalEmployee + shif.employee + ahl.employee + paye.employee + otherTotal);
  const netPay = r2(grossPay - totalEmployee);
  const employerCost = r2(grossPay + nssf.totalEmployer + ahl.employer);

  return {
    country: 'KE',
    currency: 'KES',
    grossPay,
    statutoryDeductions: { nssf, shif, ahl, paye },
    otherDeductions,
    otherDeductionsTotal: otherTotal,
    totalEmployeeDeductions: totalEmployee,
    netPay,
    employerCost,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function resolveRate(table, onDate = new Date(), label = '') {
  const target = new Date(onDate).toISOString().slice(0, 10);
  const hit = [...table]
    .filter(e => e.effectiveFrom <= target)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0];
  if (!hit) throw new Error(`No ${label} rate covers ${target}`);
  return hit;
}

function applyBands(income, bands) {
  let remaining = income, lower = 0, tax = 0;
  for (const b of bands) {
    if (remaining <= 0) break;
    const width = b.upTo - lower;
    const chunk = Math.min(remaining, width);
    tax += chunk * b.rate;
    remaining -= chunk;
    lower = b.upTo;
  }
  return tax;
}

function r2(v) { return Math.round(v * 100) / 100; }

module.exports = {
  code: 'KE',
  name: 'Kenya',
  currency: 'KES',
  currencySymbol: 'KES',
  calculate,
  // Exposed for direct use (e.g. salarycalculator.co.ke redirect)
  calcNSSF, calcSHIF, calcAHL, calcPAYE,
};
