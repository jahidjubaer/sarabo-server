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

module.exports = { logTracking };

