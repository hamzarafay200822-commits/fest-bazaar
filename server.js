const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Directories ───────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// ── JSON Database ─────────────────────────────────────────────
const DB_FILE = path.join(__dirname, 'festbazaar.json');

function loadDB() {
  if (fs.existsSync(DB_FILE)) {
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) {}
  }
  return { bookings: [], capital: [], expenses: [], archive: [] };
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ── Middleware ────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// ── Multer ────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${req.params.stall}_${Date.now()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

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
    date: r.booking_date ? fmtDate(r.booking_date) : ''
  };
}

function getFinancials(db) {
  const capital  = db.capital.map(r => ({ id:r.id, date:fmtDate(r.date), description:r.description||'', amount:r.amount||0 }));
  const expenses = db.expenses.map(r => ({ id:r.id, date:fmtDate(r.date), category:r.category||'', description:r.description||'', amount:r.amount||0 }));
  const bookings = db.bookings.map(mapBooking);

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

// ── Bookings ──────────────────────────────────────────────────
app.get('/api/bookings', (req, res) => {
  const db = loadDB();
  res.json({ bookings: db.bookings.map(mapBooking) });
});

app.post('/api/bookings', (req, res) => {
  const b  = req.body;
  const db = loadDB();
  if (!b.stall||!b.vendor||!b.brand||!b.phone)
    return res.json({ success:false, error:'Missing required fields' });
  if (db.bookings.find(r => r.stall === b.stall))
    return res.json({ success:false, error:'Double booking: '+b.stall, bookings:db.bookings.map(mapBooking) });

  const total = parseFloat(b.total)||0, paid = parseFloat(b.paid)||0;
  db.bookings.push({ stall:b.stall, zone:b.zone||'', vendor:b.vendor, brand:b.brand,
    phone:b.phone, items:b.items||'', total, paid, payment_status: paid>=total?'cleared':paid===0?'pending':'partial',
    booking_date: new Date().toISOString() });
  saveDB(db);
  res.json({ success:true, bookings:db.bookings.map(mapBooking) });
});

app.post('/api/bookings/:stall/clear-payment', (req, res) => {
  const db = loadDB();
  const row = db.bookings.find(r => r.stall === req.params.stall);
  if (!row) return res.json({ success:false, error:'Stall not found' });
  row.paid = row.total; row.payment_status = 'cleared'; row.cleared_date = new Date().toISOString();
  saveDB(db);
  res.json({ success:true, bookings:db.bookings.map(mapBooking) });
});

app.delete('/api/bookings/:stall', (req, res) => {
  const db  = loadDB();
  const idx = db.bookings.findIndex(r => r.stall === req.params.stall);
  if (idx === -1) return res.json({ success:false, error:'Stall not found' });
  const row = db.bookings[idx];
  if (row.logo_url) { const fp = path.join(UPLOADS_DIR, path.basename(row.logo_url)); if (fs.existsSync(fp)) fs.unlinkSync(fp); }
  db.bookings.splice(idx, 1);
  saveDB(db);
  res.json({ success:true, bookings:db.bookings.map(mapBooking) });
});

// ── Logo ──────────────────────────────────────────────────────
app.post('/api/bookings/:stall/logo', upload.single('logo'), (req, res) => {
  const db  = loadDB();
  const row = db.bookings.find(r => r.stall === req.params.stall);
  if (!row) { if (req.file) fs.unlinkSync(req.file.path); return res.json({ success:false, error:'Booking not found' }); }
  if (row.logo_url) { const fp = path.join(UPLOADS_DIR, path.basename(row.logo_url)); if (fs.existsSync(fp)) fs.unlinkSync(fp); }
  row.logo_url = '/uploads/' + req.file.filename;
  saveDB(db);
  res.json({ success:true, logoUrl:row.logo_url, bookings:db.bookings.map(mapBooking) });
});

app.delete('/api/bookings/:stall/logo', (req, res) => {
  const db  = loadDB();
  const row = db.bookings.find(r => r.stall === req.params.stall);
  if (!row) return res.json({ success:false, error:'Booking not found' });
  if (row.logo_url) { const fp = path.join(UPLOADS_DIR, path.basename(row.logo_url)); if (fs.existsSync(fp)) fs.unlinkSync(fp); }
  row.logo_url = null;
  saveDB(db);
  res.json({ success:true, bookings:db.bookings.map(mapBooking) });
});

// ── Financials ────────────────────────────────────────────────
app.get('/api/financials', (req, res) => res.json(getFinancials(loadDB())));

app.post('/api/capital', (req, res) => {
  const { description, amount } = req.body;
  if (!description||!amount) return res.json({ success:false, error:'Missing fields' });
  const db = loadDB();
  db.capital.unshift({ id:'CAP-'+Date.now(), date:new Date().toISOString(), description, amount:parseFloat(amount)||0 });
  saveDB(db);
  res.json({ success:true, financials:getFinancials(db) });
});

app.delete('/api/capital/:id', (req, res) => {
  const db  = loadDB();
  const idx = db.capital.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.json({ success:false, error:'Not found' });
  db.capital.splice(idx, 1); saveDB(db);
  res.json({ success:true, financials:getFinancials(db) });
});

app.post('/api/expenses', (req, res) => {
  const { category, description, amount } = req.body;
  if (!description||!amount) return res.json({ success:false, error:'Missing fields' });
  const db = loadDB();
  db.expenses.unshift({ id:'EXP-'+Date.now(), date:new Date().toISOString(),
    category:category||'Miscellaneous', description, amount:parseFloat(amount)||0 });
  saveDB(db);
  res.json({ success:true, financials:getFinancials(db) });
});

app.delete('/api/expenses/:id', (req, res) => {
  const db  = loadDB();
  const idx = db.expenses.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.json({ success:false, error:'Not found' });
  db.expenses.splice(idx, 1); saveDB(db);
  res.json({ success:true, financials:getFinancials(db) });
});

// ── Archive ───────────────────────────────────────────────────
function archiveList(db) {
  return [...db.archive].sort((a,b) => new Date(b.archived_date)-new Date(a.archived_date))
    .map(r => ({ id:r.id, name:r.name||'', date:fmtDateTime(r.archived_date),
      dateRaw: new Date(r.archived_date).getTime(),
      bookingsCount:r.bookings_count||0, revenue:r.revenue||0,
      capital:r.capital_amount||0, expenses:r.expenses_amount||0, netProfit:r.net_profit||0 }));
}

app.get('/api/archive', (req, res) => res.json({ events: archiveList(loadDB()) }));

app.get('/api/archive/:id', (req, res) => {
  const db  = loadDB();
  const row = db.archive.find(r => r.id === req.params.id);
  if (!row) return res.json({ success:false, error:'Not found' });
  res.json({ success:true, event:{ id:row.id, name:row.name||'',
    date:fmtDateTime(row.archived_date), bookings:row.bookings_json||[], financials:row.financials_json||null }});
});

app.post('/api/archive', (req, res) => {
  const db = loadDB();
  const bookings = db.bookings.map(mapBooking);
  if (!bookings.length) return res.json({ success:false, error:'No bookings to archive' });
  const fin  = getFinancials(db);
  const now  = new Date().toISOString();
  const name = req.body.name || ('Event - '+fmtDate(now));
  db.archive.push({ id:'EVT-'+Date.now(), name, archived_date:now,
    bookings_count:bookings.length, revenue:fin.summary.revenueCollected,
    capital_amount:fin.summary.totalCapital, expenses_amount:fin.summary.totalExpenses,
    net_profit:fin.summary.netProfit, bookings_json:bookings,
    financials_json:{ capital:fin.capital, expenses:fin.expenses, summary:fin.summary, breakdown:fin.breakdown }});
  saveDB(db);
  res.json({ success:true, events:archiveList(db) });
});

app.delete('/api/archive/:id', (req, res) => {
  const db  = loadDB();
  const idx = db.archive.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.json({ success:false, error:'Not found' });
  db.archive.splice(idx, 1); saveDB(db);
  res.json({ success:true, events:archiveList(db) });
});

// ── Reset ─────────────────────────────────────────────────────
app.post('/api/reset', (req, res) => {
  const db = loadDB();
  const bc = db.bookings.length, cc = db.capital.length, ec = db.expenses.length;
  db.bookings.forEach(r => {
    if (r.logo_url) { const fp = path.join(UPLOADS_DIR, path.basename(r.logo_url)); if (fs.existsSync(fp)) fs.unlinkSync(fp); }
  });
  db.bookings = []; db.capital = []; db.expenses = [];
  saveDB(db);
  res.json({ success:true, cleared:{ bookings:bc, capital:cc, expenses:ec },
    message:`Reset complete. ${bc} bookings, ${cc} capital entries, ${ec} expenses cleared. Archive preserved.` });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  🎪  Fest Bazaar  →  http://localhost:${PORT}\n`);
});
