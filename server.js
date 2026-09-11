// Western Gospel Music Awards 2026 — ticket sales
// Card payments via HandyPay. Lynk via reserve-then-confirm.
// Run: npm install && npm start

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sgMail = require('@sendgrid/mail');
const QRCode = require('qrcode');
const { buildTicket } = require('./ticket');

// Initialize SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const app = express();
app.set('trust proxy', 1);           // Render sits behind a proxy
app.disable('x-powered-by');

const PUBLIC_DIR = path.join(__dirname, 'public');

/* ==================================================================
   1. TICKET TIERS — change a price here and change the matching
      TIERS block in public/index.html. Those two must agree.

      The price is also printed on the artwork in public/img, so if you
      move a price you want that artwork redrawn as well.
   ================================================================== */
const TIERS = {
  ga:  { id: 'ga',  name: 'General Admission', price: { JMD: 3000, USD: 20 }, art: 'ticket-ga.jpg'  },
  vip: { id: 'vip', name: 'VIP Admission',     price: { JMD: 6000, USD: 40 }, art: 'ticket-vip.jpg' }
};
// Orders taken before tiers existed are General Admission.
const tierOf = order => TIERS[order.tier] || TIERS.ga;

const EVENT = {
  name: 'Western Gospel Music Awards 2026',
  date: 'Sunday, November 22, 2026',
  time: '1:00 PM',
  venue: 'West Jamaica Conference Centre, Mt Salem, Montego Bay'
};

/* ==================================================================
   2. ORDER STORE
      Plain JSON file. Every Lynk order is also emailed to you the
      moment it is placed, so your inbox is the real backup if the
      host ever wipes this file.
   ================================================================== */
const DB = process.env.DATA_FILE || path.join(__dirname, 'orders.json');
fs.mkdirSync(path.dirname(DB), { recursive: true });

const load = () => { try { return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { return {}; } };

// Write to a temp file first, then rename. A crash mid-write can no
// longer leave you with a half-written orders.json.
const save = o => {
  const tmp = DB + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(o, null, 2));
  fs.renameSync(tmp, DB);
};

/* ==================================================================
   3. EMAIL — uses SendGrid API for reliable delivery
   ================================================================== */

// Anything a buyer types goes through this before it lands in an email.
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* ==================================================================
   4. HANDYPAY
      HandyPay's API lives at https://api.handypay.me and authenticates
      with your API key. Confirm the exact endpoint path and field
      names against the docs HandyPay gives you when your merchant
      account is approved, then adjust the two marked lines below.
      Nothing else in this file needs to change.
   ================================================================== */
const HANDYPAY_BASE = process.env.HANDYPAY_BASE || 'https://api.handypay.me';

