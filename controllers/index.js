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
const AdminReportController = require('./adminReportController');
const AdminAttentionController = require('./adminAttentionController');
const MissedPickupController = require('./missedPickupController');
const ServiceAvailabilityController = require('./serviceAvailabilityController');
const JobPortalController = require('./jobPortalController');
const InspectionFeeController = require('./inspectionFeeController');
const WarrantyController = require('./warrantyController');
const WorkflowController = require('./workflowController');
const AiRequestDraftController = require('./aiRequestDraftController');
const AdminReportSummaryController = require('./adminReportSummaryController');
const { loadEmailConfig } = require('../config/email');
const { createEmailService } = require('../services/emailService');
const { connectDatabase } = require('../config/database');
const { loadAiSupportConfig } = require('../config/aiSupport');
const { createAiSupportService } = require('../services/aiSupportService');
const { createSupportKnowledgeService } = require('../services/supportKnowledgeService');
const { createConfiguredGeminiSupportProvider } = require('../services/aiProviders/geminiSupportProvider');
const { loadAiRequestHelperConfig, loadAiOfferHelperConfig, loadAiReportSummaryConfig } = require('../config/aiRequestHelper');
const { createAiReportSummaryService } = require('../services/aiReportSummaryService');
const { createConfiguredGeminiReportSummaryProvider } = require('../services/aiProviders/geminiReportSummaryProvider');
const { createAiOfferNoteService } = require('../services/aiOfferNoteService');
const { createConfiguredGeminiOfferNoteProvider } = require('../services/aiProviders/geminiOfferNoteProvider');
const { createAiRequestDraftService } = require('../services/aiRequestDraftService');
const { createConfiguredGeminiRequestDraftProvider } = require('../services/aiProviders/geminiRequestDraftProvider');

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

    const aiRequestHelperConfig = dependencies.aiRequestHelperConfig || loadAiRequestHelperConfig();
    const aiRequestDraftService = dependencies.aiRequestDraftService || createAiRequestDraftService({
        provider: Object.prototype.hasOwnProperty.call(dependencies, 'aiRequestDraftProvider')
            ? dependencies.aiRequestDraftProvider
            : createConfiguredGeminiRequestDraftProvider(aiRequestHelperConfig, {
                client: dependencies.geminiClient,
                clientFactory: dependencies.geminiClientFactory,
            }),
        config: aiRequestHelperConfig,
        serviceDefinitionModel: models.ServiceDefinition,
    });

    const aiOfferHelperConfig = dependencies.aiOfferHelperConfig || loadAiOfferHelperConfig();
    const aiOfferNoteService = dependencies.aiOfferNoteService || createAiOfferNoteService({
        provider: Object.prototype.hasOwnProperty.call(dependencies, 'aiOfferNoteProvider')
            ? dependencies.aiOfferNoteProvider
            : createConfiguredGeminiOfferNoteProvider(aiOfferHelperConfig, {
                client: dependencies.geminiClient,
                clientFactory: dependencies.geminiClientFactory,
            }),
        config: aiOfferHelperConfig,
    });

    const aiReportSummaryConfig = dependencies.aiReportSummaryConfig || loadAiReportSummaryConfig();
    const aiReportSummaryService = dependencies.aiReportSummaryService || createAiReportSummaryService({
        provider: Object.prototype.hasOwnProperty.call(dependencies, 'aiReportSummaryProvider')
            ? dependencies.aiReportSummaryProvider
            : createConfiguredGeminiReportSummaryProvider(aiReportSummaryConfig, {
                client: dependencies.geminiClient,
                clientFactory: dependencies.geminiClientFactory,
            }),
        config: aiReportSummaryConfig,
    });

    // One email service for the whole app (a no-op unless EMAIL_ENABLED=true).
    const emailService = dependencies.emailService || createEmailService({ config: loadEmailConfig(), collections });

    const adminReport = new AdminReportController(models, collections);
    const adminAttention = new AdminAttentionController(models, collections);

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
        adminReport,
        adminAttention,
        adminReportSummary: new AdminReportSummaryController({
            collections, reportController: adminReport, attentionController: adminAttention, aiReportSummaryService,
        }),
        missedPickup: new MissedPickupController(models, collections),
        serviceAvailability: new ServiceAvailabilityController(models, collections),
        jobPortal: new JobPortalController(models, collections, { aiOfferNoteService }),
        inspectionFee: new InspectionFeeController(models, collections),
        warranty: new WarrantyController(models, collections),
        workflow: new WorkflowController(models, collections),
        aiRequestDraft: new AiRequestDraftController({ aiRequestDraftService, aiOfferNoteService, aiReportSummaryService, config: aiRequestHelperConfig }),
        support: new SupportController({
            aiSupportService,
            supportKnowledgeService,
            config: aiSupportConfig,
        }),
    };
}

module.exports = { initializeControllers };

