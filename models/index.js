const UserModel = require('./User');
const RepairRequestModel = require('./RepairRequest');
const TechnicianModel = require('./Technician');
const PaymentModel = require('./Payment');
const TrackingModel = require('./Tracking');
const NotificationModel = require('./Notification');
const { ServiceDefinitionModel } = require('./ServiceDefinition');
const DamageUploadSessionModel = require('./DamageUploadSession');
const RepairEvidenceSessionModel = require('./RepairEvidenceSession');
const DeletionCleanupModel = require('./DeletionCleanup');

function initializeModels(collections) {
    return {
        User: new UserModel(collections.users),
        RepairRequest: new RepairRequestModel(collections.repairRequests),
        Technician: new TechnicianModel(collections.technicians),
        Payment: new PaymentModel(collections.payments),
        Tracking: new TrackingModel(collections.trackingEvents),
        Notification: new NotificationModel(collections.notifications),
        ServiceDefinition: new ServiceDefinitionModel(collections.serviceDefinitions),
        DamageUploadSession: new DamageUploadSessionModel(collections.damageUploadSessions),
        RepairEvidenceSession: new RepairEvidenceSessionModel(collections.repairEvidenceSessions),
        DeletionCleanup: new DeletionCleanupModel(collections.deletionCleanups)
    };
}

module.exports = { initializeModels };

