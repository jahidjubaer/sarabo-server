const { ObjectId } = require('mongodb');
const { client } = require('../config/database');
const { createNotificationService } = require('../services/notificationService');
const { logSafeError, getSafeLogPath } = require('../utils/safeLogger');
const { FeedbackError, REPORT_TRANSITIONS, normalizeEmail, objectId, validateReview, validateReport, validateVisibility, validateStatus, validateNote, validateList, assignmentTargets, reviewTarget, projectReview, projectReport } = require('../utils/feedback');

class FeedbackController {
    constructor(models, collections, dependencies = {}) {
        this.models = models;
        this.collections = collections;
        this.client = dependencies.client || client;
        this.notifications = dependencies.notifications || createNotificationService(models);
    }

    async actor(req, role, session) {
        const email = normalizeEmail(req.decoded_email);
        if (!email) throw new FeedbackError('AUTHENTICATION_REQUIRED', 'Authentication required.', 401);
        const user = await this.collections.users.findOne({ email }, { session, projection: { _id: 1, role: 1 } });
        if (!user || user.role !== role) throw new FeedbackError('FORBIDDEN', 'Access denied.', 403);
        return { id: user._id.toString(), email };
    }

    async ownedRepair(req, session) {
        const actor = await this.actor(req, 'user', session);
        const repair = await this.collections.repairRequests.findOne({ _id: objectId(req.params.id) }, { session });
        if (!repair || normalizeEmail(repair.senderEmail) !== actor.email) throw new FeedbackError('REQUEST_NOT_FOUND', 'Repair request not found.', 404);
        return { actor, repair };
    }

    async verifiedTargets(repair, session) {
        const targets = assignmentTargets(repair);
        if (!targets.length) return [];
        const technicians = await this.collections.technicians.find({ _id: { $in: targets.map(target => new ObjectId(target.technicianId)) } }, { session, projection: { _id: 1, email: 1 } }).toArray();
        const existing = new Map(technicians.map(technician => [technician._id.toString(), normalizeEmail(technician.email)]));
        return targets.filter(target => target.email && existing.get(target.technicianId) === target.email);
    }

    async execute(req, res, operation) {
        try {
            return await operation();
        } catch (error) {
            const known = error instanceof FeedbackError;
            const status = known ? error.status : 500;
            if (!known) logSafeError({ requestId: req.requestId, method: req.method, path: getSafeLogPath(req), status, category: 'INTERNAL_ERROR' });
            return res.status(status).send({ code: known ? error.code : 'FEEDBACK_UNAVAILABLE', message: known ? error.message : 'Feedback is temporarily unavailable.' });
        }
    }

    async summary(req, res) {
        return this.execute(req, res, async () => {
            const { actor, repair } = await this.ownedRepair(req);
            const repairRequestId = repair._id.toString();
            const [ownReview, reports, targets] = await Promise.all([
                this.models.TechnicianReview.findForRepair(repairRequestId),
                this.models.TechnicianReport.findForRepair(repairRequestId, actor.id),
                this.verifiedTargets(repair),
            ]);
            const final = reviewTarget(repair);
            const eligible = !!final && targets.some(target => target.technicianId === final.technicianId && target.assignmentId === final.assignmentId);
            const seen = new Set();
            const reportTargets = targets.slice().reverse().filter(target => {
                if (seen.has(target.technicianId)) return false;
                seen.add(target.technicianId);
                return !reports.some(report => report.technicianId === target.technicianId);
            }).map(target => ({ assignmentId: target.assignmentId, technicianName: target.name }));
            return res.send({ reviewEligibility: { eligible: eligible && !ownReview && req.decoded_email_verified === true, code: ownReview ? 'REVIEW_ALREADY_EXISTS' : !eligible ? 'REVIEW_NOT_ELIGIBLE' : req.decoded_email_verified !== true ? 'EMAIL_NOT_VERIFIED' : null }, ownReview: ownReview?.customerId === actor.id ? projectReview(ownReview) : null, reportTargets, reports: reports.map(report => projectReport(report)) });
        });
    }

    async create(req, res, kind) {
        return this.execute(req, res, async () => {
            const input = kind === 'review' ? validateReview(req.body) : validateReport(req.body);
            const session = this.client.startSession();
            let document;
            try {
                await session.withTransaction(async () => {
                    const { actor, repair } = await this.ownedRepair(req, session);
                    if (kind === 'review' && req.decoded_email_verified !== true) throw new FeedbackError('EMAIL_NOT_VERIFIED', 'Email verification required.', 403);
                    const targets = await this.verifiedTargets(repair, session);
                    const target = kind === 'review' ? reviewTarget(repair) : input.assignmentId
                        ? targets.find(candidate => candidate.assignmentId === input.assignmentId)
                        : targets.slice().reverse().find(candidate => candidate.technicianId === repair.technicianId && candidate.email === normalizeEmail(repair.technicianEmail));
                    if (!target || !targets.some(candidate => candidate.technicianId === target.technicianId && candidate.assignmentId === target.assignmentId)) throw new FeedbackError(kind === 'review' ? 'REVIEW_NOT_ELIGIBLE' : 'REPORT_NOT_ELIGIBLE', 'This repair does not have an eligible technician for this submission.', 409);
                    // Real write, not a no-op: serializes with the deletion
                    // transaction on this exact repair. If delete wins, retry
                    // sees no repair; if feedback wins, delete's guard fails.
                    const lock = await this.collections.repairRequests.updateOne({ _id: repair._id }, { $inc: { feedbackRevision: 1 } }, { session });
                    if (!lock.matchedCount) throw new FeedbackError('REQUEST_NOT_FOUND', 'Repair request not found.', 404);
                    const now = new Date();
                    document = { _id: new ObjectId(), repairRequestId: repair._id.toString(), customerId: actor.id, technicianId: target.technicianId, version: 1, createdAt: now, updatedAt: now };
                    if (kind === 'review') {
                        Object.assign(document, { rating: input.rating, comment: input.comment, visibility: 'visible', moderationHistory: [] });
                        await this.models.TechnicianReview.insert(document, { session });
                    } else {
                        Object.assign(document, { assignmentId: target.assignmentId, reason: input.reason, description: input.description, status: 'open', adminNotes: [], statusHistory: [], closedAt: null, closedBy: null });
                        await this.models.TechnicianReport.insert(document, { session });
                    }
                });
            } catch (error) {
                if (error.code === 11000) throw new FeedbackError(kind === 'review' ? 'REVIEW_ALREADY_EXISTS' : 'REPORT_ALREADY_EXISTS', 'Feedback has already been submitted for this repair and technician.', 409);
                throw error;
            } finally {
                await session.endSession();
            }
            if (kind === 'report') await this.notifyAdmins(req, document);
            return res.status(201).send(kind === 'review' ? projectReview(document) : projectReport(document));
        });
    }

