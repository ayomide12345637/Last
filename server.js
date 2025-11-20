// server.js  ← Save with this name
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Use env var for secret (set on Render dashboard)
const SECRET_KEY = process.env.SECRET_KEY;
const BASE_URL = 'https://api-d.squadco.com';  // Live URL

if (!SECRET_KEY) {
  console.error('Error: SECRET_KEY env var is missing!');
  process.exit(1);
}

// Simple fuzzy name match function (allows variations like you want)
function fuzzyNameMatch(name1, name2) {
  // Normalize: lower case, remove extra spaces/punctuation
  const normalize = (str) => str.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  name1 = normalize(name1);
  name2 = normalize(name2);

  // Split into words
  const words1 = name1.split(' ').sort();
  const words2 = name2.split(' ').sort();

  // Check if at least 2/3 of words from shorter name are in longer one
  const shorter = words1.length < words2.length ? words1 : words2;
  const longer = words1.length >= words2.length ? words1 : words2;

  let matches = 0;
  shorter.forEach(word => {
    if (longer.includes(word)) matches++;
  });

  // Allow if 66%+ match (e.g., "ade abuka joy" matches "ade joy" or "ADE ABUKA JOY")
  return matches / shorter.length >= 0.66;
}

app.post('/withdraw', async (req, res) => {
  const { amount, accountNumber, bankCode, beneficiaryName } = req.body;

  if (!amount || !accountNumber || !bankCode || !beneficiaryName) {
    return res.status(400).json({ success: false, message: 'Fill all fields' });
  }

  try {
    // 1. Account lookup to verify
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

    // Fuzzy check (flexible for variations)
    if (!fuzzyNameMatch(lookupJson.account_name || '', beneficiaryName)) {
      return res.status(400).json({ success: false, message: 'Name mismatch—check spelling or try a variation' });
    }

    // 2. Do the transfer
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
      // Passes SquadCo's exact message (e.g., "Insufficient balance")
      res.status(400).json({ success: false, message: result.message || 'Transfer failed' });
    }
  } catch (e) {
    console.log(e);
    res.status(500).json({ success: false, message: 'Server error, try again' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));