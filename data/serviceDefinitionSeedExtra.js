// More repair services per device, on top of the canonical 16 in
// serviceDefinitionSeed.js. That set stays exactly as it is (the BDT
// migration and its tests count on those 16 rows); this file fills in every
// other product/repair pair utils/serviceTaxonomy.js allows, so a customer
// can pick e.g. "Battery Replacement - Mobile Phone" instead of only a
// diagnosis or the one representative repair.
//
// Same rules as the canonical set: BDT, whole taka in multiples of 100,
// estimate ranges only (the final cost is confirmed after inspection or a
// quote). inspectionRequired and imageRequirements.recommended come from the
// repair category's own metadata in utils/repairCategory.js; a repair that
// needs an inspection carries an inspection fee, one that doesn't has none.
//
// scripts/seed-service-definitions.js seeds ALL_SERVICE_DEFINITION_SEED
// (canonical + these). It only inserts missing rows and never overwrites one
// an admin has changed.
const { getRepairCategoryBySlug } = require('../utils/repairCategory');
const { SERVICE_DEFINITION_SEED, PROVISIONAL_NOTE } = require('./serviceDefinitionSeed');

function service(productCategorySlug, repairCategorySlug, label, summary, [baseMin, baseMax, inspectionFee], requiredExpertiseLevel, estimatedDurationMinutes) {
    const category = getRepairCategoryBySlug(repairCategorySlug);
    const inspectionRequired = category.inspectionNormallyRequired;
    return {
        productCategorySlug, repairCategorySlug, label,
        description: `${summary} ${PROVISIONAL_NOTE}`,
        isActive: true,
        pricingRule: { currency: 'BDT', baseMin, baseMax, inspectionFee: inspectionRequired ? inspectionFee : 0, version: 2 },
        requiredExpertiseLevel, estimatedDurationMinutes,
        inspectionRequired, imageRequirements: { min: 0, max: 3, recommended: category.imageEvidenceUseful },
    };
}

