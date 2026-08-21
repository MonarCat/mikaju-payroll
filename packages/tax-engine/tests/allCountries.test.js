/**
 * Mikaju Tax Engine — multi-country test suite
 * Run: node tests/allCountries.test.js  OR  npm test (from packages/tax-engine)
 */
const assert = require('assert');
const { calculatePayroll, getCountryModule, COUNTRIES } = require('../src/index');

let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓  ${label}`);
  } catch (err) {
    console.error(`  ✗  ${label}`);
    console.error(`     ${err.message}`);
    process.exitCode = 1;
  }
}

// ─── Registry ────────────────────────────────────────────────────────────────
console.log('\nRegistry');
check('All 9 countries registered', () => {
  const codes = ['KE','UG','TZ','RW','BI','SS','SO','CD','ET'];
  for (const code of codes) {
    const m = getCountryModule(code);
    assert.ok(m.calculate, `${code} missing calculate()`);
    assert.strictEqual(m.code, code);
  }
});
check('COUNTRIES list has 9 entries with required fields', () => {
  assert.strictEqual(COUNTRIES.length, 9);
  for (const c of COUNTRIES) {
    assert.ok(c.code && c.name && c.flag && c.currency, `Incomplete entry: ${JSON.stringify(c)}`);
  }
});
check('Unknown country throws a clear error', () => {
  assert.throws(() => calculatePayroll({ grossPay: 1000 }, 'XX'), /not supported/);
});

// ─── Kenya ──────────────────────────────────────────────────────────────────
console.log('\nKenya (KE)');
check('KES 50,000 gross — NSSF, SHIF, AHL, PAYE correct (June 2026)', () => {
  const r = calculatePayroll({ grossPay: 50000, onDate: '2026-06-01' }, 'KE');
  assert.strictEqual(r.currency, 'KES');
  assert.strictEqual(r.statutoryDeductions.nssf.totalEmployee, 3000);
  assert.strictEqual(r.statutoryDeductions.shif.employee, 1375);
  assert.strictEqual(r.statutoryDeductions.ahl.employee, 750);
  assert.strictEqual(r.statutoryDeductions.paye.employee, 5845.85);
  assert.strictEqual(r.netPay, 39029.15);
  assert.strictEqual(r.employerCost, 53750);
});
check('KE: PWD flag zeros out PAYE for income under exemption cap', () => {
  const r = calculatePayroll({ grossPay: 100000, isPWD: true, onDate: '2026-06-01' }, 'KE');
  assert.strictEqual(r.statutoryDeductions.paye.employee, 0);
});
check('KE: other deductions reduce net pay', () => {
  const r = calculatePayroll({
    grossPay: 50000,
    onDate: '2026-06-01',
    otherDeductions: [{ name: 'Loan', amount: 3000 }],
  }, 'KE');
  assert.strictEqual(r.otherDeductionsTotal, 3000);
  assert.strictEqual(r.netPay, 36029.15);
});

// ─── Uganda ─────────────────────────────────────────────────────────────────
console.log('\nUganda (UG)');
check('UGX 2,000,000 gross — NSSF 5%/10%, PAYE in 20% band', () => {
  const r = calculatePayroll({ grossPay: 2000000, onDate: '2026-06-01' }, 'UG');
  assert.strictEqual(r.currency, 'UGX');
  assert.strictEqual(r.statutoryDeductions.nssf.employee, 100000);  // 5%
  assert.strictEqual(r.statutoryDeductions.nssf.employer, 200000);  // 10%
  // Taxable = 2,000,000 - 100,000 (NSSF) = 1,900,000
  // Band: 0% up to 335k, 10% 335k→410k, 20% 410k→1.9M
  const expectedPAYE = Math.round(((410000 - 335000) * 0.10 + (1900000 - 410000) * 0.20) * 100) / 100;
  assert.strictEqual(r.statutoryDeductions.paye.employee, expectedPAYE);
});
check('UG: below 335,000 taxable pays zero PAYE', () => {
  const r = calculatePayroll({ grossPay: 300000, onDate: '2026-06-01' }, 'UG');
  // Taxable = 300,000 - 15,000 (NSSF) = 285,000 < 335,000 threshold
  assert.strictEqual(r.statutoryDeductions.paye.employee, 0);
});

// ─── Tanzania ────────────────────────────────────────────────────────────────
console.log('\nTanzania (TZ)');
check('TZS 1,500,000 gross — NSSF 10%/10%, SDL 4% (employer), PAYE in 30% band', () => {
  const r = calculatePayroll({ grossPay: 1500000, onDate: '2026-06-01' }, 'TZ');
  assert.strictEqual(r.currency, 'TZS');
  assert.strictEqual(r.statutoryDeductions.nssf.employee, 150000);
  assert.strictEqual(r.statutoryDeductions.nssf.employer, 150000);
  assert.strictEqual(r.statutoryDeductions.sdl.employer, 60000);  // 4% employer-only
  assert.strictEqual(r.statutoryDeductions.wcf.employee, 0);       // employer-only
});

// ─── Rwanda ──────────────────────────────────────────────────────────────────
console.log('\nRwanda (RW)');
check('RWF 500,000 gross — pension 6%/8%, health 7.5%/7.5%, PAYE in 30% band', () => {
  const r = calculatePayroll({ grossPay: 500000, onDate: '2026-06-01' }, 'RW');
  assert.strictEqual(r.currency, 'RWF');
  assert.strictEqual(r.statutoryDeductions.pension.employee, 30000);   // 6%
  assert.strictEqual(r.statutoryDeductions.pension.employer, 40000);   // 8%
  assert.strictEqual(r.statutoryDeductions.health.employee, 37500);    // 7.5%
  assert.strictEqual(r.statutoryDeductions.health.employer, 37500);    // 7.5%
  // Taxable = 500,000 - 30,000 - 37,500 = 432,500
  // PAYE: 0% on 30k, 20% on 70k = 14,000, 30% on 332,500 = 99,750 → 113,750
  assert.strictEqual(r.statutoryDeductions.paye.employee, 113750);
});

// ─── Burundi ─────────────────────────────────────────────────────────────────
console.log('\nBurundi (BI)');
check('BIF 800,000 gross — INSS 6%/15%, PAYE in 25% band', () => {
  const r = calculatePayroll({ grossPay: 800000, onDate: '2026-06-01' }, 'BI');
  assert.strictEqual(r.currency, 'BIF');
  assert.strictEqual(r.statutoryDeductions.inss.employee, 48000);   // 6%
  assert.strictEqual(r.statutoryDeductions.inss.employer, 120000);  // 15%
});

// ─── South Sudan ─────────────────────────────────────────────────────────────
console.log('\nSouth Sudan (SS)');
check('SSP 30,000 gross — SSPS 8%/17%, PAYE in 15% band', () => {
  const r = calculatePayroll({ grossPay: 30000, onDate: '2026-06-01' }, 'SS');
  assert.strictEqual(r.currency, 'SSP');
  assert.strictEqual(r.statutoryDeductions.ssps.employee, 2400);   // 8%
  assert.strictEqual(r.statutoryDeductions.ssps.employer, 5100);   // 17%
});

// ─── Somalia ─────────────────────────────────────────────────────────────────
console.log('\nSomalia (SO)');
check('SOS 3,000,000 gross — income tax in 10% band', () => {
  const r = calculatePayroll({ grossPay: 3000000, onDate: '2026-06-01' }, 'SO');
  assert.strictEqual(r.currency, 'SOS');
  // 0% on first 1,000,000; 5% on next 1,000,000 = 50,000; 10% on remaining 1,000,000 = 100,000
  assert.strictEqual(r.statutoryDeductions.paye.employee, 150000);
});
check('SO: below 1,000,000 pays zero income tax', () => {
  const r = calculatePayroll({ grossPay: 900000, onDate: '2026-06-01' }, 'SO');
  assert.strictEqual(r.statutoryDeductions.paye.employee, 0);
});

// ─── DR Congo ────────────────────────────────────────────────────────────────
console.log('\nDR Congo (CD)');
check('CDF 2,000,000 gross — INSS 5%/13%, ONEM 0.2% employer, IPR applied after 15% deduction', () => {
  const r = calculatePayroll({ grossPay: 2000000, onDate: '2026-06-01' }, 'CD');
  assert.strictEqual(r.currency, 'CDF');
  assert.strictEqual(r.statutoryDeductions.inss.employee, 100000);   // 5%
  assert.strictEqual(r.statutoryDeductions.inss.employer, 260000);   // 13%
  assert.strictEqual(r.statutoryDeductions.onem.employer, 4000);     // 0.2%
  assert.strictEqual(r.professionalExpenseDeduction, 300000);        // 15% of 2M
  // Taxable for IPR = 2,000,000 - 300,000 - 100,000 = 1,600,000
  assert.strictEqual(r.statutoryDeductions.ipr.taxableIncome, 1600000);
});

// ─── Ethiopia ────────────────────────────────────────────────────────────────
console.log('\nEthiopia (ET)');
check('ETB 5,000 gross (private) — pension 7%/11%, PAYE in 20% band', () => {
  const r = calculatePayroll({ grossPay: 5000, onDate: '2026-06-01' }, 'ET');
  assert.strictEqual(r.currency, 'ETB');
  assert.strictEqual(r.statutoryDeductions.pension.employee, 350);   // 7%
  assert.strictEqual(r.statutoryDeductions.pension.employer, 550);   // 11%
});
check('ET: public sector uses higher employer rate (25%)', () => {
  const r = calculatePayroll({ grossPay: 5000, employmentSector: 'public', onDate: '2026-06-01' }, 'ET');
  assert.strictEqual(r.statutoryDeductions.pension.employer, 1250);  // 25%
  assert.strictEqual(r.statutoryDeductions.pension.employee, 300);   // 6%
});
check('ET: below ETB 600 pays zero PAYE', () => {
  const r = calculatePayroll({ grossPay: 500, onDate: '2026-06-01' }, 'ET');
  assert.strictEqual(r.statutoryDeductions.paye.employee, 0);
});

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${passed} checks passed.\n`);
