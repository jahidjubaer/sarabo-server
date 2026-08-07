const UserController = require('./userController');
const ParcelController = require('./parcelController');
const RiderController = require('./riderController');
const PaymentController = require('./paymentController');
const TrackingController = require('./trackingController');
const NotificationController = require('./NotificationController');
const HealthController = require('./healthController');
const ServiceDefinitionController = require('./serviceDefinitionController');
const DamageUploadController = require('./damageUploadController');
const InspectionController = require('./inspectionController');

function initializeControllers(models, collections) {
    return {
        user: new UserController(models, collections),
        parcel: new ParcelController(models, collections),
        rider: new RiderController(models, collections),
        payment: new PaymentController(models, collections),
        tracking: new TrackingController(models, collections),
        notification: new NotificationController(models),
        health: new HealthController(),
        serviceDefinition: new ServiceDefinitionController(models),
        damageUpload: new DamageUploadController(models, collections),
        inspection: new InspectionController(models, collections)
    };
}

module.exports = { initializeControllers };

