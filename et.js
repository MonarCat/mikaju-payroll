/**
 * Ethiopia (ET) — Statutory Payroll Engine
 *
 * Deductions:
 *   1. Pension — 7% employee + 11% employer (private sector, Proclamation 715/2011)
 *   2. PAYE   — Graduated monthly bands; no standard personal relief outside
 *               the zero-rate band
 *
 * Sources: Income Tax Proclamation 979/2016 (as amended), Private Organization
 * Employees' Pension Proclamation 715/2011.
 * Rates verified June 2026. All amounts in ETB.
 *
 * NOTE: Public sector employees use different pension rates (6% employee +
 * 25% employer). Set employmentSector: 'public' in input to apply those.
 */

const PENSION_RATES = [
  {
    effectiveFrom: '2011-01-01',
    private:  { employeeRate: 0.07, employerRate: 0.11 },
    public:   { employeeRate: 0.06, employerRate: 0.25 },
  },
];

function calcPension(grossPay, sector = 'private', onDate) {
  const entry = resolveRate(PENSION_RATES, onDate, 'ET Pension');
  const r = entry[sector] ?? entry.private;
  return {
    label: 'Pension',
    employee: r2(grossPay * r.employeeRate),
    employer: r2(grossPay * r.employerRate),
    rateSnapshot: r,
  };
}

// Monthly PAYE bands in ETB
const PAYE_BANDS = [
  {
    effectiveFrom: '2016-07-08',
    bands: [
      { upTo: 600,      rate: 0.00 },
      { upTo: 1650,     rate: 0.10 },
      { upTo: 3200,     rate: 0.15 },
      { upTo: 5250,     rate: 0.20 },
      { upTo: 7800,     rate: 0.25 },
      { upTo: 10900,    rate: 0.30 },
      { upTo: Infinity, rate: 0.35 },
    ],
  },
];

function calcPAYE(taxablePay, onDate) {
  const { bands } = resolveRate(PAYE_BANDS, onDate, 'ET PAYE');
  return {
    label: 'PAYE (Employment Income Tax)',
    taxableIncome: r2(taxablePay),
    employee: r2(applyBands(taxablePay, bands)),
    employer: 0,
  };
}

function calculate(input) {
  const { grossPay, employmentSector = 'private', otherDeductions = [], onDate = new Date() } = input;

  const pension = calcPension(grossPay, employmentSector, onDate);
  const paye    = calcPAYE(r2(grossPay - pension.employee), onDate);

  const otherTotal = r2(otherDeductions.reduce((s, d) => s + (d.amount || 0), 0));
  const totalEmployee = r2(pension.employee + paye.employee + otherTotal);
  const netPay = r2(grossPay - totalEmployee);
  const employerCost = r2(grossPay + pension.employer);

  return {
    country: 'ET', currency: 'ETB', grossPay,
    statutoryDeductions: { pension, paye },
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

module.exports = { code: 'ET', name: 'Ethiopia', currency: 'ETB', currencySymbol: 'ETB', calculate, calcPension, calcPAYE };
