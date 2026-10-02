// "Describe your problem" helper: the model's answer is only a suggestion, so
// every id it returns is checked against the live catalogue, and bad input is
// refused before any AI call. Uses a fake provider - never calls Gemini.
const { MemoryStore } = require('express-rate-limit');
const AiRequestDraftController = require('../controllers/aiRequestDraftController');
const { createAiRequestDraftService, buildCatalogue, validateDraft } = require('../services/aiRequestDraftService');
const { loadAiRequestHelperConfig } = require('../config/aiRequestHelper');
const { createSupportRateLimit } = require('../middleware/supportRateLimit');
const { buildResponseSchema, buildContents, createGeminiRequestDraftProvider } = require('../services/aiProviders/geminiRequestDraftProvider');

const id = (hex) => ({ toString: () => hex });
const DOCS = [
    { _id: id('a1'), isActive: true, productCategorySlug: 'smartphone', label: 'Screen replacement', description: 'Cracked or dead screen' },
    { _id: id('a2'), isActive: true, productCategorySlug: 'smartphone', label: 'Battery replacement', description: 'Battery drains fast' },
    { _id: id('b1'), isActive: true, productCategorySlug: 'laptop-computer', label: 'Keyboard repair', description: '' },
    { _id: id('c1'), isActive: false, productCategorySlug: 'smartphone', label: 'Old service', description: '' },
];
const fakeModel = { findMany: async () => DOCS };

function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        send(payload) { this.body = payload; return this; },
    };
}

const config = { ...loadAiRequestHelperConfig({}), enabled: true, timeoutMs: 100 };
function makeController(provider, overrides = {}) {
    const service = createAiRequestDraftService({ provider, config: { ...config, ...overrides }, serviceDefinitionModel: fakeModel });
    return new AiRequestDraftController({ aiRequestDraftService: service, config });
}
const answer = (fields = {}) => ({
    deviceCategory: 'smartphone', serviceId: 'a1', brand: 'Samsung', model: 'Galaxy A52',
    description: 'The screen cracked after a fall and the touch does not work.', confidence: 'high', followUpQuestion: null, ...fields,
});
const providerReturning = (value, onCall) => ({ async generateDraft(input) { if (onCall) onCall(input); return value; } });

