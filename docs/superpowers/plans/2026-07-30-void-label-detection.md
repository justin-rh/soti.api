# VOID Label Detection Column Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sortable "Activity" column to the SOTI Connect printer table showing whether each printer is currently printing VOID labels, derived from RFID valid/void odometer deltas sampled by a new server-side background poller.

**Architecture:** A pure verdict function (`lib/print-activity.js`) computes one of five states (`voiding`, `ok`, `idle_voiding`, `idle`, `null`) from aggregate inputs. `server.js` gains a `label_activity_events` SQLite table (a row only when a counter increases), a 60-second background poller that fetches from SOTI Connect and records samples, and an in-memory cache that `/api/devices` serves from. The frontend renders the server-computed verdict as a badge.

**Tech Stack:** Node.js 18+ (CommonJS), Express, better-sqlite3, vanilla JS frontend, `node:test` built-in test runner (no new dependencies).

**Spec:** `docs/superpowers/specs/2026-07-30-void-label-detection-design.md`

## Global Constraints

- Detection window: **15 minutes** (`DEFAULT_WINDOW_MS = 15 * 60 * 1000`).
- Poll interval: **60 s**; `/api/devices` cache considered stale after **10 s**.
- Valid labels take precedence: any valid-label printing at or after the last void clears VOIDING/Idle (V).
- A calibration reset (existing `calibration_events` logic) clears Idle (V) back to plain Idle.
- Negative counter deltas (resets) never produce activity events.
- Activity events older than **30 days** are pruned at startup.
- API state values: `"voiding" | "ok" | "idle_voiding" | "idle" | null` — exactly these strings.
- No new npm dependencies. CommonJS (`require`/`module.exports`) throughout, matching the codebase.
- Timestamps are ISO 8601 strings from `new Date().toISOString()`, compared lexicographically in SQL and via `Date.parse` in JS.

---

### Task 1: Pure verdict function `computePrintActivity`

**Files:**
- Create: `lib/print-activity.js`
- Create: `test/print-activity.test.js`
- Modify: `package.json` (add `test` script)

**Interfaces:**
- Consumes: nothing (pure module).
- Produces: `computePrintActivity({ lastEvent, voidsInWindow, lastVoidAt, lastValidAt, lastCalibrationAt, now, windowMs })` → `{ state, voidsInWindow, lastVoidAt, lastValidAt }` where `state` ∈ `'voiding' | 'ok' | 'idle_voiding' | 'idle'`. Also exports `DEFAULT_WINDOW_MS` (number). Task 3 imports both from `./lib/print-activity`.
  - `lastEvent`: `{ recorded_at: string, void_delta: number, valid_delta: number } | null` — most recent activity event ever for the device.
  - `voidsInWindow`: number — sum of `void_delta` within the window.
  - `lastVoidAt` / `lastValidAt`: ISO string or null — all-time most recent void / valid increase.
  - `lastCalibrationAt`: ISO string or null.
  - `now`: epoch milliseconds. `windowMs` optional, defaults to `DEFAULT_WINDOW_MS`.
  - The `null` (counters unavailable) state is decided by the **caller** (Task 3), not this function.

- [ ] **Step 1: Add the test script to package.json**

In `package.json`, change the `scripts` block to:

```json
  "scripts": {
    "start": "node server.js",
    "test": "node --test test/"
  },
```

- [ ] **Step 2: Write the failing tests**

