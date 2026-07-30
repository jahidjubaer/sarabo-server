const UserModel = require('./User');
const ParcelModel = require('./Parcel');
const RiderModel = require('./Rider');
const PaymentModel = require('./Payment');
const TrackingModel = require('./Tracking');
const NotificationModel = require('./Notification');

function initializeModels(collections) {
    return {
        User: new UserModel(collections.users),
        Parcel: new ParcelModel(collections.parcels),
        Rider: new RiderModel(collections.riders),
        Payment: new PaymentModel(collections.payments),
        Tracking: new TrackingModel(collections.trackings),
        Notification: new NotificationModel(collections.notifications)
    };
}

module.exports = { initializeModels };

