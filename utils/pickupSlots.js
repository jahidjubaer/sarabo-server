// Pickup scheduling rules (pickup-scheduling phase). Pure: no database, no
// clock of its own - every function takes `now` so tests control time.
//
// All times are Bangladesh time (Asia/Dhaka, UTC+6 all year - Bangladesh has
// no daylight saving), which is where every service area is. A slot is
// stored as its Dhaka calendar date plus a fixed slot id, alongside the exact
// UTC instants it starts and ends, so it can be compared and sorted without
// any timezone arithmetic later.

const TIMEZONE = 'Asia/Dhaka';
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const PICKUP_SLOTS = Object.freeze([
    Object.freeze({ slotId: '10-12', startHour: 10, endHour: 12, label: '10:00 AM – 12:00 PM' }),
    Object.freeze({ slotId: '12-14', startHour: 12, endHour: 14, label: '12:00 PM – 2:00 PM' }),
    Object.freeze({ slotId: '14-16', startHour: 14, endHour: 16, label: '2:00 PM – 4:00 PM' }),
    Object.freeze({ slotId: '16-18', startHour: 16, endHour: 18, label: '4:00 PM – 6:00 PM' }),
]);

// 0 = Sunday ... 5 = Friday. Open Saturday to Thursday.
const CLOSED_WEEKDAYS = Object.freeze([5]);
// Today plus the next 7 days can be booked.
const BOOKING_WINDOW_DAYS = 7;
// A slot must start at least this long from now, so a technician can be found.
const MIN_LEAD_MINUTES = 60;
const DEFAULT_SLOT_CAPACITY = 3;

// Requests that still hold their pickup slot. Once the device is picked up
// the slot is history; cancelled requests free it.
const SLOT_HOLDING_STATUSES = Object.freeze(['pending-pickup', 'assignment_pending', 'driver_assigned', 'rider_arriving']);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function findSlot(slotId) {
    return PICKUP_SLOTS.find((slot) => slot.slotId === slotId) || null;
}

// "YYYY-MM-DD" of the Dhaka calendar day containing `instant`.
function dhakaDateString(instant) {
    return new Date(instant.getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 10);
}

// The UTC instant of hour `hour` on Dhaka date `date`.
function dhakaInstant(date, hour) {
    return new Date(Date.parse(`${date}T00:00:00Z`) - DHAKA_OFFSET_MS + hour * 60 * 60 * 1000);
}

function addDays(date, days) {
    return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function weekdayOf(date) {
    return new Date(`${date}T00:00:00Z`).getUTCDay();
}

// A real calendar date (rejects 2026-02-30, which Date.parse would roll over).
function isRealDate(date) {
    if (typeof date !== 'string' || !DATE_PATTERN.test(date)) return false;
    const parsed = new Date(`${date}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function resolveSlotCapacity(env = process.env) {
    const raw = env.PICKUP_SLOT_CAPACITY;
    if (raw === undefined || raw === '') return DEFAULT_SLOT_CAPACITY;
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_SLOT_CAPACITY;
}

function buildPickupSlot(date, slot) {
    return {
        date,
        slotId: slot.slotId,
        startsAt: dhakaInstant(date, slot.startHour),
        endsAt: dhakaInstant(date, slot.endHour),
    };
}

// Checks a client-chosen { date, slotId } against the calendar and the clock
// (not capacity - that needs the database). Returns the full stored shape.
function validatePickupSlotInput(input, now) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return { valid: false, code: 'INVALID_PICKUP_SLOT', message: 'pickupSlot must be an object with date and slotId' };
    }
    const { date, slotId } = input;
    if (!isRealDate(date)) {
        return { valid: false, code: 'INVALID_PICKUP_SLOT', message: 'pickupSlot.date must be a real date in YYYY-MM-DD format' };
    }
    const slot = findSlot(slotId);
    if (!slot) {
        return { valid: false, code: 'INVALID_PICKUP_SLOT', message: `pickupSlot.slotId must be one of: ${PICKUP_SLOTS.map((s) => s.slotId).join(', ')}` };
    }
    if (CLOSED_WEEKDAYS.includes(weekdayOf(date))) {
        return { valid: false, code: 'PICKUP_DAY_CLOSED', message: 'pickups are not available on this day' };
    }
    const today = dhakaDateString(now);
    if (date > addDays(today, BOOKING_WINDOW_DAYS)) {
        return { valid: false, code: 'PICKUP_SLOT_TOO_FAR', message: `pickups can be booked at most ${BOOKING_WINDOW_DAYS} days ahead` };
    }
    const pickupSlot = buildPickupSlot(date, slot);
    if (pickupSlot.startsAt.getTime() < now.getTime() + MIN_LEAD_MINUTES * 60 * 1000) {
        return { valid: false, code: 'PICKUP_SLOT_TOO_SOON', message: `this slot has passed or starts in less than ${MIN_LEAD_MINUTES} minutes` };
    }
    return { valid: true, pickupSlot };
}

// Every slot from today through the booking window, marked open/closed by
// the calendar and the clock. `bookedCounts` maps "date|slotId" to how many
// requests already hold that slot; capacity turns that into `remaining`.
function buildSlotCalendar(now, { bookedCounts = new Map(), capacity = DEFAULT_SLOT_CAPACITY } = {}) {
    const today = dhakaDateString(now);
    const days = [];
    for (let offset = 0; offset <= BOOKING_WINDOW_DAYS; offset += 1) {
        const date = addDays(today, offset);
        const weekday = weekdayOf(date);
        const closed = CLOSED_WEEKDAYS.includes(weekday);
        const slots = PICKUP_SLOTS.map((slot) => {
            const { startsAt, endsAt } = buildPickupSlot(date, slot);
            const booked = bookedCounts.get(`${date}|${slot.slotId}`) || 0;
            const remaining = Math.max(capacity - booked, 0);
            const tooSoon = startsAt.getTime() < now.getTime() + MIN_LEAD_MINUTES * 60 * 1000;
            return { slotId: slot.slotId, label: slot.label, startsAt, endsAt, remaining, available: !closed && !tooSoon && remaining > 0 };
        });
        days.push({ date, weekday: WEEKDAY_NAMES[weekday], closed, slots });
    }
    return days;
}

module.exports = {
    TIMEZONE,
    PICKUP_SLOTS,
    CLOSED_WEEKDAYS,
    BOOKING_WINDOW_DAYS,
    MIN_LEAD_MINUTES,
    DEFAULT_SLOT_CAPACITY,
    SLOT_HOLDING_STATUSES,
    findSlot,
    dhakaDateString,
    resolveSlotCapacity,
    validatePickupSlotInput,
    buildSlotCalendar,
};
