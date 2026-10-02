// Payment receipts as PDF (GET /payments/:transactionId/receipt.pdf).
// Everything on a receipt comes from the stored payment row and its repair
// request - never from the client. buildReceipt is pure (tested); the PDF is
// drawn with pdfkit's built-in Helvetica, so money is written "BDT 1,200.00"
// (the standard fonts have no taka sign).
const PDFDocument = require('pdfkit');

const PURPOSE_LABELS = {
    repair: 'Repair payment',
    inspection_fee: 'Inspection fee',
};

function humanize(slug) {
    if (typeof slug !== 'string' || !slug) return '';
    return slug.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function formatAmount(amount, currency) {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) return '-';
    const code = typeof currency === 'string' && currency ? currency.toUpperCase() : 'BDT';
    return `${code} ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(value) {
    const date = value ? new Date(value) : null;
    if (!date || !Number.isFinite(date.getTime())) return '-';
    // Bangladesh time, as customers read it.
    return `${date.toLocaleString('en-GB', {
        timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    })} (Dhaka)`;
}

// { number, paidAt, status, customerEmail, trackingId, device, repair,
//   purpose, technicianName, lines: [{ label, value }], total, method }
function buildReceipt({ payment, repairRequest = null, technicianName = null }) {
    const product = (repairRequest && repairRequest.product) || {};
    const device = [product.brand, product.model].filter(Boolean).join(' ') || humanize(product.categorySlug);
    const repairSlug = repairRequest && ((repairRequest.service && repairRequest.service.repairCategorySlug) || repairRequest.repairCategorySlug);
    const purpose = PURPOSE_LABELS[payment.purpose] || PURPOSE_LABELS.repair;
    const currency = payment.currency || 'BDT';

    const lines = [];
    if (typeof payment.quoteTotal === 'number' && typeof payment.inspectionCredit === 'number' && payment.inspectionCredit > 0) {
        lines.push({ label: 'Repair total', value: formatAmount(payment.quoteTotal, currency) });
        lines.push({ label: 'Inspection fee already paid', value: `- ${formatAmount(payment.inspectionCredit, currency)}` });
    } else {
        lines.push({ label: purpose, value: formatAmount(payment.amount, currency) });
    }

    let status = 'Paid';
    if (payment.refundStatus === 'refunded' || payment.paymentStatus === 'refunded') status = 'Refunded';
    else if (payment.refundStatus) status = 'Paid - refund in progress';

    return {
        number: payment.transactionId || String(payment._id || ''),
        paidAt: formatDate(payment.paidAt),
        status,
        customerEmail: payment.customerEmail || '-',
        trackingId: payment.trackingId || '-',
        device: device || '-',
        repair: humanize(repairSlug) || '-',
        purpose,
        technicianName: technicianName || null,
        lines,
        total: formatAmount(payment.amount, currency),
        method: 'Card (Stripe)',
    };
}

const INK = '#111827';
const MUTED = '#6b7280';
const RULE = '#e5e7eb';
const BRAND = '#0f766e';

// Resolves to the PDF as a Buffer.
function renderReceiptPdf(receipt) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: `Sarabo receipt ${receipt.number}`, Author: 'Sarabo' } });
        const chunks = [];
        doc.on('data', (chunk) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const left = doc.page.margins.left;
        const width = doc.page.width - left - doc.page.margins.right;
        const rule = (gap = 14) => {
            doc.moveDown(0.4);
            doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(1).strokeColor(RULE).stroke();
            doc.y += gap;
        };
        const row = (label, value, { bold = false, size = 10 } = {}) => {
            const y = doc.y;
            doc.font('Helvetica').fontSize(size).fillColor(MUTED).text(label, left, y, { width: width * 0.45 });
            const labelBottom = doc.y;
            doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(INK)
                .text(value, left + width * 0.45, y, { width: width * 0.55, align: 'right' });
            doc.y = Math.max(labelBottom, doc.y) + 6;
        };

        // Header
        doc.font('Helvetica-Bold').fontSize(22).fillColor(BRAND).text('Sarabo', left, doc.y);
        doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('Device repair with pickup and delivery, Bangladesh');
        doc.moveDown(1.2);
        doc.font('Helvetica-Bold').fontSize(16).fillColor(INK).text('Payment receipt');
        doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(`Status: ${receipt.status}`);
        rule();

        row('Receipt number', receipt.number);
        row('Date paid', receipt.paidAt);
        row('Paid by', receipt.customerEmail);
        row('Payment method', receipt.method);
        rule();

        row('Repair tracking ID', receipt.trackingId);
        row('Device', receipt.device);
        row('Repair', receipt.repair);
        if (receipt.technicianName) row('Technician', receipt.technicianName);
        rule();

        receipt.lines.forEach((line) => row(line.label, line.value));
        rule(10);
        row('Amount paid', receipt.total, { bold: true, size: 13 });

        doc.moveDown(2);
        doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(
            'This receipt confirms a payment made through Sarabo. Keep it for your records. '
            + 'Questions about this payment? Contact Sarabo support and quote the receipt number.',
            left, doc.y, { width }
        );
        doc.end();
    });
}

module.exports = { buildReceipt, renderReceiptPdf, formatAmount };
