const SUPPORT_ACTIONS = Object.freeze({
    VIEW_SERVICES: Object.freeze({ id: 'VIEW_SERVICES', label: 'View services', to: '/services' }),
    TRACK_REQUEST: Object.freeze({ id: 'TRACK_REQUEST', label: 'Track a request', to: '/track-request' }),
    LOGIN: Object.freeze({ id: 'LOGIN', label: 'Log in', to: '/login' }),
    REGISTER: Object.freeze({ id: 'REGISTER', label: 'Create an account', to: '/register' }),
});

function resolveSupportActions(actionIds) {
    if (!Array.isArray(actionIds)) return [];
    const seen = new Set();
    const actions = [];
    for (const actionId of actionIds) {
        if (typeof actionId !== 'string' || seen.has(actionId)) continue;
        const action = SUPPORT_ACTIONS[actionId];
        if (!action) continue;
        seen.add(actionId);
        actions.push({ ...action });
    }
    return actions;
}

module.exports = { SUPPORT_ACTIONS, resolveSupportActions };