    createReview(req, res) { return this.create(req, res, 'review'); }
    createReport(req, res) { return this.create(req, res, 'report'); }

    async notifyAdmins(req, document) {
        try {
            const emails = await this.models.User.findEmailsByRole('admin');
            for (const email of emails) {
                try {
                    await this.notifications.createNotification({ recipientEmail: email, recipientRole: 'admin', type: 'technician_report_submitted', entityType: 'technician_report', entityId: document._id.toString(), metadata: {} });
                } catch {
                    logSafeError({ requestId: req.requestId, method: req.method, path: getSafeLogPath(req), status: 500, category: 'INTERNAL_ERROR' });
                }
            }
        } catch {
            logSafeError({ requestId: req.requestId, method: req.method, path: getSafeLogPath(req), status: 500, category: 'INTERNAL_ERROR' });
        }
    }

    async technicianReviews(req, res) {
        return this.execute(req, res, async () => {
            const actor = await this.actor(req, 'rider');
            const technician = await this.collections.technicians.findOne({ email: actor.email }, { projection: { _id: 1 } });
            if (!technician) throw new FeedbackError('TECHNICIAN_NOT_FOUND', 'Technician not found.', 404);
            const pagination = validateList(req.query, 'technician');
            const technicianId = technician._id.toString();
            const [list, summary] = await Promise.all([this.models.TechnicianReview.list({ technicianId, visibility: 'visible' }, pagination), this.models.TechnicianReview.aggregate(technicianId)]);
            return res.send({ ...list, ...summary, items: list.items.map(item => projectReview(item, 'technician')) });
        });
    }

    async adminList(req, res, kind) {
        return this.execute(req, res, async () => {
            await this.actor(req, 'admin');
            const pagination = validateList(req.query, kind);
            const model = kind === 'review' ? this.models.TechnicianReview : this.models.TechnicianReport;
            const list = await model.list(pagination.filter, pagination);
            return res.send({ ...list, items: list.items.map(item => kind === 'review' ? projectReview(item, 'admin') : projectReport(item, true)) });
        });
    }

    listReviews(req, res) { return this.adminList(req, res, 'review'); }
    listReports(req, res) { return this.adminList(req, res, 'report'); }

    async reportDetail(req, res) {
        return this.execute(req, res, async () => {
            await this.actor(req, 'admin');
            objectId(req.params.id);
            const document = await this.models.TechnicianReport.findById(req.params.id);
            if (!document) throw new FeedbackError('REPORT_NOT_FOUND', 'Report not found.', 404);
            return res.send(projectReport(document, true));
        });
    }

    async moderate(req, res, kind) {
        return this.execute(req, res, async () => {
            const actor = await this.actor(req, 'admin');
            objectId(req.params.id);
            const now = new Date();
            let updated;
            if (kind === 'visibility') {
                const input = validateVisibility(req.body);
                updated = await this.models.TechnicianReview.moderate(req.params.id, input.expectedVersion, input.visibility, { visibility: input.visibility, reason: input.reason, adminId: actor.id, createdAt: now });
            } else if (kind === 'note') {
                const input = validateNote(req.body);
                updated = await this.models.TechnicianReport.appendNote(req.params.id, input.expectedVersion, { text: input.text, adminId: actor.id, createdAt: now });
            } else {
                const input = validateStatus(req.body);
                const document = await this.models.TechnicianReport.findById(req.params.id);
                if (!document) throw new FeedbackError('REPORT_NOT_FOUND', 'Report not found.', 404);
                if (document.version !== input.expectedVersion) throw new FeedbackError('FEEDBACK_CONFLICT', 'This record has changed. Refresh and try again.', 409);
                if (!REPORT_TRANSITIONS[document.status]?.includes(input.status)) throw new FeedbackError('REPORT_TRANSITION_NOT_ALLOWED', 'This report cannot move to that status.', 409);
                updated = await this.models.TechnicianReport.changeStatus(document, input.expectedVersion, input.status, actor.id, input.explanation, now);
            }
            if (!updated) throw new FeedbackError('FEEDBACK_CONFLICT', 'The record changed or is unavailable. Refresh and try again.', 409);
            return res.send(kind === 'visibility' ? projectReview(updated, 'admin') : projectReport(updated, true));
        });
    }

    visibility(req, res) { return this.moderate(req, res, 'visibility'); }
    status(req, res) { return this.moderate(req, res, 'status'); }
    note(req, res) { return this.moderate(req, res, 'note'); }
}

module.exports = FeedbackController;
