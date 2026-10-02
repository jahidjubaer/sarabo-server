const { helperErrors, runAiCall } = require('./aiHelperCall');
const { NOTE_MAX_LENGTH } = require('../utils/jobPortal');

const NOTE_MIN_LENGTH = 20;
const LANGUAGES = Object.freeze(['en', 'bn']);

const errors = helperErrors({
    unavailable: 'The AI note writer is not available right now. Please write the note yourself.',
    timeout: 'The AI note writer took too long. Please try again or write the note yourself.',
    invalid: 'The AI note writer could not write a note. Please try again or write the note yourself.',
});

const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';
const toAsciiDigits = (text) => text.replace(/[০-৯]/g, (d) => String(BANGLA_DIGITS.indexOf(d)));

// Contact details keep the job on Sarabo, so they never go out in a note:
// emails, links, @handles and phone-like digit runs (7+ digits, any digits).
const CONTACT_PATTERNS = Object.freeze([
    /[^\s@]+@[^\s@]+\.[^\s@]+/g,
    /\b(?:https?:\/\/|www\.)\S+/gi,
    /\b[a-z0-9-]+\.(?:com|net|org|bd|me|io|link)\b\S*/gi,
    /(?:^|\s)@[A-Za-z0-9_.]{3,}/g,
    /\+?\d(?:[\s().-]*\d){6,}/g,
]);

function removeContactDetails(text) {
    let clean = toAsciiDigits(text);
    for (const pattern of CONTACT_PATTERNS) clean = clean.replace(pattern, ' ');
    // Put the customer's Bangla digits back only if nothing was removed.
    const result = clean === toAsciiDigits(text) ? text : clean;
    return result.replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,!?।])/g, '$1').trim();
}

function validateNote(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.note !== 'string') throw errors.unusable();
    const note = removeContactDetails(raw.note);
    if (note.length < NOTE_MIN_LENGTH) throw errors.unusable();
    return note.length > NOTE_MAX_LENGTH ? `${note.slice(0, NOTE_MAX_LENGTH - 1).trimEnd()}…` : note;
}

function createAiOfferNoteService({ provider = null, config }) {
    const isAvailable = () => Boolean(config && config.enabled && provider && typeof provider.generateNote === 'function');

    // `job` holds the safe facts the technician already sees on the board.
    async function writeNote({ job, language = 'en', technicianNotes = '', requestId }) {
        if (!isAvailable()) throw errors.unavailable();
        const raw = await runAiCall({
            timeoutMs: config.timeoutMs,
            errors,
            call: (signal) => provider.generateNote({ job, language, technicianNotes, signal, requestId }),
        });
        return validateNote(raw);
    }

    return { isAvailable, writeNote };
}

module.exports = { LANGUAGES, removeContactDetails, validateNote, createAiOfferNoteService };
