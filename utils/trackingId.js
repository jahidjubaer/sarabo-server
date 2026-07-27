const crypto = require("crypto");

// Legacy generator - only ~24 bits of randomness (3 random bytes) plus a
// public, guessable date prefix that adds no real security. Kept only so
// existing historical tracking codes keep resolving; no longer used when
// creating new repair requests. See generateSecureTrackingId below, which is
// the current standard now that tracking codes are also used as an
// unauthenticated, bearer-style public lookup key (see
// controllers/trackingController.js's getPublicTracking).
function generateTrackingId() {
    const prefix = "PRCL"; // your brand prefix
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
    const random = crypto.randomBytes(3).toString("hex").toUpperCase(); // 6-char random hex

    return `${prefix}-${date}-${random}`;
}

// 16 cryptographically random bytes (128 bits, well above the 96-bit
// minimum) base64url-encoded - URL-safe, copy-friendly, and carries no
// date/sequence component that would narrow a brute-force search. Tracking
// codes are handed out to anyone with the link, so guessing one must stay
// infeasible even before rate limiting is taken into account.
function generateSecureTrackingId() {
    const token = crypto.randomBytes(16).toString('base64url');
    return `SRB-${token}`;
}

module.exports = { generateTrackingId, generateSecureTrackingId };

