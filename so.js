/**
 * Somalia (SO) — Statutory Payroll Engine
 *
 * Deductions:
 *   1. PAYE — Graduated income tax on employment income (Ministry of Finance,
 *             Federal Government of Somalia, Tax Administration Law 2018)
 *   2. Social contributions are not uniformly enforced federally as of 2026;
 *      this module applies the published FGS rates where formalized. Employers
 *      operating in Somaliland or Puntland should override the rate table
 *      entries via the versioned table pattern and add a regional module.
 *
 * Sources: Federal Government of Somalia Tax Administration Law (2018),
 * Ministry of Finance revenue circulars 2023/24.
 * All amounts in SOS (Somali Shilling). USD amounts common in practice —
 * the caller may pass grossPay in USD and set currency: 'USD' in the
 * company record; convert before calling this module.
 *
 * NOTE: Somalia's tax environment is still maturing. Always verify current
 * rates with the MoF before a live payroll run and update the table below.
 */

// Monthly PAYE bands in SOS
const PAYE_BANDS = [
  {
    effectiveFrom: '2018-01-01',
    bands: [
      { upTo: 1000000,  rate: 0.00 },  // ~approx USD 1,750 at 2026 rates — effectively zero band
      { upTo: 2000000,  rate: 0.05 },
      { upTo: 4000000,  rate: 0.10 },
      { upTo: 8000000,  rate: 0.15 },
      { upTo: Infinity, rate: 0.20 },
    ],
  },
];

function calcPAYE(taxablePay, onDate) {
  const { bands } = resolveRate(PAYE_BANDS, onDate, 'SO PAYE');
  return {
    label: 'Income Tax (PAYE)',
    taxableIncome: r2(taxablePay),
    employee: r2(applyBands(taxablePay, bands)),
    employer: 0,
  };
}

// Social contribution — minimal formal rate; placeholder for when FGS
// formalises a national social security scheme. Currently 0% but kept in
// the versioned table so adding rates later is a one-line change.
const SOCIAL_RATES = [
  { effectiveFrom: '2018-01-01', employeeRate: 0.00, employerRate: 0.00 },
];

function calcSocial(grossPay, onDate) {
  const r = resolveRate(SOCIAL_RATES, onDate, 'SO Social');
  return {
    label: 'Social Contribution',
    employee: r2(grossPay * r.employeeRate),
    employer: r2(grossPay * r.employerRate),
    rateSnapshot: r,
  };
}

function calculate(input) {
  const { grossPay, otherDeductions = [], onDate = new Date() } = input;

  const social = calcSocial(grossPay, onDate);
  const paye   = calcPAYE(r2(grossPay - social.employee), onDate);

  const otherTotal    = r2(otherDeductions.reduce((s, d) => s + (d.amount || 0), 0));
  const totalEmployee = r2(social.employee + paye.employee + otherTotal);
  const netPay        = r2(grossPay - totalEmployee);
  const employerCost  = r2(grossPay + social.employer);

  return {
    country: 'SO',
    currency: 'SOS',
    grossPay,
    statutoryDeductions: { social, paye },
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
  code: 'SO',
  name: 'Somalia',
  currency: 'SOS',
  currencySymbol: 'SOS',
  calculate,
  calcPAYE,
  calcSocial,
};
