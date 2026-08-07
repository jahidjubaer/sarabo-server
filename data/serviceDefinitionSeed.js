// Canonical service-definition seed set (Phase 6.3 Unit 2 seed shape;
// pricing migrated to BDT in Phase 6.4 Unit 3C / Phase E).
//
// CURRENCY: Bangladesh Taka (BDT). Sarabo targets Bangladesh customers, so
// the canonical estimate currency for every new repair-service definition is
// BDT, stored uppercase ("BDT") exactly as the public API and every new
// request snapshot expose it. Payment (Stripe) is a separate concern and
// deliberately remains USD-configured (see config/paymentConfig.js) - v2
// requests are not payable yet, so the two never meet in this unit.
//
// PRICING PROVENANCE: every baseMin/baseMax/inspectionFee below is an
// explicit, business-set BDT amount for this unit - NOT a runtime exchange-
// rate conversion of the previous USD figures. The values are whole-taka
// integers (no poisha), rounded to practical multiples of 100/500, and scaled
// to reflect relative repair complexity in the local market: diagnosis /
// service-call tiers are low, component-heavy or major repairs are higher.
// They remain estimate ranges, not final invoices - the final cost is still
// confirmed after inspection or a written quote (a future unit).
// scripts/seed-service-definitions.js and
// scripts/migrate-service-definitions-to-bdt.js both refuse to run against a
// production database, as an independent safeguard.
//
// This is NOT an exhaustive catalog of every product/repair pair the
// taxonomy in utils/serviceTaxonomy.js allows - only a representative
// starter set: the universal 'diagnosis' category for every product,
// plus one clearly-representative non-diagnosis repair category per
// product. The remaining allowed pairs are intentionally left unseeded
// until their own pricing is reviewed.
//
// requiredExpertiseLevel is a judgment call introduced by Unit 2 (technician
// expertise itself is out of scope there). inspectionRequired and
// imageRequirements.recommended are NOT arbitrary here: they are derived
// directly from the already-locked per-repair-category metadata in
// utils/repairCategory.js (inspectionNormallyRequired and
// imageEvidenceUseful respectively), so this seed data stays consistent
// with Unit 1's canonical taxonomy rather than inventing a second,
// parallel judgment about the same repair categories.

const PROVISIONAL_NOTE = 'Estimated price range in BDT - the final cost is confirmed after inspection or a written quote.';

