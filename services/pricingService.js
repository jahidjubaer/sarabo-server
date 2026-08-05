// Narrow, server-owned pricing-estimate helper (Phase 6.3 Unit 2 / Phase J).
// Deliberately takes only a persisted service definition, never a
// client-supplied price/cost - there is no parameter through which a caller
// could influence the returned amounts. This will later be used by repair-
// request v2 creation (a future unit); it has no modifiers (no urgency fee,
// area fee, brand modifier) and produces no quote or final amount - it is
// strictly the estimate range plus optional inspection fee, matching the
// locked "hybrid pricing" architecture decision.
function getPricingEstimate(serviceDefinition) {
    const { pricingRule } = serviceDefinition;
    return {
        currency: pricingRule.currency,
        estimateMin: pricingRule.baseMin,
        estimateMax: pricingRule.baseMax,
        inspectionFee: pricingRule.inspectionFee,
        pricingVersion: pricingRule.version
    };
}

module.exports = { getPricingEstimate };
