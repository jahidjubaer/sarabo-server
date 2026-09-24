// Email settings (email-updates phase). Emails go out through a Gmail account
// using a Google "App password" (free, about 500 emails a day). Everything is
// optional: with EMAIL_ENABLED unset or the credentials missing, the email
// service quietly does nothing and the rest of the app is unaffected.

const DEFAULT_FROM_NAME = 'Sarabo';
const DEFAULT_SEND_TIMEOUT_MS = 10000;

function loadEmailConfig(env = process.env) {
    const enabled = env.EMAIL_ENABLED === 'true';
    const user = typeof env.GMAIL_USER === 'string' ? env.GMAIL_USER.trim() : '';
    // Google shows app passwords in groups of four ("abcd efgh ..."); the
    // spaces are not part of it.
    const appPassword = typeof env.GMAIL_APP_PASSWORD === 'string' ? env.GMAIL_APP_PASSWORD.replace(/\s+/g, '') : '';
    const fromName = typeof env.EMAIL_FROM_NAME === 'string' && env.EMAIL_FROM_NAME.trim() ? env.EMAIL_FROM_NAME.trim() : DEFAULT_FROM_NAME;
    // Links in emails point at the client app (SITE_DOMAIN, already required).
    const siteOrigin = typeof env.SITE_DOMAIN === 'string' ? env.SITE_DOMAIN.trim().replace(/\/+$/, '') : '';
    const timeout = Number(env.EMAIL_SEND_TIMEOUT_MS);

    const missing = [];
    if (enabled && !user) missing.push('GMAIL_USER');
    if (enabled && !appPassword) missing.push('GMAIL_APP_PASSWORD');

    return {
        enabled: enabled && missing.length === 0,
        requestedButIncomplete: enabled && missing.length > 0,
        missing,
        user,
        appPassword,
        fromName,
        siteOrigin,
        sendTimeoutMs: Number.isInteger(timeout) && timeout > 0 ? timeout : DEFAULT_SEND_TIMEOUT_MS,
    };
}

module.exports = { loadEmailConfig };
