const UserController = require('./userController');
const ParcelController = require('./parcelController');
const RiderController = require('./riderController');
const PaymentController = require('./paymentController');
const TrackingController = require('./trackingController');
const NotificationController = require('./NotificationController');
const HealthController = require('./healthController');

function initializeControllers(models, collections) {
    return {
        user: new UserController(models),
        parcel: new ParcelController(models, collections),
        rider: new RiderController(models, collections),
        payment: new PaymentController(models, collections),
        tracking: new TrackingController(models, collections),
        notification: new NotificationController(models),
        health: new HealthController()
    };
}

module.exports = { initializeControllers };

