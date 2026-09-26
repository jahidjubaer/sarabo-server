const { ObjectId } = require('mongodb');
const { hasTechnicianFor, isMatchGateSkipped } = require('../services/technicianMatchGate');

const MAX_REGION_LENGTH = 150;

// GET /service-availability?region=&serviceDefinitionId= (job-portal phase A).
// Lets the create form warn the customer as soon as they pick the repair and
// region, instead of after they have filled everything in. Request creation
// re-checks on its own; this is only the early warning.
class ServiceAvailabilityController {
    constructor(models, collections, { skipMatchGate } = {}) {
        this.collections = collections;
        this.ServiceDefinition = models.ServiceDefinition;
        this.skipMatchGate = typeof skipMatchGate === 'boolean' ? () => skipMatchGate : () => isMatchGateSkipped();
    }

    async check(req, res) {
        try {
            const region = typeof req.query.region === 'string' ? req.query.region.trim() : '';
            const definitionId = req.query.serviceDefinitionId;
            if (!region || region.length > MAX_REGION_LENGTH) {
                return res.status(400).send({ message: 'region is required', code: 'INVALID_REGION' });
            }
            if (!ObjectId.isValid(definitionId)) {
                return res.status(400).send({ message: 'invalid service definition id', code: 'INVALID_SERVICE_DEFINITION_ID' });
            }
            const definition = await this.ServiceDefinition.findById(definitionId);
            if (!definition || definition.isActive !== true) {
                return res.status(404).send({ message: 'service not found', code: 'SERVICE_DEFINITION_NOT_FOUND' });
            }
            if (this.skipMatchGate()) return res.send({ available: true });
            res.send({ available: await hasTechnicianFor(this.collections, { region, definition }) });
        } catch (error) {
            res.status(500).send({ message: 'Error checking availability', code: 'INTERNAL_ERROR' });
        }
    }
}

module.exports = ServiceAvailabilityController;
