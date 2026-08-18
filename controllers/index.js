const UserController = require('./userController');
const RepairRequestController = require('./repairRequestController');
const TechnicianController = require('./technicianController');
const PaymentController = require('./paymentController');
const TrackingController = require('./trackingController');
const NotificationController = require('./NotificationController');
const HealthController = require('./healthController');
const ServiceDefinitionController = require('./serviceDefinitionController');
const DamageUploadController = require('./damageUploadController');
const InspectionController = require('./inspectionController');
const QuoteController = require('./quoteController');
const RepairController = require('./repairController');
const WalletController = require('./walletController');

function initializeControllers(models, collections) {
    return {
        user: new UserController(models, collections),
        repairRequest: new RepairRequestController(models, collections),
        technician: new TechnicianController(models, collections),
        payment: new PaymentController(models, collections),
        tracking: new TrackingController(models, collections),
        notification: new NotificationController(models),
        health: new HealthController(),
        serviceDefinition: new ServiceDefinitionController(models),
        damageUpload: new DamageUploadController(models, collections),
        inspection: new InspectionController(models, collections),
        quote: new QuoteController(models, collections),
        repair: new RepairController(models, collections),
        wallet: new WalletController(models, collections)
    };
}

module.exports = { initializeControllers };

