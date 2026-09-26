// `mongoSession` is optional and defaults to undefined - every existing
// fire-and-forget caller is unaffected. Pass a MongoDB ClientSession to make
// this insert part of an in-progress transaction (see
// controllers/repairRequestController.js's assignTechnicianToRepairRequest).
const logTracking = async (trackingsCollection, trackingId, status, mongoSession = undefined) => {
    const log = {
        trackingId,
        status,
        details: status.split('_').join(' '),
        createdAt: new Date()
    }
    const options = mongoSession ? { session: mongoSession } : {};
    const result = await trackingsCollection.insertOne(log, options);
    return result;
}

// For a tracking log written AFTER the action it records has already
// succeeded: waits for the insert (so the log exists before the response is
// sent - callers and tests can rely on it), but a failed insert is only
// logged, never thrown. The action itself already happened, so a missing log
// line must not turn it into an error - and an un-awaited rejected promise
// here could otherwise crash the process as an unhandled rejection.
const logTrackingSafely = async (trackingsCollection, trackingId, status) => {
    try {
        return await logTracking(trackingsCollection, trackingId, status);
    } catch (error) {
        console.error(`Tracking log failed (non-fatal) for status ${status}:`, error.message);
        return null;
    }
}

module.exports = { logTracking, logTrackingSafely };

