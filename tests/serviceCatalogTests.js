// The full repair-service seed (data/serviceDefinitionSeedExtra.js): every
// product/repair pair the taxonomy allows has exactly one valid BDT service,
// the canonical 16 are untouched, and the seed only inserts what is missing.
const { minimumInspectionFee } = require('../utils/inspectionFee');

async function runServiceCatalogTests({ logTest }) {
    const { connectDatabase, collections: c, client } = require('../config/database');
    const { SERVICE_DEFINITION_SEED } = require('../data/serviceDefinitionSeed');
    const { EXTRA_SERVICE_DEFINITION_SEED, ALL_SERVICE_DEFINITION_SEED } = require('../data/serviceDefinitionSeedExtra');
    const { ServiceDefinitionModel, validateServiceDefinitionInput } = require('../models/ServiceDefinition');
    const { getRepairCategoryBySlug } = require('../utils/repairCategory');
    const { PRODUCT_REPAIR_CATEGORY_MAP, getAllowedRepairCategories, validateProductRepairPair } = require('../utils/serviceTaxonomy');
    const { runSeed } = require('../scripts/seed-service-definitions');
    if (process.env.NODE_ENV !== 'test' || !c.users.dbName.includes('test')) throw new Error('Isolated test database required');
    await connectDatabase();

    const key = (r) => `${r.productCategorySlug}/${r.repairCategorySlug}`;
    const keys = ALL_SERVICE_DEFINITION_SEED.map(key);
    const allowed = Object.keys(PRODUCT_REPAIR_CATEGORY_MAP).flatMap((p) => getAllowedRepairCategories(p).map((r) => `${p}/${r}`));
    logTest('Service catalogue: the canonical 16 stay first and unchanged',
        SERVICE_DEFINITION_SEED.length === 16 && ALL_SERVICE_DEFINITION_SEED.slice(0, 16).every((r, i) => r === SERVICE_DEFINITION_SEED[i]));
    logTest('Service catalogue: every allowed device/repair pair has exactly one service',
        new Set(keys).size === keys.length && allowed.every((k) => keys.includes(k)) && keys.length === allowed.length);
    logTest('Service catalogue: every extra service is valid, in whole BDT and a real taxonomy pair',
        EXTRA_SERVICE_DEFINITION_SEED.every((r) => validateServiceDefinitionInput(r).valid
            && validateProductRepairPair(r.productCategorySlug, r.repairCategorySlug).valid
            && r.pricingRule.currency === 'BDT' && r.pricingRule.baseMin % 100 === 0 && r.pricingRule.baseMax % 100 === 0
            && r.pricingRule.baseMin <= r.pricingRule.baseMax && r.pricingRule.inspectionFee % 100 === 0));
    logTest('Service catalogue: inspection and photo hints follow the repair category, and every service carries at least the fee floor',
        EXTRA_SERVICE_DEFINITION_SEED.every((r) => {
            const category = getRepairCategoryBySlug(r.repairCategorySlug);
            return r.inspectionRequired === category.inspectionNormallyRequired
                && r.imageRequirements.recommended === category.imageEvidenceUseful
                && r.pricingRule.inspectionFee >= minimumInspectionFee(r.pricingRule.baseMax);
        }));
    logTest('Service catalogue: a mobile phone now offers 8 repairs', ALL_SERVICE_DEFINITION_SEED.filter((r) => r.productCategorySlug === 'smartphone').length === 8);

    // Seeding on top of a database that already has the canonical 16 (one of
    // them customised by an admin) adds only the new rows and keeps the change.
    const collection = client.db(c.users.dbName).collection(`test_service_catalogue_${Date.now()}`);
    try {
        await collection.createIndex({ productCategorySlug: 1, repairCategorySlug: 1 }, { unique: true });
        const model = new ServiceDefinitionModel(collection);
        await runSeed({ model, seedRows: SERVICE_DEFINITION_SEED, dryRun: false });
        await collection.updateOne({ productCategorySlug: 'smartphone', repairCategorySlug: 'display-screen' }, { $set: { label: 'Admin edit' } });
        const result = await runSeed({ model, seedRows: ALL_SERVICE_DEFINITION_SEED, dryRun: false });
        const edited = await collection.findOne({ productCategorySlug: 'smartphone', repairCategorySlug: 'display-screen' });
        logTest('Service catalogue: seeding adds only the missing services and keeps admin changes',
            result.created === EXTRA_SERVICE_DEFINITION_SEED.length && result.conflicted === 1 && result.skippedIdentical === 15
            && edited.label === 'Admin edit' && (await collection.countDocuments()) === ALL_SERVICE_DEFINITION_SEED.length);
    } finally {
        await collection.drop().catch(() => {});
    }
}

module.exports = { runServiceCatalogTests };
