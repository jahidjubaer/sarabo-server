const { generateTrackingId } = require('../utils/trackingId');
const { logTracking } = require('../middleware/logging');
const { VALID_STATUSES, isValidTransition } = require('../utils/parcelStatus');

class ParcelController {
    constructor(models, collections) {
        this.Parcel = models.Parcel;
        this.Rider = models.Rider;
        this.User = models.User;
        this.collections = collections;
    }

    async getAllParcels(req, res) {
        try {
            const query = {};
            const { email, deliveryStatus } = req.query;
            const currentUser = await this.User.findByEmail(req.decoded_email);

            // Non-admin users can only see their own repair requests
            if (!currentUser || currentUser.role !== 'admin') {
                query.senderEmail = req.decoded_email;
            } else if (email) {
                // Admins can filter by email
                query.senderEmail = email;
            }

            if (deliveryStatus) {
                query.deliveryStatus = deliveryStatus;
            }

            const result = await this.Parcel.findAll(query);
            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error fetching repair requests', error: error.message });
        }
    }

    async getRiderParcels(req, res) {
        try {
            const { deliveryStatus } = req.query;
            const query = { riderEmail: req.decoded_email };

            if (deliveryStatus !== 'parcel_delivered') {
                query.deliveryStatus = { $nin: ['parcel_delivered'] };
            } else {
                query.deliveryStatus = deliveryStatus;
            }

            const result = await this.Parcel.findAll(query);
            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error fetching technician repair requests', error: error.message });
        }
    }

    async getParcelById(req, res) {
        try {
            const id = req.params.id;
            const parcel = await this.Parcel.findById(id);
            
            if (!parcel) {
                return res.status(404).send({ message: 'repair request not found' });
            }
            
            const currentUser = await this.User.findByEmail(req.decoded_email);
            const isOwner = parcel.senderEmail === req.decoded_email;
            const isAssignedRider = parcel.riderEmail === req.decoded_email;
            const isAdmin = currentUser && currentUser.role === 'admin';
            
            if (!isOwner && !isAssignedRider && !isAdmin) {
                return res.status(403).send({ message: 'forbidden access' });
            }
            
            res.send(parcel);
        } catch (error) {
            res.status(500).send({ message: 'Error fetching repair request', error: error.message });
        }
    }

    async getDeliveryStatusStats(req, res) {
        try {
            const result = await this.Parcel.getDeliveryStatusStats();
            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error fetching repair status stats', error: error.message });
        }
    }

    async createParcel(req, res) {
        try {
            const parcel = req.body;
            const trackingId = generateTrackingId();
            parcel.createdAt = new Date();
            parcel.trackingId = trackingId;
            parcel.senderEmail = req.decoded_email;
            parcel.deliveryStatus = 'pending-pickup';

            logTracking(this.collections.trackings, trackingId, 'parcel_created');

            const result = await this.Parcel.create(parcel);
            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error creating repair request', error: error.message });
        }
    }

    async updateParcelStatus(req, res) {
        try {
            const { deliveryStatus, riderId, trackingId } = req.body;
            const id = req.params.id;
            
            const parcel = await this.Parcel.findById(id);
            if (!parcel) {
                return res.status(404).send({ message: 'repair request not found' });
            }
            
            const currentUser = await this.User.findByEmail(req.decoded_email);
            const isRider = currentUser && currentUser.role === 'rider';
            const isAdmin = currentUser && currentUser.role === 'admin';
            const isAssignedRider = parcel.riderEmail === req.decoded_email;
            
            // Only the assigned technician or admins can update the repair request status
            if (!isAdmin && !(isRider && isAssignedRider)) {
                return res.status(403).send({ message: 'forbidden access' });
            }

            if (!VALID_STATUSES.includes(deliveryStatus)) {
                return res.status(400).send({ message: 'invalid repair status' });
            }

            if (deliveryStatus === parcel.deliveryStatus) {
                // Idempotent re-submission of the current status: nothing to
                // persist, and no tracking log should be duplicated for it.
                return res.send({ message: 'status unchanged', matchedCount: 1, modifiedCount: 0 });
            }

            if (!isValidTransition(parcel.deliveryStatus, deliveryStatus)) {
                return res.status(400).send({ message: 'invalid status transition' });
            }

            const result = await this.Parcel.updateStatus(id, deliveryStatus);

            if (deliveryStatus === 'parcel_delivered' && riderId) {
                await this.Rider.updateWorkStatus(riderId, 'available');
            }

            logTracking(this.collections.trackings, trackingId, deliveryStatus);

            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error updating repair status', error: error.message });
        }
    }

    async assignRiderToParcel(req, res) {
        try {
            const { riderId, riderName, riderEmail, trackingId } = req.body;
            const id = req.params.id;

            const updatedDoc = {
                deliveryStatus: 'driver_assigned',
                riderId: riderId,
                riderName: riderName,
                riderEmail: riderEmail
            };

            const result = await this.Parcel.update(id, updatedDoc);
            await this.Rider.updateWorkStatus(riderId, 'in_delivery');
            logTracking(this.collections.trackings, trackingId, 'driver_assigned');

            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error assigning technician to repair request', error: error.message });
        }
    }

    async deleteParcel(req, res) {
        try {
            const id = req.params.id;
            const result = await this.Parcel.delete(id);
            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error deleting repair request', error: error.message });
        }
    }
}

module.exports = ParcelController;

