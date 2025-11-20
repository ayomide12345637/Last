// server.js  ← Save with this name
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// NO MORE HARDCODED KEY! Use env var (set on Render dashboard)
const SECRET_KEY = process.env.SECRET_KEY;  // ← This pulls your live key securely
const BASE_URL = 'https://api-d.squadco.com';  // Live URL

// Quick check if key is missing (for safety)
if (!SECRET_KEY) {
  console.error('Error: SECRET_KEY env var is missing!');
  process.exit(1);  // Stops server if not set
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

    if (lookupJson.account_name?.toLowerCase() !== beneficiaryName.toLowerCase()) {
      return res.status(400).json({ success: false, message: 'Name does not match bank' });
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
      res.status(400).json({ success: false, message: result.message || 'Transfer failed' });
    }
  } catch (e) {
    console.log(e);
    res.status(500).json({ success: false, message: 'Server error, try again' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));