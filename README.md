# Christian Worship Centre — Church Management PWA

A complete church management system and member app for **Christian Worship Centre (CWC)**, built as an installable Progressive Web App that works on any phone, tablet or computer — and keeps working on patchy mobile data.

- **Live app:** <https://cwc-ch.pages.dev> (Cloudflare Pages)
- **Backend:** Supabase project `cwc-church` (`myektndhhvbkhvkyireg`, Frankfurt) — Postgres + row level security, Auth, Edge Functions, pg_cron
- **Media:** Cloudinary (photos, banners, sermon audio). Uploads are signed by the API; a developer enters the cloud name, API key and secret in **Developer → Integrations**. Until then uploads fall back to Supabase Storage. Expense receipts stay in a private Supabase bucket.

**Designed & developed by ProfJero** — *Building Solutions. Empowering Lives.*

---

## What’s inside

### Member app (everyone)
- **Home** — greeting, today’s devotional, quick actions, announcements, upcoming events, latest sermon, testimonies, live-service check-in banner.
- **Devotionals** — daily reader with adjustable text size, bookmarks (saved for offline), share to WhatsApp, previous/next.
- **Events** — upcoming/past, category filters, one-tap RSVP with guests and capacity, add to phone calendar (.ics), share, map link.
- **Sermons** — YouTube (privacy-enhanced) or audio (lighter on data), series filter, search.
- **Give** — church MoMo / bank details with one-tap copy and MoMo how-to (MTN, Telecel, AT), personal giving history, pledge progress, printable giving statement.
- **Care** — prayer, counselling, visitation, urgent needs and testimonies; private or public (prayer wall, optionally anonymous); conversation thread with pastors; works offline (sends when back online).
- **Prayer wall** — “I prayed” counter and published testimonies.
- **Notifications** — in-app inbox synced across devices (read receipts), live updates, push notifications (works for visitors too), categories, per-person preferences, test push, app badge.
- **Profile** — photo, contact details, groups, attendance, SMS opt-out, theme (light/dark/system), change password, install app.
- **QR self check-in** — scan the code shown at church to check yourself in.
- **No account needed.** Visitors browse straight away; to RSVP, ask for prayer, check in or see their giving they only *complete a short profile* (name + phone). A private device account is created behind the scenes; they can set a password later to use another phone.
- Sign in with **email or phone number** (many members don’t use email).

### Church admin (staff)
| Module | Highlights |
|---|---|
| **Dashboard** | Role-aware KPIs, Sunday attendance trend, income vs expenses, giving by category, birthdays this week, follow-ups, care inbox, upcoming events |
| **People** | Directory with search/filters, rich profiles (GhanaPost GPS, hometown/region, emergency contact, baptism), households, tags, bulk SMS/group/status actions, CSV import with auto column-matching & duplicate detection, CSV export |
| **Groups & ministries** | Departments, fellowships, home cells/bacentas, committees; leaders; SMS a whole group |
| **Follow-ups** | Kanban pipeline (drag & drop) for first-timers, new converts, absentees; notes, assignment, due dates |
| **Attendance** | Start a service, live usher headcounts (multi-device sync), fast name check-in, first-timer registration at the door, QR self check-in, trends, absentee finder → follow-ups/SMS |
| **Giving & finance** | Record tithes/offerings/seeds (cash, MoMo ref, bank, cheque), **batch entry** for envelope stacks, SMS receipts (personalised bulk send), printable receipts & statements, pledges & campaigns (building fund, harvest), expenses with receipt photos, period filters, financial summary print, CSV |
| **Events** | Create/publish with banners, RSVPs list & export, push reminders, SMS attendees |
| **Content** | Devotionals (schedule ahead), sermons (YouTube or audio upload), announcements (pinned, expiry) — with optional push on publish |
| **Pastoral care** | Request inbox, assignment, replies that notify the member, private internal notes, care log (visits, hospital, counselling), testimony moderation |
| **Messages** | SMS via **ProfJero Connect**: audience builder, personalisation (`{first_name|Beloved}`), live page/unit counter with Unicode warning & one-tap fix, cost check against wallet, scheduling, delivery tracking, templates, wallet & MoMo/card top-up; free push notifications |
| **Reports** | Growth, age profile, gender, group sizes, attendance, income/expenses, tithers per month; printable annual report; CSV |
| **Users & roles** | Staff accounts (created on the server with a one-time password), **custom roles with a permission editor**, role changes, deactivation, link app accounts to member records, password resets |
| **Settings** | Church profile, giving accounts, categories, service types, SMS defaults, welcome/birthday automation, integration health |
| **Activity log** | Append-only audit trail of important changes |
| **New in the app** | Self-registered people to welcome, confirm, or merge into an existing record (matched by phone/name) |
| **Developer console** | On-demand system health: database/storage/MAU usage vs free-tier limits, table sizes, client error log with stacks, background jobs, integration checks (SMS, push), maintenance actions, SMS key management |

