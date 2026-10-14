// Job portal (job-portal phase B): who sees an open request, applying and
// withdrawing, what the customer sees, accepting (which books the
// technician), invitations, photo access and the 24-hour alert. Open jobs
// board: the public listing, rejecting an offer (repost) and one revised offer.
const { ObjectId } = require('mongodb');

function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        send(payload) { this.body = payload; return this; },
    };
}

async function runJobPortalTests({ logTest }) {
    const { connectDatabase, collections: c } = require('../config/database');
    const { initializeModels } = require('../models');
    const JobPortalController = require('../controllers/jobPortalController');
    const AdminAttentionController = require('../controllers/adminAttentionController');
    const { resolveImageAccess } = require('../services/damageImageAccessService');
    const { validateApplicationInput, isOpenForApplications } = require('../utils/jobPortal');
    const routes = require('../routes/jobPortal');
    const { verifyFBToken, verifyAdmin, verifyTechnician, verifyEmailVerified } = require('../middleware/auth');
    if (process.env.NODE_ENV !== 'test' || !c.repairRequests.dbName.includes('test') || c.repairRequests.dbName === 'sarabo-db') {
        throw new Error('Isolated test database required');
    }
    await connectDatabase();
    const models = initializeModels(c);
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const REGION = `PortalRegion-${runId}`;
    const CUSTOMER = `portal-customer-${runId}@example.test`;
    const ADMIN = `portal-admin-${runId}@example.test`;
    const emails = [CUSTOMER, ADMIN];
    const requestIds = [];
    const technicianIds = [];

    const portal = new JobPortalController(models, c);
    const call = async (method, email, req = {}) => {
        const res = fakeRes();
        await portal[method]({ decoded_email: email, params: {}, query: {}, body: {}, ...req }, res);
        return res;
    };
    const definition = await c.serviceDefinitions.findOne({ isActive: true, 'pricingRule.inspectionFee': { $gt: 0 } })
        || await c.serviceDefinitions.findOne({ isActive: true });
    // At least the 200 BDT floor for these 3,000 BDT estimates (utils/inspectionFee.js).
    const cap = Math.max(Math.floor(definition.pricingRule.inspectionFee || 0), 200);
    const insertTech = async (name, overrides = {}) => {
        const email = `portal-${name}-${runId}@example.test`;
        emails.push(email);
        await c.users.insertOne({ email, role: 'rider', createdAt: new Date() });
        const { insertedId } = await c.technicians.insertOne({
            name: `${name} ${runId}`, email, region: REGION, district: 'Near', status: 'approved', workStatus: 'available', createdAt: new Date(),
            expertise: [{ productCategorySlug: definition.productCategorySlug, repairCategorySlugs: [definition.repairCategorySlug], level: 'expert', experienceYears: 9 }],
            ...overrides,
        });
        technicianIds.push(insertedId);
        return { id: insertedId.toString(), email };
    };
    const photo = (uploadedAt) => ({ storageKey: `k-${runId}-${Math.random()}`, url: 'x', mimeType: 'image/jpeg', size: 1, uploadedAt, uploadedByRole: 'user' });
    const insertRequest = async (overrides = {}) => {
        const { insertedId } = await c.repairRequests.insertOne({
            schemaVersion: 2, senderEmail: CUSTOMER, trackingId: `PORTAL-${runId}-${requestIds.length}`,
            product: { categorySlug: definition.productCategorySlug, brand: 'PortalBrand', model: 'P1' },
            service: { definitionId: definition._id.toString(), repairCategorySlug: definition.repairCategorySlug },
            damage: { description: 'Portal test problem description.', images: [photo(new Date())] },
            serviceLocation: { region: REGION, district: 'Near', address: 'SECRET STREET 12' },
            pricing: { currency: 'BDT', estimateMin: 1000, estimateMax: 3000, inspectionFee: cap },
            deliveryStatus: 'pending-pickup', createdAt: new Date(), ...overrides,
        });
        requestIds.push(insertedId);
        return insertedId.toString();
    };
    // Offers charge the 200 BDT floor. The accept tests below use an offer made
    // before the floor (fee 0), which books straight away; the paid-fee flow is
    // covered in tests/inspectionFeeTests.js.
    const good = { estimateMin: 1200, estimateMax: 2500, inspectionFee: 200, note: 'Screen connector, likely.' };

    try {
        await c.users.insertMany([{ email: CUSTOMER, role: 'user', createdAt: new Date() }, { email: ADMIN, role: 'admin', createdAt: new Date() }]);

        // ---- pure rules ----
        logTest('Job portal: an application needs a sensible estimate, a fee within the limit and a short note',
            validateApplicationInput({ ...good, inspectionFee: cap }, { maxFee: cap }).valid
            && validateApplicationInput({ ...good, estimateMin: 3000 }, { maxFee: cap }).code === 'INVALID_ESTIMATE'
            && validateApplicationInput({ ...good, inspectionFee: cap + 1 }, { maxFee: cap }).code === 'INSPECTION_FEE_TOO_HIGH'
            && validateApplicationInput({ ...good, estimateMax: 1.5 }, { maxFee: cap }).code === 'INVALID_ESTIMATE'
            && validateApplicationInput({ ...good, note: 'x'.repeat(501) }, { maxFee: cap }).code === 'INVALID_NOTE');
        logTest('Job portal: a waiting v2 request with no technician is open, with or without photos',
            isOpenForApplications({ schemaVersion: 2, deliveryStatus: 'pending-pickup', damage: { images: [photo(new Date())] } })
            && isOpenForApplications({ schemaVersion: 2, deliveryStatus: 'pending-pickup', damage: { images: [] } })
            && !isOpenForApplications({ schemaVersion: 2, deliveryStatus: 'picked-up', damage: { images: [] } })
            && !isOpenForApplications({ schemaVersion: 2, deliveryStatus: 'pending-pickup', technicianId: 'x', damage: { images: [photo(new Date())] } }));

        const alpha = await insertTech('alpha');
        const beta = await insertTech('beta');
        const outsider = await insertTech('outsider', { region: `Other-${runId}` });
        const open = await insertRequest();
        const noPhoto = await insertRequest({ damage: { description: 'No photo yet.', images: [] } });

        // ---- the portal ----
        const alphaPortal = await call('listPortal', alpha.email);
        const job = alphaPortal.body.jobs.find((j) => j.id === open);
        logTest('Job portal: a qualified local technician sees open requests, including one without photos',
            alphaPortal.statusCode === 200 && !!job && alphaPortal.body.jobs.some((j) => j.id === noPhoto && j.photoCount === 0));
        logTest('Job portal: the listing shows the district, problem and fee limit - never the address or customer',
            job && job.district === 'Near' && job.maxInspectionFee === cap && !JSON.stringify(alphaPortal.body).includes('SECRET STREET') && !JSON.stringify(alphaPortal.body).includes(CUSTOMER));
        logTest('Job portal: a technician in another region does not see it and cannot apply',
            !(await call('listPortal', outsider.email)).body.jobs.some((j) => j.id === open)
            && (await call('apply', outsider.email, { params: { id: open }, body: good })).body.code === 'JOB_NOT_OPEN');
        logTest('Job portal: a customer is not a technician here', (await call('listPortal', CUSTOMER)).statusCode === 403);

        // ---- photos ----
        const openDoc = await c.repairRequests.findOne({ _id: new ObjectId(open) });
        const alphaAccess = await resolveImageAccess({ repairRequest: openDoc, callerEmail: alpha.email, models });
        const outsiderAccess = await resolveImageAccess({ repairRequest: openDoc, callerEmail: outsider.email, models });
        logTest('Job portal: technicians who could take an open request may see its photos; others may not',
            alphaAccess.allowed && alphaAccess.accessRole === 'prospective-technician' && !outsiderAccess.allowed);

        // ---- applying ----
        const applied = await call('apply', alpha.email, { params: { id: open }, body: good });
        const tooHigh = await call('apply', beta.email, { params: { id: open }, body: { ...good, inspectionFee: cap + 50 } });
        const betaApplied = await call('apply', beta.email, { params: { id: open }, body: { ...good, estimateMin: 900, estimateMax: 2000 } });
        logTest('Job portal: technicians apply; a fee above the limit is refused',
            applied.statusCode === 201 && betaApplied.statusCode === 201 && tooHigh.statusCode === 400 && tooHigh.body.code === 'INSPECTION_FEE_TOO_HIGH');
        const updated = await call('apply', alpha.email, { params: { id: open }, body: { ...good, estimateMax: 2800 } });
        logTest('Job portal: applying again updates the application instead of duplicating it',
            updated.statusCode === 200 && (await c.jobApplications.countDocuments({ requestId: open, technicianId: alpha.id })) === 1);
        logTest('Job portal: the customer is told once per technician',
            (await c.notifications.countDocuments({ recipientEmail: CUSTOMER, type: 'application_received', entityId: open })) === 2);

        // ---- what the customer sees ----
        const listed = await call('listForRequest', CUSTOMER, { params: { id: open } });
        const alphaApp = listed.body.applications.find((a) => a.technician.name.startsWith('alpha'));
        logTest('Job portal: the customer compares applications with public technician facts only',
            listed.statusCode === 200 && listed.body.open === true && listed.body.applications.length === 2
            && alphaApp.estimateMax === 2800 && alphaApp.technician.level === 'expert' && typeof alphaApp.technician.completedRepairs === 'number'
            && !JSON.stringify(listed.body).includes(alpha.email));
        logTest('Job portal: another customer cannot see them',
            (await call('listForRequest', `stranger-${runId}@example.test`, { params: { id: open } })).statusCode === 404);

        // ---- withdraw ----
        const gamma = await insertTech('gamma');
        await call('apply', gamma.email, { params: { id: open }, body: good });
        const withdrawn = await call('withdraw', gamma.email, { params: { id: open } });
        logTest('Job portal: a technician can withdraw, and the customer no longer sees it',
            withdrawn.statusCode === 200 && (await call('listForRequest', CUSTOMER, { params: { id: open } })).body.applications.length === 2);

        // ---- accept ----
        const busyTech = await insertTech('busy', { workStatus: 'in_delivery' });
        await call('apply', busyTech.email, { params: { id: open }, body: good });
        const busyApp = await c.jobApplications.findOne({ requestId: open, technicianId: busyTech.id });
        logTest('Job portal: a technician on another job cannot be accepted right now',
            (await call('accept', CUSTOMER, { params: { id: open, applicationId: busyApp._id.toString() } })).body.code === 'TECHNICIAN_BUSY');
        await c.jobApplications.updateMany({ requestId: open }, { $set: { inspectionFee: 0 } });
        const alphaDoc = await c.jobApplications.findOne({ requestId: open, technicianId: alpha.id });
        logTest('Job portal: only the owner can accept',
            (await call('accept', `stranger-${runId}@example.test`, { params: { id: open, applicationId: alphaDoc._id.toString() } })).statusCode === 404);
        const accepted = await call('accept', CUSTOMER, { params: { id: open, applicationId: alphaDoc._id.toString() } });
        const bookedRequest = await c.repairRequests.findOne({ _id: new ObjectId(open) });
        const alphaTech = await c.technicians.findOne({ _id: new ObjectId(alpha.id) });
        logTest('Job portal: accepting books the technician for the request',
            accepted.statusCode === 200 && bookedRequest.deliveryStatus === 'driver_assigned' && bookedRequest.technicianId === alpha.id
            && accepted.body.booked === true && alphaTech.workStatus === 'in_delivery' && bookedRequest.acceptedApplication.inspectionFee === 0
            && bookedRequest.assignmentHistory.slice(-1)[0].decision === 'accepted' && bookedRequest.assignmentHistory.slice(-1)[0].source === 'job_portal');
        const statuses = Object.fromEntries((await c.jobApplications.find({ requestId: open }).toArray()).map((a) => [a.technicianId, a.status]));
        logTest('Job portal: the chosen application is accepted and the other pending ones are closed',
            statuses[alpha.id] === 'accepted' && statuses[beta.id] === 'not_chosen' && statuses[busyTech.id] === 'not_chosen' && statuses[gamma.id] === 'withdrawn');
        logTest('Job portal: the chosen and the other technicians are told',
            (await c.notifications.countDocuments({ recipientEmail: alpha.email, type: 'application_accepted', entityId: open })) === 1
            && (await c.notifications.countDocuments({ recipientEmail: beta.email, type: 'application_not_chosen', entityId: open })) === 1);
        logTest('Job portal: the request leaves the portal, a second accept is refused, and photo access ends for others',
            !(await call('listPortal', beta.email)).body.jobs.some((j) => j.id === open)
            && (await call('accept', CUSTOMER, { params: { id: open, applicationId: alphaDoc._id.toString() } })).statusCode === 409
            && !(await resolveImageAccess({ repairRequest: bookedRequest, callerEmail: beta.email, models })).allowed);

        // ---- open jobs board (no sign-in) ----
        const board = await insertRequest();
        const pub = fakeRes();
        await portal.listPublic({ query: {} }, pub);
        const pubJob = pub.body.jobs.find((j) => j.id === board);
        const pubText = JSON.stringify(pub.body);
        logTest('Open jobs: anyone sees a safe summary - no problem text, photos, tracking id, address or customer',
            pub.statusCode === 200 && !!pubJob && pubJob.district === 'Near' && pubJob.offers === 0 && !('photoCount' in pubJob)
            && pub.body.jobs.some((j) => j.id === noPhoto) && !pub.body.jobs.some((j) => j.id === open)
            && !pubText.includes('Portal test problem') && !pubText.includes('SECRET STREET') && !pubText.includes(`PORTAL-${runId}`) && !pubText.includes(CUSTOMER));
        const pubOther = fakeRes();
        await portal.listPublic({ query: { region: `Other-${runId}` } }, pubOther);
        logTest('Open jobs: the board can be filtered by region', pubOther.statusCode === 200 && !pubOther.body.jobs.some((j) => j.id === board));

        // ---- rejecting an offer reposts the request ----
        await call('apply', beta.email, { params: { id: board }, body: good });
        const betaBoardApp = await c.jobApplications.findOne({ requestId: board, technicianId: beta.id });
        const rejectReq = (body = {}) => ({ params: { id: board, applicationId: betaBoardApp._id.toString() }, body });
        logTest('Open jobs: only the owner can reject an offer, with a known reason',
            (await call('decline', `stranger-${runId}@example.test`, rejectReq())).statusCode === 404
            && (await call('decline', CUSTOMER, rejectReq({ reason: 'nope' }))).body.code === 'INVALID_DECLINE_REASON');
        const declined = await call('decline', CUSTOMER, rejectReq({ reason: 'price', note: 'Too expensive for me.' }));
        const repostedDoc = await c.repairRequests.findOne({ _id: new ObjectId(board) });
        const betaView = (await call('listPortal', beta.email)).body.jobs.find((j) => j.id === board);
        logTest('Open jobs: rejecting an offer reposts the request, and the technician is told they may revise it',
            declined.statusCode === 200 && repostedDoc.repostCount === 1 && !!repostedDoc.repostedAt
            && !!betaView && betaView.reposted === true && betaView.myApplication.status === 'declined' && betaView.myApplication.canReoffer === true
            && (await c.notifications.countDocuments({ recipientEmail: beta.email, type: 'application_declined', entityId: board })) === 1);
        const repostNotes = async (email) => c.notifications.countDocuments({ recipientEmail: email, type: 'job_reposted', entityId: board });
        logTest('Open jobs: other local technicians who could take it are told it is open again - not the rejected one or outsiders',
            (await repostNotes(gamma.email)) === 1 && (await repostNotes(alpha.email)) === 1
            && (await repostNotes(beta.email)) === 0 && (await repostNotes(outsider.email)) === 0);
        const listedAfter = await call('listForRequest', CUSTOMER, { params: { id: board } });
        logTest('Open jobs: the customer still sees the rejected offer, marked rejected',
            listedAfter.body.applications.length === 1 && listedAfter.body.applications[0].status === 'declined'
            && listedAfter.body.applications[0].declineReason === 'price' && listedAfter.body.repostCount === 1 && listedAfter.body.open === true);
        logTest('Open jobs: a rejected offer cannot be accepted or rejected again',
            (await call('accept', CUSTOMER, rejectReq())).body.code === 'APPLICATION_NOT_PENDING'
            && (await call('decline', CUSTOMER, rejectReq())).body.code === 'APPLICATION_NOT_PENDING');
        const revised = await call('apply', beta.email, { params: { id: board }, body: { ...good, estimateMin: 800, estimateMax: 1500 } });
        const revisedDoc = await c.jobApplications.findOne({ requestId: board, technicianId: beta.id });
        logTest('Open jobs: the technician sends one revised offer, and the customer is told',
            revised.statusCode === 200 && revisedDoc.status === 'pending' && revisedDoc.revisedAfterDecline === true && revisedDoc.estimateMax === 1500
            && (await c.notifications.countDocuments({ recipientEmail: CUSTOMER, type: 'application_received', entityId: board })) === 2);
        await call('decline', CUSTOMER, rejectReq());
        const blocked = await call('apply', beta.email, { params: { id: board }, body: good });
        logTest('Open jobs: once the revised offer is rejected too, no further offer is allowed',
            blocked.statusCode === 409 && blocked.body.code === 'APPLICATION_CLOSED'
            && (await call('listPortal', beta.email)).body.jobs.find((j) => j.id === board).myApplication.canReoffer === false
            && (await c.repairRequests.findOne({ _id: new ObjectId(board) })).repostCount === 2
            && (await repostNotes(gamma.email)) === 2
            && (await c.notifications.countDocuments({ recipientEmail: beta.email, type: 'application_declined', entityId: board })) === 2);

        // ---- invitations ----
        const second = await insertRequest();
        const invited = await call('invite', ADMIN, { params: { id: second }, body: { technicianId: beta.id } });
        logTest('Job portal: an admin can invite a qualified technician once, who is notified and sees it marked',
            invited.statusCode === 200 && (await call('invite', ADMIN, { params: { id: second }, body: { technicianId: beta.id } })).body.code === 'ALREADY_INVITED'
            && (await c.notifications.countDocuments({ recipientEmail: beta.email, type: 'job_invitation', entityId: second })) === 1
            && (await call('listPortal', beta.email)).body.jobs.find((j) => j.id === second).invited === true);
        logTest('Job portal: inviting someone who cannot take it is refused',
            (await call('invite', ADMIN, { params: { id: second }, body: { technicianId: outsider.id } })).body.code === 'TECHNICIAN_NOT_ELIGIBLE');

        // ---- 24 hours ----
        const dayAgo = () => new Date(Date.now() - 25 * 3600000);
        const stale = await insertRequest({ damage: { description: 'Old request.', images: [photo(dayAgo())] }, createdAt: dayAgo() });
        await call('apply', beta.email, { params: { id: stale }, body: good });
        const silent = await insertRequest({ damage: { description: 'Nobody answered.', images: [] }, createdAt: dayAgo() });
        const repostedRecently = await insertRequest({ damage: { description: 'Reposted.', images: [photo(dayAgo())] }, createdAt: dayAgo(), repostedAt: new Date(), repostCount: 1 });
        const attentionRes = fakeRes();
        await new AdminAttentionController(models, c).getAttention({}, attentionRes);
        const unchosenIds = attentionRes.body.unchosen.map((r) => r.id);
        logTest('Open jobs: 24 hours after posting, the admin is alerted only when no technician has sent an offer',
            unchosenIds.includes(silent) && !unchosenIds.includes(stale) && !unchosenIds.includes(second) && !unchosenIds.includes(board));
        logTest('Open jobs: a repost restarts the 24-hour clock', !unchosenIds.includes(repostedRecently));

        // ---- routes ----
        const captured = [];
        const capture = (method) => (path, ...handlers) => captured.push({ method, path, handlers });
        routes({ get: capture('GET'), post: capture('POST') }, { jobPortal: portal });
        const find = (method, path) => captured.find((r) => r.method === method && r.path === path);
        logTest('Job portal: technician routes need the technician role, accepting a verified email, inviting an admin',
            captured.every((r) => r.path === '/jobs' || r.handlers.includes(verifyFBToken))
            && !find('GET', '/jobs').handlers.includes(verifyFBToken)
            && !!find('POST', '/repair-requests/:id/applications/:applicationId/decline')
            && find('GET', '/technician/job-portal').handlers.includes(verifyTechnician)
            && find('POST', '/repair-requests/:id/applications').handlers.includes(verifyTechnician)
            && find('POST', '/repair-requests/:id/applications/:applicationId/accept').handlers.includes(verifyEmailVerified)
            && find('POST', '/admin/repair-requests/:id/invite').handlers.includes(verifyAdmin));
    } finally {
        const ids = requestIds.map(String);
        await c.jobApplications.deleteMany({ requestId: { $in: ids } });
        await c.notifications.deleteMany({ entityId: { $in: ids } });
        if (requestIds.length) {
            const tracking = (await c.repairRequests.find({ _id: { $in: requestIds } }, { projection: { trackingId: 1 } }).toArray()).map((r) => r.trackingId);
            await c.trackingEvents.deleteMany({ trackingId: { $in: tracking } });
            await c.repairRequests.deleteMany({ _id: { $in: requestIds } });
        }
        if (technicianIds.length) await c.technicians.deleteMany({ _id: { $in: technicianIds } });
        await c.users.deleteMany({ email: { $in: emails } });
    }
}

module.exports = { runJobPortalTests };
