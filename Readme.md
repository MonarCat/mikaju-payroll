# Mikaju Payroll

**Professional offline-first payroll & HR software for Kenyan businesses.**  
By [Mikaju Software Solutions](https://mikaju.com) — a subsidiary of Afams Limited, Nairobi.

---

## What this is

Mikaju Payroll is a desktop application (Electron + React) that lets Kenyan businesses run statutory-compliant payroll **with or without internet**. All data lives locally in an encrypted SQLite database and syncs to Supabase cloud whenever the machine comes online.

It is the dedicated payroll & HR product that succeeds the payroll features previously offered by [salarycalculator.co.ke](https://salarycalculator.co.ke), which will continue to serve lightweight, browser-based salary calculations.

---

## Statutory compliance (2026)

| Deduction | Rate / Rule |
|---|---|
| PAYE | Graduated bands 10% → 35%, personal relief KES 2,400/mo |
| NSSF | Tier I: 6% up to LEL (KES 9,000) · Tier II: 6% up to UEL (KES 108,000) |
| SHIF | 2.75% of gross, minimum KES 300 |
| Affordable Housing Levy | 1.5% employee + 1.5% employer |

All rates are stored in **versioned tables keyed by `effectiveFrom` date** so historical payroll runs stay reproducible after statutory changes.

---

## Pricing

| Plan | Monthly | Annual | Employees |
|---|---|---|---|
| Free | KES 0 | — | Up to 3 |
| Basic | KES 99 | KES 999 | Up to 25 |
| Enterprise | KES 399 | KES 3,999 | Unlimited |

Subscriptions run on Paystack recurring billing. Offline license tokens allow the app to enforce entitlements without requiring internet on every launch.

---

## Repo structure

```
mikaju-payroll/
├── apps/
│   ├── landing/          # mikaju.com static site (plain HTML/CSS/JS)
│   └── desktop/          # Electron + Vite + React desktop app
│       ├── electron/
│       │   ├── main.js          # Main process entry point
│       │   ├── preload.js       # contextBridge IPC surface
│       │   ├── db/              # SQLite schema + writeRecord()
│       │   ├── sync/            # Sync engine (push outbox → pull remote)
│       │   └── license/         # Offline ECDSA license verification
│       └── src/                 # React renderer
├── packages/
│   └── tax-engine/       # Pure JS statutory calculation modules (tested)
│       ├── src/
│       │   ├── index.js         # calculatePayroll() — main entry point
│       │   ├── paye.js
│       │   ├── nssf.js
│       │   ├── shif.js
│       │   └── housingLevy.js
│       └── tests/
│           └── taxEngine.test.js
├── supabase/
│   ├── schema.sql               # Postgres schema + RLS policies
│   └── functions/
│       ├── paystack-webhook/    # Billing event handler
│       └── license-issue/       # Signs offline license tokens
├── scripts/
│   └── generate-license-keypair.js
├── docs/
│   └── ARCHITECTURE.md
├── .env.example
└── package.json                 # npm workspaces root
```

---

## Getting started (development)

### Prerequisites
- Node.js 20+
- Supabase CLI (`npm i -g supabase`)
- A Supabase project (create at supabase.com)

### 1. Clone & install
```bash
git clone https://github.com/MonarCat/mikaju-payroll.git
cd mikaju-payroll
npm install
```

### 2. Configure environment
```bash
cp .env.example apps/desktop/.env
# Fill in SUPABASE_URL and SUPABASE_ANON_KEY
```

### 3. Generate the license signing key pair (once only)
```bash
node scripts/generate-license-keypair.js
# → paste private key JWK into: supabase secrets set LICENSE_SIGNING_PRIVATE_KEY_JWK='...'
# → paste public key JWK into:  apps/desktop/electron/license/publicKey.json
```

### 4. Apply the Supabase schema
```bash
# In the Supabase SQL editor, run:
supabase/schema.sql
```

### 5. Deploy edge functions
```bash
supabase functions deploy paystack-webhook
supabase functions deploy license-issue
```

### 6. Run the tax engine tests
```bash
npm run test:tax-engine
# Expected: 11 checks passed.
```

### 7. Start the desktop app
```bash
npm run dev:desktop
```

---

## Architecture notes

- **Offline-first**: every write goes through `writeRecord()` which commits to SQLite and queues for sync in the same transaction. You cannot write to SQLite and skip the outbox.
- **Conflict detection**: `employees.version` is bumped on every update. The sync engine surfaces version conflicts to the user rather than silently overwriting — since this is payroll data, guessing wrong is worse than pausing.
- **Payroll runs are append-only once locked**: locked payroll runs and their payslips are never mutated after approval, which eliminates the conflict problem entirely for the highest-risk data.
- **Signed license tokens**: the desktop app verifies entitlement offline using an ECDSA public key baked into the app. Only the Supabase Edge Function (with the private key) can issue tokens.

---

## Legal

© 2026 Mikaju Software Solutions. All rights reserved.  
Private & proprietary. Do not distribute.
