# New Brand Deployment Guide

How to stand up a fresh Supabase-backed deployment of this app for a new brand (e.g. a new league or association).

---

## Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli) installed (`brew install supabase/tap/supabase`)
- A Supabase account with an Organisation to host the new project
- A Vercel account (or any static host) for the frontend

---

## Step 1 — Create a Supabase Project (Dashboard)

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard) → **New project**.
2. Choose your organisation, enter a project name (e.g. `ecva-beach`), set a strong database password, and pick a region close to your users.
3. Wait for provisioning (~1 min). Note your:
   - **Project ref** (shown in the URL: `https://supabase.com/dashboard/project/<ref>`)
   - **Project URL**: `https://<ref>.supabase.co`
   - **Anon key**: Settings → API → `anon` `public` key

---

## Step 2 — Enable Auth Providers (Dashboard)

1. Authentication → Providers → **Email** — enable it, turn off "Confirm email" if you want password-only admin logins without an email confirmation step.
2. (Optional) Add any OAuth providers your admins will use.
3. Authentication → **URL Configuration**:
   - **Site URL**: your production frontend URL (e.g. `https://yournewbrand.com`)
   - **Redirect URLs**: add `https://yournewbrand.com/**` and your local dev URL `http://localhost:5173/**`

---

## Step 3 — Create the Admin User (Dashboard)

1. Authentication → Users → **Invite user** (or **Add user** → Create new user).
2. Set the email and a temporary password.
3. The user must sign in once via the app's Admin Login page to activate the account.

---

## Step 4 — Apply the Schema (CLI)

From inside `gbv-app/`:

```bash
# Authenticate once (opens browser)
supabase login

# Link CLI to the new project (prompts for DB password)
supabase link --project-ref <your-project-ref> --password '<your-db-password>'

# Apply the complete idempotent schema
supabase db query --linked --file supabase/schema.sql
```

> **Why `schema.sql` and not `db push`?**
> The files in `supabase/migrations/` are incremental patches applied on top of an existing schema. `schema.sql` is the single idempotent source of truth for a brand-new empty database. Use `db push` only when adding incremental migrations to an already-provisioned project.

---

## Step 5 — Verify the Schema

Run these queries to confirm everything is in place:

```bash
# All expected tables
supabase db query --linked \
  "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;"
# Expected: matches, pools, schedule_templates, teams, tournaments

# RLS enabled on tournaments
supabase db query --linked \
  "SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'tournaments';"
# Expected: relrowsecurity = true

# Policy count on tournaments (expect 5)
supabase db query --linked \
  "SELECT policyname, cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tournaments' ORDER BY policyname;"

# matches in realtime publication
supabase db query --linked \
  "SELECT pubname, tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'matches';"
```

---

## Step 6 — Configure the Frontend

Create `gbv-app/.env.<brand>` (git-ignored — never commit it):

```env
VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<your-anon-key>
VITE_BRAND=<brand-id>
VITE_APP_NAME="Your League Name"
VITE_SITE_URL=https://yourleague.com
VITE_ENABLE_REALTIME=true
```

See `.env.ecva.example` for a complete reference.

---

## Step 7 — Add Brand Assets

1. Create `public/brands/<brand-id>/`:
   - `logo.png` — primary logo graphic
   - `wordmark.png` — text/wordmark image (can be same as logo)
   - `favicon.ico`, `apple-touch-icon.png`, `android-chrome-192x192.png`, `android-chrome-512x512.png`, `favicon-16x16.png`, `favicon-32x32.png`
2. Add a `[data-theme="<brand-id>"]` block to `src/styles/themes.css` with your brand's `--brand-*` colour tokens.

---

## Step 8 — Deploy to Vercel

1. Import the repo in Vercel.
2. Set **Root Directory** to `gbv-app`.
3. Add all `VITE_*` variables from your `.env.<brand>` file as Vercel Environment Variables.
4. Each brand gets its own Vercel project pointing at the same git repo — only the env vars differ.

---

## Adding Subsequent Migrations

After the initial deployment, schema changes are made as migration files:

```bash
supabase migration new <description>
# edit supabase/migrations/<timestamp>_<description>.sql
supabase db push --linked
```

Do **not** edit `schema.sql` for incremental changes — it is only used for fresh provisioning.