async function handypayCheckout({ tier, quantity, currency, name, email, reference }) {
  const total = TIERS[tier].price[currency] * quantity;

  const res = await fetch(`${HANDYPAY_BASE}/v1/checkout/sessions`, {   // <-- confirm path
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.HANDYPAY_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({                                             // <-- confirm fields
      amount: Math.round(total * 100),
      currency,
      description: `${EVENT.name} - ${TIERS[tier].name} x${quantity}`,
      customer_email: email,
      customer_name: name,
      reference,
      success_url: `${process.env.DOMAIN}/success.html?ref=${reference}`,
      cancel_url: `${process.env.DOMAIN}/#tickets`
    })
  });

  if (!res.ok) throw new Error(`HandyPay ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const url = data.url || data.checkout_url || data.payment_url;
  if (!url) throw new Error('HandyPay returned no checkout URL');
  return url;
}

/* ==================================================================
   5. HANDYPAY WEBHOOK
      Tickets send from here, not the success page, so a buyer who
      closes the tab still gets their ticket.

      This route is mounted BEFORE express.json() on purpose. Signature
      checking needs the exact bytes HandyPay sent — once a JSON parser
      has touched the body those bytes are gone and every signature
      fails. Do not move it down the file.
   ================================================================== */
app.post('/webhook/handypay', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';

  if (process.env.HANDYPAY_WEBHOOK_SECRET) {
    const expected = crypto.createHmac('sha256', process.env.HANDYPAY_WEBHOOK_SECRET)
      .update(raw).digest('hex');
    const got = (req.headers['x-handypay-signature'] || '').replace(/^sha256=/, '');
    const ok = got.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
    if (!ok) { console.warn('Webhook rejected: bad signature'); return res.status(400).send('bad signature'); }
  }

  let event;
  try { event = JSON.parse(raw); } catch { return res.status(400).send('bad json'); }

  const type = event.type || event.event || '';
  const ref = (event.data && event.data.reference) || event.reference;

  if (/succeed|complete|paid/i.test(type) && ref) {
    const orders = load();
    const order = orders[ref];
    if (order && order.status !== 'paid') {
      order.status = 'paid';
      order.paidAt = new Date().toISOString();
      save(orders);
      try { await mailTicket(order); console.log('Ticket sent:', ref); }
      catch (e) { console.error('Ticket email failed:', ref, e.message); }
    }
  }

  res.json({ received: true });
});

// Everything from here down speaks JSON.
app.use(express.json({ limit: '64kb' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

/* ==================================================================
   6. CHECKOUT
   ================================================================== */
app.post('/api/checkout', async (req, res) => {
  try {
    const { method, tier, quantity, currency, name, email, phone } = req.body || {};

    const qty = Number(quantity);
    if (!TIERS[tier]) return res.status(400).json({ error: 'Pick a ticket type' });
    if (!['card', 'lynk'].includes(method)) return res.status(400).json({ error: 'Unknown payment method' });
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) return res.status(400).json({ error: 'Check the quantity' });
    if (!['JMD', 'USD'].includes(currency)) return res.status(400).json({ error: 'Unknown currency' });
    if (!name || String(name).trim().length < 2) return res.status(400).json({ error: 'Name is required' });
    if (!/^\S+@\S+\.\S+$/.test(email || '')) return res.status(400).json({ error: 'A valid email is required' });
    if (method === 'lynk' && currency !== 'JMD') return res.status(400).json({ error: 'Lynk settles in JMD' });
    if (method === 'lynk' && !phone) return res.status(400).json({ error: 'Lynk number required' });

    const reference = 'WGMA-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const order = {
      reference, method, tier, tierName: TIERS[tier].name, quantity: qty, currency,
      name: String(name).trim().slice(0, 120),
      email: String(email).trim().slice(0, 160),
      phone: phone ? String(phone).trim().slice(0, 40) : null,
      total: TIERS[tier].price[currency] * qty,
      status: 'pending',
      createdAt: new Date().toISOString()
    };

    const orders = load();
    orders[reference] = order;
    save(orders);

    if (method === 'card') {
      try {
        const url = await handypayCheckout({ tier, quantity: qty, currency, name: order.name, email: order.email, reference });
        return res.json({ url });
      } catch (e) {
        // HandyPay never opened a checkout, so there is no order to speak of.
        // Drop it rather than leave a ghost sitting on your admin page.
        const current = load();
        delete current[reference];
        save(current);
        throw e;
      }
    }

    // Lynk: hold the seat, then send the emails. The buyer is not kept
    // waiting on the mail server — the next page shows the same details.
    res.json({ reference });
    mailLynkInstructions(order).catch(e => console.error('Lynk email failed:', reference, e.message));
    mailOrganiser(order).catch(e => console.error('Organiser email failed:', reference, e.message));

  } catch (err) {
    console.error('Checkout failed:', err.message);
    res.status(500).json({ error: 'Checkout unavailable' });
  }
});

/* ==================================================================
   7. ADMIN — mark Lynk payments received, check tickets at the door
      Open /admin.html and enter your ADMIN_KEY.
   ================================================================== */
// Twenty wrong keys from one address and that address sits out two minutes.
// Generous on purpose: at the door, several phones share one WiFi address.
const attempts = new Map();
function guard(req, res, next) {
  const who = req.ip || 'unknown';
  const now = Date.now();
  const rec = attempts.get(who) || { n: 0, until: 0 };

  if (rec.until > now) return res.status(429).json({ error: 'Too many tries. Wait two minutes.' });

  const given = Buffer.from(req.get('x-admin-key') || '');
  const want = Buffer.from(process.env.ADMIN_KEY || '');
  const ok = want.length > 0 && given.length === want.length && crypto.timingSafeEqual(given, want);

  if (!ok) {
    rec.n += 1;
    if (rec.n >= 20) { rec.until = now + 2 * 60_000; rec.n = 0; }
    attempts.set(who, rec);
    return res.status(401).json({ error: 'Wrong key' });
  }

  attempts.delete(who);
  next();
}

app.get('/api/admin/orders', guard, (req, res) => {
  const orders = Object.values(load()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const paid = orders.filter(o => o.status === 'paid');
  const sold = id => paid.filter(o => tierOf(o).id === id).reduce((n, o) => n + o.quantity, 0);
  res.json({
    orders,
    summary: {
      pending: orders.filter(o => o.status === 'pending').length,
      paidOrders: paid.length,
      ticketsSold: paid.reduce((n, o) => n + o.quantity, 0),
      gaSold: sold('ga'),
      vipSold: sold('vip'),
      takingsJMD: paid.filter(o => o.currency === 'JMD').reduce((n, o) => n + o.total, 0),
      takingsUSD: paid.filter(o => o.currency === 'USD').reduce((n, o) => n + o.total, 0)
    }
  });
});

app.post('/api/admin/confirm', guard, async (req, res) => {
  const orders = load();
  const order = orders[String(req.body.reference || '').toUpperCase()];
  if (!order) return res.status(404).json({ error: 'No order with that reference' });
  if (order.status === 'paid') return res.json({ ok: true, already: true });

  order.status = 'paid';
  order.paidAt = new Date().toISOString();
  save(orders);

  try { await mailTicket(order); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'Marked paid but the ticket email failed: ' + e.message }); }
});

app.post('/api/admin/cancel', guard, (req, res) => {
  const orders = load();
  const order = orders[String(req.body.reference || '').toUpperCase()];
  if (!order) return res.status(404).json({ error: 'No order with that reference' });
  order.status = 'cancelled';
  order.cancelledAt = new Date().toISOString();
  save(orders);
  res.json({ ok: true });
});

app.get('/api/admin/check/:ref', guard, (req, res) => {
  const order = load()[req.params.ref.toUpperCase()];
  if (!order) return res.json({ valid: false });
  res.json({
    valid: order.status === 'paid',
    name: order.name,
    tier: tierOf(order).id,
    tierName: tierOf(order).name,
    quantity: order.quantity,
    status: order.status,
    usedAt: order.usedAt || null
  });
});

app.post('/api/admin/admit/:ref', guard, (req, res) => {
  const orders = load();
  const order = orders[req.params.ref.toUpperCase()];
  if (!order || order.status !== 'paid') return res.status(400).json({ error: 'Not a paid ticket' });
  if (order.usedAt) return res.json({ ok: true, already: true, usedAt: order.usedAt });
  order.usedAt = new Date().toISOString();
  save(orders);
  res.json({ ok: true });
});

/* ==================================================================
   8. EMAILS
   ================================================================== */
const money = (n, cur) => (cur === 'JMD' ? '$' : 'US$') + n.toLocaleString('en-US');

const shell = inner => `
<div style="background:#150720;padding:28px 16px;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#2c1040;border:1px solid #d4a534;padding:32px 26px;color:#f7f3ea">
    <p style="letter-spacing:.28em;font-size:11px;color:#f6e9c4;margin:0 0 10px">THE INAUGURAL</p>
    <h1 style="font-size:22px;color:#f0d67f;margin:0 0 4px;font-weight:normal">Western Gospel Music Awards</h1>
    <p style="letter-spacing:.4em;color:#d4a534;margin:0 0 24px">2026</p>
    ${inner}
    <p style="font-size:13px;color:#c9b6d8;margin:24px 0 0">
      Questions? Reply to this email or WhatsApp 876 816 2565.
    </p>
    <p style="font-size:11px;color:#c9b6d8;margin:16px 0 0">
      Not seeing this email? Check your spam or promotions folder and mark it as not spam.
    </p>
  </div>
</div>`;

const row = (k, v, gold) =>
  `<tr><td style="padding:10px 0;color:#c9b6d8">${k}</td>
   <td style="text-align:right${gold ? ';color:#f0d67f' : ''}">${v}</td></tr>`;

const plainTicket = (o, tier) => [
  `Give thanks, ${o.name}. Your WGMA 2026 ticket is confirmed.`,
  ``,
  `Ticket:    ${tier.name}`,
  `Admits:    ${o.quantity}`,
  `Paid:      ${money(o.total, o.currency)} ${o.currency}`,
  `Reference: ${o.reference}`,
  ``,
  `${EVENT.date} at ${EVENT.time}`,
  `${EVENT.venue}`,
  ``,
  `Your ticket is attached to this email. Show the QR code at the door.`,
  `Questions? Reply here or WhatsApp 876 816 2565.`
].join('\n');

async function mailTicket(order) {
  const tier = tierOf(order);
  const attachments = [];

  // The printed ticket: your artwork with their QR code on the stub.
  // If it cannot be drawn for any reason, the plain QR below still gets
  // them through the door, so never let this stop the email.
  let hero = '';
  try {
    const png = await buildTicket(order, tier, EVENT);
    attachments.push({ filename: `wgma-ticket-${order.reference}.jpg`, content: png.toString('base64'), type: 'image/jpeg' });
    hero = `<div style="margin:0 0 24px">
      <img src="data:image/jpeg;base64,${png.toString('base64')}" width="468" alt="${esc(tier.name)} ticket ${esc(order.reference)}"
           style="width:100%;max-width:468px;display:block;border:1px solid #d4a534">
      <p style="font-size:12px;color:#c9b6d8;margin:8px 0 0">Save this image. It is your ticket.</p>
    </div>`;
  } catch (e) {
    console.error('Ticket artwork failed, sending QR only:', order.reference, e.message);
  }

  const qr = await QRCode.toBuffer(order.reference, { width: 320, margin: 1 });
  attachments.push({ filename: `wgma-qr-${order.reference}.png`, content: qr.toString('base64'), type: 'image/png' });

  const html = shell(`
    <p style="margin:0 0 20px">Give thanks, ${esc(order.name)}. Your ticket is confirmed.</p>
    ${hero}
    <table style="width:100%;border-top:1px solid rgba(212,165,52,.4);font-size:14px">
      ${row('Ticket', esc(tier.name), true)}
      ${row('Admits', order.quantity)}
      ${row('Paid', money(order.total, order.currency) + ' ' + order.currency)}
      ${row('Reference', esc(order.reference), true)}
    </table>
    <div style="text-align:center;margin:26px 0">
      <img src="data:image/png;base64,${qr.toString('base64')}" width="180" alt="Ticket code ${esc(order.reference)}" style="background:#fff;padding:10px">
      <p style="font-size:12px;color:#c9b6d8;margin:10px 0 0">Show this at the door</p>
    </div>
    <table style="width:100%;border-top:1px solid rgba(212,165,52,.4);font-size:14px">
      ${row('Date', EVENT.date)}
      ${row('Time', EVENT.time)}
      ${row('Venue', EVENT.venue)}
    </table>`);

  const msg = {
    to: order.email,
    from: process.env.ORGANISER_EMAIL || 'noreply@wgma.com',
    subject: `Your WGMA 2026 ${tier.name} ticket - ${order.reference}`,
    text: plainTicket(order, tier),
    html,
    attachments
  };

  await sgMail.send(msg);
}

async function mailLynkInstructions(order) {
  const handle = process.env.LYNK_HANDLE || 'our Lynk account';
  const html = shell(`
    <p style="margin:0 0 8px">Your seat is held, ${esc(order.name)}.</p>
    <p style="margin:0 0 20px;color:#c9b6d8;font-size:14px">
      Send the payment on Lynk and your ticket follows once we confirm it.
      Held seats are released after 48 hours.
    </p>
    <table style="width:100%;border-top:1px solid rgba(212,165,52,.4);font-size:14px">
      ${row('Ticket', esc(tierOf(order).name))}
      ${row('Send to', esc(handle), true)}
      ${row('Amount', money(order.total, 'JMD') + ' JMD', true)}
      ${row('Put this in the note', esc(order.reference), true)}
      ${row('Admits', order.quantity)}
    </table>
    <p style="font-size:13px;color:#c9b6d8;margin:22px 0 0">
      The reference in the note is how we match your payment to you. Without it we
      cannot find your order.
    </p>`);

  const msg = {
    to: order.email,
    from: process.env.ORGANISER_EMAIL || 'noreply@wgma.com',
    subject: `Finish your WGMA 2026 booking - ${order.reference}`,
    text: `Your seat is held, ${order.name}.\n\nTicket: ${tierOf(order).name}\nSend to: ${handle}\nAmount: ${money(order.total, 'JMD')} JMD\nPut this in the note: ${order.reference}\nAdmits: ${order.quantity}\n\nYour ticket emails once we confirm the payment. Held seats are released after 48 hours.\nStuck? WhatsApp 876 816 2565.`,
    html
  };

  await sgMail.send(msg);
}

async function mailOrganiser(order) {
  const msg = {
    to: process.env.ORGANISER_EMAIL || 'noreply@wgma.com',
    from: process.env.ORGANISER_EMAIL || 'noreply@wgma.com',
    subject: `Lynk booking held - ${tierOf(order).name} - ${order.reference} - ${order.name}`,
    html: `<p style="font-family:Helvetica,Arial,sans-serif;line-height:1.7">
      <strong>${esc(order.reference)}</strong><br>
      ${esc(order.name)} &middot; ${esc(order.email)} &middot; ${esc(order.phone)}<br>
      ${esc(tierOf(order).name)} &middot; ${order.quantity} ticket(s) &middot; ${money(order.total, 'JMD')} JMD<br><br>
      When the Lynk payment lands, mark it paid on your admin page and the ticket sends itself.
    </p>`
  };

  await sgMail.send(msg);
}

/* ==================================================================
   9. HOUSEKEEPING
   ================================================================== */
app.get('/healthz', (req, res) => res.json({ ok: true, event: EVENT.name }));

// Anything else is a wrong turn.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
});

app.use((err, req, res, next) => {
  console.error('Unhandled:', err.message);
  res.status(500).json({ error: 'Something went wrong' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`WGMA tickets running on port ${PORT}`);

  const missing = ['SENDGRID_API_KEY', 'ADMIN_KEY', 'DOMAIN', 'ORGANISER_EMAIL']
    .filter(k => !process.env[k]);
  if (missing.length) console.warn('Missing from .env:', missing.join(', '));
  if (!process.env.LYNK_HANDLE) console.warn('Missing from .env: LYNK_HANDLE (Lynk emails will say "our Lynk account")');
  if (!process.env.HANDYPAY_API_KEY) console.warn('Missing from .env: HANDYPAY_API_KEY (card payments will fail)');

  if (process.env.SENDGRID_API_KEY) {
    console.log('Email ready: SendGrid configured');
  }
});
