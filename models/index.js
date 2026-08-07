const UserModel = require('./User');
const ParcelModel = require('./Parcel');
const RiderModel = require('./Rider');
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
        Parcel: new ParcelModel(collections.parcels),
        Rider: new RiderModel(collections.riders),
        Payment: new PaymentModel(collections.payments),
        Tracking: new TrackingModel(collections.trackings),
        Notification: new NotificationModel(collections.notifications),
        ServiceDefinition: new ServiceDefinitionModel(collections.serviceDefinitions),
        DamageUploadSession: new DamageUploadSessionModel(collections.damageUploadSessions),
        RepairEvidenceSession: new RepairEvidenceSessionModel(collections.repairEvidenceSessions),
        DeletionCleanup: new DeletionCleanupModel(collections.deletionCleanups)
    };
}

module.exports = { initializeModels };

