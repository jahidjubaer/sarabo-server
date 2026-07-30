// Single source of truth for every notification event type this project can
// create - mirrors utils/parcelStatus.js and utils/riderStatus.js's role as
// the one place a business-state enum and its rules live. A caller (see
// services/notificationService.js) only ever supplies a `type` plus a small
// set of identity/entity/metadata fields; every visible piece of copy
// (title/message/actionUrl/deduplicationKey) is rendered from here, never
// accepted from the caller.
//
// `priority: 'high'` is kept in the allowed enum as a safe, forward-
// compatible value - no V1 event definition below uses it, and nothing here
// currently produces it.
const ENTITY_TYPES = ['parcel', 'rider'];
const ROLES = ['user', 'rider', 'admin'];
const PRIORITIES = ['normal', 'high'];

// Every definition owns: entityType, the role a notification of this type is
// always addressed to, priority (always 'normal' in V1), the metadata keys
// it will accept, which of those are required to render a safe message
// (never silently rendering "undefined"), and the four template functions.
// Template functions receive `{ entityId, metadata }` - only the fields a
// given template actually needs are used.
const NOTIFICATION_EVENTS = {
    technician_application_submitted: {
        entityType: 'rider',
        recipientRole: 'admin',
        priority: 'normal',
        allowedMetadataKeys: [],
        requiresMetadata: [],
        title: () => 'New technician application',
        message: () => 'A new technician application is awaiting review.',
        actionUrl: () => '/dashboard/approve-technicians',
        deduplicationKey: ({ entityId }) => `rider:${entityId}:application_submitted`,
    },
    technician_application_approved: {
        entityType: 'rider',
        recipientRole: 'rider',
        priority: 'normal',
        allowedMetadataKeys: [],
        requiresMetadata: [],
        title: () => 'Your technician application was approved',
        message: () => 'You can now access assigned repairs.',
        actionUrl: () => '/dashboard/assigned-jobs',
        deduplicationKey: ({ entityId }) => `rider:${entityId}:approved`,
    },
    technician_application_rejected: {
        entityType: 'rider',
        recipientRole: 'rider',
        priority: 'normal',
        allowedMetadataKeys: [],
        requiresMetadata: [],
        title: () => 'Your technician application was not approved',
        message: () => 'Your technician application was not approved at this time.',
        actionUrl: () => '/dashboard',
        deduplicationKey: ({ entityId }) => `rider:${entityId}:rejected`,
    },
    technician_assigned: {
        entityType: 'parcel',
        recipientRole: 'user',
        priority: 'normal',
        allowedMetadataKeys: ['trackingId'],
        requiresMetadata: ['trackingId'],
        title: () => 'A technician has been assigned',
        message: ({ metadata }) => `A technician has been assigned to your repair request ${metadata.trackingId}.`,
        actionUrl: ({ entityId }) => `/dashboard/my-requests/${entityId}`,
        deduplicationKey: ({ entityId }) => `repair:${entityId}:technician_assigned:customer`,
    },
    new_repair_assignment: {
        entityType: 'parcel',
        recipientRole: 'rider',
        priority: 'normal',
        // trackingId is accepted (for future use/consistency) but not
        // required - this template's message does not interpolate it.
        allowedMetadataKeys: ['trackingId'],
        requiresMetadata: [],
        title: () => 'New repair assignment',
        message: () => 'You have been assigned a new repair request.',
        actionUrl: () => '/dashboard/assigned-jobs',
        deduplicationKey: ({ entityId }) => `repair:${entityId}:technician_assigned:technician`,
    },
    technician_on_the_way: {
        entityType: 'parcel',
        recipientRole: 'user',
        priority: 'normal',
        allowedMetadataKeys: ['trackingId'],
        requiresMetadata: ['trackingId'],
        title: () => 'Technician on the way',
        message: ({ metadata }) => `Your technician is on the way for repair request ${metadata.trackingId}.`,
        actionUrl: ({ entityId }) => `/dashboard/my-requests/${entityId}`,
        deduplicationKey: ({ entityId }) => `repair:${entityId}:status:rider_arriving`,
    },
    repair_in_progress: {
        entityType: 'parcel',
        recipientRole: 'user',
        priority: 'normal',
        allowedMetadataKeys: ['trackingId'],
        requiresMetadata: ['trackingId'],
        title: () => 'Repair work started',
        message: ({ metadata }) => `Work has started on your repair request ${metadata.trackingId}.`,
        actionUrl: ({ entityId }) => `/dashboard/my-requests/${entityId}`,
        deduplicationKey: ({ entityId }) => `repair:${entityId}:status:parcel_picked_up`,
    },
    repair_completed: {
        entityType: 'parcel',
        recipientRole: 'user',
        priority: 'normal',
        allowedMetadataKeys: ['trackingId'],
        requiresMetadata: ['trackingId'],
        title: () => 'Repair completed',
        message: ({ metadata }) => `Your repair request ${metadata.trackingId} has been completed.`,
        actionUrl: ({ entityId }) => `/dashboard/my-requests/${entityId}`,
        deduplicationKey: ({ entityId }) => `repair:${entityId}:completed`,
    },
    payment_confirmed: {
        entityType: 'parcel',
        recipientRole: 'user',
        priority: 'normal',
        allowedMetadataKeys: ['trackingId'],
        requiresMetadata: ['trackingId'],
        title: () => 'Payment confirmed',
        message: ({ metadata }) => `Your payment for repair request ${metadata.trackingId} has been confirmed.`,
        actionUrl: ({ entityId }) => `/dashboard/my-requests/${entityId}`,
        deduplicationKey: ({ entityId }) => `repair:${entityId}:payment_confirmed`,
    },
};

module.exports = { NOTIFICATION_EVENTS, ENTITY_TYPES, ROLES, PRIORITIES };
