// ============================================================
// Medical Appointment System — Express Backend (Render)
// Replaces Google Apps Script + Google Sheets
// Database: Supabase (PostgreSQL)
// ============================================================

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const { createClient } = require('@supabase/supabase-js');

// ── Supabase client (server-side, uses service_role key) ─────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS ──────────────────────────────────────────────────────
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({
  origin: allowedOrigin === '*' ? '*' : (origin, cb) => {
    if (!origin || origin === allowedOrigin) cb(null, true);
    else cb(new Error('Not allowed by CORS'));
  }
}));

app.use(express.json());
app.use(express.text({ type: 'text/plain' }));   // Apps-Script-style POST bodies

// ── Helpers ───────────────────────────────────────────────────
const TZ = 'Africa/Algiers';   // UTC+1, no DST
const TRIAL_MONTHS = 1;
const RENEWAL_WINDOW_DAYS = 20;

/** yyyy-MM-dd for a given Date in Algiers time */
function todayStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: TZ }); // sv-SE = ISO date
}

/** yyyy-MM-dd HH:mm:ss in Algiers time */
function nowStr() {
  return new Date().toLocaleString('sv-SE', { timeZone: TZ }).replace('T', ' ');
}

/** HH:mm in Algiers time */
function nowTime() {
  return new Date().toLocaleTimeString('sv-SE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}

/** Add months to a yyyy-MM-dd string */
function addMonths(dateStr, months) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setMonth(d.getMonth() + Number(months));
  return d.toLocaleDateString('sv-SE', { timeZone: TZ });
}

/** Add days to a yyyy-MM-dd string */
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + Number(days));
  return d.toLocaleDateString('sv-SE', { timeZone: TZ });
}

/** Days from today to dateStr (negative = past) */
function daysUntil(dateStr) {
  const today = new Date(todayStr() + 'T00:00:00');
  const target = new Date(dateStr + 'T00:00:00');
  return Math.round((target - today) / 86400000);
}

/** Parse working_days string "0,1,2,3,4" → Set of numbers */
function parseWorkingDays(str) {
  if (!str) return new Set([0, 1, 2, 3, 4, 5, 6]);
  const arr = String(str).split(',')
    .map(x => parseInt(x.trim(), 10))
    .filter(n => !isNaN(n) && n >= 0 && n <= 6);
  return arr.length ? new Set(arr) : new Set([0, 1, 2, 3, 4, 5, 6]);
}

/** Find previous / next working day from a date string */
function previousWorkingDay(dateStr, wdSet) {
  const d = new Date(dateStr + 'T00:00:00');
  for (let safety = 0; safety < 14; safety++) {
    d.setDate(d.getDate() - 1);
    if (wdSet.has(d.getDay())) break;
  }
  return d.toLocaleDateString('sv-SE', { timeZone: TZ });
}

function nextWorkingDay(dateStr, wdSet) {
  const d = new Date(dateStr + 'T00:00:00');
  for (let safety = 0; safety < 14; safety++) {
    d.setDate(d.getDate() + 1);
    if (wdSet.has(d.getDay())) break;
  }
  return d.toLocaleDateString('sv-SE', { timeZone: TZ });
}

/** Build full subscription info object */
function subscriptionInfo(subStart, subEnd, subDuration) {
  const duration = Number(subDuration) || 0;
  const endStr   = subEnd ? String(subEnd).split(' ')[0] : '';
  const startStr = subStart ? String(subStart).split(' ')[0] : '';
  const days     = endStr ? daysUntil(endStr) : null;

  let status = 'unknown';
  if (days !== null) {
    if      (days < 0)                      status = 'expired';
    else if (days <= RENEWAL_WINDOW_DAYS)   status = 'expiring';
    else                                    status = 'active';
  }

  return {
    subscriptionStart:    startStr,
    subscriptionEnd:      endStr,
    subscriptionDuration: duration,
    planLabel:    duration > 0 ? `${duration} Month${duration > 1 ? 's' : ''}` : 'Free Trial',
    daysRemaining:        days,
    subscriptionStatus:   status,
    showRenewal:          days !== null && days <= RENEWAL_WINDOW_DAYS
  };
}

