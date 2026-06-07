# 🎓 MSBTE Summer 2026 Result Monitor

Automatically monitors the [MSBTE result portal](https://result.msbte.ac.in/) every **5 minutes** using GitHub Actions and sends you an **instant email** via [Resend](https://resend.com) the moment Summer 2026 Diploma results go live.

**100% free to run** · No server needed · No duplicate emails · Secure secrets management

---

## 📁 Project Structure

```
msbte-monitor/
├── .github/
│   └── workflows/
│       └── check-results.yml   # GitHub Actions scheduler (runs every 5 min)
├── monitor.js                  # Core monitoring + email script
├── package.json
└── README.md
```

---

## 🚀 Quick Start (Full Setup Guide)

Follow these steps **in order**. Total time: ~10 minutes.

---

### Step 1 — Fork / Create the GitHub Repository

1. Go to [github.com](https://github.com) and sign in (or create a free account).
2. Click **"New repository"** (top-right `+` button → "New repository").
3. Name it: `msbte-result-monitor`
4. Set visibility to **Private** (recommended) or Public.
5. Click **"Create repository"**.

---

### Step 2 — Upload the Project Files

**Option A — GitHub Web UI (easiest)**

1. Open your new repository.
2. Click **"Add file" → "Upload files"**.
3. Upload `monitor.js` and `package.json`.
4. Then create the workflow file manually:
   - Click **"Add file" → "Create new file"**
   - Name it: `.github/workflows/check-results.yml`
   - Paste the contents of `check-results.yml`
   - Click **"Commit new file"**

**Option B — Git CLI**

```bash
git clone https://github.com/YOUR_USERNAME/msbte-result-monitor.git
cd msbte-result-monitor

# Copy all project files into this folder, then:
git add .
git commit -m "Initial commit: MSBTE result monitor"
git push
```

---

### Step 3 — Create a Resend Account & API Key

Resend is a free email delivery service. The free plan allows **3,000 emails/month** — more than enough.

1. Go to **[resend.com](https://resend.com)** and click **"Get Started"**.
2. Sign up with your email (GitHub login also works).
3. Verify your email address.
4. Once logged in, go to **API Keys** (left sidebar).
5. Click **"Create API Key"**.
   - Name: `msbte-monitor`
   - Permission: **Sending access**
   - Click **"Add"**
6. **Copy the API key immediately** — it won't be shown again!
   It looks like: `re_xxxxxxxxxxxxxxxxxxxx`

#### 📧 Setting up your sender email (EMAIL_FROM)

Resend requires a verified sender address. You have two options:

**Option A — Use Resend's shared domain (easiest, no DNS changes needed)**
- Use: `onboarding@resend.dev`
- This works immediately on free accounts.

**Option B — Use your own domain (recommended for reliability)**
1. In Resend dashboard → **Domains** → **"Add Domain"**
2. Enter your domain (e.g., `yourdomain.com`)
3. Add the DNS records Resend shows you (MX, TXT, DKIM)
4. Wait for verification (usually 5–30 minutes)
5. Then use: `alerts@yourdomain.com`

---

### Step 4 — Configure GitHub Secrets

Secrets keep your API keys secure — they are **never visible** in logs or code.

1. Open your repository on GitHub.
2. Go to **Settings** (top menu) → **Secrets and variables** → **Actions**.
3. Click **"New repository secret"** for each of the following:

| Secret Name     | Value                                      | Example                        |
|-----------------|--------------------------------------------|--------------------------------|
| `RESEND_API_KEY` | Your Resend API key                       | `re_abc123xyz...`              |
| `EMAIL_TO`      | Email address to receive notifications     | `your@email.com`               |
| `EMAIL_FROM`    | Verified sender address in Resend          | `onboarding@resend.dev`        |

> ⚠️ **Important:** The `EMAIL_FROM` address must be verified in your Resend account, otherwise emails will fail to send.

---

### Step 5 — Enable GitHub Actions

1. In your repository, click the **"Actions"** tab.
2. If prompted, click **"I understand my workflows, go ahead and enable them"**.
3. Your workflow is now active! It will run every 5 minutes automatically.

---

### Step 6 — Test It Manually

Before waiting for results, verify everything works:

1. Go to **Actions** tab → Select **"MSBTE Result Monitor"** workflow.
2. Click **"Run workflow"** (right side).
3. Set **"Dry run"** to `true` (no email will be sent).
4. Click **"Run workflow"**.
5. Watch the run complete — check logs for any errors.

To test the full email flow (with actual email):
1. Run workflow again with **"Dry run"** = `false`.
2. Temporarily edit `monitor.js`, change one keyword to something that exists on the page (e.g., a word you know is there), run it, then revert.

---

## 🔍 How It Works

```
Every 5 minutes:
  ┌─────────────────────────────────────────────────┐
  │  1. GitHub Actions wakes up                     │
  │  2. Check if "notified.flag" exists (cache)     │
  │     → YES: Already sent email. Exit silently.   │
  │     → NO:  Continue to check portal             │
  │  3. Fetch https://result.msbte.ac.in/           │
  │     + https://msbte.org.in/ (backup)            │
  │  4. Scan page text, links, raw HTML for:        │
  │     "summer 2026", "summer-2026", "s2026", etc. │
  │     → NOT FOUND: Exit. Try again in 5 minutes.  │
  │     → FOUND: Send email via Resend              │
  │  5. Write "notified.flag" to cache              │
  │     → Future runs will skip email (no duplicates)│
  └─────────────────────────────────────────────────┘
```

---

## 🛡️ Duplicate Email Prevention

The system uses **GitHub Actions Cache** to store a `notified.flag` file:

- On first successful notification → flag is written to cache
- Every subsequent run → flag is detected → script exits immediately
- Flag persists across all future workflow runs
- You will receive **exactly one email**, guaranteed

To **reset** and allow a new notification (e.g., for testing):
1. Go to **Actions** tab → your workflow run.
2. In the left sidebar, click **"Caches"** (under Management).
3. Delete the cache named `msbte-notified-flag-v1`.

---

## 📊 Monitoring & Logs

- Every workflow run is logged under the **Actions** tab
- Each run shows: pages checked, keywords scanned, detection result
- If the workflow **fails** (red ✗), GitHub will email you about the failure
- Normal "not found yet" runs appear as green ✓ (exits with code 0)

---

## ⚙️ Configuration Reference

Edit these values in `monitor.js` if needed:

| Setting | Default | Description |
|---------|---------|-------------|
| `targetUrl` | `https://result.msbte.ac.in/` | Primary URL to monitor |
| `extraUrls` | msbte.org.in + notices | Backup URLs also checked |
| `keywords` | `summer 2026`, `summer-2026`, etc. | Detection keywords |
| `timeoutMs` | `30000` (30s) | HTTP request timeout |

---

## 🔄 Changing the Check Frequency

Edit `.github/workflows/check-results.yml`:

```yaml
schedule:
  - cron: "*/5 * * * *"   # Every 5 minutes (default)
  # - cron: "*/10 * * * *"  # Every 10 minutes
  # - cron: "0 * * * *"     # Every hour
```

> ⚠️ GitHub's minimum schedule interval is **5 minutes**. Going faster is not supported.

---

## 💸 Cost

| Service | Free Tier | This Project Uses |
|---------|-----------|-------------------|
| GitHub Actions | 2,000 min/month (free accounts) | ~1 min/run × 288 runs/day ≈ 288 min/day | 
| Resend | 3,000 emails/month | 1 email total |

**Total cost: $0.00** — well within free tiers.

> GitHub Actions free minutes: public repos get **unlimited** minutes. Private repos get 2,000 min/month, which equals ~69 days of 5-minute checks.

---

## 🐛 Troubleshooting

| Problem | Solution |
|---------|----------|
| Workflow not running | Check Actions tab is enabled; check cron syntax |
| Email not received | Check spam folder; verify `EMAIL_FROM` is validated in Resend |
| `RESEND_API_KEY` error | Re-add secret; make sure there are no spaces |
| "Already notified" but no email | Delete the cache `msbte-notified-flag-v1` and re-run |
| Portal unreachable | MSBTE site may be down; workflow will retry in 5 min |
| Workflow fails with red ✗ | Click the run → read logs for the exact error message |

---

## 📬 Support

If you hit issues:
1. Check the **Actions** tab logs first — they are very detailed.
2. Ensure all 3 GitHub Secrets are set correctly (no extra spaces or quotes).
3. Verify your `EMAIL_FROM` domain/address is **verified** in Resend dashboard.

---

*Built with Node.js · GitHub Actions · Resend · Cheerio*
