// server.js  ← Save with this name
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const rateLimit = require('express-rate-limit'); // NEW: Add this package for rate limiting

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));