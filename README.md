# Alert Management Backend

Node.js (Express) API + background worker for the mobile alert app.

- **Reads** plants, devices, limits, users and readings from the existing database **`ptechview_cpcb`**. It never writes to it.
- **Writes** only to its own database **`alert_app`**: alerts, login sessions, push tokens and the notification queue.

```
ptechview_cpcb (read only)          alert_app (this app)
  m_user, m_user_role, m_role   ─┐    am_alert               alerts (critical / warning / offline)
  m_plant, m_device             ├─▶   am_refresh_token       login sessions
  m_device_param(_map)          │     am_device_token        phone push tokens
  m_device_setpoint (limits)    │     am_notification_outbox push/email queue with retries
  tt_raw_device (readings)      │     am_user_plant          optional: limit a user to some plants
  ta_device_hrs (hourly avg)   ─┘     am_worker_state        last worker run
```

## Setup (first time)

1. **Install packages:** `npm install`
2. **Create `.env`:** copy `.env.example` to `.env`, then fill in `DB_USER`, `DB_PASSWORD` and `JWT_SECRET`.
   - `SRC_DB=ptechview_cpcb`: during development, point this at your local copy.
   - `APP_DB=alert_app`: the migration creates this database.
3. **Create the app tables:** `npm run migrate`. This only creates the `alert_app` database and its `am_*` tables.
4. **Check the connection:** `npm run check-db`. It prints row counts from the source tables.
5. **Start the API:** `npm run dev` (http://localhost:4000)
6. **Start the worker** in a second terminal: `npm run worker`. Or run `npm run worker:once` for a single check.
7. **Run the tests:** `npm test`

### Recommended: a read-only MySQL user for the real server

Run this once as a MySQL admin. With this user, the real data cannot be changed even by a bug:

```sql
CREATE USER 'alert_app'@'%' IDENTIFIED BY 'strong-password';
GRANT SELECT ON ptechview_cpcb.* TO 'alert_app'@'%';
GRANT ALL PRIVILEGES ON alert_app.* TO 'alert_app'@'%';
```

The code also blocks writes itself: every query on `ptechview_cpcb` goes through `srcQuery()`, which only allows `SELECT`.

## Mobile app API (`/api/v1`)

The React Native app (`alert-manager-react-native`) uses `/api/v1`. The app's `.env` must point at this server: `EXPO_PUBLIC_API_URL=http://<your-mac-ip>:4000`.

| Method | Path | Screen |
|---|---|---|
| POST | `/api/v1/auth/login` | Sign in. `{ email, password }`, where `email` may also be the user id |
| POST | `/api/v1/auth/refresh` · `/auth/logout` | Session |
| GET | `/api/v1/auth/me` | Current user |
| POST | `/api/v1/auth/forgot-password` · `/auth/reset-password` | Returns a "contact your administrator" message (503) until writing to `m_user` is approved |
| GET | `/api/v1/public/contact` | Contact administrator screen (`CONTACT_*` in `.env`) |
| GET | `/api/v1/sites` | Site picker (plants) |
| GET | `/api/v1/dashboard?siteId=` | Dashboard: alert counts, MTD compliance, failure events, % of limit bars |
| GET | `/api/v1/parameters/live?siteId=&kind=effluent\|emission` | Trends and report graphs (latest value, 24 h trend and avg) |
| GET | `/api/v1/alerts?type=all\|critical\|warning\|offline\|resolved&q=&siteId=&limit=&offset=` | Alerts list |
| GET | `/api/v1/alerts/summary` · `/alerts/:id` | Bell badge and alert details |
| GET | `/api/v1/reports/:kind?siteId=&from=YYYY-MM-DD&to=` | Reports table (effluent = ETP devices, emission = STACK devices) |
| GET | `/api/v1/reports/:kind/export.csv` | Report export |
| POST / DELETE | `/api/v1/devices` | Push token register / unregister |

## APIs

Every endpoint except login, refresh, logout and health needs the header `Authorization: Bearer <accessToken>`.

| Method | Path | What it does |
|---|---|---|
| GET | `/api/health` | Server up? Latest reading time and last worker run |
| POST | `/api/auth/login` | `{ username, password }` → access token, refresh token, user. Username is `m_user.user_id` or email |
| POST | `/api/auth/refresh` | `{ refreshToken }` → new tokens (the old refresh token stops working) |
| POST | `/api/auth/logout` | `{ refreshToken }` |
| POST | `/api/auth/logout-all` | Sign out on all phones |
| GET | `/api/auth/me` | Current user, roles and visible plant ids |
| GET | `/api/dashboard` | Home screen: alert counts, device status counts, every plant with live values |
| GET | `/api/plants` | Plants with device count and open alert counts |
| GET | `/api/plants/:plantId` | One plant with its devices, live values and status |
| GET | `/api/devices?plantId=` | Devices with their parameters and limits |
| GET | `/api/devices/:deviceId` | Latest value and status of each parameter |
| GET | `/api/devices/:deviceId/readings?param=BOD&from=&to=&limit=` | Raw readings from `tt_raw_device` |
| GET | `/api/devices/:deviceId/hourly?param=BOD&from=&to=` | Hourly min/max/avg from `ta_device_hrs` |
| GET | `/api/alerts?status=active\|open\|acknowledged\|closed&type=critical\|warning\|offline&plantId=&deviceId=&from=&to=&page=&pageSize=` | Alert list |
| GET | `/api/alerts/summary` | Counts of active alerts |
| GET | `/api/alerts/:id` | One alert |
| POST | `/api/alerts/:id/acknowledge` | `{ note? }` Marks the alert as seen. It stays active until the value is back to normal |
| POST | `/api/alerts/:id/close` | Admin only: close the alert manually |
| POST | `/api/notifications/device-token` | `{ token, platform }`: the phone registers its Firebase token |
| DELETE | `/api/notifications/device-token` | `{ token }`: call on logout |

Dates are IST strings like `2026-10-28 10:30:00` (or just `2026-10-28`).

## Alert rules (worker)

The worker runs every 60 s. For each active device it checks the newest reading of each parameter against `m_device_setpoint`:

| Type | When |
|---|---|
| **critical** | Value is above `max_setpoint`, or below `min_setpoint` when min > 0 (e.g. pH < 5.5) |
| **warning** | Value is ≥ 90 % of max. For a range like pH 5.5–9, it is in the outer 10 % of the range |
| **offline** | No reading from the device for `OFFLINE_AFTER_MINUTES` (default 120) |

Other behaviour:

- There is only one open alert per device + parameter. It is updated while the problem continues, and closes automatically on the first normal reading.
- A push notification is sent when an alert opens, and again if a warning becomes critical.
- Email goes to `ALERT_EMAILS` when SMTP is set up.

## Roles

Roles come from `m_user_role` (falling back to `m_user.role_id`):

- Ids in `ADMIN_ROLE_IDS` (default 1 = Admin, 3 = Super User) see every plant and can close alerts.
- Other users see every plant unless you add rows for them to `alert_app.am_user_plant`. The old database has no user→plant table.

## Not included (needs writing to `ptechview_cpcb`)

Forgot password, change password and "last login" updates would all write to `m_user`, so they are left out. They can be added later if writing to that table is approved.

## Production (pm2)

```
pm2 start src/server.js --name alert-api
pm2 start src/worker/index.js --name alert-worker   # run only ONE worker
pm2 save
```
