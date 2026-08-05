// Initial approved service-definition seed set (Phase 6.3 Unit 2 / Phase E).
//
// PROVISIONAL/DEMO PRICING WARNING: every baseMin/baseMax/inspectionFee value
// below is a placeholder for local development and automated testing only.
// None of it has been reviewed or approved by the business owner, none of it
// reflects researched real-world repair-market prices, and none of it should
// ever be treated as production-ready. Real pricing is a product decision
// (see Phase 6.3 Unit 2's spec, Phase E) that this unit deliberately does not
// make - scripts/seed-service-definitions.js refuses to run against a
// production database regardless, as a second, independent safeguard.
//
// This is NOT an exhaustive catalog of every product/repair pair the
// taxonomy in utils/serviceTaxonomy.js allows - only a representative
// starter set: the universal 'diagnosis' category for every product,
// plus one clearly-representative non-diagnosis repair category per
// product. The remaining allowed pairs are intentionally left unseeded
// until their own pricing is reviewed.
//
// requiredExpertiseLevel is a new judgment call introduced by this unit
// (technician expertise itself is explicitly out of scope - see the unit
// spec's "Do not implement technician expertise"). inspectionRequired and
// imageRequirements.recommended are NOT arbitrary here: they are derived
// directly from the already-locked per-repair-category metadata in
// utils/repairCategory.js (inspectionNormallyRequired and
// imageEvidenceUseful respectively), so this seed data stays consistent
// with Unit 1's canonical taxonomy rather than inventing a second,
// parallel judgment about the same repair categories.

const PROVISIONAL_NOTE = 'Provisional/demo pricing - not reviewed or approved by the business owner.';

