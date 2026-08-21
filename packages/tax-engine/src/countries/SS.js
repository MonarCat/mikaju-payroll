/**
 * South Sudan (SS) — Statutory Payroll Engine
 *
 * Deductions:
 *   1. SSPS  — Social Security: 8% employee + 17% employer
 *             (South Sudan Pension & Social Security Act 2012)
 *   2. PAYE  — Graduated monthly bands on gross less SSPS employee
 *
 * Sources: Taxation Act 2009 (as amended), SSPS Act 2012.
 * Rates verified June 2026. All amounts in SSP.
 *
 * NOTE: South Sudan's tax environment has seen frequent regulatory changes.
 * Always cross-check with the National Revenue Authority (NRA) before
 * processing a live payroll run, and update PAYE_BANDS below accordingly.
 */

const SSPS_RATES = [
  { effectiveFrom: '2012-01-01', employeeRate: 0.08, employerRate: 0.17 },
];

function calcSSPS(grossPay, onDate) {
  const r = resolveRate(SSPS_RATES, onDate, 'SS SSPS');
  return {
    label: 'SSPS (Social Security)',
    employee: r2(grossPay * r.employeeRate),
    employer: r2(grossPay * r.employerRate),
    rateSnapshot: r,
  };
}

// Monthly PAYE bands in SSP
const PAYE_BANDS = [
  {
    effectiveFrom: '2009-01-01',
    bands: [
      { upTo: 5000,     rate: 0.00 },
      { upTo: 10000,    rate: 0.10 },
      { upTo: 20000,    rate: 0.15 },
      { upTo: 40000,    rate: 0.20 },
      { upTo: Infinity, rate: 0.25 },
    ],
  },
];

function calcPAYE(taxablePay, onDate) {
  const { bands } = resolveRate(PAYE_BANDS, onDate, 'SS PAYE');
  return { label: 'PAYE', taxableIncome: r2(taxablePay), employee: r2(applyBands(taxablePay, bands)), employer: 0 };
}

function calculate(input) {
  const { grossPay, otherDeductions = [], onDate = new Date() } = input;
  const ssps = calcSSPS(grossPay, onDate);
  const paye = calcPAYE(r2(grossPay - ssps.employee), onDate);
  const otherTotal = r2(otherDeductions.reduce((s, d) => s + (d.amount || 0), 0));
  const totalEmployee = r2(ssps.employee + paye.employee + otherTotal);
  return {
    country: 'SS', currency: 'SSP', grossPay,
    statutoryDeductions: { ssps, paye },
    otherDeductions, otherDeductionsTotal: otherTotal,
    totalEmployeeDeductions: totalEmployee,
    netPay: r2(grossPay - totalEmployee),
    employerCost: r2(grossPay + ssps.employer),
  };
}

function resolveRate(table, onDate = new Date(), label = '') {
  const target = new Date(onDate).toISOString().slice(0, 10);
  const hit = [...table].filter(e => e.effectiveFrom <= target).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0];
  if (!hit) throw new Error(`No ${label} rate covers ${target}`); return hit;
}
function applyBands(income, bands) {
  let remaining = income, lower = 0, tax = 0;
  for (const b of bands) { if (remaining <= 0) break; const chunk = Math.min(remaining, b.upTo - lower); tax += chunk * b.rate; remaining -= chunk; lower = b.upTo; } return tax;
}
function r2(v) { return Math.round(v * 100) / 100; }

module.exports = { code: 'SS', name: 'South Sudan', currency: 'SSP', currencySymbol: 'SSP', calculate, calcSSPS, calcPAYE };