Create `test/print-activity.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computePrintActivity, DEFAULT_WINDOW_MS } = require('../lib/print-activity');

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const minAgo = (m) => new Date(NOW - m * 60000).toISOString();

function compute(overrides) {
  return computePrintActivity({
    lastEvent: null,
    voidsInWindow: 0,
    lastVoidAt: null,
    lastValidAt: null,
    lastCalibrationAt: null,
    now: NOW,
    ...overrides,
  });
}

test('exports a 15-minute default window', () => {
  assert.equal(DEFAULT_WINDOW_MS, 15 * 60 * 1000);
});

test('no events ever -> idle', () => {
  const r = compute({});
  assert.equal(r.state, 'idle');
  assert.equal(r.voidsInWindow, 0);
});

test('void-only event within window -> voiding', () => {
  const r = compute({
    lastEvent: { recorded_at: minAgo(5), void_delta: 2, valid_delta: 0 },
    voidsInWindow: 4,
    lastVoidAt: minAgo(5),
  });
  assert.equal(r.state, 'voiding');
  assert.equal(r.voidsInWindow, 4);
});

test('valid labels after the last void -> ok (valid takes precedence)', () => {
  const r = compute({
    lastEvent: { recorded_at: minAgo(2), void_delta: 0, valid_delta: 10 },
    voidsInWindow: 1,
    lastVoidAt: minAgo(5),
    lastValidAt: minAgo(2),
  });
  assert.equal(r.state, 'ok');
});

test('void and valid in the same delta -> ok (valid takes precedence)', () => {
  const r = compute({
    lastEvent: { recorded_at: minAgo(3), void_delta: 1, valid_delta: 5 },
    voidsInWindow: 1,
    lastVoidAt: minAgo(3),
    lastValidAt: minAgo(3),
  });
  assert.equal(r.state, 'ok');
});

test('void more recent than valid, within window -> voiding', () => {
  const r = compute({
    lastEvent: { recorded_at: minAgo(3), void_delta: 1, valid_delta: 0 },
    voidsInWindow: 1,
    lastVoidAt: minAgo(3),
    lastValidAt: minAgo(10),
  });
  assert.equal(r.state, 'voiding');
});

test('last event was valid, outside window -> idle', () => {
  const r = compute({
    lastEvent: { recorded_at: minAgo(30), void_delta: 0, valid_delta: 8 },
    lastValidAt: minAgo(30),
  });
  assert.equal(r.state, 'idle');
});

test('last event void-only, outside window -> idle_voiding (abandoned while voiding)', () => {
  const r = compute({
    lastEvent: { recorded_at: minAgo(45), void_delta: 3, valid_delta: 0 },
    lastVoidAt: minAgo(45),
    lastValidAt: minAgo(120),
  });
  assert.equal(r.state, 'idle_voiding');
});

test('calibration after the last void clears idle_voiding -> idle', () => {
  const r = compute({
    lastEvent: { recorded_at: minAgo(45), void_delta: 3, valid_delta: 0 },
    lastVoidAt: minAgo(45),
    lastCalibrationAt: minAgo(20),
  });
  assert.equal(r.state, 'idle');
});

test('calibration before the last void does NOT clear idle_voiding', () => {
  const r = compute({
    lastEvent: { recorded_at: minAgo(45), void_delta: 3, valid_delta: 0 },
    lastVoidAt: minAgo(45),
    lastCalibrationAt: minAgo(90),
  });
  assert.equal(r.state, 'idle_voiding');
});

test('result echoes lastVoidAt / lastValidAt for the tooltip', () => {
  const r = compute({
    lastEvent: { recorded_at: minAgo(2), void_delta: 0, valid_delta: 1 },
    lastVoidAt: minAgo(9),
    lastValidAt: minAgo(2),
  });
  assert.equal(r.lastVoidAt, minAgo(9));
  assert.equal(r.lastValidAt, minAgo(2));
});

test('custom windowMs is honored', () => {
  const r = compute({
    lastEvent: { recorded_at: minAgo(10), void_delta: 1, valid_delta: 0 },
    lastVoidAt: minAgo(10),
    windowMs: 5 * 60 * 1000,
  });
  assert.equal(r.state, 'idle_voiding'); // 10 min ago is outside a 5-min window
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/print-activity'`

- [ ] **Step 4: Write the implementation**

Create `lib/print-activity.js`:

