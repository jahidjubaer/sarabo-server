const { SLOT_HOLDING_STATUSES } = require('../utils/pickupSlots');

// Work that has not moved on for longer than expected (workflow review). Each
// stage names who should act; admins see the list (controllers/
// adminAttentionController.js) and get one alert per request and stage from
// the daily job (controllers/workflowController.js alertStalled). Read-only.
//
//   reschedule_unanswered   customer asked for a new pickup time 3+ days ago, none chosen
//   not_inspected           device collected 3+ days ago, no inspection yet
//   no_quote                inspected 3+ days ago, no quote sent
//   quote_unanswered        quote sent 3+ days ago, customer has not answered
//   repair_not_started      paid 3+ days ago, repair not started
//   repair_slow             repair started 14+ days ago and not finished
//   not_returned            repair finished 3+ days ago, device not marked returned
//   cancelled_not_returned  cancelled after pickup 3+ days ago, device not marked returned
// A technician who already reported they cannot finish is on its own list.
const DAY_MS = 24 * 60 * 60 * 1000;
const LIMIT = 200;
const STAGES = Object.freeze({
    reschedule_unanswered: { days: 3, field: 'pickupRescheduleRequestedAt', filter: { deliveryStatus: { $in: SLOT_HOLDING_STATUSES } } },
    not_inspected: { days: 3, field: 'pickedUpAt', filter: { deliveryStatus: 'parcel_picked_up' } },
    no_quote: { days: 3, field: 'inspection.submittedAt', filter: { deliveryStatus: 'inspection_completed' } },
    quote_unanswered: { days: 3, field: 'quote.submittedAt', filter: { deliveryStatus: 'quote_submitted' } },
    repair_not_started: { days: 3, field: 'payment.completedAt', filter: { deliveryStatus: 'payment_completed', repairBlocked: { $exists: false } } },
    repair_slow: { days: 14, field: 'repair.startedAt', filter: { deliveryStatus: 'repair_in_progress', repairBlocked: { $exists: false } } },
    not_returned: {
        days: 3, field: 'repair.completion.completedAt',
        filter: { deliveryStatus: 'repair_completed', 'customerReceiptConfirmation.status': { $ne: 'confirmed' }, 'deviceReturn.markedAt': { $exists: false } },
    },
    cancelled_not_returned: {
        days: 3, field: 'deviceReturn.since',
        filter: { deliveryStatus: 'cancelled', 'deviceReturn.required': true, 'deviceReturn.markedAt': { $exists: false }, 'deviceReturn.confirmedAt': { $exists: false } },
    },
});

const PROJECTION = {
    trackingId: 1, product: 1, service: 1, serviceLocation: 1, pickupSlot: 1, deliveryStatus: 1, technicianId: 1, technicianName: 1, createdAt: 1,
    pickupRescheduleRequestedAt: 1, pickedUpAt: 1, 'inspection.submittedAt': 1, 'quote.submittedAt': 1, 'payment.completedAt': 1,
    'repair.startedAt': 1, 'repair.completion.completedAt': 1, deviceReturn: 1,
};

function readPath(doc, path) {
    return path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), doc);
}

// [{ request, stage, since }] - the longest-stalled first.
async function findStalledWork(collections, now = new Date()) {
    const groups = await Promise.all(Object.entries(STAGES).map(async ([stage, rule]) => {
        const cutoff = new Date(now.getTime() - rule.days * DAY_MS);
        const rows = await collections.repairRequests
            .find({ ...rule.filter, [rule.field]: { $lte: cutoff } }, { projection: PROJECTION })
            .sort({ [rule.field]: 1 }).limit(LIMIT).toArray();
        return rows.map((request) => ({ request, stage, since: readPath(request, rule.field) }));
    }));
    return groups.flat().sort((a, b) => new Date(a.since) - new Date(b.since));
}

module.exports = { STAGES, findStalledWork };
