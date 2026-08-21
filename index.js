/**
 * Mikaju Tax Engine — Country Registry
 *
 * This is the only file the rest of the app (Electron IPC handlers, payroll
 * run wizard, payslip PDF generator) should import. It:
 *   1. Registers all supported country modules.
 *   2. Exposes COUNTRIES — the list the country-selection onboarding screen
 *      renders (code, name, currency, flag emoji).
 *   3. Exports calculatePayroll(input, countryCode) — the single entry point
 *      for every payroll calculation in the product.
 *
 * Adding a new country = drop a new module in ./countries/, add one line to
 * REGISTRY below, done.
 */

const KE = require('./countries/KE');
const UG = require('./countries/UG');
const TZ = require('./countries/TZ');
const RW = require('./countries/RW');
const BI = require('./countries/BI');
const SS = require('./countries/SS');
const SO = require('./countries/SO');
const CD = require('./countries/CD');
const ET = require('./countries/ET');

// Keyed by ISO 3166-1 alpha-2 code.
const REGISTRY = { KE, UG, TZ, RW, BI, SS, SO, CD, ET };

/**
 * The ordered list rendered by the country-selection onboarding screen.
 * Flag emojis are Unicode regional indicator pairs — no image assets needed.
 */
const COUNTRIES = [
  { code: 'KE', name: 'Kenya',                  flag: '🇰🇪', currency: 'KES' },
  { code: 'UG', name: 'Uganda',                 flag: '🇺🇬', currency: 'UGX' },
  { code: 'TZ', name: 'Tanzania',               flag: '🇹🇿', currency: 'TZS' },
  { code: 'RW', name: 'Rwanda',                 flag: '🇷🇼', currency: 'RWF' },
  { code: 'BI', name: 'Burundi',                flag: '🇧🇮', currency: 'BIF' },
  { code: 'SS', name: 'South Sudan',            flag: '🇸🇸', currency: 'SSP' },
  { code: 'SO', name: 'Somalia',                flag: '🇸🇴', currency: 'SOS' },
  { code: 'CD', name: 'DR Congo',               flag: '🇨🇩', currency: 'CDF' },
  { code: 'ET', name: 'Ethiopia',               flag: '🇪🇹', currency: 'ETB' },
];

/**
 * Runs a full statutory payroll calculation for a single employee in a
 * single pay period, using the correct country module.
 *
 * @param {object} input  - See individual country modules for accepted fields.
 *   Required: grossPay {number}
 *   Common optional: pensionablePay, otherDeductions, onDate
 *   Country-specific optional: isPWD (KE), insurancePremium (KE),
 *     employmentSector (ET)
 * @param {string} countryCode - ISO 3166-1 alpha-2 (e.g. 'KE', 'UG')
 * @returns {object} Full payslip breakdown — structure varies by country but
 *   always includes: country, currency, grossPay, statutoryDeductions,
 *   otherDeductions, totalEmployeeDeductions, netPay, employerCost.
 */
function calculatePayroll(input, countryCode) {
  const module = REGISTRY[countryCode?.toUpperCase()];
  if (!module) {
    throw new Error(
      `Country "${countryCode}" is not supported. Supported codes: ${Object.keys(REGISTRY).join(', ')}`
    );
  }
  return module.calculate(input);
}

/**
 * Returns the country module directly for cases where you need access to
 * individual statutory functions (e.g. a standalone PAYE calculator on the
 * salarycalculator.co.ke redirect page).
 * @param {string} countryCode
 */
function getCountryModule(countryCode) {
  const module = REGISTRY[countryCode?.toUpperCase()];
  if (!module) throw new Error(`Country "${countryCode}" is not supported.`);
  return module;
}

module.exports = { calculatePayroll, getCountryModule, COUNTRIES, REGISTRY };