```js
'use strict';

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

// Pure verdict function for the Print Activity column. All inputs are plain
// values so this is testable without a database. The caller is responsible
// for returning null instead when the device reports no RFID odometers.
function computePrintActivity({
  lastEvent,
  voidsInWindow,
  lastVoidAt,
  lastValidAt,
  lastCalibrationAt,
  now,
  windowMs = DEFAULT_WINDOW_MS,
}) {
  const result = {
    state: 'idle',
    voidsInWindow: voidsInWindow || 0,
    lastVoidAt: lastVoidAt || null,
    lastValidAt: lastValidAt || null,
  };
  if (!lastEvent) return result;

  const lastEventAt = Date.parse(lastEvent.recorded_at);
  const hasRecentActivity = now - lastEventAt <= windowMs;

  // Valid labels take precedence: any valid printing at or after the last
  // void means the printer is producing good labels.
  const voidAt  = lastVoidAt  ? Date.parse(lastVoidAt)  : null;
  const validAt = lastValidAt ? Date.parse(lastValidAt) : null;
  const validSinceVoid = validAt !== null && (voidAt === null || validAt >= voidAt);

  if (hasRecentActivity) {
    result.state = validSinceVoid ? 'ok' : 'voiding';
    return result;
  }

  // Quiet printer: flag it if its last-ever activity was void-only and no
  // calibration reset (= serviced) has happened since.
  const calibratedSince = lastCalibrationAt != null
    && voidAt !== null
    && Date.parse(lastCalibrationAt) >= voidAt;
  if (voidAt !== null && !validSinceVoid && !calibratedSince) {
    result.state = 'idle_voiding';
  }
  return result;
}

module.exports = { computePrintActivity, DEFAULT_WINDOW_MS };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 12 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add lib/print-activity.js test/print-activity.test.js package.json
git commit -m "feat: add pure print-activity verdict function with tests"
```

---

### Task 2: Activity event recording in server.js (schema + sampling)

**Files:**
- Modify: `server.js` — schema block (~line 25-54), migration section (~line 56-69), `stmt` object (~line 71-115), `checkCalibrations` (~line 117-133)

**Interfaces:**
- Consumes: existing `stmt.getVoidState`, `stmt.insertCalibration`, `device.voidCount` / `device.validCount` from `processDevice`.
- Produces (used by Task 3):
  - `recordCounterSample(devices)` — replaces `checkCalibrations` (renamed + extended). Call once per SOTI fetch.
  - Prepared statements: `stmt.insertActivity`, `stmt.getLastActivity`, `stmt.getVoidsInWindow`, `stmt.getLastVoidAt`, `stmt.getLastValidAt`, `stmt.getLastCalibrationAt`, `stmt.pruneActivity`.
  - `device_void_state` gains nullable `last_valid_count` column; `stmt.upsertVoidState` now takes **5** params: `(device_id, device_name, last_void_count, last_valid_count, updated_at)`.

- [ ] **Step 1: Add the new table and index to the schema block**

In the `db.exec(...)` block in `server.js` (after the `reader_settings` table, before the `CREATE INDEX` lines), add:

```sql
  CREATE TABLE IF NOT EXISTS label_activity_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id   INTEGER NOT NULL,
    device_name TEXT    NOT NULL,
    recorded_at TEXT    NOT NULL,
    void_delta  INTEGER NOT NULL DEFAULT 0,
    valid_delta INTEGER NOT NULL DEFAULT 0
  );
```

and alongside the existing index lines:

```sql
  CREATE INDEX IF NOT EXISTS idx_activity_device_time ON label_activity_events(device_id, recorded_at);
```

- [ ] **Step 2: Migrate `device_void_state` to add `last_valid_count`**

Directly after the existing `reader_host_state` migration block (~line 69), add a second migration block following the same pattern:

```js
// Migrate device_void_state to track the valid-label counter too (for print-activity deltas)
{
  const cols = db.prepare("PRAGMA table_info(device_void_state)").all().map((c) => c.name);
  if (!cols.includes('last_valid_count')) {
    db.exec('ALTER TABLE device_void_state ADD COLUMN last_valid_count INTEGER');
  }
}
```

- [ ] **Step 3: Add the new prepared statements and update `upsertVoidState`**

In the `stmt` object, replace `upsertVoidState` with:

```js
  upsertVoidState:    db.prepare(`
    INSERT INTO device_void_state (device_id, device_name, last_void_count, last_valid_count, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      device_name      = excluded.device_name,
      last_void_count  = excluded.last_void_count,
      last_valid_count = excluded.last_valid_count,
      updated_at       = excluded.updated_at
  `),
```

and add these entries to the `stmt` object:

```js
  insertActivity: db.prepare(`
    INSERT INTO label_activity_events (device_id, device_name, recorded_at, void_delta, valid_delta)
    VALUES (?, ?, ?, ?, ?)
  `),
  getLastActivity: db.prepare(`
    SELECT recorded_at, void_delta, valid_delta
    FROM label_activity_events
    WHERE device_id = ?
    ORDER BY recorded_at DESC, id DESC
    LIMIT 1
  `),
  getVoidsInWindow: db.prepare(`
    SELECT COALESCE(SUM(void_delta), 0) AS voids
    FROM label_activity_events
    WHERE device_id = ? AND recorded_at >= ?
  `),
  getLastVoidAt:  db.prepare('SELECT MAX(recorded_at) AS t FROM label_activity_events WHERE device_id = ? AND void_delta > 0'),
  getLastValidAt: db.prepare('SELECT MAX(recorded_at) AS t FROM label_activity_events WHERE device_id = ? AND valid_delta > 0'),
  getLastCalibrationAt: db.prepare('SELECT MAX(triggered_at) AS t FROM calibration_events WHERE device_id = ?'),
  pruneActivity:  db.prepare('DELETE FROM label_activity_events WHERE recorded_at < ?'),
```

- [ ] **Step 4: Prune old events at startup**

Immediately after the `stmt` object definition, add:

```js
// Keep 30 days of label activity history
stmt.pruneActivity.run(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
```

- [ ] **Step 5: Rename and extend `checkCalibrations` into `recordCounterSample`**

Replace the entire `checkCalibrations` function (lines ~117-133) with:

```js
// Process one counter sample per device: detect void-counter resets (each
// reset = one completed RFID calibration) and record label activity deltas
// for print-activity detection. Must run exactly once per SOTI fetch.
function recordCounterSample(devices) {
  const now = new Date().toISOString();
  for (const device of devices) {
    if (device.voidCount === null) continue;

    const prev = stmt.getVoidState.get(device.id);
    const current = device.voidCount;

    if (prev && prev.last_void_count > 0 && current === 0) {
      stmt.insertCalibration.run(device.id, device.name, now, prev.last_void_count);
      console.log(`[calibration] ${device.name}: void count reset ${prev.last_void_count} → 0`);
    }

    if (prev) {
      // Negative deltas are counter resets (calibration), not print activity.
      const voidDelta = Math.max(0, current - prev.last_void_count);
      const validDelta = device.validCount !== null && prev.last_valid_count !== null
        ? Math.max(0, device.validCount - prev.last_valid_count)
        : 0;
      if (voidDelta > 0 || validDelta > 0) {
        stmt.insertActivity.run(device.id, device.name, now, voidDelta, validDelta);
      }
    }

    stmt.upsertVoidState.run(device.id, device.name, current, device.validCount, now);
  }
}
```

Note: the old call site `checkCalibrations(sorted)` inside `app.get('/api/devices')` will fail after this rename — that handler is rewritten in Task 3. To keep the tree runnable at this commit, update the call at ~line 872 to `recordCounterSample(sorted);`.

- [ ] **Step 6: Syntax-check and run existing tests**

Run: `node --check server.js && npm test`
Expected: no syntax errors; Task 1's 12 tests still PASS.

- [ ] **Step 7: Commit**

```bash
git add server.js
git commit -m "feat: record label activity events from RFID counter deltas"
```

---

### Task 3: Background poller, cache, and /api/devices rework

**Files:**
- Modify: `server.js` — add a poller/cache section after `fetchDevices()` (~line 258), rewrite `app.get('/api/devices')` (~line 865-894), add `require` at top.

**Interfaces:**
- Consumes: `computePrintActivity` + `DEFAULT_WINDOW_MS` from `./lib/print-activity` (Task 1); `recordCounterSample` and the `stmt.*` activity statements (Task 2); existing `fetchDevices`, `processDevice`, `sortDevices`, `stmt.getCalibrationCount`.
- Produces: `/api/devices` response where each device has `printActivity: { state, voidsInWindow, lastVoidAt, lastValidAt } | null` (null when `voidCount` is null). Response shape otherwise unchanged (`summary`, `devices`, `lastUpdated`). Task 4 renders `printActivity`.

- [ ] **Step 1: Import the verdict function**

At the top of `server.js`, after the existing `require` lines (~line 10), add:

```js
const { computePrintActivity, DEFAULT_WINDOW_MS } = require('./lib/print-activity');
```

- [ ] **Step 2: Add the verdict lookup helper**

After `recordCounterSample` (Task 2's function), add:

```js
// Compute the Print Activity verdict for one device from stored events.
function getPrintActivity(deviceId, hasCounters) {
  if (!hasCounters) return null;
  const nowMs = Date.now();
  const windowStart = new Date(nowMs - DEFAULT_WINDOW_MS).toISOString();
  return computePrintActivity({
    lastEvent:         stmt.getLastActivity.get(deviceId) || null,
    voidsInWindow:     stmt.getVoidsInWindow.get(deviceId, windowStart).voids,
    lastVoidAt:        stmt.getLastVoidAt.get(deviceId).t,
    lastValidAt:       stmt.getLastValidAt.get(deviceId).t,
    lastCalibrationAt: stmt.getLastCalibrationAt.get(deviceId).t,
    now: nowMs,
  });
}
```

- [ ] **Step 3: Add the poller and cache**

After `fetchDevices()` (~line 258), add a new section:

```js
// ─── SOTI Connect poller & cache ──────────────────────────────────────────────
// The server samples SOTI Connect on its own timer so void detection keeps
// working when nobody has the dashboard open. /api/devices serves this cache.

const CONNECT_POLL_MS      = 60 * 1000;
const CONNECT_CACHE_MAX_MS = 10 * 1000;

let connectCache    = { payload: null, fetchedAt: 0 };
let connectInFlight = null;

function refreshConnectDevices() {
  if (connectInFlight) return connectInFlight;
  connectInFlight = (async () => {
    const rawDevices = await fetchDevices();
    const processed  = rawDevices.map(processDevice);
    const sorted     = sortDevices(processed);

    recordCounterSample(sorted);

    const enriched = sorted.map((d) => ({
      ...d,
      calibrationCount: d.voidCount !== null
        ? stmt.getCalibrationCount.get(d.id).count
        : null,
      printActivity: getPrintActivity(d.id, d.voidCount !== null),
    }));

    const online  = enriched.filter((d) => d.connectionStatus === 1).length;
    const offline = enriched.filter((d) => d.connectionStatus !== 1).length;
    const alerts  = enriched.filter((d) => d.hasAlert).length;

    connectCache = {
      payload: {
        summary: { total: enriched.length, online, offline, alerts },
        devices: enriched,
        lastUpdated: new Date().toISOString(),
      },
      fetchedAt: Date.now(),
    };
    return connectCache.payload;
  })().finally(() => { connectInFlight = null; });
  return connectInFlight;
}

setInterval(() => {
  refreshConnectDevices().catch((err) => console.error('[connect-poll]', err.message));
}, CONNECT_POLL_MS);
refreshConnectDevices().catch((err) => console.error('[connect-poll] initial fetch:', err.message));
```

- [ ] **Step 4: Rewrite the /api/devices handler**

Replace the body of `app.get('/api/devices', ...)` (which still contains the inline fetch/process/enrich logic and the `recordCounterSample(sorted)` call from Task 2) with:

```js
app.get('/api/devices', async (req, res) => {
  try {
    if (Date.now() - connectCache.fetchedAt > CONNECT_CACHE_MAX_MS) {
      try {
        await refreshConnectDevices();
      } catch (err) {
        // SOTI unreachable: serve the previous snapshot if we have one.
        if (!connectCache.payload) throw err;
        console.error('[/api/devices] refresh failed, serving cached data:', err.message);
      }
    }
    res.json(connectCache.payload);
  } catch (err) {
    console.error('[/api/devices]', err.message);
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 5: Syntax-check and run tests**

Run: `node --check server.js && npm test`
Expected: no syntax errors; 12 tests PASS.

- [ ] **Step 6: Smoke-test against live SOTI Connect**

Run: `npm start` in one terminal; in another:
`curl -s http://localhost:3000/api/devices | node -e "const d=JSON.parse(require('fs').readFileSync(0));console.log(d.devices.length, JSON.stringify(d.devices[0].printActivity))"`
Expected: a device count and a `printActivity` object (state likely `"idle"` on first run, or `null` for printers without RFID odometers). Server log shows `[auth] Token acquired`. Stop the server after.

- [ ] **Step 7: Commit**

```bash
git add server.js
git commit -m "feat: background SOTI poller with cached /api/devices and print-activity verdicts"
```

---

### Task 4: Frontend Activity column

**Files:**
- Modify: `public/index.html` — printer table header (~line 143-160)
- Modify: `public/app.js` — `sortConnectDevices` (~line 246-260), `buildConnectRow` (~line 298-323), new cell builder near `buildRfidCell` (~line 339)
- Modify: `public/style.css` — after the `.cell-rfid` rules (~line 559-563)

**Interfaces:**
- Consumes: `d.printActivity` (`{ state, voidsInWindow, lastVoidAt, lastValidAt } | null`) from Task 3; existing helpers `relativeTime`, `esc`, `.badge` base CSS class, `.cell-na` style.
- Produces: user-visible sortable "Activity" column. No new JS exports.

- [ ] **Step 1: Add the table header and fix the placeholder colspan**

In `public/index.html`, after the `<th class="col-rfid">RFID</th>` line (~153), add:

```html
              <th class="col-activity" data-sort="printActivity">Activity <span class="sort-icon">↕</span></th>
```

And change the loading placeholder row from `<td colspan="12">` to `<td colspan="13">` (~line 159).

- [ ] **Step 2: Add the cell builder and rank helper in app.js**

After `buildRfidCell` (~line 348), add:

```js
  const ACTIVITY_RANK = { voiding: 0, idle_voiding: 1, ok: 2, idle: 3 };

  function activityRank(pa) {
    if (!pa || !pa.state) return 4;
    return ACTIVITY_RANK[pa.state] ?? 4;
  }

  function buildActivityCell(d) {
    const pa = d.printActivity;
    if (!pa || !pa.state) return '<span class="cell-na">—</span>';
    const lastVoid  = pa.lastVoidAt  ? relativeTime(new Date(pa.lastVoidAt))  : 'never';
    const lastValid = pa.lastValidAt ? relativeTime(new Date(pa.lastValidAt)) : 'never';
    const tip = `Last void: ${lastVoid} · Last valid label: ${lastValid}`;
    switch (pa.state) {
      case 'voiding':
        return `<span class="badge badge--voiding" title="${tip}">VOIDING · ${pa.voidsInWindow} in 15m</span>`;
      case 'ok':
        return `<span class="badge badge--print-ok" title="${tip}">OK · printing</span>`;
      case 'idle_voiding':
        return `<span class="activity-idle" title="Stopped while voiding — no valid labels since. ${tip}">Idle <span class="activity-idle-v">(V)</span></span>`;
      default:
        return `<span class="activity-idle" title="${tip}">Idle</span>`;
    }
  }
```

- [ ] **Step 3: Render the cell in buildConnectRow**

In `buildConnectRow`, after the `cell-rfid` line and before the `cell-actions` line, add:

```js
      `<td class="cell-activity">${buildActivityCell(d)}</td>`,
```

- [ ] **Step 4: Make the column sortable**

In `sortConnectDevices`, immediately after `let va = a[connect.sort.key]; let vb = b[connect.sort.key];`, add:

```js
      if (connect.sort.key === 'printActivity') { va = activityRank(a.printActivity); vb = activityRank(b.printActivity); }
```

(Problem states sort first ascending: VOIDING, Idle (V), OK, Idle, —.)

- [ ] **Step 5: Add the styles**

In `public/style.css`, after the `.rfid-cal-count` rule (~line 563), add:

```css
.cell-activity { white-space: nowrap; font-size: 0.8rem; }
.badge--voiding  { background: var(--color-offline-bg); color: var(--color-offline); }
.badge--print-ok { background: var(--color-online-bg);  color: var(--color-online); }
.activity-idle   { color: var(--color-text-muted); }
.activity-idle-v { color: var(--color-offline); font-weight: 700; }
```

- [ ] **Step 6: Verify in the browser**

Run: `npm start`, open `http://localhost:3000`, SOTI Connect tab.
Expected: new "Activity" column between RFID and the actions column; printers show `Idle`, `OK · printing`, or `—`; clicking the header sorts; no console errors. (A live `VOIDING` state needs a printer actually voiding — see Task 5.)

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/app.js public/style.css
git commit -m "feat: add Print Activity column to SOTI Connect table"
```

---

### Task 5: README update and end-to-end verification

**Files:**
- Modify: `README.md` — SOTI Connect tab description (~line 8), API endpoints table (~line 85)

**Interfaces:**
- Consumes: everything above. Produces: docs only.

- [ ] **Step 1: Update README**

Replace the SOTI Connect tab paragraph (~line 8) with:

```markdown
Displays all printers managed by SOTI Connect with status, battery, firmware, group, alerts, RFID void/calibration counts, and a live **Activity** verdict (VOIDING / OK / Idle / Idle (V)) derived from RFID odometer deltas. The server polls SOTI Connect every 60 s in the background, so void detection keeps running with no browser open. A printer shows **VOIDING** when its most recent label activity is void-only within the last 15 minutes; valid labels printing clears it immediately. **Idle (V)** flags a printer whose last activity before going quiet was voids — likely abandoned in a non-working state — until valid labels print or a calibration reset occurs. Supports search, filter by status/group, sortable columns, and per-device actions (Check In / Test Print).
```

In the API endpoints table, update the `/api/devices` row description to:

```markdown
| GET | `/api/devices` | SOTI Connect printers (served from 60 s background poll cache, incl. `printActivity`) |
```

- [ ] **Step 2: Full verification pass**

Run: `npm test && node --check server.js`
Expected: 12 tests PASS, no syntax errors.

Then `npm start` and verify end-to-end (requires a live printer):
1. Print a valid RFID label on one printer → within ~60 s its Activity cell shows `OK · printing`.
2. If feasible, force a void (e.g., unencodable tag) with no valid labels after → cell shows `VOIDING · N in 15m`; after 15 quiet minutes it becomes `Idle (V)`; a calibration or a good label clears it.
3. Restart the server mid-test → no errors, history and verdicts survive (SQLite-backed).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document Print Activity column and background poller"
```
