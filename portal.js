// Booking Portal API — parents managing children's private lessons,
// instructors managing their timetable, admins running the whole thing.
// Mounted onto the main Express app under /portal in server.js.
//
// Booking-critical logic (capacity, cancellation fees, waitlist) lives in
// booking-engine.js and is unit-tested separately — this file is mostly
// routing, validation, and shaping data for the frontend.

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('./db');
const engine = require('./booking-engine');
const { requireAuth, requireRole } = require('./auth-middleware');

const router = express.Router();

function newId(prefix) { return `${prefix}_${Date.now()}${Math.random().toString(36).slice(2, 8)}`; }

/* ---------------- seed data (runs once, safe to call every startup) ---------------- */
function ensureSeedData() {
  if (!db.readAll('locations').length) {
    db.writeAll('locations', [
      { id: 'london', name: 'London', address: 'To be confirmed — set the real studio address in Admin → Locations.' },
      { id: 'stevenage', name: 'Stevenage', address: 'To be confirmed — set the real studio address in Admin → Locations.' },
    ]);
  }
  if (!db.readAll('settings').length) {
    db.writeAll('settings', [{
      id: 'settings',
      cancellationDays: 7,
      cancellationFeePercent: 100,
      billingMode: 'monthly',
      standardPrivatePrice: 5000,
      educationalIncluded: true,
      reminderHours: [168, 24, 2],
    }]);
  }
}
ensureSeedData();

function getSettings() { return db.readAll('settings')[0]; }

/* ---------------- children (students) ---------------- */

router.post('/children', requireAuth, requireRole('parent'), (req, res) => {
  const { name, dateOfBirth, programme, instructorId, emergencyContact } = req.body;
  if (!name) return res.status(400).json({ error: 'Child name is required.' });
  const child = {
    id: newId('stu'),
    parentId: req.user.id,
    name,
    dateOfBirth: dateOfBirth || null,
    studentId: 'WALA-' + Math.floor(10000 + Math.random() * 90000),
    programme: programme || null,
    instructorId: instructorId || null,
    emergencyContact: emergencyContact || null,
    active: true,
    createdAt: new Date().toISOString(),
  };
  db.insert('children', child);
  res.json({ child });
});

router.get('/children', requireAuth, requireRole('parent'), (req, res) => {
  res.json({ children: db.find('children', (c) => c.parentId === req.user.id && c.active) });
});

router.get('/admin/students', requireAuth, requireRole('admin'), (req, res) => {
  const children = db.readAll('children');
  const users = db.readAll('users');
  const withParent = children.map((c) => {
    const parent = users.find((u) => u.id === c.parentId);
    return Object.assign({}, c, { parentName: parent ? parent.name : 'Unknown', parentEmail: parent ? parent.email : '' });
  });
  res.json({ students: withParent });
});

router.put('/admin/students/:id', requireAuth, requireRole('admin'), (req, res) => {
  const rows = db.readAll('children');
  const idx = rows.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Student not found.' });
  rows[idx] = Object.assign({}, rows[idx], req.body, { id: rows[idx].id, parentId: rows[idx].parentId });
  db.writeAll('children', rows);
  res.json({ child: rows[idx] });
});

router.delete('/admin/students/:id', requireAuth, requireRole('admin'), (req, res) => {
  const rows = db.readAll('children');
  const idx = rows.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Student not found.' });
  rows[idx].active = false;
  db.writeAll('children', rows);
  res.json({ ok: true });
});

/* ---------------- locations ---------------- */

router.get('/locations', requireAuth, (req, res) => {
  res.json({ locations: db.readAll('locations') });
});