/**
 * Ensure trial subscription for doctors registered before the subscription system.
 * If all three fields are blank, assign a 1-month trial from registration_date.
 * Returns { start, end, duration } strings.
 */
async function ensureTrial(doctor) {
  if (!doctor.subscription_start && !doctor.subscription_end) {
    const startStr = doctor.registration_date
      ? new Date(doctor.registration_date).toLocaleDateString('sv-SE', { timeZone: TZ })
      : todayStr();
    const endStr = addMonths(startStr, TRIAL_MONTHS);
    await supabase.from('doctors').update({
      subscription_start: startStr,
      subscription_end:   endStr,
      subscription_duration: 0
    }).eq('id', doctor.id);
    return { start: startStr, end: endStr, duration: 0 };
  }
  return {
    start:    doctor.subscription_start || '',
    end:      doctor.subscription_end   || '',
    duration: doctor.subscription_duration || 0
  };
}

// ── Parse body ────────────────────────────────────────────────
// Supports both JSON body and text/plain (as Apps Script did)
function parseBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

// ── Response helpers ──────────────────────────────────────────
const ok   = (res, obj)  => res.json({ result: 'success', ...obj });
const fail = (res, msg, field)  => res.json({ result: 'error', message: msg, field: field || null });

// =============================================================
// GET /api  — read-only actions
// =============================================================
app.get('/api', async (req, res) => {
  const action = req.query.action;

  // ── get_regions ──────────────────────────────────────────
  if (action === 'get_regions') {
    const { data, error } = await supabase
      .from('regions')
      .select('state, circle, municipality')
      .order('state').order('circle').order('municipality');
    if (error) return fail(res, error.message);
    // Return as [[state, circle, municipality], ...] to match original format
    return res.json(data.map(r => [r.state, r.circle, r.municipality]));
  }

  // ── get_specialties ──────────────────────────────────────
  if (action === 'get_specialties') {
    const { data, error } = await supabase
      .from('specialties')
      .select('name')
      .order('name');
    if (error) return fail(res, error.message);
    return res.json(data.map(r => r.name));
  }

  // ── get_doctors ──────────────────────────────────────────
  if (action === 'get_doctors') {
    const { state, circle, municipality, type, specialty } = req.query;
    if (!state || !circle || !municipality || !type) return fail(res, 'Missing parameters.');

    let query = supabase
      .from('doctors')
      .select('*')
      .eq('state', state)
      .eq('circle', circle)
      .eq('municipality', municipality)
      .eq('type', type);

    if (type === 'Specialist' && specialty) query = query.eq('specialty', specialty);

    const { data: doctors, error } = await query;
    if (error) return fail(res, error.message);

    const result = [];
    for (const doc of doctors) {
      const sub = await ensureTrial(doc);
      const info = subscriptionInfo(sub.start, sub.end, sub.duration);
      const isActive = doc.is_active && info.subscriptionStatus !== 'expired';
      result.push({
        fullName:   `${doc.first_name} ${doc.last_name}`,
        address:    doc.address,
        municipality: doc.municipality,
        state:      doc.state,
        type:       doc.type,
        specialty:  doc.specialty,
        isActive,
        isVerified: doc.verified
      });
    }
    return res.json(result);
  }

  // ── doctor dashboard (by email) ──────────────────────────
  if (req.query.doctorEmail) {
    const email = req.query.doctorEmail.trim();
    const { data: docs, error } = await supabase
      .from('doctors')
      .select('*')
      .eq('email', email)
      .limit(1);
    if (error || !docs.length) return res.json({ doctorName: null });

    const doc = docs[0];
    const sub  = await ensureTrial(doc);
    const info = subscriptionInfo(sub.start, sub.end, sub.duration);
    const isActive = doc.is_active && info.subscriptionStatus !== 'expired';
    const docName  = `${doc.first_name} ${doc.last_name}`;
    const workingDaysArr = [...parseWorkingDays(doc.working_days)];
    const wdSet    = parseWorkingDays(doc.working_days);

    const today     = todayStr();
    const yesterday = previousWorkingDay(today, wdSet);
    const tomorrow  = nextWorkingDay(today, wdSet);

    // Cleanup: delete appointments older than yesterday
    const cutoff = previousWorkingDay(today, wdSet);
    await supabase
      .from('appointments')
      .delete()
      .eq('doctor_name', docName)
      .lt('assigned_date', cutoff);

    const { data: appts } = await supabase
      .from('appointments')
      .select('*')
      .eq('doctor_name', docName)
      .gte('assigned_date', cutoff)
      .order('assigned_date')
      .order('queue_number');

    const appointments = (appts || []).map(a => {
      const aDay = a.assigned_date;
      let dayLabel = aDay;
      if (aDay === today)     dayLabel = 'TODAY';
      else if (aDay === yesterday) dayLabel = 'YESTERDAY';
      else if (aDay === tomorrow)  dayLabel = 'TOMORROW';
      return {
        firstName:   a.first_name,
        lastName:    a.last_name,
        phone:       a.phone,
        assignedDate: a.assigned_date,
        assignedDay:  a.assigned_date,
        dayLabel,
        queueNumber: a.queue_number
      };
    });

    // Sort: YESTERDAY → TODAY → TOMORROW → future
    const order = { YESTERDAY: 0, TODAY: 1, TOMORROW: 2 };
    appointments.sort((a, b) => {
      const oa = order[a.dayLabel] !== undefined ? order[a.dayLabel] : 3;
      const ob = order[b.dayLabel] !== undefined ? order[b.dayLabel] : 3;
      if (oa !== ob) return oa - ob;
      if (a.assignedDay !== b.assignedDay) return a.assignedDay.localeCompare(b.assignedDay);
      return a.queueNumber - b.queueNumber;
    });

    return res.json({
      doctorName:           docName,
      dailyLimit:           doc.daily_limit,
      isActive,
      isVerified:           doc.verified,
      workingDays:          workingDaysArr,
      workStart:            doc.work_start  || '08:00',
      workEnd:              doc.work_end    || '17:00',
      subscriptionStart:    info.subscriptionStart,
      subscriptionEnd:      info.subscriptionEnd,
      subscriptionDuration: info.subscriptionDuration,
      planLabel:            info.planLabel,
      daysRemaining:        info.daysRemaining,
      subscriptionStatus:   info.subscriptionStatus,
      showRenewal:          info.showRenewal,
      appointments
    });
  }

  return fail(res, 'Unknown action');
});

