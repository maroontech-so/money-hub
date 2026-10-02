/**
 * EarnWave Backend Server
 * -----------------------
 * - Firebase Admin SDK for user verification & Firestore
 * - PayHero STK Push for M-Pesa payments
 * - Express REST API
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
   FIREBASE ADMIN INIT
============================================================ */
let db;
try {
  let serviceAccount;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    const p = path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
    if (fs.existsSync(p)) {
      serviceAccount = JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  }

  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    db = admin.firestore();
    console.log('[Firebase] Admin SDK initialized.');
  } else {
    console.warn('[Firebase] No service account found. Running in MOCK mode.');
    db = createMockFirestore();
  }
} catch (err) {
  console.error('[Firebase] Init failed:', err.message);
  console.warn('[Firebase] Falling back to MOCK Firestore.');
  db = createMockFirestore();
}

/* ============================================================
   MOCK FIRESTORE (dev fallback when no credentials)
============================================================ */
function createMockFirestore() {
  const store = new Map();
  return {
    collection: (name) => ({
      doc: (id) => ({
        async get() {
          const key = `${name}/${id}`;
          const data = store.get(key);
          return { exists: !!data, data: () => data, id };
        },
        async set(data, opts = {}) {
          const key = `${name}/${id}`;
          const existing = store.get(key) || {};
          store.set(key, opts.merge ? { ...existing, ...data } : data);
          return true;
        },
        async update(data) {
          const key = `${name}/${id}`;
          const existing = store.get(key) || {};
          store.set(key, { ...existing, ...data });
          return true;
        },
        async delete() {
          store.delete(`${name}/${id}`);
          return true;
        },
      }),
      where: (field, op, value) => ({
        limit: () => ({
          async get() {
            const results = [];
            for (const [key, val] of store.entries()) {
              if (key.startsWith(name + '/') && val[field] === value) {
                results.push({ id: key.split('/')[1], data: () => val });
              }
            }
            return { empty: results.length === 0, docs: results, forEach: (cb) => results.forEach(cb) };
          },
        }),
      }),
    }),
  };
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
   LOAD TASKS
============================================================ */
const TASKS_DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'tasks.json'), 'utf8'));
const CATEGORIES = TASKS_DATA.categories;
const TASKS = TASKS_DATA.tasks;

function unlockFeeFor(task) {
  const cat = CATEGORIES.find(c => c.id === task.categoryId);
  return cat ? cat.unlockFee : Number(process.env.UNLOCK_FEE_DEFAULT_KES || 15);
}

/* ============================================================
   AUTH MIDDLEWARE — verify Firebase ID token
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
   PAYHERO CLIENT
============================================================ */
const payhero = axios.create({
  baseURL: process.env.PAYHERO_API_BASE || 'https://backend.payhero.co.ke/api/v2',
  headers: {
    'Authorization': process.env.PAYHERO_AUTH_TOKEN,
    'Content-Type': 'application/json',
  },
  timeout: 20000,
});

/* ============================================================
   ROUTES — PUBLIC
============================================================ */

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'EarnWave', time: new Date().toISOString() });
});

// Serve tasks list
app.get('/api/tasks', (req, res) => {
  res.json({
    categories: CATEGORIES,
    tasks: TASKS,
  });
});

/* ============================================================
   ROUTES — AUTHENTICATED
============================================================ */

/**
 * POST /api/user/bootstrap
 * Create or fetch the user's Firestore doc on first login.
 */
