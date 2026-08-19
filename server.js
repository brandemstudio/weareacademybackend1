// Backend for We Are The Academy London.
// Handles: accounts (students + instructors), Stripe payments for classes and
// event tickets, and the data instructors/students see on sign in — who's
// enrolled in a class, and which classes/tickets a student has booked.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const db = require('./db');

if (!process.env.STRIPE_SECRET_KEY) {
  console.error('Missing STRIPE_SECRET_KEY in .env — copy .env.example to .env and fill it in.');
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  console.error('Missing JWT_SECRET in .env — add any long random string.');
  process.exit(1);
}

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
app.use(cors()); // for production, restrict this to your actual site's domain
app.use(express.json());

// Package prices in pence (GBP), kept server-side so nobody can tamper with
// the amount from the browser before it reaches Stripe.
const PACKAGES = {
  single: { label: 'Single Class', amount: 1200 },
  pass5: { label: '5-Class Pass', amount: 5000 },
  unlimited: { label: 'Monthly Unlimited', amount: 9000 },
};

// Which instructor teaches which class — used to build instructor rosters.
// Keep this in sync with the `schedule` data in index.html.
const CLASS_INSTRUCTORS = {
  'Hip-Hop': 'Danny Baker',
  'Street Fundamentals': 'Danny Baker',
  'Junior Academy': 'Danny Baker',
  'Heels': 'Kelly Westgate',
  'Commercial': 'Kelly Westgate',
  'Afrobeats': 'Kelly Westgate',
};

/* ---------------- auth helpers ---------------- */
const { signToken, requireAuth, requireRole } = require('./auth-middleware');

/* ---------------- accounts ---------------- */

