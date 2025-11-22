// server.js  ← Save with this name
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const rateLimit = require('express-rate-limit'); // NEW: Add this package for rate limiting
const crypto = require('crypto'); // Built-in for webhook signature verification
const admin = require('firebase-admin'); // NEW: For server-side Firebase updates

const app = express();
app.use(cors());
app.use(express.json());

// NEW: Global rate limiter (limits per IP to prevent spam/abuse)
// Adjust limits as needed: e.g., 50 requests per 15 min window
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 50, // Max 50 requests per IP per window
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests—try again later' }
});
app.use(globalLimiter);

// NEW: Stricter limiter just for /withdraw (e.g., 5 per hour per IP)
const withdrawLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 5, // Max 5 withdrawals per IP per hour
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Withdrawal limit reached—try again tomorrow' }
});

// NEW: Concurrent request limiter for /withdraw (to protect low CPU)
// Caps at 2 simultaneous withdrawals; adjust if needed
let processingWithdraws = 0;
const MAX_CONCURRENT_WITHDRAWS = 2;
const concurrentLimiter = (req, res, next) => {
  if (processingWithdraws >= MAX_CONCURRENT_WITHDRAWS) {
    return res.status(503).json({ success: false, message: 'Server busy—try again tomorrow' });
  }
  processingWithdraws++;
  res.on('finish', () => processingWithdraws--);
  next();
};

// Use env var for secret (set on Render dashboard)
const SECRET_KEY = process.env.SECRET_KEY;
const BASE_URL = 'https://api-d.squadco.com';  // Live URL

if (!SECRET_KEY) {
  console.error('Error: SECRET_KEY env var is missing!');
  process.exit(1);
}

// Simple fuzzy name match function (allows variations)
function fuzzyNameMatch(name1, name2) {
  const normalize = (str) => str.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  name1 = normalize(name1);
  name2 = normalize(name2);
  const words1 = name1.split(' ').sort();
  const words2 = name2.split(' ').sort();
  const shorter = words1.length < words2.length ? words1 : words2;
  const longer = words1.length >= words2.length ? words1 : words2;
  let matches = 0;
  shorter.forEach(word => {
    if (longer.includes(word)) matches++;
  });
  return matches / shorter.length >= 0.66;
}

// NEW: Lookup endpoint (just for auto-fill name)
// Added rate limiting here too, but lighter since it's cheaper
app.post('/lookup', globalLimiter, async (req, res) => {
  const { accountNumber, bankCode } = req.body;

  if (!accountNumber || !bankCode) {
    return res.status(400).json({ success: false, message: 'Need account number and bank' });
  }

  try {
    const lookup = await fetch(`${BASE_URL}/payout/account/lookup`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        account_number: accountNumber,
        bank_code: bankCode
      })
    });
    const lookupJson = await lookup.json();

    if (lookupJson.account_name) {
      res.json({ success: true, accountName: lookupJson.account_name });
    } else {
      res.status(400).json({ success: false, message: lookupJson.message || 'Invalid account details' });
    }
  } catch (e) {
    console.error(e); // Changed to console.error for better logging
    res.status(500).json({ success: false, message: 'Server error during lookup' });
  }
});

app.post('/withdraw', [withdrawLimiter, concurrentLimiter], async (req, res) => {
  const { amount, accountNumber, bankCode, beneficiaryName } = req.body;

  if (!amount || !accountNumber || !bankCode || !beneficiaryName) {
    return res.status(400).json({ success: false, message: 'Fill all fields' });
  }

  try {
    const lookup = await fetch(`${BASE_URL}/payout/account/lookup`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        account_number: accountNumber,
        bank_code: bankCode
      })
    });
    const lookupJson = await lookup.json();

    if (!fuzzyNameMatch(lookupJson.account_name || '', beneficiaryName)) {
      return res.status(400).json({ success: false, message: 'Name mismatch—check spelling or try a variation' });
    }

    const transfer = await fetch(`${BASE_URL}/payout/transfer`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        amount: Math.round(amount * 100),  // NGN to kobo
        account_number: accountNumber,
        bank_code: bankCode,
        beneficiary_name: beneficiaryName,
        currency: 'NGN',
        narration: 'Earnings Withdrawal',
        reference: 'wd_' + Date.now()
      })
    });

    const result = await transfer.json();

    if (result.status === 'SUCCESS' || result.status === 200) {
      res.json({ success: true, message: 'Withdrawal successful!', ref: result.reference });
    } else {
      res.status(400).json({ success: false, message: result.message || 'Transfer failed' });
    }
  } catch (e) {
    console.error(e); // Changed to console.error
    res.status(500).json({ success: false, message: 'Server error, try again' });
  }
});

// NEW: Squad Webhook Endpoint for Payment Verification
// This handles Squad notifications (e.g., successful payments) and updates Firebase server-side
app.post('/squad-webhook', async (req, res) => {
  const event = req.body;  // Squad's JSON payload
  const signature = req.headers['x-squad-signature'];  // Adjust if Squad uses a different header (check docs)

  // Verify signature to ensure it's from Squad
  const squadSecret = process.env.SQUAD_WEBHOOK_SECRET;  // Set this in Render env vars
  if (!squadSecret) {
    console.error('SQUAD_WEBHOOK_SECRET not set');
    return res.status(500).send('Server config error');
  }
  const hmac = crypto.createHmac('sha512', squadSecret);
  const expectedHash = hmac.update(JSON.stringify(event)).digest('hex');
  if (expectedHash !== signature) {
    return res.status(400).send('Invalid signature');
  }

  // Handle successful payment event
  if (event.event_type === 'transaction.successful') {
    const { transaction_ref, amount, email } = event.data;

    try {
      // Initialize Firebase Admin (only once)
      if (!admin.apps.length) {
        const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT);  // Set this in Render env vars (full JSON string)
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
          databaseURL: 'https://fastmoney-bc060.firebaseio.com'  // Your project URL
        });
      }
      const db = admin.firestore();

      // Find user by email
      const userSnap = await db.collection('users').where('email', '==', email).limit(1).get();
      if (userSnap.empty) {
        console.log(`No user found for email: ${email}`);
        return res.status(200).send('Webhook received but no user found');
      }

      const uid = userSnap.docs[0].id;
      const userData = userSnap.docs[0].data();

      // Update paid status and add payment record
      await db.collection('users').doc(uid).update({ paid: true });
      await db.collection('payments').add({
        userUid: uid,
        amount: amount / 100,  // Convert kobo to NGN
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        adminShare: (amount / 100) / 2
      });

      // Credit referrer if exists
      if (userData.referrerUid) {
        const refDoc = db.collection('users').doc(userData.referrerUid);
        const refData = (await refDoc.get()).data();
        const earn = (amount / 100) / 2;
        await refDoc.update({
          balance: refData.balance + earn,
          referrals: admin.firestore.FieldValue.arrayUnion({ refUid: uid, name: userData.name, earn })
        });
      }

      console.log(`Processed webhook for ref: ${transaction_ref}`);
    } catch (err) {
      console.error('Webhook error:', err);
      return res.status(500).send('Server error processing webhook');
    }
  }

  // Acknowledge webhook (important to prevent Squad retries)
  res.status(200).send('Webhook received');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));