const SERVICE_DEFINITION_SEED = [
    {
        productCategorySlug: 'smartphone', repairCategorySlug: 'diagnosis',
        label: 'General Diagnosis - Mobile Phone',
        description: `Initial diagnosis for an unclear smartphone problem. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'BDT', baseMin: 300, baseMax: 500, inspectionFee: 0, version: 2 },
        requiredExpertiseLevel: 'beginner', estimatedDurationMinutes: 30,
        inspectionRequired: false, imageRequirements: { min: 0, max: 3, recommended: true }
    },
    {
        productCategorySlug: 'smartphone', repairCategorySlug: 'display-screen',
        label: 'Screen Replacement - Mobile Phone',
        description: `Replacement of a cracked or unresponsive smartphone display. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'BDT', baseMin: 1500, baseMax: 6000, inspectionFee: 0, version: 2 },
        requiredExpertiseLevel: 'intermediate', estimatedDurationMinutes: 45,
        inspectionRequired: false, imageRequirements: { min: 0, max: 3, recommended: true }
    },
    {
        productCategorySlug: 'laptop-computer', repairCategorySlug: 'diagnosis',
        label: 'General Diagnosis - Laptop / Computer',
        description: `Initial diagnosis for an unclear laptop or computer problem. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'BDT', baseMin: 500, baseMax: 800, inspectionFee: 0, version: 2 },
        requiredExpertiseLevel: 'beginner', estimatedDurationMinutes: 30,
        inspectionRequired: false, imageRequirements: { min: 0, max: 3, recommended: true }
    },
    {
        productCategorySlug: 'laptop-computer', repairCategorySlug: 'battery-power',
        label: 'Battery Replacement - Laptop / Computer',
        description: `Battery health diagnosis and replacement for a laptop or computer. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'BDT', baseMin: 2500, baseMax: 6000, inspectionFee: 500, version: 2 },
        requiredExpertiseLevel: 'intermediate', estimatedDurationMinutes: 60,
        inspectionRequired: true, imageRequirements: { min: 0, max: 3, recommended: true }
    },
    {
        productCategorySlug: 'television', repairCategorySlug: 'diagnosis',
        label: 'General Diagnosis - TV / Electronics',
        description: `Initial diagnosis for an unclear television problem. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'BDT', baseMin: 500, baseMax: 800, inspectionFee: 0, version: 2 },
        requiredExpertiseLevel: 'beginner', estimatedDurationMinutes: 30,
        inspectionRequired: false, imageRequirements: { min: 0, max: 3, recommended: true }
    },
    {
        productCategorySlug: 'television', repairCategorySlug: 'display-screen',
        label: 'Screen / Panel Repair - TV',
        description: `Diagnosis and repair of a damaged or malfunctioning television panel. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'BDT', baseMin: 4000, baseMax: 18000, inspectionFee: 0, version: 2 },
        requiredExpertiseLevel: 'advanced', estimatedDurationMinutes: 120,
        inspectionRequired: false, imageRequirements: { min: 0, max: 3, recommended: true }
    },
    {
        productCategorySlug: 'refrigerator', repairCategorySlug: 'diagnosis',
        label: 'General Diagnosis - Refrigerator',
        description: `Initial diagnosis for an unclear refrigerator problem. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'BDT', baseMin: 500, baseMax: 800, inspectionFee: 0, version: 2 },
        requiredExpertiseLevel: 'beginner', estimatedDurationMinutes: 30,
        inspectionRequired: false, imageRequirements: { min: 0, max: 3, recommended: true }
    },
    {
        productCategorySlug: 'refrigerator', repairCategorySlug: 'compressor-cooling',
        label: 'Compressor / Refrigerant Service - Refrigerator',
        description: `Compressor and refrigerant-cycle diagnosis and service for a refrigerator. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'BDT', baseMin: 3500, baseMax: 15000, inspectionFee: 800, version: 2 },
        requiredExpertiseLevel: 'advanced', estimatedDurationMinutes: 180,
        inspectionRequired: true, imageRequirements: { min: 0, max: 3, recommended: false }
    },
    {
        productCategorySlug: 'washing-machine', repairCategorySlug: 'diagnosis',
        label: 'General Diagnosis - Washing Machine',
        description: `Initial diagnosis for an unclear washing machine problem. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'BDT', baseMin: 500, baseMax: 800, inspectionFee: 0, version: 2 },
        requiredExpertiseLevel: 'beginner', estimatedDurationMinutes: 30,
        inspectionRequired: false, imageRequirements: { min: 0, max: 3, recommended: true }
    },
    {
        productCategorySlug: 'washing-machine', repairCategorySlug: 'mechanical-parts',
        label: 'Mechanical Parts Repair - Washing Machine',
        description: `Repair of drum, motor, drainage, or other mechanical components. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'BDT', baseMin: 2000, baseMax: 8000, inspectionFee: 600, version: 2 },
        requiredExpertiseLevel: 'intermediate', estimatedDurationMinutes: 90,
        inspectionRequired: true, imageRequirements: { min: 0, max: 3, recommended: true }
    },
    {
        productCategorySlug: 'air-conditioner', repairCategorySlug: 'diagnosis',
        label: 'General Diagnosis - AC',
        description: `Initial diagnosis for an unclear air conditioner problem. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'BDT', baseMin: 500, baseMax: 800, inspectionFee: 0, version: 2 },
        requiredExpertiseLevel: 'beginner', estimatedDurationMinutes: 30,
        inspectionRequired: false, imageRequirements: { min: 0, max: 3, recommended: true }
    },
    {
        productCategorySlug: 'air-conditioner', repairCategorySlug: 'cooling-overheating',
        label: 'Cooling Performance Repair - AC',
        description: `Diagnosis and repair of reduced cooling performance or overheating. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'BDT', baseMin: 3000, baseMax: 12000, inspectionFee: 800, version: 2 },
        requiredExpertiseLevel: 'advanced', estimatedDurationMinutes: 150,
        inspectionRequired: true, imageRequirements: { min: 0, max: 3, recommended: false }
    },
    {
        productCategorySlug: 'microwave-oven', repairCategorySlug: 'diagnosis',
        label: 'General Diagnosis - Microwave',
        description: `Initial diagnosis for an unclear microwave problem. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'BDT', baseMin: 400, baseMax: 700, inspectionFee: 0, version: 2 },
        requiredExpertiseLevel: 'beginner', estimatedDurationMinutes: 30,
        inspectionRequired: false, imageRequirements: { min: 0, max: 3, recommended: true }
    },
    {
        productCategorySlug: 'microwave-oven', repairCategorySlug: 'electrical-power',
        label: 'Electrical / Power Repair - Microwave',
        description: `Electrical fault and power-supply diagnosis and repair for a microwave oven. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'BDT', baseMin: 1500, baseMax: 5000, inspectionFee: 500, version: 2 },
        requiredExpertiseLevel: 'advanced', estimatedDurationMinutes: 60,
        inspectionRequired: true, imageRequirements: { min: 0, max: 3, recommended: true }
    },
    {
        productCategorySlug: 'other-electronics', repairCategorySlug: 'diagnosis',
        label: 'General Diagnosis - Other Electronics',
        description: `Initial diagnosis for any other electronic device or appliance. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'BDT', baseMin: 400, baseMax: 700, inspectionFee: 0, version: 2 },
        requiredExpertiseLevel: 'beginner', estimatedDurationMinutes: 30,
        inspectionRequired: false, imageRequirements: { min: 0, max: 3, recommended: true }
    },
    {
        productCategorySlug: 'other-electronics', repairCategorySlug: 'other',
        label: 'General Repair - Other Electronics',
        description: `Repair for any other electronic device or appliance not covered by a specific category. ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'BDT', baseMin: 1000, baseMax: 5000, inspectionFee: 500, version: 2 },
        requiredExpertiseLevel: 'beginner', estimatedDurationMinutes: 60,
        inspectionRequired: true, imageRequirements: { min: 0, max: 3, recommended: true }
    }
];

module.exports = { SERVICE_DEFINITION_SEED, PROVISIONAL_NOTE };
