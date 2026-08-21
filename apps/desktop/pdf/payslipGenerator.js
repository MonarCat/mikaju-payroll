/**
 * Payslip PDF generator — Mikaju Payroll.
 *
 * Takes the frozen breakdown_json from a payslip row (the exact output of
 * calculatePayroll() at the moment the run was calculated — never
 * recalculated here) and renders it to a PDF.
 *
 * Works generically across all 9 country modules without per-country
 * templates. Every country's statutoryDeductions sub-object exposes a
 * `label` and an employee-side amount — under `.employee` for all
 * countries except Kenya's two-tier NSSF, which uses `.totalEmployee`.
 * normalizeDeduction() below is the one place that difference is handled;
 * everything downstream (this file, future annual-form generators) reads
 * a uniform { label, amount } shape and never needs to know which country
 * it's looking at.
 *
 * Watermarking: Free plan gets a diagonal "SAMPLE" watermark on every
 * page; Basic/Enterprise render clean. This is the ONLY place that
 * decision is made — callers just pass the resolved entitlement.plan.
 */
const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const fs = require('fs');

function normalizeDeduction(key, obj) {
  const amount = obj.employee ?? obj.totalEmployee ?? 0;
  return { key, label: obj.label || key.toUpperCase(), amount };
}

function money(n, currency) {
  return `${currency} ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const PAGE_WIDTH = 595.28; // A4 at 72dpi
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;

async function generatePayslipPdf({ company, employee, payslip, plan, periodLabel }) {
  const breakdown = typeof payslip.breakdown_json === 'string'
    ? JSON.parse(payslip.breakdown_json)
    : payslip.breakdown_json;

  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`Payslip — ${employee.full_name} — ${periodLabel}`);
  pdfDoc.setProducer('Mikaju Payroll');

  const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let y = PAGE_HEIGHT - MARGIN;
  const ink = rgb(0.08, 0.12, 0.1);
  const muted = rgb(0.45, 0.52, 0.48);
  const brand = rgb(0.06, 0.42, 0.28);
  const lineColor = rgb(0.85, 0.88, 0.86);

  function text(str, x, size, f, color) {
    page.drawText(str, { x, y, size, font: f || font, color: color || ink });
  }
  function newLine(gap) { y -= gap; }
  function hr() {
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 0.75, color: lineColor });
  }

  // --- Optional logo -------------------------------------------------------
  let headerTextX = MARGIN;
  if (company.logo_path && fs.existsSync(company.logo_path)) {
    try {
      const bytes = fs.readFileSync(company.logo_path);
      const isPng = company.logo_path.toLowerCase().endsWith('.png');
      const img = isPng ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
      const logoHeight = 40;
      const logoWidth = (img.width / img.height) * logoHeight;
      page.drawImage(img, { x: MARGIN, y: y - logoHeight + 10, width: logoWidth, height: logoHeight });
      headerTextX = MARGIN + logoWidth + 16;
    } catch {
      // A corrupt/unreadable logo file should never block payslip
      // generation — the payslip is the important artifact, the logo isn't.
    }
  }

  text(company.name, headerTextX, 18, bold, brand);
  newLine(20);
  text([company.kra_pin ? `Tax PIN: ${company.kra_pin}` : null].filter(Boolean).join('  ·  '), headerTextX, 10, font, muted);
  newLine(28);
  hr();
  newLine(28);

  // --- Title ----------------------------------------------------------------
  text('PAYSLIP', MARGIN, 16, bold, ink);
  text(periodLabel, PAGE_WIDTH - MARGIN - font.widthOfTextAtSize(periodLabel, 11), 11, font, muted);
  newLine(30);

  // --- Employee details -------------------------------------------------------
  const col2 = PAGE_WIDTH / 2 + 10;
  text('Employee', MARGIN, 10, bold, muted);
  text('Details', col2, 10, bold, muted);
  newLine(16);
  text(employee.full_name, MARGIN, 12, bold, ink);
  text(`Country: ${breakdown.country}  ·  Currency: ${breakdown.currency}`, col2, 11, font, ink);
  newLine(16);
  if (employee.national_id) { text(`National ID: ${employee.national_id}`, MARGIN, 10, font, muted); }
  if (employee.bank_name) { text(`Bank: ${employee.bank_name}${employee.bank_account ? ' — ' + employee.bank_account : ''}`, col2, 10, font, muted); }
  newLine(24);
  hr();
  newLine(24);

  // --- Earnings ---------------------------------------------------------------
  text('EARNINGS', MARGIN, 11, bold, ink);
  newLine(18);
  text('Gross pay', MARGIN, 11, font, ink);
  const grossStr = money(breakdown.grossPay, breakdown.currency);
  text(grossStr, PAGE_WIDTH - MARGIN - bold.widthOfTextAtSize(grossStr, 11), 11, bold, ink);
  newLine(26);
  hr();
  newLine(24);

  // --- Statutory deductions (generic across all 9 countries) -----------------
  text('STATUTORY DEDUCTIONS', MARGIN, 11, bold, ink);
  newLine(18);
  const deductions = Object.entries(breakdown.statutoryDeductions || {}).map(([k, v]) => normalizeDeduction(k, v));
  for (const d of deductions) {
    text(d.label, MARGIN, 10, font, ink);
    const amtStr = money(d.amount, breakdown.currency);
    text(amtStr, PAGE_WIDTH - MARGIN - font.widthOfTextAtSize(amtStr, 10), 10, font, ink);
    newLine(16);
  }

  if (breakdown.otherDeductions && breakdown.otherDeductions.length > 0) {
    newLine(4);
    text('OTHER DEDUCTIONS', MARGIN, 11, bold, ink);
    newLine(18);
    for (const d of breakdown.otherDeductions) {
      const label = d.label || d.name || 'Other';
      text(label, MARGIN, 10, font, ink);
      const amtStr = money(d.amount || 0, breakdown.currency);
      text(amtStr, PAGE_WIDTH - MARGIN - font.widthOfTextAtSize(amtStr, 10), 10, font, ink);
      newLine(16);
    }
  }

  newLine(10);
  hr();
  newLine(28);

  // --- Net pay (highlighted) ---------------------------------------------------
  page.drawRectangle({
    x: MARGIN - 8, y: y - 12, width: PAGE_WIDTH - 2 * MARGIN + 16, height: 32,
    color: rgb(0.93, 0.97, 0.95),
  });
  text('NET PAY', MARGIN, 14, bold, brand);
  const netStr = money(breakdown.netPay, breakdown.currency);
  text(netStr, PAGE_WIDTH - MARGIN - bold.widthOfTextAtSize(netStr, 14), 14, bold, brand);
  newLine(48);

  // --- Footer --------------------------------------------------------------
  text(
    'This payslip was generated by Mikaju Payroll. Figures are frozen at the time this payroll run was approved.',
    MARGIN, 8, font, muted
  );

  // --- Watermark (Free plan only) -------------------------------------------
  if (plan === 'free') {
    const watermarkText = 'MIKAJU FREE — SAMPLE';
    const size = 42;
    const textWidth = bold.widthOfTextAtSize(watermarkText, size);
    page.drawText(watermarkText, {
      x: PAGE_WIDTH / 2 - textWidth / 2,
      y: PAGE_HEIGHT / 2,
      size,
      font: bold,
      color: rgb(0.7, 0.75, 0.72),
      opacity: 0.35,
      rotate: degrees(35),
    });
  }

  return pdfDoc.save();
}

module.exports = { generatePayslipPdf };
