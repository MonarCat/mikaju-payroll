/**
 * Tanzania (TZ) — Statutory Payroll Engine
 *
 * Deductions:
 *   1. NSSF  — 10% employee + 10% employer (National Social Security Fund)
 *   2. SDL   — Skills Development Levy, 4% of gross payroll (employer only)
 *   3. WCF   — Workers' Compensation Fund, 0.5% (employer only)
 *   4. PAYE  — Graduated monthly bands on gross less NSSF employee share
 *
 * Sources: Income Tax Act Cap 332 (TRA), NSSF Act 1997 as amended,
 * Vocational Education and Training Act (SDL), Workers' Compensation Act 2008.
 * Rates verified June 2026. All amounts in TZS.
 */

const NSSF_RATES = [
  { effectiveFrom: '2000-01-01', employeeRate: 0.10, employerRate: 0.10 },
];

function calcNSSF(grossPay, onDate) {
  const r = resolveRate(NSSF_RATES, onDate, 'TZ NSSF');
  return {
    label: 'NSSF',
    employee: r2(grossPay * r.employeeRate),
    employer: r2(grossPay * r.employerRate),
    rateSnapshot: r,
  };
}

const SDL_RATES = [
  { effectiveFrom: '2000-01-01', employerRate: 0.04 },
];

function calcSDL(grossPay, onDate) {
  const r = resolveRate(SDL_RATES, onDate, 'TZ SDL');
  return {
    label: 'Skills Development Levy (SDL)',
    employee: 0,
    employer: r2(grossPay * r.employerRate),
    rateSnapshot: r,
  };
}

const WCF_RATES = [
  { effectiveFrom: '2000-01-01', employerRate: 0.005 },
];

function calcWCF(grossPay, onDate) {
  const r = resolveRate(WCF_RATES, onDate, 'TZ WCF');
  return {
    label: "Workers' Compensation Fund (WCF)",
    employee: 0,
    employer: r2(grossPay * r.employerRate),
    rateSnapshot: r,
  };
}

// Monthly PAYE bands in TZS
const PAYE_BANDS = [
  {
    effectiveFrom: '2023-07-01',
    bands: [
      { upTo: 270000,    rate: 0.00 },
      { upTo: 520000,    rate: 0.09 },
      { upTo: 760000,    rate: 0.20 },
      { upTo: 1000000,   rate: 0.25 },
      { upTo: Infinity,  rate: 0.30 },
    ],
  },
];

function calcPAYE(taxablePay, onDate) {
  const { bands } = resolveRate(PAYE_BANDS, onDate, 'TZ PAYE');
  return {
    label: 'PAYE',
    taxableIncome: r2(taxablePay),
    employee: r2(applyBands(taxablePay, bands)),
    employer: 0,
  };
}

function calculate(input) {
  const { grossPay, otherDeductions = [], onDate = new Date() } = input;

  const nssf = calcNSSF(grossPay, onDate);
  const sdl  = calcSDL(grossPay, onDate);
  const wcf  = calcWCF(grossPay, onDate);
  const paye = calcPAYE(r2(grossPay - nssf.employee), onDate);

  const otherTotal = r2(otherDeductions.reduce((s, d) => s + (d.amount || 0), 0));
  const totalEmployee = r2(nssf.employee + paye.employee + otherTotal);
  const netPay = r2(grossPay - totalEmployee);
  const employerCost = r2(grossPay + nssf.employer + sdl.employer + wcf.employer);

  return {
    country: 'TZ', currency: 'TZS', grossPay,
    statutoryDeductions: { nssf, sdl, wcf, paye },
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

module.exports = { code: 'TZ', name: 'Tanzania', currency: 'TZS', currencySymbol: 'TZS', calculate, calcNSSF, calcSDL, calcWCF, calcPAYE };
