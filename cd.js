/**
 * Democratic Republic of Congo (CD) — Statutory Payroll Engine
 *
 * Deductions:
 *   1. INSS    — Institut National de Sécurité Sociale
 *                5% employee + 13% employer of pensionable pay (capped)
 *   2. ONEM    — Office National de l'Emploi (employer only)
 *                0.2% of gross — workforce training levy
 *   3. IPR     — Impôt Professionnel sur les Rémunérations (employment income tax)
 *                Graduated bands on taxable pay; standard deduction of 15%
 *                of gross is applied before bands (representing professional
 *                expenses — Code des Impôts art. 48)
 *
 * Sources: Code des Impôts (DRC) — Ordonnance-Loi n° 69-009 as amended;
 * INSS Décret-loi 087-2002; Direction Générale des Impôts (DGI) tariff 2024.
 * Rates verified June 2026. All amounts in CDF (Congolese Franc).
 * USD is frequently used in parallel — convert before passing grossPay.
 */

// INSS is capped at a ceiling salary; where not set nationally, we use the
// full gross. The table carries a ceiling field for when it is gazetted.
const INSS_RATES = [
  {
    effectiveFrom: '2002-01-01',
    employeeRate: 0.05,
    employerRate: 0.13,
    pensionCeiling: Infinity, // apply to full gross until a gazette sets a cap
  },
];

function calcINSS(grossPay, onDate) {
  const r = resolveRate(INSS_RATES, onDate, 'CD INSS');
  const base = Math.min(grossPay, r.pensionCeiling);
  return {
    label: 'INSS',
    employee: r2(base * r.employeeRate),
    employer: r2(base * r.employerRate),
    rateSnapshot: r,
  };
}

const ONEM_RATES = [
  { effectiveFrom: '2002-01-01', employerRate: 0.002 },
];

function calcONEM(grossPay, onDate) {
  const r = resolveRate(ONEM_RATES, onDate, 'CD ONEM');
  return {
    label: 'ONEM',
    employee: 0,
    employer: r2(grossPay * r.employerRate),
    rateSnapshot: r,
  };
}

// IPR — monthly bands in CDF (approximate 2024 gazette values)
// The 15% professional expense deduction is applied by calculate() before
// passing taxablePay here.
const IPR_BANDS = [
  {
    effectiveFrom: '2024-01-01',
    bands: [
      { upTo: 524160,   rate: 0.00 },
      { upTo: 1404360,  rate: 0.15 },
      { upTo: 2748360,  rate: 0.20 },
      { upTo: 4320360,  rate: 0.22 },
      { upTo: 6048360,  rate: 0.24 },
      { upTo: Infinity, rate: 0.30 },
    ],
  },
];

function calcIPR(taxablePay, onDate) {
  const { bands } = resolveRate(IPR_BANDS, onDate, 'CD IPR');
  return {
    label: 'IPR (Impôt Professionnel sur les Rémunérations)',
    taxableIncome: r2(taxablePay),
    employee: r2(applyBands(taxablePay, bands)),
    employer: 0,
  };
}

function calculate(input) {
  const { grossPay, otherDeductions = [], onDate = new Date() } = input;

  const inss = calcINSS(grossPay, onDate);
  const onem = calcONEM(grossPay, onDate);

  // Professional expense deduction (15%) then less INSS employee share
  const professionalExpenseDeduction = r2(grossPay * 0.15);
  const taxablePay = r2(grossPay - professionalExpenseDeduction - inss.employee);
  const ipr = calcIPR(taxablePay, onDate);

  const otherTotal    = r2(otherDeductions.reduce((s, d) => s + (d.amount || 0), 0));
  const totalEmployee = r2(inss.employee + ipr.employee + otherTotal);
  const netPay        = r2(grossPay - totalEmployee);
  const employerCost  = r2(grossPay + inss.employer + onem.employer);

  return {
    country: 'CD',
    currency: 'CDF',
    grossPay,
    professionalExpenseDeduction,
    statutoryDeductions: { inss, onem, ipr },
    otherDeductions,
    otherDeductionsTotal: otherTotal,
    totalEmployeeDeductions: totalEmployee,
    netPay,
    employerCost,
  };
}

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
    const chunk = Math.min(remaining, b.upTo - lower);
    tax += chunk * b.rate;
    remaining -= chunk;
    lower = b.upTo;
  }
  return tax;
}

function r2(v) { return Math.round(v * 100) / 100; }

module.exports = {
  code: 'CD',
  name: 'DR Congo',
  currency: 'CDF',
  currencySymbol: 'CDF',
  calculate,
  calcINSS,
  calcONEM,
  calcIPR,
};