app.post('/api/user/bootstrap', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { phone, username } = req.body || {};

    const userRef = db.collection('users').doc(uid);
    const snap = await userRef.get();

    if (!snap.exists) {
      const newUser = {
        uid,
        email: req.user.email || null,
        username: username || (req.user.email ? req.user.email.split('@')[0] : 'user'),
        phone: phone || null,
        referralCode: 'EARNWAVE-' + Math.random().toString(36).substring(2, 7).toUpperCase(),
        status: 'PENDING',           // PENDING → ACTIVE after KES 100 activation
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

    return res.json({ created: false, user: snap.data() });
  } catch (err) {
    console.error('[bootstrap]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/user/me
 * Fetch current user doc + wallet.
 */
app.get('/api/user/me', requireAuth, async (req, res) => {
  try {
    const snap = await db.collection('users').doc(req.user.uid).get();
    if (!snap.exists) return res.status(404).json({ error: 'User not found' });
    res.json({ user: snap.data() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/user/transactions
 */
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
    // Fallback if orderBy fails on mock
    res.json({ transactions: [] });
  }
});

/**
 * POST /api/payment/activation
 * Initiate KES 100 STK push for account activation.
 */
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

    const amount = Number(process.env.ACCOUNT_ACTIVATION_FEE_KES || 100);
    const reference = `ACT-${uid.slice(0, 8)}-${Date.now()}`;

    // Call PayHero STK Push
    const response = await payhero.post('/payments/initiate-stk-push', {
      amount,
      phone_number: normalizePhone(phone),
      channel_id: process.env.PAYHERO_CHANNEL_ID,
      provider: 'm-pesa',
      external_reference: reference,
    });

    // Record pending payment
    await db.collection('payments').doc(reference).set({
      uid,
      type: 'ACTIVATION',
      amount,
      phone,
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
    console.error('[activation payment]', err.response?.data || err.message);
    res.status(500).json({
      error: 'Payment initiation failed',
      details: err.response?.data || err.message,
    });
  }
});

/**
 * POST /api/payment/unlock
 * Unlock a task for the given fee.
 */
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

    // Deduct fee
    await userRef.update({
      balance: admin.firestore.FieldValue.increment(-fee),
    });

    // Record unlock
    await userRef.collection('transactions').add({
      type: `Unlock: ${task.title}`,
      amount: fee,
      direction: 'DEBIT',
      status: 'COMPLETED',
      date: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Record unlocked task
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

/**
 * POST /api/task/submit
 * Submit completed task and credit reward.
 */
app.post('/api/task/submit', requireAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { taskId, submission } = req.body;

    const task = TASKS.find(t => t.id === taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const userRef = db.collection('users').doc(uid);

    // Credit reward
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

    // Mark task closed
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

/**
 * POST /api/withdraw
 * Request M-Pesa withdrawal.
 */
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

    // TODO: Call PayHero Wallet Withdraw endpoint here
    // await payhero.post('/payments/wallet-withdraw', { amount, phone_number: user.phone, ... });

    res.json({ success: true, amount, networkFee });
  } catch (err) {
    console.error('[withdraw]', err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   PAYHERO CALLBACK — public endpoint
============================================================ */
app.post('/api/payhero/callback', async (req, res) => {
  try {
    console.log('[PayHero Callback]', JSON.stringify(req.body, null, 2));

    const payload = req.body;
    const reference = payload.external_reference || payload.reference;
    const status = (payload.status || payload.ResultCode || '').toString().toUpperCase();
    const mpesaCode = payload.mpesa_code || payload.MpesaReceiptNumber || null;

    if (!reference) {
      return res.status(400).json({ error: 'Missing reference' });
    }

    const paySnap = await db.collection('payments').doc(reference).get();
    if (!paySnap.exists) {
      console.warn('[Callback] Unknown reference:', reference);
      return res.json({ received: true });
    }

    const payment = paySnap.data();
    const success = ['SUCCESS', 'SUCCESSFUL', 'COMPLETED', '0'].includes(status);

    await db.collection('payments').doc(reference).update({
      status: success ? 'SUCCESS' : 'FAILED',
      mpesaCode,
      callbackPayload: payload,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (success && payment.type === 'ACTIVATION') {
      const userRef = db.collection('users').doc(payment.uid);
      await userRef.update({ status: 'ACTIVE' });
      await userRef.collection('transactions').add({
        type: 'Account Activation Fee',
        amount: payment.amount,
        direction: 'DEBIT',
        status: 'COMPLETED',
        date: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`[Callback] Activated user ${payment.uid}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[Callback] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

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
  console.log(`  Server running on http://localhost:${PORT}`);
  console.log(`  Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('');
  console.log('  Setup checklist:');
  console.log('   [ ] Firebase serviceAccountKey.json in project root');
  console.log('   [ ] PayHero credentials in .env');
  console.log('   [ ] PayHero callback URL set to ' + (process.env.PUBLIC_BASE_URL || 'your-domain') + '/api/payhero/callback');
  console.log('');
});

module.exports = app;
