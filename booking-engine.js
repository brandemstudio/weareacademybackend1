// Core booking rules for the portal, kept separate from server.js so the
// trickiest logic (capacity limits, cancellation fees, waitlist handoff) can
// be unit-tested directly without spinning up HTTP requests.
//
// IMPORTANT — why this is safe from double-booking the last space:
// Node runs JS on a single thread. Two requests can only "race" each other
// at an `await` boundary (or other async gap) — not in between two plain
// synchronous statements. Every function below is 100% synchronous (db.js
// uses fs.readFileSync/writeFileSync, not the async fs.promises API), so a
// capacity check and the write that reserves the space happen as one
// uninterruptible unit. A second request literally cannot run until the
// first one has finished writing. See backend/test/booking.test.js for a
// concurrency test that proves this holds under real parallel requests.

const db = require('./db');

function nowIso() { return new Date().toISOString(); }
function newId(prefix) { return `${prefix}_${Date.now()}${Math.random().toString(36).slice(2, 8)}`; }

function getSettings() {
  const rows = db.readAll('settings');
  return rows[0] || {
    cancellationDays: 7,
    cancellationFeePercent: 100,
    billingMode: 'monthly', // 'monthly' | 'immediate'
  };
}

function activeBookingsFor(sessionId) {
  return db.find('bookings', (b) => b.sessionId === sessionId && ['booked', 'attended'].includes(b.status));
}

function spacesRemaining(session) {
  return session.capacity - activeBookingsFor(session.id).length;
}

class BookingError extends Error {
  constructor(message, code) { super(message); this.code = code || 'booking_error'; }
}

/**
 * Book a student into a session. Throws BookingError if the session is full,
 * the student is already booked, or the session doesn't exist/is cancelled.
 * Fully synchronous — see file header for why that matters.
 */
function bookSession({ sessionId, studentId, parentId }) {
  const session = db.findOne('sessions', (s) => s.id === sessionId);
  if (!session) throw new BookingError('Session not found.', 'not_found');
  if (session.status === 'cancelled') throw new BookingError('This session has been cancelled.', 'cancelled');

  const already = db.findOne('bookings', (b) => b.sessionId === sessionId && b.studentId === studentId && ['booked', 'attended'].includes(b.status));
  if (already) throw new BookingError('This student is already booked onto this session.', 'already_booked');

  if (spacesRemaining(session) <= 0) throw new BookingError('This session is full.', 'full');

  const booking = {
    id: newId('bkg'),
    sessionId,
    studentId,
    parentId,
    status: 'booked',
    paymentStatus: session.sessionType === 'educational' ? 'included' : (getSettings().billingMode === 'immediate' ? 'due' : 'billed_monthly'),
    price: session.sessionType === 'educational' ? 0 : session.price,
    bookedAt: nowIso(),
    cancelledAt: null,
    cancellationReason: null,
    cancellationFeeApplied: false,
  };
  db.insert('bookings', booking);
  return booking;
}

/**
 * Cancel a booking, applying the configured cancellation-fee window.
 * `now` is injectable for testing "within 7 days" vs "outside 7 days".
 */
function cancelBooking({ bookingId, reason, actorRole }, now = new Date()) {
  const booking = db.findOne('bookings', (b) => b.id === bookingId);
  if (!booking) throw new BookingError('Booking not found.', 'not_found');
  if (booking.status === 'cancelled') throw new BookingError('Booking is already cancelled.', 'already_cancelled');

  const session = db.findOne('sessions', (s) => s.id === booking.sessionId);
  const settings = getSettings();

  const sessionDateTime = new Date(`${session.date}T${to24h(session.startTime)}`);
  const daysUntil = (sessionDateTime - now) / (1000 * 60 * 60 * 24);
  const withinPolicyWindow = daysUntil < settings.cancellationDays;
  // Admins can override the charge; everyone else follows the policy.
  const feeApplies = withinPolicyWindow && actorRole !== 'admin' && session.sessionType !== 'educational';

  updateBooking(booking.id, {
    status: 'cancelled',
    cancelledAt: nowIso(),
    cancellationReason: reason || null,
    cancellationFeeApplied: feeApplies,
    paymentStatus: feeApplies ? booking.paymentStatus : 'waived',
  });

  notifyWaitlistIfSpaceOpened(session.id);
  return { feeApplies, daysUntil };
}

/** Parent releases their booked slot for someone else to take. */
function releaseBooking({ bookingId }) {
  const booking = db.findOne('bookings', (b) => b.id === bookingId);
  if (!booking) throw new BookingError('Booking not found.', 'not_found');
  updateBooking(booking.id, { status: 'released', cancelledAt: nowIso(), cancellationReason: 'released_by_parent' });
  notifyWaitlistIfSpaceOpened(booking.sessionId);
  return booking;
}

function updateBooking(id, patch) {
  const rows = db.readAll('bookings');
  const idx = rows.findIndex((b) => b.id === id);
  if (idx === -1) return null;
  rows[idx] = Object.assign({}, rows[idx], patch);
  db.writeAll('bookings', rows);
  return rows[idx];
}

function joinWaitlist({ sessionId, studentId, parentId }) {
  const existing = db.findOne('waitlist', (w) => w.sessionId === sessionId && w.studentId === studentId && !w.bookedAt);
  if (existing) return existing;
  const entry = { id: newId('wl'), sessionId, studentId, parentId, createdAt: nowIso(), notifiedAt: null, bookedAt: null };
  db.insert('waitlist', entry);
  return entry;
}

/** Notify (create an in-app notification for) everyone waiting on a session that now has space. */
function notifyWaitlistIfSpaceOpened(sessionId) {
  const session = db.findOne('sessions', (s) => s.id === sessionId);
  if (!session || spacesRemaining(session) <= 0) return;

  const waiting = db.find('waitlist', (w) => w.sessionId === sessionId && !w.bookedAt && !w.notifiedAt);
  waiting.forEach((entry) => {
    db.insert('notifications', {
      id: newId('ntf'),
      userId: entry.parentId,
      type: 'space_available',
      title: 'A space has become available',
      message: `A space is now available for your ${session.date} ${session.startTime} session in ${session.locationName || session.locationId}.`,
      data: { sessionId: session.id, studentId: entry.studentId },
      read: false,
      createdAt: nowIso(),
    });
    const rows = db.readAll('waitlist');
    const idx = rows.findIndex((w) => w.id === entry.id);
    if (idx !== -1) { rows[idx].notifiedAt = nowIso(); db.writeAll('waitlist', rows); }
  });
}

function to24h(t) {
  // "10:00am" / "4:00pm" -> "10:00" / "16:00"
  const m = t.match(/(\d+):(\d+)\s*(am|pm)/i);
  if (!m) return '00:00';
  let [, h, min, ap] = m;
  h = parseInt(h, 10);
  if (ap.toLowerCase() === 'pm' && h !== 12) h += 12;
  if (ap.toLowerCase() === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${min}`;
}

module.exports = {
  BookingError, getSettings, spacesRemaining, activeBookingsFor,
  bookSession, cancelBooking, releaseBooking, joinWaitlist, notifyWaitlistIfSpaceOpened,
  to24h,
};