// =============================================================
// POST /api  — write actions
// =============================================================
app.post('/api', async (req, res) => {
  const data = parseBody(req);
  const { action } = data;

  // ── signup ────────────────────────────────────────────────
  if (action === 'signup') {
    const email = String(data.email || '').trim().toLowerCase();

    // Check duplicate email
    const { data: existing } = await supabase
      .from('doctors')
      .select('id')
      .eq('email', email)
      .limit(1);
    if (existing && existing.length)
      return fail(res, 'Email is already registered.', 'email');

    // Check duplicate phone
    const phone = String(data.phone || '').trim();
    if (phone) {
      const { data: existingPhone } = await supabase
        .from('doctors')
        .select('id')
        .eq('phone', phone)
        .limit(1);
      if (existingPhone && existingPhone.length)
        return fail(res, 'Phone is already registered.', 'phone');
    }

    const today    = todayStr();
    const trialEnd = addMonths(today, TRIAL_MONTHS);

    const { error } = await supabase.from('doctors').insert({
      first_name:           data.firstName   || '',
      last_name:            data.lastName    || '',
      phone:                data.phone       || '',
      birth_date:           data.birthDate   || null,
      email,
      password:             data.password    || '',
      state:                data.state       || '',
      circle:               data.circle      || '',
      municipality:         data.municipality|| '',
      address:              data.address     || '',
      type:                 data.type        || 'General',
      specialty:            data.specialty   || null,
      daily_limit:          40,
      is_active:            true,
      working_days:         '0,1,2,3,4,5,6',
      work_start:           '08:00',
      work_end:             '17:00',
      subscription_start:   today,
      subscription_end:     trialEnd,
      subscription_duration: 0,
      verified:             false
    });

    if (error) return fail(res, error.message);
    return ok(res);
  }

  // ── login ─────────────────────────────────────────────────
  if (action === 'login') {
    const identifier = String(data.email || '').trim();
    const password   = String(data.password || '').trim();

    const { data: docs } = await supabase
      .from('doctors')
      .select('*')
      .or(`email.eq.${identifier},phone.eq.${identifier}`)
      .limit(1);

    if (!docs || !docs.length) return fail(res, 'Invalid email or password');
    const doc = docs[0];
    if (doc.password.trim() !== password) return fail(res, 'Invalid email or password');

    const sub  = await ensureTrial(doc);
    const info = subscriptionInfo(sub.start, sub.end, sub.duration);
    const isActive = doc.is_active && info.subscriptionStatus !== 'expired';

    return ok(res, {
      doctor: {
        fullName:             `${doc.first_name} ${doc.last_name}`,
        email:                doc.email,
        dailyLimit:           doc.daily_limit,
        isActive,
        isVerified:           doc.verified,
        workingDays:          [...parseWorkingDays(doc.working_days)],
        workStart:            doc.work_start || '08:00',
        workEnd:              doc.work_end   || '17:00',
        subscriptionStart:    info.subscriptionStart,
        subscriptionEnd:      info.subscriptionEnd,
        subscriptionDuration: info.subscriptionDuration,
        planLabel:            info.planLabel,
        daysRemaining:        info.daysRemaining,
        subscriptionStatus:   info.subscriptionStatus,
        showRenewal:          info.showRenewal
      }
    });
  }

  // ── update_settings ───────────────────────────────────────
  if (action === 'update_settings') {
    const email = String(data.email || '').trim();
    const wdStr = Array.isArray(data.workingDays)
      ? data.workingDays.join(',')
      : String(data.workingDays || '0,1,2,3,4,5,6');

    const { error } = await supabase.from('doctors').update({
      daily_limit:  Number(data.dailyLimit) || 40,
      is_active:    Boolean(data.isActive),
      working_days: wdStr,
      work_start:   data.workStart || '08:00',
      work_end:     data.workEnd   || '17:00'
    }).eq('email', email);

    if (error) return fail(res, error.message);
    return ok(res);
  }

  // ── redeem_subscription_code ──────────────────────────────
  if (action === 'redeem_subscription_code') {
    const code  = String(data.code || '').trim().toUpperCase();
    const email = String(data.email || '').trim();
    if (!code)  return fail(res, 'Please enter an activation code.');
    if (!email) return fail(res, 'Doctor email required.');

    // subscription_codes has ONE row (id=1) with three array columns —
    // find which duration column this code belongs to
    const { data: rows } = await supabase
      .from('subscription_codes')
      .select('*')
      .eq('id', 1)
      .limit(1);
    const row = rows && rows[0];

    const DURATION_COLUMNS = { codes_3_months: 3, codes_6_months: 6, codes_12_months: 12 };
    let matchedCol = null, durationMonths = null;
    if (row) {
      for (const col of Object.keys(DURATION_COLUMNS)) {
        if ((row[col] || []).includes(code)) {
          matchedCol = col;
          durationMonths = DURATION_COLUMNS[col];
          break;
        }
      }
    }
    if (!matchedCol) return fail(res, 'Invalid or already-used activation code.');

    // Find doctor
    const { data: docs } = await supabase
      .from('doctors')
      .select('*')
      .eq('email', email)
      .limit(1);
    if (!docs || !docs.length) return fail(res, 'Doctor not found.');
    const doc = docs[0];

    const sub     = await ensureTrial(doc);
    const curEnd  = sub.end || '';
    const today   = todayStr();

    // Extend from current end date (or today if already expired)
    const newStart = curEnd && curEnd >= today ? curEnd : today;
    const newEnd   = addMonths(newStart, durationMonths);

    await supabase.from('doctors').update({
      subscription_start:    newStart,
      subscription_end:      newEnd,
      subscription_duration: durationMonths
    }).eq('id', doc.id);

    // Remove the code from its column's array (one-time use)
    const updatedArr = (row[matchedCol] || []).filter(c => c !== code);
    await supabase.from('subscription_codes')
      .update({ [matchedCol]: updatedArr, updated_at: new Date().toISOString() })
      .eq('id', 1);

    // Log usage
    await supabase.from('used_subscription_codes').insert({
      code,
      duration_months: durationMonths,
      used_by:  email,
      used_date: nowStr()
    });

    const info = subscriptionInfo(newStart, newEnd, durationMonths);
    return ok(res, {
      subscriptionStart:    info.subscriptionStart,
      subscriptionEnd:      info.subscriptionEnd,
      subscriptionDuration: info.subscriptionDuration,
      planLabel:            info.planLabel,
      daysRemaining:        info.daysRemaining,
      subscriptionStatus:   info.subscriptionStatus,
      showRenewal:          info.showRenewal
    });
  }

  // ── book ──────────────────────────────────────────────────
  if (action === 'book') {
    const wantedDoctor = String(data.doctor || '').trim();

    // Fetch doctor info
    // fullName is stored as first_name + ' ' + last_name
    const { data: allDocs } = await supabase
      .from('doctors')
      .select('*');

    const doc = (allDocs || []).find(d =>
      `${d.first_name} ${d.last_name}`.trim() === wantedDoctor
    );

    if (!doc) {
      // Doctor not found — still allow booking (no hard block)
    }

    let dailyLimit  = 40;
    let wdSet       = new Set([0, 1, 2, 3, 4, 5, 6]);
    let workStart   = '08:00';
    let workEnd     = '17:00';
    let doctorAvailable = true;

    if (doc) {
      dailyLimit = doc.daily_limit || 40;
      wdSet      = parseWorkingDays(doc.working_days);
      workStart  = doc.work_start || '08:00';
      workEnd    = doc.work_end   || '17:00';

      const sub  = await ensureTrial(doc);
      const info = subscriptionInfo(sub.start, sub.end, sub.duration);
      if (!doc.is_active || info.subscriptionStatus === 'expired') {
        doctorAvailable = false;
      }
    }

    if (!doctorAvailable)
      return fail(res, 'This doctor is not currently accepting bookings.');

    const startDay = todayStr();
    const timeNow  = nowTime();
    let checkDay   = startDay;

    // Find first available working day with capacity
    for (let safety = 0; safety < 90; safety++) {
      const dow = new Date(checkDay + 'T00:00:00').getDay();
      const isWorkingDay = wdSet.has(dow);

      let withinWorkHours;
      if (checkDay === startDay) {
        withinWorkHours = timeNow >= workStart && timeNow < workEnd;
      } else {
        withinWorkHours = true;
      }

      let count = 0;
      if (isWorkingDay) {
        const { count: cnt } = await supabase
          .from('appointments')
          .select('*', { count: 'exact', head: true })
          .eq('doctor_name', wantedDoctor)
          .eq('assigned_date', checkDay);
        count = cnt || 0;
      }

      if (isWorkingDay && withinWorkHours && count < dailyLimit) break;

      // Move to next day
      const d = new Date(checkDay + 'T00:00:00');
      d.setDate(d.getDate() + 1);
      checkDay = d.toLocaleDateString('sv-SE', { timeZone: TZ });

      if (safety >= 89)
        return fail(res, 'No available working day found for this doctor.');
    }

    // Count existing appointments for queue number
    const { count: existingCount } = await supabase
      .from('appointments')
      .select('*', { count: 'exact', head: true })
      .eq('doctor_name', wantedDoctor)
      .eq('assigned_date', checkDay);

    const queueNumber = (existingCount || 0) + 1;

    const { error: insertError } = await supabase.from('appointments').insert({
      first_name:   data.firstName || '',
      last_name:    data.lastName  || '',
      phone:        data.phone     || '',
      state:        data.state     || '',
      doctor_name:  wantedDoctor,
      assigned_date: checkDay,
      queue_number: queueNumber
    });

    if (insertError) return fail(res, insertError.message);
    return ok(res, { assignedDate: checkDay, queueNumber });
  }

  return fail(res, 'Unknown action');
});

// =============================================================
// Health check
// =============================================================
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// =============================================================
// Start
// =============================================================
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
