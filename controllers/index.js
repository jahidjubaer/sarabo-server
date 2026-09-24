const UserController = require('./userController');
const RepairRequestController = require('./repairRequestController');
const TechnicianController = require('./technicianController');
const PaymentController = require('./paymentController');
const TrackingController = require('./trackingController');
const NotificationController = require('./NotificationController');
const HealthController = require('./healthController');
const ServiceDefinitionController = require('./serviceDefinitionController');
const AdminServiceDefinitionController = require('./adminServiceDefinitionController');
const DamageUploadController = require('./damageUploadController');
const InspectionController = require('./inspectionController');
const QuoteController = require('./quoteController');
const RepairController = require('./repairController');
const WalletController = require('./walletController');
const SupportController = require('./supportController');
const FeedbackController = require('./feedbackController');
const PickupSlotController = require('./pickupSlotController');
const PickupReminderController = require('./pickupReminderController');
const { loadEmailConfig } = require('../config/email');
const { createEmailService } = require('../services/emailService');
const { connectDatabase } = require('../config/database');
const { loadAiSupportConfig } = require('../config/aiSupport');
const { createAiSupportService } = require('../services/aiSupportService');
const { createSupportKnowledgeService } = require('../services/supportKnowledgeService');
const { createConfiguredGeminiSupportProvider } = require('../services/aiProviders/geminiSupportProvider');

function initializeControllers(models, collections, dependencies = {}) {
    const aiSupportConfig = dependencies.aiSupportConfig || loadAiSupportConfig();
    let aiSupportService = dependencies.aiSupportService;
    if (!aiSupportService) {
        const hasInjectedProvider = Object.prototype.hasOwnProperty.call(dependencies, 'aiSupportProvider');
        const provider = hasInjectedProvider
            ? dependencies.aiSupportProvider
            : createConfiguredGeminiSupportProvider(aiSupportConfig, {
                client: dependencies.geminiClient,
                clientFactory: dependencies.geminiClientFactory,
            });
        aiSupportService = createAiSupportService({ provider, config: aiSupportConfig });
    }
    const supportKnowledgeService = dependencies.supportKnowledgeService || createSupportKnowledgeService({
        serviceDefinitionModel: models.ServiceDefinition,
        connectDatabase: dependencies.connectDatabase || connectDatabase,
    });

    // One email service for the whole app (a no-op unless EMAIL_ENABLED=true).
    const emailService = dependencies.emailService || createEmailService({ config: loadEmailConfig(), collections });

    return {
        user: new UserController(models, collections),
        repairRequest: new RepairRequestController(models, collections, undefined, { emailService }),
        technician: new TechnicianController(models, collections),
        payment: new PaymentController(models, collections),
        tracking: new TrackingController(models, collections),
        notification: new NotificationController(models),
        health: new HealthController(),
        serviceDefinition: new ServiceDefinitionController(models),
        adminServiceDefinition: new AdminServiceDefinitionController(models, collections),
        damageUpload: new DamageUploadController(models, collections),
        inspection: new InspectionController(models, collections),
        quote: new QuoteController(models, collections),
        repair: new RepairController(models, collections),
        wallet: new WalletController(models, collections),
        feedback: new FeedbackController(models, collections),
        pickupSlot: new PickupSlotController(models, collections, { emailService }),
        pickupReminder: new PickupReminderController(models, collections, { emailService }),
        support: new SupportController({
            aiSupportService,
            supportKnowledgeService,
            config: aiSupportConfig,
        }),
    };
}

module.exports = { initializeControllers };