Plus: ⌘K command palette, dark mode, offline mode, and layouts designed and tested from **320 px phones to 1920 px desktops**.

### Roles

Roles live in the database (`public.roles`) as sets of permissions, so new roles can be added in **Users & roles → Roles & permissions** without code changes.

| Role | Can do |
|---|---|
| **Super Admin** | Everything. Only a super admin can create or remove another super admin. There must always be at least one. Seeded: `christianworshipcentre.ch@gmail.com` |
| **Developer** | Everything plus the developer console (system health, errors, integrations, maintenance). Seeded: `profjero947@gmail.com` |
| Administrator | Day-to-day operations (all except roles and system monitoring) |
| Pastor · Treasurer · Secretary · Ministry Staff · Viewer | As before (see `supabase/migrations/…_core.sql`) |
| *Custom roles* | Any combination of the 23 permissions |
| Member | Member app only |

Rules enforced by the database (not just hidden in the UI): nobody can change their own role; nobody can grant a role with permissions they don’t hold; nobody can manage an account more powerful than theirs; counselling and confidential care notes are pastors-only; members see only their own giving, requests and records.

---

## Architecture

```
┌────────────────────────────┐      publishable key + user JWT      ┌──────────────────────────────────┐
│ app/  React PWA            │◄────────────────────────────────────►│ Supabase                          │
│ Vite · TypeScript ·        │   PostgREST (RLS on every table),     │  Postgres + RLS + guard triggers │
│ Tailwind · Workbox SW      │   Auth, Storage, Realtime (2 screens) │  Auth (email / phone-as-login)   │
│ Cloudflare Pages           │                                       │  Storage: media (public), receipts│
└──────────┬─────────────────┘                                       │  pg_cron: daily 07:00, weekly     │
           │ user JWT                                                │  pg_net: push dispatch            │
           ▼                                                         └──────────────┬───────────────────┘
┌────────────────────────────┐  service role (server only)                          │ notification insert
│ supabase/functions/api     │◄──────────────────────────────────────────────────────┘ → pg_net → /push/dispatch
│ Edge Function (Deno)       │──► ProfJero Connect SMS (secret key stays server-side)
│ register · staff accounts ·│──► Web Push (VAPID, generated on first use)
│ SMS proxy · push · jobs ·  │
│ developer diagnostics      │
└────────────────────────────┘
```

- **No secrets in the browser.** Only the publishable key ships in the app. The SMS key, VAPID private key and dispatch secret live in `private.app_config` (unexposed schema), readable only by the service role.
- **Light on quotas.** Lists are fetched on demand, cached on the device and refreshed on focus/after writes — nothing polls. Realtime is used only for the notification feed and live service check-in. The developer console loads only when opened (auto-refresh is opt-in and stops when the tab is hidden). Client errors are de-duplicated per day with a hard daily cap; old data is pruned weekly.
- **Offline-first.** Cached data shows offline; prayer/care requests and testimonies queue on the phone and send when back online.
- **Server-side counters.** RSVP counts and capacity, check-ins, first-timers, pledge balances and group sizes are maintained by triggers, so clients can’t tamper with them.

## Repository layout

