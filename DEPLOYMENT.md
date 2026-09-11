# WGMA 2026 Ticket System — Deploy These Fixes

## ✅ What's Fixed

- **ticket.js** — Returns ticket image as Buffer (JPEG) so emails display images
- **server.js** — Includes spam folder reminder in email template  
- **Email rendering** — Ticket images now display in emails
- **Spam reminder** — Buyers see "Check your spam or promotions folder" message

## 🚀 Deploy (3 steps)

1. **Replace your local files:**
   - Copy `server.js` and `ticket.js` to your project root

2. **Commit to GitHub:**
   ```
   git add server.js ticket.js
   git commit -m "Fix: restore email image display and add spam reminder"
   git push
   ```

3. **Redeploy on Render:**
   - Manual: trigger redeployment in Render dashboard
   - Auto: Render redeploys on push
   - Wait for build to complete

## 📧 Test

1. Place a test ticket order
2. Verify ticket image appears in email
3. Check for spam folder reminder text

## 📝 Render Environment Variables

- `SENDGRID_API_KEY` — SendGrid API key
- `ORGANISER_EMAIL` — Admin email
- `ADMIN_KEY` — Admin panel password  
- `DOMAIN` — Your Render deployment URL
- `HANDYPAY_API_KEY` — HandyPay merchant key
- `HANDYPAY_WEBHOOK_SECRET` — Webhook secret
- `LYNK_HANDLE` — Your Lynk handle
