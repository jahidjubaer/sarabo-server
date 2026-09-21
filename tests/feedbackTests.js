const { ObjectId } = require('mongodb');
const { getDeletionEligibility } = require('../services/deletionPolicy');
const { projectSafeListRepairRequest } = require('../utils/repairRequestProjection');
const { REPORT_REASONS, REPORT_TRANSITIONS, validateReview, validateReport, validateList } = require('../utils/feedback');

async function runFeedbackTests({ logTest }) {
    // The full suite exercises database configuration by evicting its module
    // cache. Load DB-bound controllers only after those tests, so sessions and
    // collections belong to the same MongoClient (and Stripe mocks are ready).
    const { connectDatabase, collections: c } = require('../config/database');
    const { initializeModels } = require('../models');
    const FeedbackController = require('../controllers/feedbackController');
    const RepairRequestController = require('../controllers/repairRequestController');
    if (process.env.NODE_ENV !== 'test' || !c.repairRequests.dbName.includes('test') || c.repairRequests.dbName === 'sarabo-db') throw new Error('Isolated test database required');
    await connectDatabase();
    const models = initializeModels(c);
    const ctrl = new FeedbackController(models, c);
    const deletion = new RepairRequestController(models, c, { deleteObject: async () => { throw Error('External storage must not be called'); } });
    const prefix = `feedback-${new ObjectId()}`;
    const ids = [];
    const actors = {};
    const technicians = [];
    const ok = (name, condition) => logTest(`Feedback: ${name}`, !!condition);
    const throws = fn => { try { fn(); return false; } catch { return true; } };
    const response = () => ({ statusCode: 200, body: undefined, status(code) { this.statusCode = code; return this; }, send(body) { this.body = body; return this; }, json(body) { return this.send(body); } });
    async function call(method, id, body, actor = 'customer', query = {}, verified = true, controller = ctrl) {
        const res = response();
        await controller[method]({ params: { id }, body, query, decoded_email: actors[actor]?.email, decoded_email_verified: verified, method: 'POST', route: { path: '/feedback/:id' }, requestId: 'feedback-test' }, res);
        return res;
    }
    const reportBody = { reason: 'repair_dispute', description: 'The device issue needs private administrator review.' };
    function assignment(tech, decision = 'accepted') {
        return { assignmentId: new ObjectId().toString(), technicianId: tech._id.toString(), technicianEmail: tech.email, technicianName: 'Fixture technician', assignedAt: new Date(), assignedBy: actors.admin.email, decision, decidedAt: decision === 'pending' ? null : new Date() };
    }
    async function repair(overrides = {}, tech = technicians[0]) {
        const doc = { _id: new ObjectId(), schemaVersion: 2, senderEmail: actors.customer.email, trackingId: `${prefix}-${ids.length}`, deliveryStatus: 'parcel_delivered', technicianId: tech._id.toString(), technicianEmail: tech.email, assignmentHistory: [assignment(tech)], repair: { status: 'completed', completion: { completedAt: new Date() } }, customerReceiptConfirmation: { status: 'confirmed', confirmedAt: new Date(), confirmedBy: actors.customer.email }, ...overrides };
        for (const key of Object.keys(doc)) if (doc[key] === undefined) delete doc[key];
        ids.push(doc._id);
        await c.repairRequests.insertOne(doc);
        return doc;
    }
    const snapshotBusiness = async doc => {
        const request = await c.repairRequests.findOne({ _id: doc._id });
        delete request.feedbackRevision;
        return JSON.stringify({ request, users: await c.users.find({ _id: { $in: Object.values(actors).map(a => a._id) } }).sort({ _id: 1 }).toArray(), techs: await c.technicians.find({ _id: { $in: technicians.map(t => t._id) } }).sort({ _id: 1 }).toArray(), payments: await c.payments.find({ requestId: String(doc._id) }).toArray(), withdrawals: await c.technicianWithdrawals.find({ technicianEmail: technicians[0].email }).toArray() });
    };
    try {
        for (const [key, role] of Object.entries({ customer: 'user', other: 'user', rider: 'rider', admin: 'admin' })) {
            actors[key] = { _id: new ObjectId(), email: `${prefix}-${key}@test.local`, role };
            await c.users.insertOne(actors[key]);
        }
        for (let i = 0; i < 2; i++) {
            const tech = { _id: new ObjectId(), email: i ? `${prefix}-other-tech@test.local` : actors.rider.email, status: 'approved', workStatus: 'available' };
            technicians.push(tech);
            await c.technicians.insertOne(tech);
        }
        const reviewIndexes = await c.technicianReviews.indexes();
        const reportIndexes = await c.technicianReports.indexes();
        ok('review unique repair index', reviewIndexes.some(i => i.unique && JSON.stringify(i.key) === JSON.stringify({ repairRequestId: 1 })));
        ok('report unique pair index', reportIndexes.some(i => i.unique && JSON.stringify(i.key) === JSON.stringify({ repairRequestId: 1, technicianId: 1 })));
        ok('all seven requested feedback indexes present', reviewIndexes.length === 4 && reportIndexes.length === 5);

        for (const rating of [0, 6, 1.5, '5', null, undefined]) ok(`reject rating ${String(rating)}`, throws(() => validateReview({ rating })));
        for (const rating of [1, 2, 3, 4, 5]) ok(`accept rating ${rating}`, validateReview({ rating }).rating === rating);
        ok('whitespace comment becomes null', validateReview({ rating: 3, comment: '  \n ' }).comment === null);
        ok('trim comment', validateReview({ rating: 3, comment: ' Good ' }).comment === 'Good');
        ok('reject oversized comment', throws(() => validateReview({ rating: 3, comment: 'x'.repeat(1001) })));
        ok('reject HTML comment', throws(() => validateReview({ rating: 3, comment: '<script>alert(1)</script>' })));
        for (const field of ['customerId', 'technicianId', 'visibility', 'verifiedRepair', 'completed', 'role', 'payment', 'settlement']) ok(`review rejects ${field}`, throws(() => validateReview({ rating: 3, [field]: true })));
        const received = await repair();
        for (const role of ['rider', 'admin']) ok(`${role} cannot create customer review`, (await call('createReview', String(received._id), { rating: 4 }, role)).statusCode === 403);
        ok('missing auth rejected', (await call('createReview', String(received._id), { rating: 4 }, 'missing')).statusCode === 401);
        ok('wrong customer generic not found', (await call('createReview', String(received._id), { rating: 4 }, 'other')).body.code === 'REQUEST_NOT_FOUND');
        ok('unverified review forbidden', (await call('createReview', String(received._id), { rating: 4 }, 'customer', {}, false)).body.code === 'EMAIL_NOT_VERIFIED');
        for (const [label, overrides] of [
            ['repair completed without receipt', { deliveryStatus: 'repair_completed', customerReceiptConfirmation: { status: 'pending' } }],
            ['legacy delivered', { schemaVersion: 1, customerReceiptConfirmation: undefined }],
            ['missing assignment', { technicianId: undefined, technicianEmail: undefined, assignmentHistory: [] }],
            ['missing completion timestamp', { repair: { status: 'completed', completion: {} } }],
            ['missing receipt timestamp', { customerReceiptConfirmation: { status: 'confirmed', confirmedBy: actors.customer.email } }],
            ['legacy current assignment on modern repair', { assignmentHistory: undefined }],
            ['rejected final assignment', { assignmentHistory: [assignment(technicians[0], 'rejected')] }],
            ['forged current technician email', { technicianEmail: technicians[1].email }],
        ]) {
            const doc = await repair(overrides);
            ok(`review ineligible: ${label}`, (await call('createReview', String(doc._id), { rating: 4 })).body.code === 'REVIEW_NOT_ELIGIBLE');
        }
        const notificationBeforeReview = await c.notifications.countDocuments({ entityId: String(received._id) });
        const created = await call('createReview', String(received._id), { rating: 5, comment: '  Thanks  ' });
        ok('valid modern review HTTP 201', created.statusCode === 201 && created.body.comment === 'Thanks' && created.body.verifiedRepair === true);
        const stored = await models.TechnicianReview.findForRepair(String(received._id));
        ok('server-derived review references', stored.customerId === String(actors.customer._id) && stored.technicianId === String(technicians[0]._id) && stored.visibility === 'visible' && stored.version === 1);
        ok('review has no notification', await c.notifications.countDocuments({ entityId: String(received._id) }) === notificationBeforeReview);
        ok('duplicate review returns stable 409', (await call('createReview', String(received._id), { rating: 1 })).body.code === 'REVIEW_ALREADY_EXISTS');
        const raceReview = await repair();
        const reviewRace = await Promise.all([1, 2].map(() => call('createReview', String(raceReview._id), { rating: 3 })));
        ok('concurrent reviews one 201 one 409', reviewRace.filter(r => r.statusCode === 201).length === 1 && reviewRace.filter(r => r.statusCode === 409).length === 1);
        ok('concurrent review stored once', await c.technicianReviews.countDocuments({ repairRequestId: String(raceReview._id) }) === 1);
        const multi = await repair({ assignmentHistory: [assignment(technicians[1]), assignment(technicians[0])] });
        const multiReview = await call('createReview', String(multi._id), { rating: 4 });
        ok('review uses accepted final technician only', (await models.TechnicianReview.findForRepair(String(multi._id))).technicianId === String(technicians[0]._id));
        ok('technician visible average and count', (await call('technicianReviews', null, null, 'rider')).body.averageRating === 4 && (await call('technicianReviews', null, null, 'rider')).body.reviewCount === 3);
        const techList = (await call('technicianReviews', null, null, 'rider')).body.items;
        ok('technician projection excludes identity and repair references', techList.every(r => r.reviewerLabel === 'Verified customer' && !['customerId', 'technicianId', 'repairRequestId', 'email', 'trackingId', 'moderationHistory'].some(k => k in r)));
        ok('zero-visible average is null', (await models.TechnicianReview.aggregate(String(technicians[1]._id))).averageRating === null && (await models.TechnicianReview.aggregate(String(technicians[1]._id))).reviewCount === 0);
        ok('customer cannot list technician reviews', (await call('technicianReviews', null, null)).statusCode === 403);
        ok('non-admin cannot moderate review', (await call('visibility', created.body._id, { visibility: 'hidden', reason: 'Test', expectedVersion: 1 })).statusCode === 403);
        const hidden = await call('visibility', created.body._id, { visibility: 'hidden', reason: 'Policy review', expectedVersion: 1 }, 'admin');
        ok('hide records reason admin and version', hidden.statusCode === 200 && hidden.body.version === 2 && hidden.body.moderationHistory[0].adminId === String(actors.admin._id));
        const afterHide = (await call('technicianReviews', null, null, 'rider')).body;
        ok('hidden excluded from visible list/count/average', afterHide.reviewCount === 2 && afterHide.averageRating === 3.5 && !afterHide.items.some(r => r._id === created.body._id));
        ok('stale moderation rejected', (await call('visibility', created.body._id, { visibility: 'visible', reason: 'Restore', expectedVersion: 1 }, 'admin')).statusCode === 409);
        ok('admin cannot rewrite review', (await call('visibility', created.body._id, { visibility: 'visible', reason: 'Restore', expectedVersion: 2, rating: 1 }, 'admin')).statusCode === 400);
        await call('visibility', created.body._id, { visibility: 'visible', reason: 'Restored', expectedVersion: 2 }, 'admin');
        ok('restore re-enters aggregation', (await models.TechnicianReview.aggregate(String(technicians[0]._id))).averageRating === 4);
        ok('restoration preserves customer content', (await models.TechnicianReview.findById(created.body._id)).comment === 'Thanks');
        const reviewConflicts = await Promise.all([1, 2].map(() => call('visibility', multiReview.body._id, { visibility: 'hidden', reason: 'Concurrent moderation', expectedVersion: 1 }, 'admin')));
        ok('concurrent moderation one winner', reviewConflicts.filter(r => r.statusCode === 200).length === 1 && reviewConflicts.filter(r => r.statusCode === 409).length === 1);

        for (const reason of REPORT_REASONS) ok(`valid report reason ${reason}`, validateReport({ ...reportBody, reason }).reason === reason);
        for (const [label, body] of [
            ['unknown reason', { ...reportBody, reason: 'fraud' }], ['short description', { ...reportBody, description: 'short' }],
            ['oversized description', { ...reportBody, description: 'x'.repeat(2001) }], ['non-string description', { ...reportBody, description: 42 }],
            ['HTML description', { ...reportBody, description: '<b>This is a private report</b>' }], ['invalid assignment id', { ...reportBody, assignmentId: 'no' }],
        ]) ok(`reject ${label}`, throws(() => validateReport(body)));
        for (const field of ['customerId', 'technicianId', 'status', 'adminId', 'role', 'images', 'payment', 'settlement']) ok(`report rejects ${field}`, throws(() => validateReport({ ...reportBody, [field]: true })));
        const active = await repair({ deliveryStatus: 'driver_assigned', repair: undefined, customerReceiptConfirmation: undefined, payment: { status: 'not_paid' }, technicianSettlement: { status: 'pending', technicianReceivable: 90 }, assignmentHistory: [assignment(technicians[0], 'pending')] });
        const beforeBusiness = await snapshotBusiness(active);
        for (const role of ['rider', 'admin']) ok(`${role} cannot report as customer`, (await call('createReport', String(active._id), reportBody, role)).statusCode === 403);
        ok('wrong owner report generic not found', (await call('createReport', String(active._id), reportBody, 'other')).body.code === 'REQUEST_NOT_FOUND');
        ok('unrelated assignment rejected', (await call('createReport', String(active._id), { ...reportBody, assignmentId: new ObjectId().toString() })).body.code === 'REPORT_NOT_ELIGIBLE');
        const reported = await call('createReport', String(active._id), reportBody, 'customer', {}, false);
        ok('active unpaid repair unverified Customer can report', reported.statusCode === 201 && reported.body.status === 'open');
        ok('customer report projection excludes complaint and internal fields', !['description', 'customerId', 'adminNotes', 'statusHistory', 'closedBy', 'technicianId'].some(k => k in reported.body));
        ok('report creation preserves all business state', beforeBusiness === await snapshotBusiness(active));
        ok('duplicate report pair 409', (await call('createReport', String(active._id), reportBody)).body.code === 'REPORT_ALREADY_EXISTS');
        for (const status of ['repair_completed', 'cancelled']) {
            const doc = await repair({ deliveryStatus: status, customerReceiptConfirmation: undefined });
            ok(`${status} can report without receipt`, (await call('createReport', String(doc._id), reportBody)).statusCode === 201);
        }
        const historicEntry = assignment(technicians[1], 'rejected');
        const reassigned = await repair({ assignmentHistory: [historicEntry, assignment(technicians[0])] });
        ok('verifiable rejected historical assignment reportable', (await call('createReport', String(reassigned._id), { ...reportBody, assignmentId: historicEntry.assignmentId })).statusCode === 201);
        ok('reassigned repair allows different technician pair', (await call('createReport', String(reassigned._id), reportBody)).statusCode === 201);
        ok('historical same pair cannot report again', (await call('createReport', String(reassigned._id), { ...reportBody, assignmentId: historicEntry.assignmentId })).statusCode === 409);
        const legacy = await repair({ schemaVersion: 1, assignmentHistory: undefined });
        ok('legacy verified current assignment reportable', (await call('createReport', String(legacy._id), reportBody)).statusCode === 201);
        const legacyMismatch = await repair({ schemaVersion: 1, assignmentHistory: undefined, technicianEmail: technicians[1].email });
        ok('legacy mismatched identity rejected', (await call('createReport', String(legacyMismatch._id), reportBody)).statusCode === 409);
        const reportRaceDoc = await repair();
        const reportRace = await Promise.all([1, 2].map(() => call('createReport', String(reportRaceDoc._id), reportBody)));
        ok('concurrent report one 201 one 409', reportRace.filter(r => r.statusCode === 201).length === 1 && reportRace.filter(r => r.statusCode === 409).length === 1);
        ok('one report pair persisted after race', await c.technicianReports.countDocuments({ repairRequestId: String(reportRaceDoc._id) }) === 1);
        const notesId = reported.body._id;
        for (const role of ['customer', 'rider']) {
            ok(`${role} cannot read Admin report detail`, (await call('reportDetail', notesId, null, role)).statusCode === 403);
            ok(`${role} cannot moderate status`, (await call('status', notesId, { status: 'under_review', expectedVersion: 1 }, role)).statusCode === 403);
            ok(`${role} cannot append admin notes`, (await call('note', notesId, { text: 'Private note', expectedVersion: 1 }, role)).statusCode === 403);
            ok(`${role} cannot list reports`, (await call('listReports', null, null, role)).statusCode === 403);
        }
        ok('admin report list filter', (await call('listReports', null, null, 'admin', { status: 'open', technicianId: String(technicians[0]._id) })).body.items.every(x => x.status === 'open' && x.technicianId === String(technicians[0]._id)));
        ok('admin report detail contains authorized description', (await call('reportDetail', notesId, null, 'admin')).body.description === reportBody.description);
        ok('admin review list visibility filter', (await call('listReviews', null, null, 'admin', { visibility: 'hidden', technicianId: String(technicians[0]._id) })).body.items.every(x => x.visibility === 'hidden'));
        for (const badQuery of [{ limit: '51' }, { page: '0' }, { page: ['1'] }, { search: 'private' }, { status: 'bogus' }, { technicianId: '.*' }]) ok('invalid report filter rejected '+JSON.stringify(badQuery), throws(() => validateList(badQuery, 'report')));
        ok('pagination defaults 20 and max 50', validateList({}, 'report').limit === 20 && validateList({ limit: '50' }, 'report').limit === 50);
        const pg1 = await call('listReports', null, null, 'admin', { technicianId: String(technicians[0]._id), limit: '1', page: '1' });
        const pg2 = await call('listReports', null, null, 'admin', { technicianId: String(technicians[0]._id), limit: '1', page: '2' });
        ok('pagination pages deterministic and distinct', pg1.body.items.length === 1 && pg2.body.items.length === 1 && pg1.body.items[0]._id !== pg2.body.items[0]._id);
        for (const text of ['', 'x'.repeat(1001), '<b>private note</b>', 42]) ok('invalid admin note rejected '+typeof text, (await call('note', notesId, { text, expectedVersion: 1 }, 'admin')).statusCode === 400);
        const note = await call('note', notesId, { text: ' Private investigation note ', expectedVersion: 1 }, 'admin');
        ok('admin note appended attributed versioned', note.statusCode === 200 && note.body.version === 2 && note.body.adminNotes[0].text === 'Private investigation note' && note.body.adminNotes[0].adminId === String(actors.admin._id));
        ok('stale note rejected', (await call('note', notesId, { text: 'Overwrite?', expectedVersion: 1 }, 'admin')).statusCode === 409);
        ok('open cannot directly resolve', (await call('status', notesId, { status: 'resolved', expectedVersion: 2, explanation: 'Done' }, 'admin')).statusCode === 409);
        const under = await call('status', notesId, { status: 'under_review', expectedVersion: 2 }, 'admin');
        ok('open to under_review with history', under.body.status === 'under_review' && under.body.statusHistory[0].from === 'open' && under.body.statusHistory[0].adminId === String(actors.admin._id));
        ok('terminal explanation required', (await call('status', notesId, { status: 'resolved', expectedVersion: 3 }, 'admin')).statusCode === 400);
        const resolved = await call('status', notesId, { status: 'resolved', expectedVersion: 3, explanation: 'Admin handling completed.' }, 'admin');
        ok('resolved closed fields and append-only explanation', resolved.body.status === 'resolved' && resolved.body.adminNotes.length === 2 && resolved.body.statusHistory.length === 2 && resolved.body.closedBy === String(actors.admin._id) && resolved.body.closedAt instanceof Date);
        ok('terminal cannot reopen', (await call('status', notesId, { status: 'under_review', expectedVersion: 4 }, 'admin')).statusCode === 409);
        ok('closed report cannot be resubmitted', (await call('createReport', String(active._id), reportBody)).statusCode === 409);
        ok('moderation has no financial repair assignment account side effects', beforeBusiness === await snapshotBusiness(active));
        for (const from of ['open', 'under_review']) {
            const doc = await repair();
            const report = await call('createReport', String(doc._id), reportBody);
            if (from === 'under_review') await call('status', report.body._id, { status: 'under_review', expectedVersion: 1 }, 'admin');
            const dismissed = await call('status', report.body._id, { status: 'dismissed', expectedVersion: from === 'open' ? 1 : 2, explanation: 'Closed without further action.' }, 'admin');
            ok(`${from} to dismissed`, dismissed.body.status === 'dismissed' && dismissed.body.closedAt instanceof Date);
        }
        for (const [from, allowed] of Object.entries(REPORT_TRANSITIONS)) for (const to of Object.keys(REPORT_TRANSITIONS)) {
            if (allowed.includes(to)) continue;
            const doc = await repair(); const report = await call('createReport', String(doc._id), reportBody);
            await c.technicianReports.updateOne({ _id: new ObjectId(report.body._id) }, { $set: { status: from } });
            ok(`reject transition ${from} -> ${to}`, (await call('status', report.body._id, { status: to, expectedVersion: 1, explanation: 'Transition test' }, 'admin')).statusCode === 409);
        }
        const summary = await call('summary', String(active._id));
        ok('owner summary no private notes history description', summary.body.reports.length === 1 && !/adminNotes|statusHistory|Private investigation|description/.test(JSON.stringify(summary.body)));
        ok('report summary removes already-reported targets', summary.body.reportTargets.length === 0);
        ok('other Customer cannot read summary', (await call('summary', String(active._id), null, 'other')).statusCode === 404);
        ok('Technician cannot read customer feedback summary', (await call('summary', String(active._id), null, 'rider')).statusCode === 403);
        const own = await call('summary', String(received._id));
        ok('submitted review is final in owner summary', own.body.reviewEligibility.code === 'REVIEW_ALREADY_EXISTS' && own.body.ownReview.rating === 5 && !('moderationHistory' in own.body.ownReview));
        const unverified = await call('summary', String(await repair().then(r => r._id)), null, 'customer', {}, false);
        ok('summary reports email verification requirement', unverified.body.reviewEligibility.code === 'EMAIL_NOT_VERIFIED');

        const notificationDoc = await models.TechnicianReport.findById(notesId);
        const adminEmails = await models.User.findEmailsByRole('admin');
        await ctrl.notifyAdmins({ method: 'POST', route: { path: '/feedback/:id' } }, notificationDoc);
        const notificationRows = await c.notifications.find({ entityType: 'technician_report', entityId: notesId }).toArray();
        ok('report admin notifications deduplicated per recipient', notificationRows.length === adminEmails.length && new Set(notificationRows.map(n => n.recipientEmail)).size === adminEmails.length);
        ok('no sensitive content or technician report notifications', notificationRows.every(n => n.recipientRole === 'admin' && n.message === 'A private technician report is available for admin review.' && Object.keys(n.metadata).length === 0 && n.actionUrl === '/dashboard'));
        const logs = []; const originalError = console.error;
        let failedNotificationReport;
        try {
            console.error = line => logs.push(String(line));
            const failing = new FeedbackController(models, c, { notifications: { createNotification: async () => { throw Error('SECRET complaint text'); } } });
            const doc = await repair();
            failedNotificationReport = await call('createReport', String(doc._id), reportBody, 'customer', {}, true, failing);
            const originalInsert = models.TechnicianReview.insert;
            try {
                models.TechnicianReview.insert = async () => { throw Error('SECRET review content'); };
                await call('createReview', String((await repair())._id), { rating: 1, comment: 'SECRET review content' });
            } finally { models.TechnicianReview.insert = originalInsert; }
        } finally { console.error = originalError; }
        ok('notification failure does not roll back report', failedNotificationReport.statusCode === 201 && !!await models.TechnicianReport.findById(failedNotificationReport.body._id));
        ok('safe logs omit report comments bodies contacts', logs.length > 0 && logs.every(line => !/SECRET|@test.local|description|comment|adminNotes/.test(line)));

        const historyOnly = await repair({ deliveryStatus: 'pending-pickup', technicianId: undefined, technicianEmail: undefined, repair: undefined, customerReceiptConfirmation: undefined, assignmentHistory: [assignment(technicians[0], 'rejected')] });
        ok('historical assignment blocks deletion eligibility', !getDeletionEligibility(historyOnly, { hasAnyPayment: false, hasActiveCheckout: false }).eligible);
        ok('historical assignment blocked by atomic delete guard', (await models.RepairRequest.deleteGuarded({ id: String(historyOnly._id) })).deletedCount === 0);
        const [reporting, deleting] = await Promise.all([
            call('createReport', String(historyOnly._id), { ...reportBody, assignmentId: historyOnly.assignmentHistory[0].assignmentId }),
            call('deleteRepairRequest', String(historyOnly._id), null, 'customer', {}, true, deletion),
        ]);
        ok('concurrent historical report and normal deletion retain repair', reporting.statusCode === 201 && deleting.statusCode === 409 && !!await c.repairRequests.findOne({ _id: historyOnly._id }));
        const bearing = await repair({ deliveryStatus: 'pending-pickup', technicianId: undefined, technicianEmail: undefined, repair: undefined, customerReceiptConfirmation: undefined, assignmentHistory: [] });
        await c.technicianReports.insertOne({ repairRequestId: String(bearing._id), technicianId: String(technicians[0]._id), customerId: String(actors.customer._id), status: 'dismissed' });
        ok('report alone blocks normal deletion even without marker/history', (await call('deleteRepairRequest', String(bearing._id), null, 'admin', {}, true, deletion)).statusCode === 409);
        const retention = await repair({ deliveryStatus: 'pending-pickup', technicianId: undefined, technicianEmail: undefined, repair: undefined, customerReceiptConfirmation: undefined, assignmentHistory: [], feedbackRevision: 1 });
        ok('feedback marker alone blocks atomic deletion', (await models.RepairRequest.deleteGuarded({ id: String(retention._id) })).deletedCount === 0);
        ok('retention marker not exposed in general list', !('feedbackRevision' in projectSafeListRepairRequest(retention)));
        const neverAssigned = await repair({ deliveryStatus: 'pending-pickup', technicianId: undefined, technicianEmail: undefined, repair: undefined, customerReceiptConfirmation: undefined, assignmentHistory: [] });
        const [noReport, cleanDelete] = await Promise.all([
            call('createReport', String(neverAssigned._id), reportBody),
            call('deleteRepairRequest', String(neverAssigned._id), null, 'customer', {}, true, deletion),
        ]);
        ok('delete-first unassigned repair cannot acquire orphan report', [404, 409].includes(noReport.statusCode) && cleanDelete.statusCode === 200 && await c.technicianReports.countDocuments({ repairRequestId: String(neverAssigned._id) }) === 0);

        // Force the report transaction to read a repair before a concurrent
        // deletion commits. This tests the shared-document write conflict,
        // independently of the earlier normal-flow assignment retention guard.
        const snapshotRace = await repair();
        const racingController = new FeedbackController(models, c);
        const originalOwnedRepair = racingController.ownedRepair.bind(racingController);
        let firstSnapshot = true;
        racingController.ownedRepair = async (req, session) => {
            const result = await originalOwnedRepair(req, session);
            if (firstSnapshot) {
                firstSnapshot = false;
                await c.repairRequests.deleteOne({ _id: snapshotRace._id });
            }
            return result;
        };
        const racedReport = await call('createReport', String(snapshotRace._id), reportBody, 'customer', {}, true, racingController);
        ok('delete after transaction snapshot forces revalidation, not orphan insert', racedReport.statusCode === 404 && await c.technicianReports.countDocuments({ repairRequestId: String(snapshotRace._id) }) === 0);

        const rollbackRepair = await repair();
        const originalReportInsert = models.TechnicianReport.insert;
        const originalConsoleError = console.error;
        let rollbackResult;
        try {
            console.error = () => {};
            models.TechnicianReport.insert = async () => { throw Error('Simulated insert failure'); };
            rollbackResult = await call('createReport', String(rollbackRepair._id), reportBody);
        } finally {
            models.TechnicianReport.insert = originalReportInsert;
            console.error = originalConsoleError;
        }
        ok('failed report insert atomically rolls back retention write', rollbackResult.statusCode === 500 && !Object.hasOwn(await c.repairRequests.findOne({ _id: rollbackRepair._id }), 'feedbackRevision') && await c.technicianReports.countDocuments({ repairRequestId: String(rollbackRepair._id) }) === 0);

        const noteRaceRepair = await repair();
        const noteRaceReport = await call('createReport', String(noteRaceRepair._id), reportBody);
        const noteRace = await Promise.all([1, 2].map(i => call('note', noteRaceReport.body._id, { text: `Concurrent note ${i}`, expectedVersion: 1 }, 'admin')));
        ok('concurrent admin notes require fresh version', noteRace.filter(r => r.statusCode === 200).length === 1 && noteRace.filter(r => r.statusCode === 409).length === 1);
        for (const body of [{ visibility: 'hidden', expectedVersion: 3 }, { visibility: 'invalid', expectedVersion: 3, reason: 'Review' }, { visibility: 'hidden', expectedVersion: '3', reason: 'Review' }]) {
            ok('review moderation requires valid visibility reason and integer version', (await call('visibility', created.body._id, body, 'admin')).statusCode === 400);
        }
        ok('notes reject spoofed admin identity', (await call('note', noteRaceReport.body._id, { text: 'A note', expectedVersion: 2, adminId: String(actors.other._id) }, 'admin')).statusCode === 400);
        ok('report status rejects content edits', (await call('status', noteRaceReport.body._id, { status: 'under_review', expectedVersion: 2, description: 'Rewritten' }, 'admin')).statusCode === 400);
        await c.technicianReports.updateOne({ _id: new ObjectId(noteRaceReport.body._id) }, { $set: { adminNotes: Array.from({ length: 100 }, () => ({ text: 'Earlier private note', adminId: String(actors.admin._id), createdAt: new Date() })) } });
        const longHistoryClosure = await call('status', noteRaceReport.body._id, { status: 'dismissed', expectedVersion: 2, explanation: 'Admin handling complete.' }, 'admin');
        ok('existing note history never prevents required closure explanation', longHistoryClosure.statusCode === 200 && longHistoryClosure.body.adminNotes.length === 101 && longHistoryClosure.body.status === 'dismissed');

        // Route chain tests inspect the real middleware and reject missing
        // tokens locally: no Firebase calls or account mutations.
        const routes = [];
        const fakeApp = Object.fromEntries(['get', 'post', 'patch', 'delete'].map(method => [method, (path, ...handlers) => routes.push({ method, path, handlers })]));
        require('../routes/feedback')(fakeApp, { feedback: ctrl });
        ok('exactly ten feedback routes', routes.length === 10);
        ok('no customer review edit/delete route', !routes.some(r => ['patch', 'delete'].includes(r.method) && r.path.startsWith('/repair-requests/')));
        ok('all feedback routes authenticate before database access', routes.every(r => r.handlers[0].name === 'verifyFBToken' && r.handlers[1].name === 'ensureDatabaseReady'));
        ok('review route verifies email; safety report does not', routes.find(r => r.path.endsWith('/review')).handlers.some(h => h.name === 'verifyEmailVerified') && !routes.find(r => r.path.endsWith('/technician-reports') && r.method === 'post').handlers.some(h => h.name === 'verifyEmailVerified'));
        const auth = require('../middleware/auth');
        for (const role of ['customer', 'rider']) {
            const res = response(); let next = false;
            await auth.verifyAdmin({ decoded_email: actors[role].email, collections: c }, res, () => { next = true; });
            ok(`${role} denied by Admin middleware`, res.statusCode === 403 && !next);
        }
        const anonymous = response(); await auth.verifyFBToken({ headers: {} }, anonymous, () => {});
        ok('anonymous route denied before DB', anonymous.statusCode === 401);
    } finally {
        const repairIds = ids.map(String);
        const reports = await c.technicianReports.find({ repairRequestId: { $in: repairIds } }, { projection: { _id: 1 } }).toArray();
        await c.notifications.deleteMany({ entityType: 'technician_report', entityId: { $in: reports.map(r => String(r._id)) } });
        await c.technicianReports.deleteMany({ repairRequestId: { $in: repairIds } });
        await c.technicianReviews.deleteMany({ repairRequestId: { $in: repairIds } });
        await c.repairRequests.deleteMany({ _id: { $in: ids } });
        await c.technicians.deleteMany({ _id: { $in: technicians.map(t => t._id) } });
        await c.users.deleteMany({ _id: { $in: Object.values(actors).map(a => a._id) } });
    }
}

module.exports = { runFeedbackTests };
