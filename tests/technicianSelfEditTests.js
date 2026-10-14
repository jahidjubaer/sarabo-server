// A technician edits their own profile (PATCH /technicians/me): name, phone,
// address and service area change; email/NID/status never do; the area is
// locked while a repair is active.
const { verifyTechnician } = require('../middleware/auth');

function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        send(payload) { this.body = payload; return this; },
    };
}

async function runTechnicianSelfEditTests({ logTest }) {
    const { connectDatabase, collections: c } = require('../config/database');
    const { initializeModels } = require('../models');
    const TechnicianController = require('../controllers/technicianController');
    const technicianRoutes = require('../routes/technicians');
    if (process.env.NODE_ENV !== 'test' || !c.technicians.dbName.includes('test') || c.technicians.dbName === 'sarabo-db') {
        throw new Error('Isolated test database required');
    }
    await connectDatabase();
    const controller = new TechnicianController(initializeModels(c), c);
    const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = (name) => `selfedit-${name}-${run}@example.test`;
    const technicianIds = [];
    const requestIds = [];

    async function addTechnician(name) {
        const doc = {
            name: `Self ${name}`, email: email(name), phone: '01700000000', nid: '1234567890',
            region: 'Dhaka', district: 'Dhaka', address: 'Old address', status: 'approved', workStatus: 'available',
            expertise: [], createdAt: new Date(),
        };
        const { insertedId } = await c.technicians.insertOne(doc);
        technicianIds.push(insertedId);
        return { ...doc, _id: insertedId };
    }
    const patch = async (technician, body) => {
        const res = fakeRes();
        await controller.updateMyTechnicianProfile({ decoded_email: technician ? technician.email : email('nobody'), body }, res);
        return res;
    };
    const stored = (technician) => c.technicians.findOne({ _id: technician._id });

    try {
        const tech = await addTechnician('main');
        const ok = await patch(tech, {
            name: ' New Name ', phone: '01811111111', address: 'New address', region: 'Chattogram', district: 'Cox\'s Bazar',
            email: 'hijack@example.test', nid: '999', status: 'pending', workStatus: 'in_delivery',
        });
        const after = await stored(tech);
        logTest('Self edit: name, phone, address and area are saved (trimmed)',
            ok.statusCode === 200 && after.name === 'New Name' && after.phone === '01811111111' && after.address === 'New address'
            && after.region === 'Chattogram' && after.district === 'Cox\'s Bazar');
        logTest('Self edit: email, NID, status and work status cannot be changed',
            after.email === tech.email && after.nid === '1234567890' && after.status === 'approved' && after.workStatus === 'available');

        const onlyRegion = await patch(tech, { region: 'Dhaka' });
        const blankName = await patch(tech, { name: '   ' });
        const badPhone = await patch(tech, { phone: 'call me' });
        const notText = await patch(tech, { address: 42 });
        const tooLong = await patch(tech, { address: 'x'.repeat(301) });
        const nothing = await patch(tech, { email: 'x@example.test' });
        logTest('Self edit: bad input is refused with 400',
            [onlyRegion, blankName, badPhone, notText, tooLong, nothing].every((r) => r.statusCode === 400)
            && nothing.body.code === 'NO_PROFILE_CHANGES' && badPhone.body.field === 'phone');

        const clearPhone = await patch(tech, { phone: '' });
        logTest('Self edit: phone can be cleared', clearPhone.statusCode === 200 && (await stored(tech)).phone === '');

        const missing = await patch(null, { name: 'Ghost' });
        logTest('Self edit: an account with no technician record gets 404', missing.statusCode === 404);

        const busy = await addTechnician('busy');
        const { insertedId } = await c.repairRequests.insertOne({
            senderEmail: `selfedit-customer-${run}@example.test`, trackingId: `SELFEDIT-${run}`,
            deliveryStatus: 'driver_assigned', technicianId: busy._id.toString(), technicianEmail: busy.email, createdAt: new Date(),
        });
        requestIds.push(insertedId);
        const areaLocked = await patch(busy, { region: 'Chattogram', district: 'Chattogram' });
        const sameArea = await patch(busy, { region: 'Dhaka', district: 'Dhaka', phone: '01922222222' });
        const busyAfter = await stored(busy);
        logTest('Self edit: the area is locked during an active repair, other details still change',
            areaLocked.statusCode === 409 && areaLocked.body.code === 'TECHNICIAN_HAS_ACTIVE_ASSIGNMENT'
            && sameArea.statusCode === 200 && busyAfter.region === 'Dhaka' && busyAfter.phone === '01922222222');

        const routes = [];
        technicianRoutes({
            get: () => {}, post: () => {}, put: () => {}, delete: () => {},
            patch: (path, ...handlers) => routes.push({ path, handlers }),
        }, { technician: controller });
        const meIndex = routes.findIndex((route) => route.path === '/technicians/me');
        const idIndex = routes.findIndex((route) => route.path === '/technicians/:id');
        logTest('Self edit: the route is technician-only and registered before /technicians/:id',
            meIndex !== -1 && meIndex < idIndex && routes[meIndex].handlers.includes(verifyTechnician));
    } finally {
        if (requestIds.length) await c.repairRequests.deleteMany({ _id: { $in: requestIds } });
        if (technicianIds.length) await c.technicians.deleteMany({ _id: { $in: technicianIds } });
    }
}

module.exports = { runTechnicianSelfEditTests };
