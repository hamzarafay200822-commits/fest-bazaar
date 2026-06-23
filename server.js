const express    = require('express');
const multer     = require('multer');
const path       = require('path');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Cloudinary ────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ── MongoDB via Mongoose ──────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err.message));

const anySchema = new mongoose.Schema({}, { strict: false });
const Booking       = mongoose.model('Booking',       anySchema, 'bookings');
const Capital       = mongoose.model('Capital',       anySchema, 'capital');
const Expense       = mongoose.model('Expense',       anySchema, 'expenses');
const Archive       = mongoose.model('Archive',       anySchema, 'archive');
const DisabledStall = mongoose.model('DisabledStall', anySchema, 'disabled_stalls');

async function loadDB() {
  const [bookings, capital, expenses, archive] = await Promise.all([
    Booking.find({}).lean(),
    Capital.find({}).lean(),
    Expense.find({}).lean(),
    Archive.find({}).lean()
  ]);
  return { bookings, capital, expenses, archive };
}

// ── Multer (memory storage for Cloudinary) ────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Middleware ────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ───────────────────────────────────────────────────
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return `${String(dt.getDate()).padStart(2,'0')}-${MONTHS[dt.getMonth()]}-${dt.getFullYear()}`;
}

function fmtDateTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  return `${fmtDate(d)} ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
}

const EXPENSE_CATS = [
  'Venue Rent','Marketing/Ads','Staff/Volunteers','Decoration/Setup',
  'Logistics','Utilities','Equipment','Miscellaneous'
];

function mapBooking(r) {
  const due = r.cleared_date ? 0 : Math.max(0, (r.total||0) - (r.paid||0));
  const status = due === 0 ? 'cleared' : (r.paid||0) === 0 ? 'pending' : 'partial';
  return {
    stall: r.stall, zone: r.zone||'', vendor: r.vendor||'', brand: r.brand||'',
    phone: r.phone||'', items: r.items||'', total: r.total||0, paid: r.paid||0, due,
    paymentStatus: status, logoUrl: r.logo_url||'',
    clearedDate: r.cleared_date ? fmtDate(r.cleared_date) : '',
    date: r.booking_date ? fmtDate(r.booking_date) : '',
    bookingTs: r.booking_date || ''
  };
}

function getFinancials(data) {
  const capital  = data.capital.map(r => ({ id:r._id.toString(), date:fmtDate(r.date), description:r.description||'', amount:r.amount||0 }));
  const expenses = data.expenses.map(r => ({ id:r._id.toString(), date:fmtDate(r.date), category:r.category||'', description:r.description||'', amount:r.amount||0 }));
  const bookings = data.bookings.map(mapBooking);

  const collected   = bookings.reduce((s,b) => s+(b.paid||0), 0);
  const expected    = bookings.reduce((s,b) => s+(b.total||0), 0);
  const outstanding = bookings.reduce((s,b) => s+(b.due||0), 0);
  const totalCap    = capital.reduce((s,c) => s+c.amount, 0);
  const totalExp    = expenses.reduce((s,e) => s+e.amount, 0);
  const netProfit   = collected - totalExp;
  const margin      = collected > 0 ? (netProfit/collected)*100 : 0;
  const roi         = totalCap  > 0 ? (netProfit/totalCap)*100  : 0;

  const breakdown = {};
  EXPENSE_CATS.forEach(c => { breakdown[c] = 0; });
  expenses.forEach(e => { breakdown[e.category] = (breakdown[e.category]||0) + e.amount; });

  return {
    capital, expenses, categories: EXPENSE_CATS,
    summary: { totalCapital:totalCap, revenueCollected:collected, revenueExpected:expected,
      revenueOutstanding:outstanding, totalExpenses:totalExp, netProfit, profitMargin:margin, roi, breakeven:netProfit>=0 },
    breakdown
  };
}

function uploadToCloudinary(buffer, filename) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'fest-bazaar', public_id: filename, overwrite: true },
      (error, result) => { if (error) reject(error); else resolve(result); }
    );
    Readable.from(buffer).pipe(stream);
  });
}

function deleteFromCloudinary(publicId) {
  return cloudinary.uploader.destroy(publicId).catch(() => {});
}

function getPublicId(logoUrl) {
  if (!logoUrl) return null;
  // Extract public_id from Cloudinary URL: .../fest-bazaar/filename
  const match = logoUrl.match(/fest-bazaar\/([^.]+)/);
  return match ? `fest-bazaar/${match[1]}` : null;
}

// ── Bookings ──────────────────────────────────────────────────
app.get('/api/bookings', async (req, res) => {
  try {
    const data = await loadDB();
    res.json({ bookings: data.bookings.map(mapBooking) });
  } catch(e) { res.json({ bookings: [], error: e.message }); }
});

app.post('/api/bookings', async (req, res) => {
  try {
    const b = req.body;
    if (!b.stall||!b.vendor||!b.brand||!b.phone)
      return res.json({ success:false, error:'Missing required fields' });
    const total = parseFloat(b.total)||0, paid = parseFloat(b.paid)||0;
    // findOneAndUpdate with upsert:false used as atomic check — if stall exists, skip insert
    const existing = await Booking.findOne({ stall: b.stall }).lean();
    if (existing) {
      const data = await loadDB();
      return res.json({ success:false, error:'Stall '+b.stall+' is already booked', bookings:data.bookings.map(mapBooking) });
    }
    await Booking.create({
      stall:b.stall, zone:b.zone||'', vendor:b.vendor, brand:b.brand,
      phone:b.phone, items:b.items||'', total, paid,
      payment_status: paid>=total?'cleared':paid===0?'pending':'partial',
      booking_date: new Date().toISOString()
    });
    const data = await loadDB();
    res.json({ success:true, bookings:data.bookings.map(mapBooking) });
  } catch(e) {
    // E11000 = duplicate key — stall already booked (race condition)
    if (e.code === 11000) {
      const data = await loadDB();
      return res.json({ success:false, error:'Stall '+b.stall+' was just booked by someone else', bookings:data.bookings.map(mapBooking) });
    }
    console.error(e); res.json({ success:false, error: e.message });
  }
});

app.put('/api/bookings/:stall', async (req, res) => {
  try {
    const row = await Booking.findOne({ stall: req.params.stall }).lean();
    if (!row) return res.json({ success:false, error:'Booking not found' });
    const b = req.body;
    const total = parseFloat(b.total)||0;
    const paid  = parseFloat(b.paid)||0;
    const status = paid >= total ? 'cleared' : paid === 0 ? 'pending' : 'partial';
    await Booking.updateOne({ stall: req.params.stall }, { $set: {
      vendor: b.vendor || row.vendor,
      brand:  b.brand  || row.brand,
      phone:  b.phone  || row.phone,
      items:  b.items  !== undefined ? b.items : (row.items||''),
      total, paid,
      payment_status: status,
      cleared_date: status === 'cleared' ? (row.cleared_date || new Date().toISOString()) : null
    }});
    const data = await loadDB();
    res.json({ success:true, bookings: data.bookings.map(mapBooking) });
  } catch(e) { console.error(e); res.json({ success:false, error: e.message }); }
});

app.post('/api/bookings/:stall/clear-payment', async (req, res) => {
  try {
    const row = await Booking.findOne({ stall: req.params.stall }).lean();
    if (!row) return res.json({ success:false, error:'Stall not found' });
    await Booking.updateOne(
      { stall: req.params.stall },
      { $set: { paid: row.total, payment_status:'cleared', cleared_date: new Date().toISOString() } }
    );
    const data = await loadDB();
    res.json({ success:true, bookings:data.bookings.map(mapBooking) });
  } catch(e) { console.error(e); res.json({ success:false, error: e.message }); }
});

app.delete('/api/bookings/:stall', async (req, res) => {
  try {
    const row = await Booking.findOne({ stall: req.params.stall }).lean();
    if (!row) return res.json({ success:false, error:'Stall not found' });
    if (row.logo_url) await deleteFromCloudinary(getPublicId(row.logo_url));
    await Booking.deleteOne({ stall: req.params.stall });
    const data = await loadDB();
    res.json({ success:true, bookings:data.bookings.map(mapBooking) });
  } catch(e) { console.error(e); res.json({ success:false, error: e.message }); }
});

// ── Logo ──────────────────────────────────────────────────────
app.post('/api/bookings/:stall/logo', upload.single('logo'), async (req, res) => {
  try {
    const row = await Booking.findOne({ stall: req.params.stall }).lean();
    if (!row) return res.json({ success:false, error:'Booking not found' });
    if (row.logo_url) await deleteFromCloudinary(getPublicId(row.logo_url));
    const result = await uploadToCloudinary(req.file.buffer, `${req.params.stall}_${Date.now()}`);
    await Booking.updateOne({ stall: req.params.stall }, { $set: { logo_url: result.secure_url } });
    const data = await loadDB();
    res.json({ success:true, logoUrl:result.secure_url, bookings:data.bookings.map(mapBooking) });
  } catch(e) { console.error(e); res.json({ success:false, error: e.message }); }
});

app.delete('/api/bookings/:stall/logo', async (req, res) => {
  try {
    const row = await Booking.findOne({ stall: req.params.stall }).lean();
    if (!row) return res.json({ success:false, error:'Booking not found' });
    if (row.logo_url) await deleteFromCloudinary(getPublicId(row.logo_url));
    await Booking.updateOne({ stall: req.params.stall }, { $set: { logo_url: null } });
    const data = await loadDB();
    res.json({ success:true, bookings:data.bookings.map(mapBooking) });
  } catch(e) { console.error(e); res.json({ success:false, error: e.message }); }
});

// ── Financials ────────────────────────────────────────────────
app.get('/api/financials', async (req, res) => {
  try {
    const data = await loadDB();
    res.json(getFinancials(data));
  } catch(e) { res.json({ error: e.message }); }
});

app.post('/api/capital', async (req, res) => {
  try {
    const { description, amount } = req.body;
    if (!description||!amount) return res.json({ success:false, error:'Missing fields' });
    await Capital.create({ id:'CAP-'+Date.now(), date:new Date().toISOString(), description, amount:parseFloat(amount)||0 });
    const data = await loadDB();
    res.json({ success:true, financials:getFinancials(data) });
  } catch(e) { console.error(e); res.json({ success:false, error: e.message }); }
});

app.delete('/api/capital/:id', async (req, res) => {
  try {
    const del = await Capital.deleteOne({ _id: req.params.id });
    if (del.deletedCount === 0) return res.json({ success:false, error:'Entry not found' });
    const data = await loadDB();
    res.json({ success:true, financials:getFinancials(data) });
  } catch(e) { console.error(e); res.json({ success:false, error: e.message }); }
});

app.post('/api/expenses', async (req, res) => {
  try {
    const { category, description, amount } = req.body;
    if (!description||!amount) return res.json({ success:false, error:'Missing fields' });
    await Expense.create({ id:'EXP-'+Date.now(), date:new Date().toISOString(), category:category||'Miscellaneous', description, amount:parseFloat(amount)||0 });
    const data = await loadDB();
    res.json({ success:true, financials:getFinancials(data) });
  } catch(e) { console.error(e); res.json({ success:false, error: e.message }); }
});

app.delete('/api/expenses/:id', async (req, res) => {
  try {
    const del = await Expense.deleteOne({ _id: req.params.id });
    if (del.deletedCount === 0) return res.json({ success:false, error:'Entry not found' });
    const data = await loadDB();
    res.json({ success:true, financials:getFinancials(data) });
  } catch(e) { console.error(e); res.json({ success:false, error: e.message }); }
});

// ── Archive ───────────────────────────────────────────────────
function archiveList(archive) {
  return [...archive].sort((a,b) => new Date(b.archived_date)-new Date(a.archived_date))
    .map(r => ({ id:r._id.toString(), name:r.name||'', date:fmtDateTime(r.archived_date),
      dateRaw: new Date(r.archived_date).getTime(),
      bookingsCount:r.bookings_count||0, revenue:r.revenue||0,
      capital:r.capital_amount||0, expenses:r.expenses_amount||0, netProfit:r.net_profit||0 }));
}

app.get('/api/archive', async (req, res) => {
  try {
    const data = await loadDB();
    res.json({ events: archiveList(data.archive) });
  } catch(e) { res.json({ events: [] }); }
});

app.get('/api/archive/:id', async (req, res) => {
  try {
    const row = await Archive.findOne({ _id: req.params.id }).lean();
    if (!row) return res.json({ success:false, error:'Not found' });
    res.json({ success:true, event:{ id:row._id.toString(), name:row.name||'',
      date:fmtDateTime(row.archived_date), bookings:row.bookings_json||[], financials:row.financials_json||null }});
  } catch(e) { res.json({ success:false, error: e.message }); }
});

app.post('/api/archive', async (req, res) => {
  try {
    const data = await loadDB();
    const bookings = data.bookings.map(mapBooking);
    if (!bookings.length) return res.json({ success:false, error:'No bookings to archive' });
    const fin  = getFinancials(data);
    const now  = new Date().toISOString();
    const name = req.body.name || ('Event - '+fmtDate(now));
    await Archive.create({
      id:'EVT-'+Date.now(), name, archived_date:now,
      bookings_count:bookings.length, revenue:fin.summary.revenueCollected,
      capital_amount:fin.summary.totalCapital, expenses_amount:fin.summary.totalExpenses,
      net_profit:fin.summary.netProfit, bookings_json:bookings,
      financials_json:{ capital:fin.capital, expenses:fin.expenses, summary:fin.summary, breakdown:fin.breakdown }
    });
    const updated = await loadDB();
    res.json({ success:true, events:archiveList(updated.archive) });
  } catch(e) { console.error(e); res.json({ success:false, error: e.message }); }
});

app.delete('/api/archive/:id', async (req, res) => {
  try {
    const del = await Archive.deleteOne({ _id: req.params.id });
    if (del.deletedCount === 0) return res.json({ success:false, error:'Archive not found' });
    const data = await loadDB();
    res.json({ success:true, events:archiveList(data.archive) });
  } catch(e) { console.error(e); res.json({ success:false, error: e.message }); }
});

// ── Disabled Stalls ───────────────────────────────────────────
app.get('/api/disabled-stalls', async (req, res) => {
  try {
    const rows = await DisabledStall.find({}).lean();
    res.json({ disabled: rows.map(r => r.stall) });
  } catch(e) { res.json({ disabled: [] }); }
});

app.post('/api/disabled-stalls/:stall', async (req, res) => {
  try {
    const existing = await DisabledStall.findOne({ stall: req.params.stall });
    if (!existing) await DisabledStall.create({ stall: req.params.stall });
    const rows = await DisabledStall.find({}).lean();
    res.json({ success: true, disabled: rows.map(r => r.stall) });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.delete('/api/disabled-stalls/:stall', async (req, res) => {
  try {
    await DisabledStall.deleteOne({ stall: req.params.stall });
    const rows = await DisabledStall.find({}).lean();
    res.json({ success: true, disabled: rows.map(r => r.stall) });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ── Reset ─────────────────────────────────────────────────────
app.post('/api/reset', async (req, res) => {
  try {
    const bookings = await Booking.find({}).lean();
    for (const b of bookings) {
      if (b.logo_url) await deleteFromCloudinary(getPublicId(b.logo_url));
    }
    const bc = bookings.length;
    const cc = await Capital.countDocuments();
    const ec = await Expense.countDocuments();
    await Promise.all([
      Booking.deleteMany({}),
      Capital.deleteMany({}),
      Expense.deleteMany({})
    ]);
    res.json({ success:true, cleared:{ bookings:bc, capital:cc, expenses:ec },
      message:`Reset complete. ${bc} bookings, ${cc} capital entries, ${ec} expenses cleared. Archive preserved.` });
  } catch(e) { console.error(e); res.json({ success:false, error: e.message }); }
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  🎪  Fest Bazaar  →  http://localhost:${PORT}\n`);
});