async function runAiRequestDraftTests({ logTest }) {
    const catalogue = buildCatalogue(DOCS);
    logTest('AI helper: catalogue holds active services only',
        catalogue.services.length === 3 && !catalogue.services.some((s) => s.id === 'c1') && catalogue.categories.length === 2);

    // ---- Output checks -----------------------------------------------------
    const good = validateDraft(answer(), catalogue);
    logTest('AI helper: a valid answer becomes form values',
        good.productCategorySlug === 'smartphone' && good.serviceDefinitionId === 'a1' && good.productBrand === 'Samsung'
        && good.productModel === 'Galaxy A52' && good.confidence === 'high' && good.damageDescription.startsWith('The screen'));

    const madeUp = validateDraft(answer({ serviceId: 'zzz' }), catalogue);
    logTest('AI helper: a service id not in the catalogue is dropped', madeUp.serviceDefinitionId === null && madeUp.productCategorySlug === 'smartphone' && madeUp.confidence === 'low');

    const inactive = validateDraft(answer({ serviceId: 'c1' }), catalogue);
    logTest('AI helper: an inactive service is never suggested', inactive.serviceDefinitionId === null);

    const mismatch = validateDraft(answer({ deviceCategory: 'laptop-computer', serviceId: 'a1' }), catalogue);
    logTest('AI helper: a service from another device is dropped, the service\'s own device is kept',
        mismatch.serviceDefinitionId === null && mismatch.productCategorySlug === 'smartphone');

    const unknownCategory = validateDraft(answer({ deviceCategory: 'spaceship', serviceId: null }), catalogue);
    logTest('AI helper: an unknown device category is dropped', unknownCategory.productCategorySlug === null);

    const messy = validateDraft(answer({ brand: 'unknown', model: 'x'.repeat(101), description: 'short', followUpQuestion: '  ' }), catalogue);
    logTest('AI helper: placeholder brand, overlong model, too-short description and blank question become null',
        messy.productBrand === null && messy.productModel === null && messy.damageDescription === null && messy.followUpQuestion === null);

    // ---- Controller --------------------------------------------------------
    let seen = null;
    let res = fakeRes();
    await makeController(providerReturning(answer(), (input) => { seen = input; })).draft({ body: { text: '  amar phone er screen fete geche  ' }, requestId: 'r1' }, res);
    logTest('AI helper: draft returned for a Banglish description, text trimmed, catalogue sent',
        res.statusCode === 200 && res.body.draft.serviceDefinitionId === 'a1' && seen.text === 'amar phone er screen fete geche' && seen.catalogue.services.length === 3);

    let called = false;
    const spy = providerReturning(answer(), () => { called = true; });
    res = fakeRes();
    await makeController(spy).draft({ body: { text: 'hi' } }, res);
    logTest('AI helper: too-short text refused before any AI call', res.statusCode === 400 && res.body.code === 'AI_HELPER_VALIDATION_ERROR' && !called);

    res = fakeRes();
    await makeController(spy).draft({ body: { text: 'x'.repeat(1501) } }, res);
    logTest('AI helper: too-long text refused', res.statusCode === 400 && !called);

    res = fakeRes();
    await makeController(spy).draft({ body: { text: 'screen broken, my card is 4242 4242 4242 4242' } }, res);
    logTest('AI helper: a card number is refused and never sent to AI', res.statusCode === 400 && /card number/.test(res.body.message) && !called);

    res = fakeRes();
    await makeController(spy).draft({ body: ['not', 'an', 'object'] }, res);
    logTest('AI helper: a non-object body is refused', res.statusCode === 400 && !called);

    res = fakeRes();
    await makeController(null).draft({ body: { text: 'phone screen broken' } }, res);
    logTest('AI helper: no provider -> 503 AI_HELPER_UNAVAILABLE', res.statusCode === 503 && res.body.code === 'AI_HELPER_UNAVAILABLE');

    res = fakeRes();
    await makeController(spy, { enabled: false }).draft({ body: { text: 'phone screen broken' } }, res);
    logTest('AI helper: switched off -> 503, no AI call', res.statusCode === 503 && !called);

    const slow = { generateDraft: ({ signal }) => new Promise((resolve) => { const t = setTimeout(() => resolve(answer()), 1000); signal.addEventListener('abort', () => clearTimeout(t)); }) };
    res = fakeRes();
    await makeController(slow).draft({ body: { text: 'phone screen broken' } }, res);
    logTest('AI helper: a slow AI answer times out with 504', res.statusCode === 504 && res.body.code === 'AI_HELPER_TIMEOUT');

    res = fakeRes();
    await makeController({ generateDraft: async () => { const e = new Error('bad'); e.code = 'PROVIDER_INVALID_RESPONSE'; throw e; } }).draft({ body: { text: 'phone screen broken' } }, res);
    logTest('AI helper: an unreadable AI answer -> 502', res.statusCode === 502 && res.body.code === 'AI_HELPER_INVALID_RESPONSE');

    res = fakeRes();
    await makeController(providerReturning('just text')).draft({ body: { text: 'phone screen broken' } }, res);
    logTest('AI helper: a non-object AI answer -> 502', res.statusCode === 502);

    res = fakeRes();
    makeController(spy).status({}, res);
    const offRes = fakeRes();
    makeController(null).status({}, offRes);
    logTest('AI helper: /ai/status says whether the helper can work', res.body.requestHelper === true && offRes.body.requestHelper === false);

    // ---- Config, provider shape, limiter wording ---------------------------
    const off = loadAiRequestHelperConfig({ AI_REQUEST_HELPER_ENABLED: 'true' });
    const on = loadAiRequestHelperConfig({ AI_REQUEST_HELPER_ENABLED: 'true', GEMINI_API_KEY: 'test-key' });
    const defaultOff = loadAiRequestHelperConfig({ GEMINI_API_KEY: 'test-key', AI_SUPPORT_ENABLED: 'true' });
    logTest('AI helper config: on only with its own switch AND a Gemini key', off.enabled === false && on.enabled === true && defaultOff.enabled === false);

    const schema = buildResponseSchema(catalogue);
    logTest('AI helper provider: the answer schema only allows catalogue ids',
        JSON.stringify(schema.properties.serviceId.anyOf[0].enum) === JSON.stringify(['a1', 'a2', 'b1']));
    logTest('AI helper provider: customer text is marked untrusted', buildContents({ text: 'hello' })[0].parts[0].text.startsWith('C. UNTRUSTED CUSTOMER TEXT'));

    let request = null;
    const provider = createGeminiRequestDraftProvider({
        apiKey: 'k', model: 'm', maxOutputTokens: 700, diagnosticLogger: () => {},
        client: { models: { generateContent: async (r) => { request = r; return { text: JSON.stringify(answer()) }; } } },
    });
    const draft = await provider.generateDraft({ text: 'screen broken', catalogue });
    logTest('AI helper provider: sends JSON mode with the catalogue in the system instruction and parses the answer',
        draft.serviceId === 'a1' && request.config.responseMimeType === 'application/json' && request.config.systemInstruction.includes('Screen replacement'));

    const limiter = createSupportRateLimit({ ...config, authenticatedShortWindowLimit: 1 }, { storeFactory: () => new MemoryStore(), label: 'AI helper' });
    const req = { supportAuth: { authenticated: true, uid: 'a@test.local' }, ip: '1.2.3.4', headers: {}, method: 'POST', app: { get: () => false } };
    const pass = fakeRes();
    let passed = false;
    await new Promise((resolve) => { limiter(req, Object.assign(pass, { setHeader() {}, getHeader() {} }), () => { passed = true; resolve(); }); setTimeout(resolve, 200); });
    const blocked = Object.assign(fakeRes(), { setHeader() {}, getHeader() {} });
    await new Promise((resolve) => { limiter(req, blocked, resolve); setTimeout(resolve, 200); });
    logTest('AI helper limiter: own wording when a customer hits the limit',
        passed && blocked.statusCode === 429 && blocked.body.message === 'Too many AI helper requests. Please try again later.');
}

module.exports = { runAiRequestDraftTests };
