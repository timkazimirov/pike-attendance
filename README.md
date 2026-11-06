# ΠΚΑ Iota Pi — Attendance

QR check-in for chapter meetings at **pike.timkazimirov.com**.

- **Members:** scan the QR on the projector → type name → **Attend**. That's it.
- **Officers:** `pike.timkazimirov.com/admin` → create an event → **Show QR code**.
- **Data:** goes straight into a Google Sheet you own (no export step). The Sheet also gets
  a **Totals** tab (meetings attended per person) and a **By Event** tab (person × event grid).

## How the QR "unlocks" check-in

Each event has its own secret. The projector shows a QR code that **changes every 15 seconds**
(an HMAC of the secret and the current time). The site only opens the name form for a code that's
less than about a minute old, so a photo of the QR texted to someone who isn't there stops working
almost right away. The code is removed from the address bar after scanning, so the link can't be
passed around either.

Other rules:
- One check-in per phone per event (stops one person checking in their friends).
- Same name twice just says "already checked in".
- Officers can add or remove names by hand, close/reopen check-in, and download a CSV.
- Optional: paste your member list into the **Roster** tab (column A, one name per row) and the
  name field will autocomplete from it, which keeps names consistent in the summaries.

## Setup (about 10 minutes, one time)

### 1. Google Sheet + backend

> Use a personal **@gmail.com** account, not your UCLA one. UCLA's Google Workspace may block
> "Anyone" access to web apps, which the site needs.

1. Create a new Google Sheet (e.g. "ΠΚΑ Attendance").
2. **Extensions → Apps Script**. Delete what's there, paste in all of [`apps-script/Code.gs`](apps-script/Code.gs), click **Save**.
3. Go back to the Sheet and **reload** the page. A **ΠΚΑ Attendance** menu appears.
4. **ΠΚΑ Attendance → Set admin password…** Google will ask you to authorize the script
   (click through "Advanced → Go to … (unsafe)"; it's your own script). Pick the officer password.
   This also creates the Events / Attendance / Roster / Totals / By Event tabs.
5. In the Apps Script editor: **Deploy → New deployment** → gear icon → **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - **Deploy**, then copy the **Web app URL** (ends in `/exec`).

### 2. Point the website at it

Put that URL in [`public/config.js`](public/config.js):

```js
window.PIKE_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfy.../exec',
};
```

Commit and push. Vercel redeploys automatically.

### 3. Vercel + domain

1. [vercel.com/new](https://vercel.com/new) → import the `pike-attendance` GitHub repo → **Deploy**.
   No settings to change; `vercel.json` tells it to serve `public/`.
2. Project → **Settings → Domains** → add `pike.timkazimirov.com`.
3. At **name.com** (DNS for timkazimirov.com) → DNS records → add the record Vercel shows, normally:
   - Type `CNAME`, Host `pike`, Answer `cname.vercel-dns.com` (or the project-specific value Vercel gives you)
4. Wait a few minutes for Vercel to show the domain as valid (it sets up HTTPS itself).

### 4. Try it

Open `pike.timkazimirov.com/admin`, log in, create a test event, hit **Show QR code**, scan it with
your phone. Delete the test event afterwards.

## Day to day

1. Before the meeting: `/admin` → **Create event** (name + date).
2. Hit **Show QR code** and put that window on the projector (it goes full screen; Esc to exit).
   The count and the latest names update live.
3. When the meeting starts, **Close check-in** so late scans are refused.
4. Someone's phone is dead? Type their name under **Add someone manually**.

## Changing the backend later

If you edit `Code.gs`, redeploy without changing the URL: **Deploy → Manage deployments → ✏️ →
Version: New version → Deploy**. (A *new* deployment would get a new URL.)

## Local preview

```bash
node dev/server.mjs
```

Opens on http://localhost:5173 (admin password `pike-dev`). It runs the real `Code.gs` against an
in-memory fake of Google Sheets, so you can try everything without touching the real Sheet.
Data resets when you stop it. Raw fake-sheet contents: http://localhost:5173/__sheet

## Files

```
apps-script/Code.gs   backend (paste into the Sheet's Apps Script)
public/index.html     member check-in page
public/admin/         officer panel
public/config.js      Apps Script URL
dev/server.mjs        local preview server
vercel.json           static hosting config + security headers
```
