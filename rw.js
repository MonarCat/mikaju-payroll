/**
 * Rwanda (RW) — Statutory Payroll Engine
 *
 * Deductions:
 *   1. RSSB Pension  — 6% employee + 8% employer (Rwanda Social Security Board)
 *   2. RSSB Health   — 7.5% employee + 7.5% employer (Community-based + compulsory)
 *   3. PAYE          — Graduated monthly bands on gross less pension + health employee
 *
 * Sources: Income Tax Law No 016/2018 of 13/04/2018 as amended, RSSB
 * contribution rates (pension scheme and health insurance) as at 2026.
 * All amounts in RWF.
 */

const PENSION_RATES = [
  { effectiveFrom: '2018-01-01', employeeRate: 0.06, employerRate: 0.08 },
];

function calcPension(grossPay, onDate) {
  const r = resolveRate(PENSION_RATES, onDate, 'RW Pension');
  return {
    label: 'RSSB Pension',
    employee: r2(grossPay * r.employeeRate),
    employer: r2(grossPay * r.employerRate),
    rateSnapshot: r,
  };
}

const HEALTH_RATES = [
  { effectiveFrom: '2018-01-01', employeeRate: 0.075, employerRate: 0.075 },
];

function calcHealth(grossPay, onDate) {
  const r = resolveRate(HEALTH_RATES, onDate, 'RW Health');
  return {
    label: 'RSSB Health Insurance',
    employee: r2(grossPay * r.employeeRate),
    employer: r2(grossPay * r.employerRate),
    rateSnapshot: r,
  };
}

// Monthly PAYE bands in RWF
const PAYE_BANDS = [
  {
    effectiveFrom: '2018-01-01',
    bands: [
      { upTo: 30000,     rate: 0.00 },
      { upTo: 100000,    rate: 0.20 },
      { upTo: Infinity,  rate: 0.30 },
    ],
  },
];

function calcPAYE(taxablePay, onDate) {
  const { bands } = resolveRate(PAYE_BANDS, onDate, 'RW PAYE');
  return {
    label: 'PAYE',
    taxableIncome: r2(taxablePay),
    employee: r2(applyBands(taxablePay, bands)),
    employer: 0,
  };
}

function calculate(input) {
  const { grossPay, otherDeductions = [], onDate = new Date() } = input;

  const pension = calcPension(grossPay, onDate);
  const health  = calcHealth(grossPay, onDate);
  const taxable = r2(grossPay - pension.employee - health.employee);
  const paye    = calcPAYE(taxable, onDate);

  const otherTotal = r2(otherDeductions.reduce((s, d) => s + (d.amount || 0), 0));
  const totalEmployee = r2(pension.employee + health.employee + paye.employee + otherTotal);
  const netPay = r2(grossPay - totalEmployee);
  const employerCost = r2(grossPay + pension.employer + health.employer);

  return {
    country: 'RW', currency: 'RWF', grossPay,
    statutoryDeductions: { pension, health, paye },
    otherDeductions, otherDeductionsTotal: otherTotal,
    totalEmployeeDeductions: totalEmployee, netPay, employerCost,
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
    tax += chunk * b.rate; remaining -= chunk; lower = b.upTo;
  }
  return tax;
}
function r2(v) { return Math.round(v * 100) / 100; }

module.exports = { code: 'RW', name: 'Rwanda', currency: 'RWF', currencySymbol: 'RWF', calculate, calcPension, calcHealth, calcPAYE };