app.post('/auth/register', async (req, res) => {
  try {
    const { role, name, email, password } = req.body;
    // Deliberately NOT including 'admin' here — anyone could otherwise self-
    // register full access to the platform. Admin accounts are created via
    // backend/create-admin.js (run once by whoever controls the server) or
    // by an existing admin through the authenticated /portal/admin/users route.
    if (!['student', 'instructor', 'parent'].includes(role)) {
      return res.status(400).json({ error: 'Unrecognised account type.' });
    }
    if (!name || !email || !password || password.length < 8) {
      return res.status(400).json({ error: 'Name, email, and an 8+ character password are required.' });
    }
    if (db.findOne('users', (u) => u.email.toLowerCase() === email.toLowerCase())) {
      return res.status(400).json({ error: 'An account with that email already exists.' });
    }
    const user = {
      id: 'usr_' + Date.now() + Math.random().toString(36).slice(2, 8),
      role,
      name,
      email,
      passwordHash: await bcrypt.hash(password, 10),
      createdAt: new Date().toISOString(),
    };
    db.insert('users', user);
    res.json({ token: signToken(user), user: { id: user.id, role, name, email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create account.' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = db.findOne('users', (u) => u.email.toLowerCase() === (email || '').toLowerCase());
    if (!user || !(await bcrypt.compare(password || '', user.passwordHash))) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }
    res.json({ token: signToken(user), user: { id: user.id, role: user.role, name: user.name, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not sign in.' });
  }
});

app.get('/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

/* ---------------- payments: class bookings ---------------- */

app.post('/create-payment-intent', async (req, res) => {
  try {
    const { pkg, customerEmail, customerName, className, classDay, classTime } = req.body;
    const chosen = PACKAGES[pkg];
    if (!chosen) return res.status(400).json({ error: 'Unknown package selected.' });

    // If the person is signed in, attach their user id so the booking can be
    // linked to their account once payment succeeds.
    let userId = null;
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (token) {
      try { userId = jwt.verify(token, process.env.JWT_SECRET).id; } catch { /* guest checkout is fine */ }
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: chosen.amount,
      currency: 'gbp',
      automatic_payment_methods: { enabled: true },
      receipt_email: customerEmail,
      metadata: {
        type: 'class',
        userId: userId || '',
        package: chosen.label,
        customerName: customerName || '',
        className: className || '',
        classDay: classDay || '',
        classTime: classTime || '',
      },
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: 'Could not start payment. Please try again.' });
  }
});

// Call this once Stripe confirms the payment succeeded, to actually save the
// booking (and, if signed in, attach it to the student's account so it shows
// up on their dashboard and the instructor's roster).
app.post('/confirm-booking', async (req, res) => {
  try {
    const { paymentIntentId } = req.body;
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (intent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment has not succeeded yet.' });
    }
    const m = intent.metadata;
    const booking = {
      id: 'bkg_' + Date.now() + Math.random().toString(36).slice(2, 8),
      type: 'class',
      userId: m.userId || null,
      customerName: m.customerName,
      customerEmail: intent.receipt_email,
      package: m.package,
      className: m.className,
      classDay: m.classDay,
      classTime: m.classTime,
      instructor: CLASS_INSTRUCTORS[m.className] || 'TBC',
      paymentIntentId: intent.id,
      createdAt: new Date().toISOString(),
    };
    db.insert('bookings', booking);
    res.json({ booking });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not confirm booking.' });
  }
});

/* ---------------- events & tickets ---------------- */

app.get('/events', (req, res) => {
  res.json({ events: db.readAll('events') });
});

app.post('/events/:id/create-payment-intent', async (req, res) => {
  try {
    const event = db.findOne('events', (e) => e.id === req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found.' });

    const quantity = Math.max(1, Math.min(10, parseInt(req.body.quantity, 10) || 1));
    const { customerEmail, customerName } = req.body;

    let userId = null;
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (token) {
      try { userId = jwt.verify(token, process.env.JWT_SECRET).id; } catch { /* guest checkout is fine */ }
    }

    if (event.price === 0) {
      // Free event — skip Stripe entirely and just record the booking.
      const booking = {
        id: 'bkg_' + Date.now() + Math.random().toString(36).slice(2, 8),
        type: 'event',
        userId,
        customerName,
        customerEmail,
        eventId: event.id,
        eventTitle: event.title,
        quantity,
        createdAt: new Date().toISOString(),
      };
      db.insert('bookings', booking);
      return res.json({ free: true, booking });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: event.price * quantity,
      currency: 'gbp',
      automatic_payment_methods: { enabled: true },
      receipt_email: customerEmail,
      metadata: {
        type: 'event',
        userId: userId || '',
        eventId: event.id,
        eventTitle: event.title,
        quantity: String(quantity),
        customerName: customerName || '',
      },
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: 'Could not start payment. Please try again.' });
  }
});

app.post('/events/confirm-ticket', async (req, res) => {
  try {
    const { paymentIntentId } = req.body;
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (intent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment has not succeeded yet.' });
    }
    const m = intent.metadata;
    const booking = {
      id: 'bkg_' + Date.now() + Math.random().toString(36).slice(2, 8),
      type: 'event',
      userId: m.userId || null,
      customerName: m.customerName,
      customerEmail: intent.receipt_email,
      eventId: m.eventId,
      eventTitle: m.eventTitle,
      quantity: parseInt(m.quantity, 10) || 1,
      paymentIntentId: intent.id,
      createdAt: new Date().toISOString(),
    };
    db.insert('bookings', booking);
    res.json({ booking });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not confirm ticket.' });
  }
});

/* ---------------- dashboards ---------------- */

// Student: everything they've booked — classes and event tickets.
app.get('/student/bookings', requireAuth, requireRole('student'), (req, res) => {
  const bookings = db.find('bookings', (b) => b.userId === req.user.id);
  res.json({ bookings });
});

// Instructor: their classes, each with the roster of students enrolled.
app.get('/instructor/roster', requireAuth, requireRole('instructor'), (req, res) => {
  const myClasses = Object.entries(CLASS_INSTRUCTORS)
    .filter(([, instructor]) => instructor === req.user.name)
    .map(([className]) => className);

  const allBookings = db.readAll('bookings').filter((b) => b.type === 'class');
  const roster = myClasses.map((className) => ({
    className,
    students: allBookings
      .filter((b) => b.className === className)
      .map((b) => ({ name: b.customerName, email: b.customerEmail, day: b.classDay, time: b.classTime, package: b.package })),
  }));

  res.json({ roster });
});

/* ---------------- booking portal (parents/instructors/admins) ---------------- */
const portalRouter = require('./portal');
portalRouter.attachStripeRoutes(stripe);
app.use('/portal', portalRouter);

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