| Path | What |
|---|---|
| `app/` | The PWA (member app + staff admin) |
| `supabase/migrations/` | Schema, RLS, functions, storage policies and schedules (applied to the project) |
| `supabase/functions/api/` | The API Edge Function (deployed as `api`, `verify_jwt = false` — it verifies JWTs itself) |
| `supabase/tests/` | Database security tests (run against a local Postgres with Supabase stubs) |
| `supabase/functions/tests/` | Edge Function tests (Node, mocked network) |
| `app/e2e/`, `app/e2e-live/` | Browser and live-API tests against the real project with dedicated test accounts |

## Setting up from scratch

1. **Supabase:** create a project, then apply `supabase/migrations/*.sql` in order (SQL editor, `supabase db push`, or MCP). Then set the function URL so the database can call the API:
   ```sql
   insert into private.app_config (key, value) values ('functions_url', 'https://<ref>.supabase.co/functions/v1/api')
   on conflict (key) do update set value = excluded.value;
   ```
2. **Edge Function:** deploy `supabase/functions/api` as `api` with JWT verification off (`supabase functions deploy api --no-verify-jwt`). Optional env: `ALLOWED_ORIGINS`, `PROFJERO_SENDER_ID`, `VAPID_SUBJECT`.
3. **Leader accounts:** call `POST /functions/v1/api/v1/admin/bootstrap` with header `x-cwc-secret: <private.app_config.dispatch_secret>` once. It creates accounts for the seeded emails (super admin, developer) with one-time passwords that must be changed at first sign-in.
4. **App:** `cd app && npm ci`, put `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env.production` (already set for this project), `npm run build`, deploy `app/dist` to Cloudflare Pages (`public/_headers` and `_redirects` are included).
5. **SMS & media:** a developer pastes the ProfJero Connect secret key and the Cloudinary cloud name / API key / API secret in **Developer → Integrations** (stored server-side, never readable again).
6. **Email:** Supabase’s built-in mailer only delivers to the project team. For password-reset emails to members, add custom SMTP (e.g. Resend/Brevo) in *Supabase → Authentication → Emails*. Phone-only accounts are reset by staff in **Users & roles**.

## Testing

| Suite | Command | Covers |
|---|---|---|
| Database security | `npm run db:test` (repo root; needs local Postgres 15+, user/password `postgres`) | 54 tests: role escalation, custom roles, last-super-admin protection, visitor access, self-registration, merges, giving privacy, care confidentiality & anonymous prayer wall, RSVP capacity, self check-in, notifications visibility, push validation, audit immutability, developer-only monitoring, write-only secrets |
| Edge Function | `npx vitest run --root supabase/functions` | 25 tests: ES256 JWT verification (forged/expired/foreign/none-alg), CORS, registration & reserved emails, rate limiting, staff admin rules, developer diagnostics, internal secrets, SMS proxy, RFC 8291 web-push vectors |
| App unit | `cd app && npm test` | Phone normalisation, SMS maths |
| Live API | `cd app && NODE_USE_ENV_PROXY=1 LIVE_PASSWORD=… npx vitest run --root e2e-live` | 18 checks against the real project with test accounts |
| Browser | `cd app && npm run build && E2E_PASSWORD=… npx playwright test` | Visitor screens at 320–1920 px (no overflow, no errors), profile prompt, member/staff/developer journeys |

## Security notes
- Keep the service role key, SMS key and VAPID private key server-side only (they are).
- `private` schema is not exposed by the Data API; `SECURITY DEFINER` RPCs in `public` check the caller themselves (see tests).
- Supabase Auth has email confirmation on and anonymous sign-ins off; accounts are created by the Edge Function (rate limited per IP and globally). Leader emails are reserved and cannot be self-registered.

## Ghana-first details
- Phone numbers accept `024 123 4567`, `+233…`, `233…`; stored as `233XXXXXXXXX`.
- Currency in GH₵ on screen; SMS templates use `GHS` (the ₵ sign makes SMS Unicode).
- Africa/Accra (UTC) for schedules; data-light images (resized to WebP on the phone).

---

<sub>Christian Worship Centre · crafted by **ProfJero** — Unveiling the Extraordinary.</sub>
