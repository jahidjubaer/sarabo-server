// Email wording (email-updates phase). Pure: every function returns
// { subject, text, html } from plain values. Anything that came from a user
// (device name, address) is escaped before it goes into HTML. No promises
// about times, prices or outcomes beyond what the request itself says.
const { findSlot } = require('./pickupSlots');

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// "Sunday, 27 September, 10:00 AM – 12:00 PM (Bangladesh time)", or '' with no slot.
function formatPickupForEmail(pickupSlot) {
    if (!pickupSlot || typeof pickupSlot.date !== 'string') return '';
    const date = new Date(`${pickupSlot.date}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return '';
    const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(date);
    const slot = findSlot(pickupSlot.slotId);
    return slot ? `${day}, ${slot.label} (Bangladesh time)` : day;
}

// Device label from the stored product snapshot, e.g. "Samsung A52" or
// "smartphone" - the same rule as the admin notification.
function deviceLabelOf(request) {
    const product = (request && request.product) || {};
    return [product.brand, product.model].filter(Boolean).join(' ').trim()
        || (product.categorySlug ? String(product.categorySlug).replace(/-/g, ' ') : 'your device');
}

// One layout for every email: a heading, short paragraphs, a details list
// and one button. Inline styles only - email clients ignore <style> blocks.
function render({ heading, paragraphs, details = [], action }) {
    const detailRows = details.filter(([, value]) => value);
    const text = [
        heading,
        '',
        ...paragraphs,
        ...(detailRows.length ? ['', ...detailRows.map(([label, value]) => `${label}: ${value}`)] : []),
        ...(action ? ['', `${action.label}: ${action.url}`] : []),
        '',
        '- Sarabo',
    ].join('\n');

    const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f5f5f4;font-family:Arial,Helvetica,sans-serif;color:#1c1917;">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px;">
<p style="margin:0 0 16px;font-size:13px;font-weight:bold;letter-spacing:0.04em;color:#57534e;">SARABO</p>
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;">${escapeHtml(heading)}</h1>
${paragraphs.map((p) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.5;">${escapeHtml(p)}</p>`).join('\n')}
${detailRows.length ? `<table role="presentation" style="width:100%;margin:16px 0;border-collapse:collapse;font-size:14px;">
${detailRows.map(([label, value]) => `<tr><td style="padding:6px 12px 6px 0;color:#57534e;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td><td style="padding:6px 0;font-weight:bold;">${escapeHtml(value)}</td></tr>`).join('\n')}
</table>` : ''}
${action ? `<p style="margin:20px 0 0;"><a href="${escapeHtml(action.url)}" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold;font-size:14px;">${escapeHtml(action.label)}</a></p>` : ''}
</div>
<p style="max-width:560px;margin:12px auto 0;font-size:12px;color:#78716c;text-align:center;">You are receiving this because of a repair request on Sarabo.</p>
</body></html>`;

    return { text, html };
}

function requestReceived({ request, requestUrl }) {
    const device = deviceLabelOf(request);
    const pickup = formatPickupForEmail(request.pickupSlot);
    return {
        subject: `We've received your repair request (${request.trackingId})`,
        ...render({
            heading: 'Your repair request is in',
            paragraphs: [
                `Thanks - we have your request for ${device}.`,
                pickup
                    ? 'We are now matching an approved technician in your area. They will collect the device at the time below.'
                    : 'We are now matching an approved technician in your area.',
            ],
            details: [['Tracking ID', request.trackingId], ['Device', device], ['Pickup', pickup]],
            action: requestUrl ? { label: 'View your request', url: requestUrl } : null,
        }),
    };
}

function pickupChanged({ request, requestUrl }) {
    const device = deviceLabelOf(request);
    const pickup = formatPickupForEmail(request.pickupSlot);
    return {
        subject: `Your pickup time has changed (${request.trackingId})`,
        ...render({
            heading: 'Your new pickup time',
            paragraphs: [`The pickup for ${device} is now at the time below.`],
            details: [['Tracking ID', request.trackingId], ['New pickup', pickup]],
            action: requestUrl ? { label: 'View your request', url: requestUrl } : null,
        }),
    };
}

function pickupReminder({ request, requestUrl }) {
    const device = deviceLabelOf(request);
    const pickup = formatPickupForEmail(request.pickupSlot);
    const address = request.serviceLocation
        ? [request.serviceLocation.address, request.serviceLocation.district].filter(Boolean).join(', ')
        : '';
    return {
        subject: `Reminder: your device pickup is tomorrow (${request.trackingId})`,
        ...render({
            heading: 'Your pickup is tomorrow',
            paragraphs: [
                `A technician is due to collect ${device} tomorrow.`,
                'Please have the device ready. If the time no longer suits you, you can change it from your request page.',
            ],
            details: [['Pickup', pickup], ['Address', address], ['Tracking ID', request.trackingId]],
            action: requestUrl ? { label: 'View or change pickup', url: requestUrl } : null,
        }),
    };
}

function jobOffer({ request, technicianName, jobsUrl }) {
    const device = deviceLabelOf(request);
    const pickup = formatPickupForEmail(request.pickupSlot);
    const location = request.serviceLocation
        ? [request.serviceLocation.district, request.serviceLocation.region].filter(Boolean).join(', ')
        : '';
    const repair = request.service && request.service.repairCategorySlug
        ? String(request.service.repairCategorySlug).replace(/-/g, ' ')
        : '';
    return {
        subject: `New repair job offered to you (${request.trackingId})`,
        ...render({
            heading: technicianName ? `${technicianName}, you have a new job offer` : 'You have a new job offer',
            paragraphs: ['An admin has offered you this repair. Please accept or decline it from your jobs page.'],
            details: [['Device', device], ['Repair', repair], ['Area', location], ['Pickup', pickup], ['Tracking ID', request.trackingId]],
            action: jobsUrl ? { label: 'Open your jobs', url: jobsUrl } : null,
        }),
    };
}

module.exports = {
    escapeHtml,
    formatPickupForEmail,
    deviceLabelOf,
    requestReceived,
    pickupChanged,
    pickupReminder,
    jobOffer,
};
