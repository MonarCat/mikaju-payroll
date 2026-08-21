/**
 * Burundi (BI) — Statutory Payroll Engine
 *
 * Deductions:
 *   1. INSS   — 6% employee + 15% employer (Institut National de Sécurité Sociale)
 *   2. PAYE   — Graduated monthly bands on gross less INSS employee share
 *
 * Sources: Code Général des Impôts (Burundi), INSS contribution schedule.
 * Rates verified June 2026. All amounts in BIF.
 */

const INSS_RATES = [
  { effectiveFrom: '2000-01-01', employeeRate: 0.06, employerRate: 0.15 },
];

function calcINSS(grossPay, onDate) {
  const r = resolveRate(INSS_RATES, onDate, 'BI INSS');
  return {
    label: 'INSS',
    employee: r2(grossPay * r.employeeRate),
    employer: r2(grossPay * r.employerRate),
    rateSnapshot: r,
  };
}

// Monthly PAYE bands in BIF
const PAYE_BANDS = [
  {
    effectiveFrom: '2015-01-01',
    bands: [
      { upTo: 150000,   rate: 0.00 },
      { upTo: 600000,   rate: 0.20 },
      { upTo: 1200000,  rate: 0.25 },
      { upTo: Infinity, rate: 0.30 },
    ],
  },
];

function calcPAYE(taxablePay, onDate) {
  const { bands } = resolveRate(PAYE_BANDS, onDate, 'BI PAYE');
  return { label: 'PAYE', taxableIncome: r2(taxablePay), employee: r2(applyBands(taxablePay, bands)), employer: 0 };
}

function calculate(input) {
  const { grossPay, otherDeductions = [], onDate = new Date() } = input;
  const inss = calcINSS(grossPay, onDate);
  const paye = calcPAYE(r2(grossPay - inss.employee), onDate);
  const otherTotal = r2(otherDeductions.reduce((s, d) => s + (d.amount || 0), 0));
  const totalEmployee = r2(inss.employee + paye.employee + otherTotal);
  return {
    country: 'BI', currency: 'BIF', grossPay,
    statutoryDeductions: { inss, paye },
    otherDeductions, otherDeductionsTotal: otherTotal,
    totalEmployeeDeductions: totalEmployee,
    netPay: r2(grossPay - totalEmployee),
    employerCost: r2(grossPay + inss.employer),
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
  for (const b of bands) { if (remaining <= 0) break; const chunk = Math.min(remaining, b.upTo - lower); tax += chunk * b.rate; remaining -= chunk; lower = b.upTo; }
  return tax;
}
function r2(v) { return Math.round(v * 100) / 100; }

module.exports = { code: 'BI', name: 'Burundi', currency: 'BIF', currencySymbol: 'BIF', calculate, calcINSS, calcPAYE };
