/**
 * EarnWave Backend Server
 * Firebase Admin SDK + PayHero SPS STK Push
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

/* ============================================================
   FIREBASE ADMIN INIT (BASE64)
============================================================ */
let db;

try {
  let serviceAccount = null;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const json = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
    serviceAccount = JSON.parse(json);
    console.log('[Firebase] Loaded from FIREBASE_SERVICE_ACCOUNT_BASE64');
  }

  if (!serviceAccount && process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    console.log('[Firebase] Loaded from FIREBASE_SERVICE_ACCOUNT_JSON');
  }

  if (!serviceAccount) {
    console.error('[Firebase] CRITICAL: No service account configured.');
    process.exit(1);
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  db = admin.firestore();
  console.log('[Firebase] Admin SDK initialized. Project:', serviceAccount.project_id);
} catch (err) {
  console.error('[Firebase] Initialization failed:', err.message);
  process.exit(1);
}

/* ============================================================
   MIDDLEWARE
============================================================ */
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

/* ============================================================
   PAYHERO CLIENT — SPS ENDPOINT (CORRECT)
   Endpoint: https://payherokenya.com/sps/portal/app/stk.php
   Auth: api_key + username in request body
============================================================ */
const PAYHERO_USERNAME = process.env.PAYHERO_USERNAME;
const PAYHERO_PASSWORD = process.env.PAYHERO_PASSWORD;

if (!PAYHERO_USERNAME || !PAYHERO_PASSWORD) {
  console.warn('[PayHero] Missing credentials. STK push will fail.');
}

const payhero = axios.create({
  baseURL: 'https://payherokenya.com/sps/portal/app',
  timeout: 25000,
  headers: {
    'Content-Type': 'application/json',
  },
});

/* ============================================================
   LOAD TASKS
============================================================ */
let TASKS_DATA;
try {
  const tasksPath = path.join(__dirname, 'tasks.json');
  if (!fs.existsSync(tasksPath)) {
    console.error('[Tasks] tasks.json not found at:', tasksPath);
    process.exit(1);
  }
  TASKS_DATA = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
} catch (err) {
  console.error('[Tasks] Failed to load tasks.json:', err.message);
  process.exit(1);
}

const CATEGORIES = TASKS_DATA.categories;
const TASKS = TASKS_DATA.tasks;

function unlockFeeFor(task) {
  const cat = CATEGORIES.find(c => c.id === task.categoryId);
  return cat ? cat.unlockFee : Number(process.env.UNLOCK_FEE_DEFAULT_KES || 15);
}

/* ============================================================
   HELPERS
============================================================ */
function normalizePhone(phone) {
  if (!phone) return phone;
  let p = phone.toString().replace(/\D/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  return p;
}

function isValidKenyanPhone(phone) {
  if (!phone) return false;
  const p = normalizePhone(phone);
  return /^254[17]\d{8}$/.test(p);
}

/* ============================================================
   AUTH MIDDLEWARE
============================================================ */
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!idToken) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.user = decoded;
    next();
  } catch (err) {
    console.error('[Auth] Token verify failed:', err.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/* ============================================================
   PUBLIC ROUTES
============================================================ */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'EarnWave',
    firebase: db ? 'connected' : 'not initialized',
    payhero_configured: !!(PAYHERO_USERNAME && PAYHERO_PASSWORD),
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/tasks', (req, res) => {
  res.json({ categories: CATEGORIES, tasks: TASKS });
});

