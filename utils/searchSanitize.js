// Escapes MongoDB regex metacharacters in user-supplied search text before it
// is ever interpolated into a $regex filter, so a search term can never be
// used to inject an unintended pattern (e.g. matching everything via `.*`)
// or to construct a catastrophic-backtracking (ReDoS-prone) expression.
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Trims and caps search input length before it is ever used to build a
// query - an unbounded search string is otherwise a cheap way to force the
// server to build/evaluate a very large regex.
function sanitizeSearchText(value, maxLength = 100) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, maxLength);
}

module.exports = { escapeRegex, sanitizeSearchText };