router.put('/admin/locations/:id', requireAuth, requireRole('admin'), (req, res) => {
  const rows = db.readAll('locations');
  const idx = rows.findIndex((l) => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Location not found.' });
  rows[idx] = Object.assign({}, rows[idx], req.body, { id: rows[idx].id });
  db.writeAll('locations', rows);
  res.json({ location: rows[idx] });
});

/* ---------------- timetable / sessions ---------------- */

function enrichSession(session) {
  const remaining = session.sessionType === 'educational' ? null : engine.spacesRemaining(session);
  const location = db.findOne('locations', (l) => l.id === session.locationId);
  const instructor = db.findOne('users', (u) => u.id === session.instructorId);
  return Object.assign({}, session, {
    spacesRemaining: remaining,
    locationName: location ? location.name : session.locationId,
    instructorName: instructor ? instructor.name : 'TBC',
  });
}

router.get('/sessions', requireAuth, (req, res) => {
  const { weekStart } = req.query;
  let sessions = db.readAll('sessions').filter((s) => s.status !== 'deleted');
  if (weekStart) {
    const start = new Date(weekStart + 'T00:00:00');
    const end = new Date(start); end.setDate(end.getDate() + 7);
    sessions = sessions.filter((s) => {
      const d = new Date(s.date + 'T00:00:00');
      return d >= start && d < end;
    });
  }
  res.json({ sessions: sessions.map(enrichSession) });
});

router.post('/admin/sessions', requireAuth, requireRole(['admin', 'instructor']), (req, res) => {
  const { date, startTime, endTime, locationId, sessionType, capacity, price, notes } = req.body;
  const instructorId = req.user.role === 'instructor' ? req.user.id : (req.body.instructorId || null);
  if (!date || !startTime || !endTime || !locationId || !sessionType) {
    return res.status(400).json({ error: 'Date, time, location and session type are required.' });
  }
  const settings = getSettings();
  const session = {
    id: newId('sess'),
    date, startTime, endTime, locationId,
    instructorId,
    sessionType,
    capacity: sessionType === 'educational' ? (capacity || 999) : Math.min(3, capacity || 3),
    price: sessionType === 'educational' ? 0 : (price != null ? price : settings.standardPrivatePrice),
    status: 'active',
    notes: notes || null,
    createdAt: new Date().toISOString(),
  };
  db.insert('sessions', session);
  res.json({ session: enrichSession(session) });
});

// Instructors can only ever touch their own sessions — admins can touch any.
function assertCanManageSession(req, session, res){
  if (req.user.role === 'admin') return true;
  if (session.instructorId !== req.user.id) {
    res.status(403).json({ error: "You can only manage your own sessions — ask an admin for changes to another instructor's session." });
    return false;
  }
  return true;
}

router.put('/admin/sessions/:id', requireAuth, requireRole(['admin', 'instructor']), (req, res) => {
  const rows = db.readAll('sessions');
  const idx = rows.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Session not found.' });
  if (!assertCanManageSession(req, rows[idx], res)) return;
  const patch = Object.assign({}, req.body); delete patch.id;
  // Instructors can't hand a session to a different instructor or reassign it away from themselves.
  if (req.user.role === 'instructor') delete patch.instructorId;
  rows[idx] = Object.assign({}, rows[idx], patch);
  db.writeAll('sessions', rows);
  res.json({ session: enrichSession(rows[idx]) });
});

router.delete('/admin/sessions/:id', requireAuth, requireRole(['admin', 'instructor']), (req, res) => {
  const rows = db.readAll('sessions');
  const idx = rows.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Session not found.' });
  if (!assertCanManageSession(req, rows[idx], res)) return;
  rows[idx].status = 'cancelled';
  db.writeAll('sessions', rows);

  const affected = db.find('bookings', (b) => b.sessionId === rows[idx].id && ['booked', 'attended'].includes(b.status));
  affected.forEach((b) => {
    db.insert('notifications', {
      id: newId('ntf'), userId: b.parentId, type: 'session_cancelled',
      title: 'A session has been cancelled',
      message: `Your ${rows[idx].date} ${rows[idx].startTime} session at ${rows[idx].locationId} has been cancelled by the academy.`,
      data: { sessionId: rows[idx].id }, read: false, createdAt: new Date().toISOString(),
    });
    engine.cancelBooking({ bookingId: b.id, reason: 'session_cancelled_by_academy', actorRole: 'admin' });
  });

  res.json({ ok: true });
});

router.post('/admin/sessions/duplicate-week', requireAuth, requireRole(['admin', 'instructor']), (req, res) => {
  const { fromWeekStart, toWeekStart } = req.body;
  if (!fromWeekStart || !toWeekStart) return res.status(400).json({ error: 'Both week start dates are required.' });

  const from = new Date(fromWeekStart + 'T00:00:00');
  const to = new Date(toWeekStart + 'T00:00:00');
  const dayOffset = Math.round((to - from) / (1000 * 60 * 60 * 24));

  const end = new Date(from); end.setDate(end.getDate() + 7);
  // Instructors duplicating a week only copy their own sessions — an admin
  // copies everyone's, since only they should be reshaping other people's timetables.
  const source = db.readAll('sessions').filter((s) => {
    const d = new Date(s.date + 'T00:00:00');
    const inWeek = d >= from && d < end && s.status === 'active';
    if (!inWeek) return false;
    return req.user.role === 'admin' || s.instructorId === req.user.id;
  });

  const created = source.map((s) => {
    const newDate = new Date(s.date + 'T00:00:00');
    newDate.setDate(newDate.getDate() + dayOffset);
    const copy = Object.assign({}, s, {
      id: newId('sess'),
      date: newDate.toISOString().slice(0, 10),
      createdAt: new Date().toISOString(),
    });
    db.insert('sessions', copy);
    return copy;
  });

  res.json({ created: created.map(enrichSession) });
});

router.post('/admin/sessions/:id/enroll-all', requireAuth, requireRole(['admin', 'instructor']), (req, res) => {
  const session = db.findOne('sessions', (s) => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  if (session.sessionType !== 'educational') return res.status(400).json({ error: 'Only educational sessions can be bulk-enrolled.' });

  const children = db.find('children', (c) => c.active);
  let enrolled = 0;
  children.forEach((child) => {
    try {
      engine.bookSession({ sessionId: session.id, studentId: child.id, parentId: child.parentId });
      enrolled++;
    } catch (e) { /* already enrolled — fine, skip */ }
  });
  res.json({ enrolled, total: children.length });
});

/* ---------------- bookings ---------------- */

router.post('/bookings', requireAuth, requireRole('parent'), (req, res) => {
  const { sessionId, studentId } = req.body;
  const child = db.findOne('children', (c) => c.id === studentId && c.parentId === req.user.id);
  if (!child) return res.status(403).json({ error: 'That student is not linked to your account.' });
  try {
    const booking = engine.bookSession({ sessionId, studentId, parentId: req.user.id });
    res.json({ booking });
  } catch (e) {
    res.status(e.code === 'full' ? 409 : 400).json({ error: e.message, code: e.code });
  }
});

router.post('/bookings/:id/cancel', requireAuth, requireRole(['parent', 'admin']), (req, res) => {
  const booking = db.findOne('bookings', (b) => b.id === req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });
  if (req.user.role === 'parent' && booking.parentId !== req.user.id) {
    return res.status(403).json({ error: 'Not your booking.' });
  }
  try {
    const result = engine.cancelBooking({ bookingId: booking.id, reason: req.body.reason, actorRole: req.user.role });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/bookings/:id/release', requireAuth, requireRole('parent'), (req, res) => {
  const booking = db.findOne('bookings', (b) => b.id === req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });
  if (booking.parentId !== req.user.id) return res.status(403).json({ error: 'Not your booking.' });
  try {
    const result = engine.releaseBooking({ bookingId: booking.id });
    res.json({ booking: result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/parent/bookings', requireAuth, requireRole('parent'), (req, res) => {
  const bookings = db.find('bookings', (b) => b.parentId === req.user.id);
  const sessions = db.readAll('sessions');
  const children = db.readAll('children');
  const enriched = bookings.map((b) => {
    const session = sessions.find((s) => s.id === b.sessionId);
    const child = children.find((c) => c.id === b.studentId);
    return Object.assign({}, b, {
      session: session ? enrichSession(session) : null,
      studentName: child ? child.name : 'Unknown',
    });
  }).sort((a, b) => (a.session && b.session ? a.session.date.localeCompare(b.session.date) : 0));
  res.json({ bookings: enriched });
});

/* ---------------- waitlist ---------------- */

router.post('/waitlist', requireAuth, requireRole('parent'), (req, res) => {
  const { sessionId, studentId } = req.body;
  const child = db.findOne('children', (c) => c.id === studentId && c.parentId === req.user.id);
  if (!child) return res.status(403).json({ error: 'That student is not linked to your account.' });
  const entry = engine.joinWaitlist({ sessionId, studentId, parentId: req.user.id });
  res.json({ entry });
});

router.get('/admin/waitlist', requireAuth, requireRole('admin'), (req, res) => {
  const entries = db.find('waitlist', (w) => !w.bookedAt);
  const sessions = db.readAll('sessions');
  const children = db.readAll('children');
  const enriched = entries.map((w) => Object.assign({}, w, {
    session: sessions.find((s) => s.id === w.sessionId),
    studentName: (children.find((c) => c.id === w.studentId) || {}).name || 'Unknown',
  }));
  res.json({ waitlist: enriched });
});

/* ---------------- notifications ---------------- */

router.get('/notifications', requireAuth, (req, res) => {
  const notifs = db.find('notifications', (n) => n.userId === req.user.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ notifications: notifs });
});

router.post('/notifications/:id/read', requireAuth, (req, res) => {
  const rows = db.readAll('notifications');
  const idx = rows.findIndex((n) => n.id === req.params.id && n.userId === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'Notification not found.' });
  rows[idx].read = true;
  db.writeAll('notifications', rows);
  res.json({ ok: true });
});

router.post('/admin/notifications/broadcast', requireAuth, requireRole('admin'), (req, res) => {
  const { title, message } = req.body;
  if (!title || !message) return res.status(400).json({ error: 'Title and message are required.' });
  const parents = db.find('users', (u) => u.role === 'parent');
  parents.forEach((p) => {
    db.insert('notifications', {
      id: newId('ntf'), userId: p.id, type: 'admin_broadcast', title, message,
      data: {}, read: false, createdAt: new Date().toISOString(),
    });
  });
  res.json({ sentTo: parents.length });
});

/* ---------------- billing / invoices ---------------- */

router.post('/admin/invoices/generate', requireAuth, requireRole('admin'), (req, res) => {
  const { billingPeriod } = req.body;
  if (!billingPeriod) return res.status(400).json({ error: 'billingPeriod is required, e.g. "2026-08".' });

  const chargeable = db.find('bookings', (b) =>
    b.paymentStatus === 'billed_monthly' &&
    ['booked', 'attended'].includes(b.status) &&
    b.sessionId && sessionInPeriod(b.sessionId, billingPeriod)
  );

  const byParent = {};
  chargeable.forEach((b) => { (byParent[b.parentId] = byParent[b.parentId] || []).push(b); });

  const invoices = Object.entries(byParent).map(([parentId, bookings]) => {
    const total = bookings.reduce((sum, b) => sum + b.price, 0);
    const invoice = {
      id: newId('inv'), parentId, billingPeriod, total, status: 'unpaid',
      dueDate: null, paidAt: null, stripePaymentIntentId: null, createdAt: new Date().toISOString(),
    };
    db.insert('invoices', invoice);
    bookings.forEach((b) => {
      db.insert('invoiceItems', {
        id: newId('invitem'), invoiceId: invoice.id, bookingId: b.id,
        description: describeBooking(b), amount: b.price,
      });
      const rows = db.readAll('bookings');
      const idx = rows.findIndex((x) => x.id === b.id);
      rows[idx].paymentStatus = 'invoiced';
      db.writeAll('bookings', rows);
    });
    db.insert('notifications', {
      id: newId('ntf'), userId: parentId, type: 'invoice_generated',
      title: `Your ${billingPeriod} invoice is ready`,
      message: `Total due: £${(total / 100).toFixed(2)}.`,
      data: { invoiceId: invoice.id }, read: false, createdAt: new Date().toISOString(),
    });
    return invoice;
  });

  res.json({ invoices, parentCount: invoices.length });
});

function sessionInPeriod(sessionId, period) {
  const session = db.findOne('sessions', (s) => s.id === sessionId);
  return session && session.date.startsWith(period);
}
function describeBooking(booking) {
  const session = db.findOne('sessions', (s) => s.id === booking.sessionId);
  return session ? `Private session — ${session.date} ${session.startTime}` : 'Private session';
}

router.get('/parent/invoices', requireAuth, requireRole('parent'), (req, res) => {
  const invoices = db.find('invoices', (i) => i.parentId === req.user.id);
  const items = db.readAll('invoiceItems');
  res.json({ invoices: invoices.map((inv) => Object.assign({}, inv, { items: items.filter((it) => it.invoiceId === inv.id) })) });
});

router.get('/admin/invoices', requireAuth, requireRole('admin'), (req, res) => {
  const invoices = db.readAll('invoices');
  const users = db.readAll('users');
  res.json({ invoices: invoices.map((inv) => Object.assign({}, inv, { parentName: (users.find((u) => u.id === inv.parentId) || {}).name || 'Unknown' })) });
});

/* ---------------- settings ---------------- */

router.get('/settings', requireAuth, (req, res) => {
  res.json({ settings: getSettings() });
});

router.put('/admin/settings', requireAuth, requireRole('admin'), (req, res) => {
  const rows = db.readAll('settings');
  rows[0] = Object.assign({}, rows[0], req.body, { id: 'settings' });
  db.writeAll('settings', rows);
  res.json({ settings: rows[0] });
});

/* ---------------- admin: staff & stats ---------------- */

router.post('/admin/users', requireAuth, requireRole('admin'), async (req, res) => {
  const { role, name, email, password } = req.body;
  if (!['instructor', 'admin'].includes(role)) return res.status(400).json({ error: 'Role must be instructor or admin.' });
  if (!name || !email || !password || password.length < 8) return res.status(400).json({ error: 'Name, email and an 8+ character password are required.' });
  if (db.findOne('users', (u) => u.email.toLowerCase() === email.toLowerCase())) return res.status(400).json({ error: 'An account with that email already exists.' });
  const user = { id: newId('usr'), role, name, email, passwordHash: await bcrypt.hash(password, 10), createdAt: new Date().toISOString() };
  db.insert('users', user);
  res.json({ user: { id: user.id, role, name, email } });
});

router.get('/admin/instructors', requireAuth, requireRole('admin'), (req, res) => {
  res.json({ instructors: db.find('users', (u) => u.role === 'instructor').map((u) => ({ id: u.id, name: u.name, email: u.email })) });
});

router.get('/admin/stats', requireAuth, requireRole('admin'), (req, res) => {
  const children = db.find('children', (c) => c.active);
  const sessions = db.readAll('sessions').filter((s) => s.status === 'active');
  const bookings = db.readAll('bookings');
  const invoices = db.readAll('invoices');
  const waitlist = db.find('waitlist', (w) => !w.bookedAt);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const weekEnd = new Date(today); weekEnd.setDate(weekEnd.getDate() + 7);
  const thisWeek = sessions.filter((s) => { const d = new Date(s.date + 'T00:00:00'); return d >= today && d < weekEnd; });
  const fullyBooked = thisWeek.filter((s) => engine.spacesRemaining(s) <= 0);
  const cancellations = bookings.filter((b) => b.status === 'cancelled').length;
  const revenueThisMonth = invoices
    .filter((i) => i.status === 'paid' && i.paidAt && i.paidAt.slice(0, 7) === new Date().toISOString().slice(0, 7))
    .reduce((sum, i) => sum + i.total, 0);
  const outstanding = invoices.filter((i) => i.status === 'unpaid').reduce((sum, i) => sum + i.total, 0);

  res.json({
    totalStudents: children.length,
    sessionsThisWeek: thisWeek.length,
    fullyBookedThisWeek: fullyBooked.length,
    upcomingSessions: sessions.filter((s) => new Date(s.date + 'T00:00:00') >= today).length,
    revenueThisMonth,
    outstandingBalance: outstanding,
    cancellations,
    waitlistRequests: waitlist.length,
  });
});

/* ---------------- instructor: timetable & attendance ---------------- */

router.get('/instructor/sessions', requireAuth, requireRole('instructor'), (req, res) => {
  const { weekStart } = req.query;
  let sessions = db.readAll('sessions').filter((s) => s.status === 'active' && s.instructorId === req.user.id);
  if (weekStart) {
    const start = new Date(weekStart + 'T00:00:00');
    const end = new Date(start); end.setDate(end.getDate() + 7);
    sessions = sessions.filter((s) => { const d = new Date(s.date + 'T00:00:00'); return d >= start && d < end; });
  }
  const children = db.readAll('children');
  const bookings = db.readAll('bookings');
  const withRoster = sessions.map((s) => {
    const roster = bookings
      .filter((b) => b.sessionId === s.id && ['booked', 'attended'].includes(b.status))
      .map((b) => ({
        bookingId: b.id,
        studentName: (children.find((c) => c.id === b.studentId) || {}).name || 'Unknown',
        attendanceStatus: b.attendanceStatus || null,
      }));
    return Object.assign(enrichSession(s), { roster });
  });
  res.json({ sessions: withRoster });
});

router.post('/instructor/attendance', requireAuth, requireRole(['instructor', 'admin']), (req, res) => {
  const { bookingId, status } = req.body;
  if (!['attended', 'absent', 'late_cancellation'].includes(status)) {
    return res.status(400).json({ error: 'Status must be attended, absent, or late_cancellation.' });
  }
  const rows = db.readAll('bookings');
  const idx = rows.findIndex((b) => b.id === bookingId);
  if (idx === -1) return res.status(404).json({ error: 'Booking not found.' });
  rows[idx].attendanceStatus = status;
  if (status === 'attended') rows[idx].status = 'attended';
  db.writeAll('bookings', rows);
  res.json({ booking: rows[idx] });
});

/* ---------------- invoice payments (Stripe) ---------------- */
// Reuses the same Stripe secret key/config as the rest of server.js — passed
// in when this router is mounted, so there's only one Stripe setup to manage.
function attachStripeRoutes(stripe) {
  router.post('/invoices/:id/create-payment-intent', requireAuth, requireRole('parent'), async (req, res) => {
    const invoice = db.findOne('invoices', (i) => i.id === req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
    if (invoice.parentId !== req.user.id) return res.status(403).json({ error: 'Not your invoice.' });
    if (invoice.status === 'paid') return res.status(400).json({ error: 'This invoice is already paid.' });
    try {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: invoice.total,
        currency: 'gbp',
        automatic_payment_methods: { enabled: true },
        metadata: { type: 'invoice', invoiceId: invoice.id, parentId: invoice.parentId },
      });
      res.json({ clientSecret: paymentIntent.client_secret });
    } catch (e) {
      res.status(500).json({ error: 'Could not start payment. Please try again.' });
    }
  });

  router.post('/invoices/confirm-payment', requireAuth, requireRole('parent'), async (req, res) => {
    try {
      const intent = await stripe.paymentIntents.retrieve(req.body.paymentIntentId);
      if (intent.status !== 'succeeded') return res.status(400).json({ error: 'Payment has not succeeded yet.' });
      const rows = db.readAll('invoices');
      const idx = rows.findIndex((i) => i.id === intent.metadata.invoiceId);
      if (idx === -1) return res.status(404).json({ error: 'Invoice not found.' });
      rows[idx].status = 'paid';
      rows[idx].paidAt = new Date().toISOString();
      rows[idx].stripePaymentIntentId = intent.id;
      db.writeAll('invoices', rows);
      res.json({ invoice: rows[idx] });
    } catch (e) {
      res.status(500).json({ error: 'Could not confirm payment.' });
    }
  });
}

module.exports = router;
module.exports.attachStripeRoutes = attachStripeRoutes;