/* ============================================================
   USER ROUTES
============================================================ */
app.post('/api/user/bootstrap', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { phone, username } = req.body || {};

    if (phone && !isValidKenyanPhone(phone)) {
      return res.status(400).json({ error: 'Invalid Kenyan phone number' });
    }

    const userRef = db.collection('users').doc(uid);
    const snap = await userRef.get();

    if (!snap.exists) {
      const newUser = {
        uid,
        email: req.user.email || null,
        username: username || (req.user.email ? req.user.email.split('@')[0] : 'user'),
        phone: phone ? normalizePhone(phone) : null,
        referralCode: 'EARNWAVE-' + Math.random().toString(36).substring(2, 7).toUpperCase(),
        status: 'PENDING',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        balance: 0,
        lifetimeEarnings: 0,
      };
      await userRef.set(newUser);
      await userRef.collection('transactions').add({
        type: 'Account Created',
        amount: 0,
        direction: 'CREDIT',
        status: 'COMPLETED',
        date: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.json({ created: true, user: newUser });
    }

    const existing = snap.data();
    if (phone && !existing.phone) {
      await userRef.update({ phone: normalizePhone(phone) });
      existing.phone = normalizePhone(phone);
    }

    return res.json({ created: false, user: existing });
  } catch (err) {
    console.error('[bootstrap]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/user/me', requireAuth, async (req, res) => {
  try {
    const snap = await db.collection('users').doc(req.user.uid).get();
    if (!snap.exists) return res.status(404).json({ error: 'User not found' });
    res.json({ user: snap.data() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/user/phone', requireAuth, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!isValidKenyanPhone(phone)) {
      return res.status(400).json({ error: 'Invalid Kenyan phone number' });
    }
    const normalized = normalizePhone(phone);
    await db.collection('users').doc(req.user.uid).update({ phone: normalized });
    res.json({ success: true, phone: normalized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/user/transactions', requireAuth, async (req, res) => {
  try {
    const snap = await db.collection('users').doc(req.user.uid)
      .collection('transactions')
      .orderBy('date', 'desc')
      .limit(100)
      .get();

    const txs = [];
    snap.forEach(doc => txs.push({ id: doc.id, ...doc.data() }));
    res.json({ transactions: txs });
  } catch (err) {
    console.error('[transactions]', err);
    res.json({ transactions: [] });
  }
});

/* ============================================================
   PAYMENT — ACTIVATION (SPS STK PUSH)
============================================================ */
app.post('/api/payment/activation', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });

    const user = userSnap.data();
    if (user.status === 'ACTIVE') {
      return res.status(400).json({ error: 'Account already active' });
    }

    const phone = req.body.phone || user.phone;
    if (!phone) return res.status(400).json({ error: 'Phone number required' });
    if (!isValidKenyanPhone(phone)) {
      return res.status(400).json({ error: 'Invalid Kenyan phone number' });
    }

    const normalizedPhone = normalizePhone(phone);
    if (!user.phone || user.phone !== normalizedPhone) {
      await db.collection('users').doc(uid).update({ phone: normalizedPhone });
    }

    const amount = Number(process.env.ACCOUNT_ACTIVATION_FEE_KES || 100);
    const reference = `ACT-${uid.slice(0, 8)}-${Date.now()}`;

    // CORRECT: SPS endpoint with credentials in body
    const response = await payhero.post('/stk.php', {
      api_key: PAYHERO_PASSWORD,
      username: PAYHERO_USERNAME,
      amount: amount,
      phone: normalizedPhone,
      user_reference: reference,
    });

    await db.collection('payments').doc(reference).set({
      uid,
      type: 'ACTIVATION',
      amount,
      phone: normalizedPhone,
      reference,
      status: 'PENDING',
      provider: 'payhero',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      payheroResponse: response.data,
    });

    res.json({
      success: true,
      reference,
      message: 'STK push sent. Enter your M-Pesa PIN to complete.',
      payhero: response.data,
    });
  } catch (err) {
    console.error('[activation payment] FULL ERROR:', {
      message: err.message,
      code: err.code,
      response: err.response?.data,
    });

    res.status(500).json({
      error: 'Payment initiation failed',
      details: err.response?.data || err.message,
      code: err.code || null,
    });
  }
});

/* ============================================================
   PAYMENT — STATUS
============================================================ */
app.get('/api/payment/status/:reference', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { reference } = req.params;

    const snap = await db.collection('payments').doc(reference).get();
    if (!snap.exists) return res.status(404).json({ error: 'Payment not found' });

    const payment = snap.data();
    if (payment.uid !== uid) {
      return res.status(403).json({ error: 'Not your payment' });
    }

    res.json({
      reference,
      status: payment.status,
      mpesaCode: payment.mpesaCode || null,
    });
  } catch (err) {
    console.error('[payment/status]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   PAYMENT — UNLOCK TASK
============================================================ */
app.post('/api/payment/unlock', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { taskId } = req.body;
    if (!taskId) return res.status(400).json({ error: 'taskId required' });

    const task = TASKS.find(t => t.id === taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const fee = unlockFeeFor(task);
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    const user = userSnap.data();

    if (user.status !== 'ACTIVE') {
      return res.status(403).json({ error: 'Activate your account first' });
    }

    if (user.balance < fee) {
      return res.status(400).json({
        error: `Insufficient balance. Need KES ${fee}, have KES ${user.balance}.`,
        required: fee,
        balance: user.balance,
      });
    }

    await userRef.update({
      balance: admin.firestore.FieldValue.increment(-fee),
    });

    await userRef.collection('transactions').add({
      type: `Unlock: ${task.title}`,
      amount: fee,
      direction: 'DEBIT',
      status: 'COMPLETED',
      date: admin.firestore.FieldValue.serverTimestamp(),
    });

    await userRef.collection('unlockedTasks').doc(taskId).set({
      taskId,
      fee,
      unlockedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'OPENED',
    });

    res.json({ success: true, fee, newBalance: user.balance - fee });
  } catch (err) {
    console.error('[unlock]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   TASK SUBMIT
============================================================ */
app.post('/api/task/submit', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { taskId, submission } = req.body;

    const task = TASKS.find(t => t.id === taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const userRef = db.collection('users').doc(uid);
    const unlockedSnap = await userRef.collection('unlockedTasks').doc(taskId).get();
    if (!unlockedSnap.exists) {
      return res.status(400).json({ error: 'Task not unlocked' });
    }

    const unlocked = unlockedSnap.data();
    if (unlocked.status === 'CLOSED') {
      return res.status(400).json({ error: 'Task already submitted' });
    }

    await userRef.update({
      balance: admin.firestore.FieldValue.increment(task.reward),
      lifetimeEarnings: admin.firestore.FieldValue.increment(task.reward),
    });

    await userRef.collection('transactions').add({
      type: `${task.categoryId}: ${task.title}`,
      amount: task.reward,
      direction: 'CREDIT',
      status: 'COMPLETED',
      date: admin.firestore.FieldValue.serverTimestamp(),
    });

    await userRef.collection('unlockedTasks').doc(taskId).update({
      status: 'CLOSED',
      submission: submission || null,
      submittedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, reward: task.reward });
  } catch (err) {
    console.error('[submit]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   WITHDRAW
============================================================ */
app.post('/api/withdraw', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const amount = Number(req.body.amount);
    const networkFee = Number(process.env.WITHDRAWAL_NETWORK_FEE_KES || 20);
    const minWithdrawal = Number(process.env.MIN_WITHDRAWAL_KES || 100);

    if (isNaN(amount) || amount < minWithdrawal) {
      return res.status(400).json({ error: `Minimum withdrawal KES ${minWithdrawal}` });
    }

    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    const user = userSnap.data();

    if (!user.phone) {
      return res.status(400).json({ error: 'Add a phone number first' });
    }

    const total = amount + networkFee;
    if (total > user.balance) {
      return res.status(400).json({ error: 'Insufficient balance', balance: user.balance });
    }

    await userRef.update({
      balance: admin.firestore.FieldValue.increment(-total),
    });

    await userRef.collection('transactions').add({
      type: 'Withdrawal to M-Pesa',
      amount,
      direction: 'DEBIT',
      status: 'COMPLETED',
      date: admin.firestore.FieldValue.serverTimestamp(),
    });
    await userRef.collection('transactions').add({
      type: 'Network Fee',
      amount: networkFee,
      direction: 'DEBIT',
      status: 'COMPLETED',
      date: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, amount, networkFee });
  } catch (err) {
    console.error('[withdraw]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   PAYHERO CALLBACK (WEBHOOK)
============================================================ */
app.post('/api/payhero/callback', async (req, res) => {
  const startedAt = Date.now();

  try {
    console.log('[PayHero Callback] Raw body:', JSON.stringify(req.body));

    const payload = req.body || {};
    
    // PayHero SPS sends data inside a "response" object
    const inner = payload.response || payload;
    
    // Extract reference — PayHero sends User_Reference
    const reference = 
      inner.User_Reference ||
      inner.user_reference ||
      payload.external_reference ||
      payload.reference;
    
    // Extract status — look inside response first
    const statusRaw = (
      inner.Status || 
      inner.status || 
      payload.status || 
      payload.ResultCode || 
      ''
    ).toString().toUpperCase();
    
    // Extract M-Pesa receipt code
    const mpesaCode = 
      inner.MPESA_Reference || 
      inner.mpesa_code || 
      payload.MpesaReceiptNumber || 
      null;

    if (!reference) {
      console.error('[PayHero Callback] Missing reference. Payload:', JSON.stringify(payload));
      return res.status(400).json({ error: 'Missing reference' });
    }

    console.log('[PayHero Callback] Parsed:', { reference, statusRaw, mpesaCode });

    const payRef = db.collection('payments').doc(reference);
    const paySnap = await payRef.get();

    if (!paySnap.exists) {
      console.error('[PayHero Callback] Unknown reference:', reference);
      return res.status(200).json({ received: true, warning: 'unknown_reference' });
    }

    const payment = paySnap.data();

    // Idempotency — don't process duplicates
    if (payment.status === 'SUCCESS' || payment.status === 'FAILED') {
      console.log('[PayHero Callback] Duplicate — already:', payment.status);
      return res.status(200).json({ received: true, duplicate: true });
    }

    // Determine final status
    const successCodes = ['SUCCESS', 'SUCCESSFUL', 'COMPLETED', '0', '200'];
    const failureCodes = ['FAILED', 'FAILURE', 'CANCELLED', 'TIMEOUT', '1037', '1032'];
    const isSuccess = successCodes.includes(statusRaw);
    const isFailure = failureCodes.includes(statusRaw);

    const finalStatus = isSuccess ? 'SUCCESS' : (isFailure ? 'FAILED' : 'PENDING');
    
    const updateData = {
      status: finalStatus,
      mpesaCode,
      callbackPayload: payload,
      callbackReceivedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (finalStatus !== 'PENDING') {
      updateData.completedAt = admin.firestore.FieldValue.serverTimestamp();
    }

    await payRef.update(updateData);

    // On successful activation, flip user to ACTIVE
    if (finalStatus === 'SUCCESS' && payment.type === 'ACTIVATION') {
      const userRef = db.collection('users').doc(payment.uid);
      await userRef.update({ status: 'ACTIVE' });
      await userRef.collection('transactions').add({
        type: 'Account Activation Fee',
        amount: payment.amount,
        direction: 'DEBIT',
        status: 'COMPLETED',
        date: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`[PayHero Callback] ✓ Activated user ${payment.uid} (ref: ${reference})`);
    }

    if (finalStatus === 'FAILED') {
      console.log(`[PayHero Callback] ✗ Payment failed: ${reference} (status: ${statusRaw})`);
    }

    res.status(200).json({
      received: true,
      reference,
      status: finalStatus,
      processingMs: Date.now() - startedAt,
    });
  } catch (err) {
    console.error('[PayHero Callback] Error:', err);
    res.status(500).json({ error: 'Callback processing failed' });
  }
});

/* ============================================================
   START
============================================================ */
app.listen(PORT, () => {
  console.log('');
  console.log('  ███████╗ █████╗ ██████╗ ███╗   ██╗██╗    ██╗ █████╗ ██╗   ██╗███████╗');
  console.log('  ██╔════╝██╔══██╗██╔══██╗████╗  ██║██║    ██║██╔══██╗██║   ██║██╔════╝');
  console.log('  █████╗  ███████║██████╔╝██╔██╗ ██║██║ █╗ ██║███████║██║   ██║█████╗  ');
  console.log('  ██╔══╝  ██╔══██║██╔══██╗██║╚██╗██║██║███╗██║██╔══██║╚██╗ ██╔╝██╔══╝  ');
  console.log('  ███████╗██║  ██║██║  ██║██║ ╚████║╚███╔███╔╝██║  ██║ ╚████╔╝ ███████╗');
  console.log('  ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝ ╚══╝╚══╝ ╚═╝  ╚═╝  ╚═══╝  ╚══════╝');
  console.log('');
  console.log(`  Server running on port ${PORT}`);
  console.log(`  Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`  Callback URL: ${process.env.PUBLIC_BASE_URL || 'http://localhost:' + PORT}/api/payhero/callback`);
  console.log('');
});

module.exports = app;