const EXTRA_SERVICE_DEFINITION_SEED = [
    // Mobile phone
    service('smartphone', 'battery-power', 'Battery Replacement - Mobile Phone', 'Battery that drains fast, swells or will not hold a charge.', [1200, 3500, 300], 'intermediate', 45),
    service('smartphone', 'charging-port', 'Charging Port Repair - Mobile Phone', 'Phone that will not charge, charges only at an angle or has a loose port.', [600, 2000, 0], 'intermediate', 45),
    service('smartphone', 'motherboard', 'Motherboard / IC Repair - Mobile Phone', 'Dead phone, no power, network or Wi-Fi faults, water damage on the board.', [1500, 8000, 500], 'advanced', 180),
    service('smartphone', 'software-os', 'Software / OS Fix - Mobile Phone', 'Stuck on logo, boot loop, slow phone, software update or reset.', [500, 1500, 0], 'beginner', 60),
    service('smartphone', 'camera-audio', 'Camera / Speaker / Mic Repair - Mobile Phone', 'Blurry or dead camera, no sound, faulty speaker or microphone.', [800, 4000, 0], 'intermediate', 60),
    service('smartphone', 'other', 'Other Repair - Mobile Phone', 'Buttons, back glass, vibration or any other phone problem.', [500, 3000, 300], 'beginner', 60),

    // Laptop / computer
    service('laptop-computer', 'display-screen', 'Screen Replacement - Laptop', 'Cracked, flickering, lined or blank laptop screen.', [3500, 12000, 0], 'intermediate', 90),
    service('laptop-computer', 'charging-port', 'Charging Port / Adapter Repair - Laptop', 'Laptop that will not charge, a loose DC jack or a faulty adapter.', [800, 3000, 0], 'intermediate', 60),
    service('laptop-computer', 'motherboard', 'Motherboard Repair - Laptop / Computer', 'No power, no display, short circuit or liquid damage on the board.', [2500, 12000, 800], 'advanced', 240),
    service('laptop-computer', 'software-os', 'Windows / Software Setup - Laptop / Computer', 'Windows install, virus removal, slow computer, driver or software problems.', [500, 2000, 0], 'beginner', 90),
    service('laptop-computer', 'cooling-overheating', 'Overheating / Fan Service - Laptop / Computer', 'Loud fan, overheating or shutting down, cleaning and thermal paste.', [800, 3000, 300], 'intermediate', 90),
    service('laptop-computer', 'other', 'Other Repair - Laptop / Computer', 'Keyboard, touchpad, hinge, RAM or storage upgrade and other problems.', [800, 5000, 300], 'intermediate', 90),

    // Television
    service('television', 'electrical-power', 'Power Supply Repair - TV', 'TV that will not turn on, turns off by itself or has a blinking light.', [1500, 6000, 500], 'intermediate', 120),
    service('television', 'motherboard', 'Mainboard Repair - TV', 'No picture or sound, stuck on logo, remote or input problems.', [2000, 8000, 500], 'advanced', 150),
    service('television', 'other', 'Other Repair - TV', 'Wall mounting, backlight, speakers or any other TV problem.', [800, 5000, 400], 'beginner', 90),

    // Refrigerator
    service('refrigerator', 'electrical-power', 'Electrical Repair - Refrigerator', 'No power, thermostat, relay or wiring faults.', [1000, 4000, 500], 'intermediate', 90),
    service('refrigerator', 'mechanical-parts', 'Parts Repair - Refrigerator', 'Door seal (gasket), fan, hinge, handle or shelf replacement.', [800, 4000, 500], 'intermediate', 90),
    service('refrigerator', 'installation-maintenance', 'Servicing / Cleaning - Refrigerator', 'General servicing, cleaning and moving or installation.', [800, 2500, 300], 'beginner', 90),
    service('refrigerator', 'other', 'Other Repair - Refrigerator', 'Water leaking, ice build-up, noise or any other fridge problem.', [800, 5000, 500], 'intermediate', 90),

    // Washing machine
    service('washing-machine', 'electrical-power', 'Electrical Repair - Washing Machine', 'Machine that will not start, trips the power or has wiring faults.', [1000, 4000, 500], 'intermediate', 90),
    service('washing-machine', 'motherboard', 'Control Board Repair - Washing Machine', 'Error codes, buttons or display not working, programmes stuck.', [2000, 7000, 600], 'advanced', 120),
    service('washing-machine', 'installation-maintenance', 'Installation / Servicing - Washing Machine', 'New installation, drum cleaning and general servicing.', [800, 2500, 300], 'beginner', 90),
    service('washing-machine', 'other', 'Other Repair - Washing Machine', 'Leaks, noise, door lock or any other washing machine problem.', [800, 5000, 500], 'intermediate', 90),

    // Air conditioner
    service('air-conditioner', 'compressor-cooling', 'Gas Refill / Compressor Repair - AC', 'Gas (refrigerant) refill, leak repair or compressor replacement.', [3000, 20000, 800], 'advanced', 180),
    service('air-conditioner', 'electrical-power', 'Electrical Repair - AC', 'AC that will not turn on, PCB, capacitor or wiring faults.', [1500, 6000, 600], 'intermediate', 120),
    service('air-conditioner', 'installation-maintenance', 'Installation / Servicing - AC', 'New installation, shifting, and general servicing and cleaning.', [1500, 6000, 500], 'intermediate', 150),
    service('air-conditioner', 'other', 'Other Repair - AC', 'Water leaking, bad smell, noise, remote or any other AC problem.', [1000, 5000, 600], 'intermediate', 120),

    // Microwave oven
    service('microwave-oven', 'mechanical-parts', 'Parts Repair - Microwave', 'Door, latch, turntable motor or button replacement.', [800, 3000, 400], 'intermediate', 60),
    service('microwave-oven', 'other', 'Other Repair - Microwave', 'Sparking, not heating evenly, noise or any other microwave problem.', [800, 4000, 400], 'intermediate', 60),
];

const ALL_SERVICE_DEFINITION_SEED = [...SERVICE_DEFINITION_SEED, ...EXTRA_SERVICE_DEFINITION_SEED];

module.exports = { EXTRA_SERVICE_DEFINITION_SEED, ALL_SERVICE_DEFINITION_SEED };
