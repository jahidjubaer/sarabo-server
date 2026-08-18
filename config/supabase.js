const { createClient } = require('@supabase/supabase-js');

// Supabase client for Storage only (Phase 9.1). Firebase remains the identity
// provider - this replaces Firebase *Storage*, which requires the paid Blaze
// plan, and nothing else. admin.auth() token verification is untouched.
//
// The SERVICE key never leaves this process. It is the full-access key that
// bypasses Row Level Security, so it is used exclusively to mint short-lived
// signed URLs the browser can use on its own; no client ever receives it.
//
// Cached against the exact (url, key) pair rather than unconditionally, so a
// changed or removed env var is still detected on a later call - the same
// "resolve lazily, never trust a value captured at startup" rule
// damageStorageService already applies to its bucket name.
let cached = null;

function getSupabaseClient() {
    const url = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) return null;

    if (cached && cached.url === url && cached.serviceKey === serviceKey) {
        return cached.client;
    }

    const client = createClient(url, serviceKey, {
        // This is a stateless server process acting as itself, never on behalf
        // of a browser session - there is no session to persist or refresh, and
        // leaving these on would start a background refresh timer that keeps
        // the serverless function alive.
        auth: { persistSession: false, autoRefreshToken: false },
    });

    cached = { url, serviceKey, client };
    return client;
}

module.exports = { getSupabaseClient };