const SERVICE_DEFINITION_SEED = [
    {
        productCategorySlug: 'smartphone', repairCategorySlug: 'diagnosis',
        label: 'General Diagnosis - Mobile Phone',
        description: `Initial diagnosis for an unclear smartphone problem. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'usd', baseMin: 15, baseMax: 25, inspectionFee: 0, version: 1 },
        requiredExpertiseLevel: 'beginner', estimatedDurationMinutes: 30,
        inspectionRequired: false, imageRequirements: { min: 0, max: 3, recommended: true }
    },
    {
        productCategorySlug: 'smartphone', repairCategorySlug: 'display-screen',
        label: 'Screen Replacement - Mobile Phone',
        description: `Replacement of a cracked or unresponsive smartphone display. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'usd', baseMin: 40, baseMax: 120, inspectionFee: 0, version: 1 },
        requiredExpertiseLevel: 'intermediate', estimatedDurationMinutes: 45,
        inspectionRequired: false, imageRequirements: { min: 0, max: 3, recommended: true }
    },
    {
        productCategorySlug: 'laptop-computer', repairCategorySlug: 'diagnosis',
        label: 'General Diagnosis - Laptop / Computer',
        description: `Initial diagnosis for an unclear laptop or computer problem. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'usd', baseMin: 20, baseMax: 30, inspectionFee: 0, version: 1 },
        requiredExpertiseLevel: 'beginner', estimatedDurationMinutes: 30,
        inspectionRequired: false, imageRequirements: { min: 0, max: 3, recommended: true }
    },
    {
        productCategorySlug: 'laptop-computer', repairCategorySlug: 'battery-power',
        label: 'Battery Replacement - Laptop / Computer',
        description: `Battery health diagnosis and replacement for a laptop or computer. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'usd', baseMin: 60, baseMax: 150, inspectionFee: 15, version: 1 },
        requiredExpertiseLevel: 'intermediate', estimatedDurationMinutes: 60,
        inspectionRequired: true, imageRequirements: { min: 0, max: 3, recommended: true }
    },
    {
        productCategorySlug: 'television', repairCategorySlug: 'diagnosis',
        label: 'General Diagnosis - TV / Electronics',
        description: `Initial diagnosis for an unclear television problem. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'usd', baseMin: 20, baseMax: 30, inspectionFee: 0, version: 1 },
        requiredExpertiseLevel: 'beginner', estimatedDurationMinutes: 30,
        inspectionRequired: false, imageRequirements: { min: 0, max: 3, recommended: true }
    },
    {
        productCategorySlug: 'television', repairCategorySlug: 'display-screen',
        label: 'Screen / Panel Repair - TV',
        description: `Diagnosis and repair of a damaged or malfunctioning television panel. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'usd', baseMin: 100, baseMax: 350, inspectionFee: 0, version: 1 },
        requiredExpertiseLevel: 'advanced', estimatedDurationMinutes: 120,
        inspectionRequired: false, imageRequirements: { min: 0, max: 3, recommended: true }
    },
    {
        productCategorySlug: 'refrigerator', repairCategorySlug: 'diagnosis',
        label: 'General Diagnosis - Refrigerator',
        description: `Initial diagnosis for an unclear refrigerator problem. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'usd', baseMin: 20, baseMax: 30, inspectionFee: 0, version: 1 },
        requiredExpertiseLevel: 'beginner', estimatedDurationMinutes: 30,
        inspectionRequired: false, imageRequirements: { min: 0, max: 3, recommended: true }
    },
    {
        productCategorySlug: 'refrigerator', repairCategorySlug: 'compressor-cooling',
        label: 'Compressor / Refrigerant Service - Refrigerator',
        description: `Compressor and refrigerant-cycle diagnosis and service for a refrigerator. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'usd', baseMin: 90, baseMax: 280, inspectionFee: 30, version: 1 },
        requiredExpertiseLevel: 'advanced', estimatedDurationMinutes: 180,
        inspectionRequired: true, imageRequirements: { min: 0, max: 3, recommended: false }
    },
    {
        productCategorySlug: 'washing-machine', repairCategorySlug: 'diagnosis',
        label: 'General Diagnosis - Washing Machine',
        description: `Initial diagnosis for an unclear washing machine problem. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'usd', baseMin: 20, baseMax: 30, inspectionFee: 0, version: 1 },
        requiredExpertiseLevel: 'beginner', estimatedDurationMinutes: 30,
        inspectionRequired: false, imageRequirements: { min: 0, max: 3, recommended: true }
    },
    {
        productCategorySlug: 'washing-machine', repairCategorySlug: 'mechanical-parts',
        label: 'Mechanical Parts Repair - Washing Machine',
        description: `Repair of drum, motor, drainage, or other mechanical components. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'usd', baseMin: 50, baseMax: 160, inspectionFee: 20, version: 1 },
        requiredExpertiseLevel: 'intermediate', estimatedDurationMinutes: 90,
        inspectionRequired: true, imageRequirements: { min: 0, max: 3, recommended: true }
    },
    {
        productCategorySlug: 'air-conditioner', repairCategorySlug: 'diagnosis',
        label: 'General Diagnosis - AC',
        description: `Initial diagnosis for an unclear air conditioner problem. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'usd', baseMin: 20, baseMax: 30, inspectionFee: 0, version: 1 },
        requiredExpertiseLevel: 'beginner', estimatedDurationMinutes: 30,
        inspectionRequired: false, imageRequirements: { min: 0, max: 3, recommended: true }
    },
    {
        productCategorySlug: 'air-conditioner', repairCategorySlug: 'cooling-overheating',
        label: 'Cooling Performance Repair - AC',
        description: `Diagnosis and repair of reduced cooling performance or overheating. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'usd', baseMin: 80, baseMax: 240, inspectionFee: 25, version: 1 },
        requiredExpertiseLevel: 'advanced', estimatedDurationMinutes: 150,
        inspectionRequired: true, imageRequirements: { min: 0, max: 3, recommended: false }
    },
    {
        productCategorySlug: 'microwave-oven', repairCategorySlug: 'diagnosis',
        label: 'General Diagnosis - Microwave',
        description: `Initial diagnosis for an unclear microwave problem. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'usd', baseMin: 15, baseMax: 25, inspectionFee: 0, version: 1 },
        requiredExpertiseLevel: 'beginner', estimatedDurationMinutes: 30,
        inspectionRequired: false, imageRequirements: { min: 0, max: 3, recommended: true }
    },
    {
        productCategorySlug: 'microwave-oven', repairCategorySlug: 'electrical-power',
        label: 'Electrical / Power Repair - Microwave',
        description: `Electrical fault and power-supply diagnosis and repair for a microwave oven. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'usd', baseMin: 40, baseMax: 100, inspectionFee: 20, version: 1 },
        requiredExpertiseLevel: 'advanced', estimatedDurationMinutes: 60,
        inspectionRequired: true, imageRequirements: { min: 0, max: 3, recommended: true }
    },
    {
        productCategorySlug: 'other-electronics', repairCategorySlug: 'diagnosis',
        label: 'General Diagnosis - Other Electronics',
        description: `Initial diagnosis for any other electronic device or appliance. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'usd', baseMin: 15, baseMax: 25, inspectionFee: 0, version: 1 },
        requiredExpertiseLevel: 'beginner', estimatedDurationMinutes: 30,
        inspectionRequired: false, imageRequirements: { min: 0, max: 3, recommended: true }
    },
    {
        productCategorySlug: 'other-electronics', repairCategorySlug: 'other',
        label: 'General Repair - Other Electronics',
        description: `Repair for any other electronic device or appliance not covered by a specific category. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'usd', baseMin: 30, baseMax: 100, inspectionFee: 15, version: 1 },
        requiredExpertiseLevel: 'beginner', estimatedDurationMinutes: 60,
        inspectionRequired: true, imageRequirements: { min: 0, max: 3, recommended: true }
    }
];

module.exports = { SERVICE_DEFINITION_SEED, PROVISIONAL_NOTE };
