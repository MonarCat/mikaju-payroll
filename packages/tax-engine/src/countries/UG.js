/**
 * Uganda (UG) — Statutory Payroll Engine
 *
 * Deductions:
 *   1. NSSF  — 5% employee + 10% employer of gross (National Social Security Fund)
 *   2. LST   — Local Service Tax, annual bands paid quarterly in arrears
 *              (withheld by employer and remitted to district/city authority)
 *   3. PAYE  — Graduated monthly bands on gross less NSSF; no standard
 *              personal relief in the same form as Kenya — the zero-rated
 *              band effectively acts as the exemption
 *
 * Sources: Income Tax Act Cap 340 (as amended by Finance Act 2023/24),
 * NSSF Act Cap 222, Local Government Act (LST rates).
 * Rates verified June 2026. UGX rates assume monthly pay unless noted.
 */

// ── NSSF ─────────────────────────────────────────────────────────────────────
const NSSF_RATES = [
  { effectiveFrom: '2000-01-01', employeeRate: 0.05, employerRate: 0.10 },
];

function calcNSSF(grossPay, onDate) {
  const r = resolveRate(NSSF_RATES, onDate, 'UG NSSF');
  return {
    label: 'NSSF',
    employee: r2(grossPay * r.employeeRate),
    employer: r2(grossPay * r.employerRate),
    rateSnapshot: r,
  };
}

// ── Local Service Tax (LST) ───────────────────────────────────────────────────
// Annual income bands; the monthly amount is annual / 12 for simplicity.
// In practice, LST is deducted in Q1 of each financial year (Jul–Sep),
// but spreading monthly gives correct annual totals. Adjust for lump-sum
// deduction in the payroll run wizard if the employer prefers.
const LST_ANNUAL_BANDS = [
  { upTo: 1200000,   annual: 0 },
  { upTo: 3600000,   annual: 25000 },
  { upTo: 4800000,   annual: 50000 },
  { upTo: 6000000,   annual: 75000 },
  { upTo: 12000000,  annual: 100000 },
  { upTo: Infinity,  annual: 100000 },
];

function calcLST(annualGross) {
  const annual = LST_ANNUAL_BANDS.find(b => annualGross <= b.upTo)?.annual ?? 100000;
  return {
    label: 'Local Service Tax (LST)',
    employee: r2(annual / 12),
    employer: 0,
    annualAmount: annual,
  };
}

// ── PAYE ─────────────────────────────────────────────────────────────────────
// Monthly bands in UGX (Finance Act 2023 introduced the 40% top band).
const PAYE_BANDS = [
  {
    effectiveFrom: '2023-07-01',
    bands: [
      { upTo: 335000,    rate: 0.00 },
      { upTo: 410000,    rate: 0.10 },
      { upTo: 10000000,  rate: 0.20 },
      { upTo: Infinity,  rate: 0.40 },
    ],
  },
];

function calcPAYE(taxablePay, onDate) {
  const { bands } = resolveRate(PAYE_BANDS, onDate, 'UG PAYE');
  return {
    label: 'PAYE',
    taxableIncome: r2(taxablePay),
    employee: r2(applyBands(taxablePay, bands)),
    employer: 0,
  };
}

// ── Unified calculate() ───────────────────────────────────────────────────────
function calculate(input) {
  const {
    grossPay,
    otherDeductions = [],
    onDate = new Date(),
  } = input;

  const nssf = calcNSSF(grossPay, onDate);
  const lst  = calcLST(grossPay * 12);
  const paye = calcPAYE(r2(grossPay - nssf.employee), onDate);

  const otherTotal = r2(otherDeductions.reduce((s, d) => s + (d.amount || 0), 0));
  const totalEmployee = r2(nssf.employee + lst.employee + paye.employee + otherTotal);
  const netPay = r2(grossPay - totalEmployee);
  const employerCost = r2(grossPay + nssf.employer);

  return {
    country: 'UG',
    currency: 'UGX',
    grossPay,
    statutoryDeductions: { nssf, lst, paye },
    otherDeductions,
    otherDeductionsTotal: otherTotal,
    totalEmployeeDeductions: totalEmployee,
    netPay,
    employerCost,
  };
}

function resolveRate(table, onDate = new Date(), label = '') {
  const target = new Date(onDate).toISOString().slice(0, 10);
  const hit = [...table].filter(e => e.effectiveFrom <= target).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0];
  if (!hit) throw new Error(`No ${label} rate covers ${target}`);
  return hit;
}

function applyBands(income, bands) {
  let remaining = income, lower = 0, tax = 0;
  for (const b of bands) {
    if (remaining <= 0) break;
    const chunk = Math.min(remaining, b.upTo - lower);
    tax += chunk * b.rate;
    remaining -= chunk;
    lower = b.upTo;
  }
  return tax;
}

function r2(v) { return Math.round(v * 100) / 100; }

module.exports = {
  code: 'UG', name: 'Uganda', currency: 'UGX', currencySymbol: 'UGX',
  calculate, calcNSSF, calcLST, calcPAYE,
};
