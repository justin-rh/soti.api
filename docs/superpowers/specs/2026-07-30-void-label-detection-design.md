# VOID Label Detection Column — Design

**Date:** 2026-07-30
**Status:** Approved
**Scope:** SOTI Connect tab of the RFID dashboard (`server.js`, `public/app.js`, `public/index.html`, `public/style.css`)

## Goal

Add a sortable **Print Activity** column to the SOTI Connect printer table that shows whether a printer is *currently* printing VOID labels, derived by comparing the RFID valid/void odometer counters over time.

## Background

The server already extracts two resettable RFID odometer counters per printer from SOTI Connect device properties:

- `Zebra-Odometer-RFID#odometer-rfid-void_resettable` → `voidCount`
- `Zebra-Odometer-RFID#odometer-rfid-valid_resettable` → `validCount`

It also already persists the last-seen void count per device in SQLite (`device_void_state`) to detect calibration resets (`calibration_events`). Today, sampling only happens when a browser has the dashboard open (the page polls `/api/devices` every 60 s).

## Detection Rule

For each printer, evaluated against a **15-minute window**:

| Verdict | Condition |
|---|---|
| **VOIDING · N in 15m** (red) | The most recent label activity is void-only (no valid labels printed at or after the last void increase), and at least one void increase occurred within the last 15 minutes. N = sum of void deltas in the window. |
| **OK · printing** (green) | Valid labels have printed at or after the last void increase, and there is label activity within the last 15 minutes. **Valid labels take precedence** — any valid-label printing since the last void clears the VOIDING state immediately. |
| **Idle** (gray) | No counter increase (valid or void) within the last 15 minutes. |
| **—** | Counters unavailable (printer doesn't report RFID odometers, or no samples yet). |

A single poll delta where **both** valid and void increased counts as valid-precedence (the printer is producing good labels; the void is shown in the N tally but the state is OK).

## Architecture

### 1. Server-side background poller (`server.js`)

- A `setInterval` (60 s) fetches devices from SOTI Connect, then:
  1. Runs the existing `checkCalibrations` reset detection.
  2. Records label activity events (see below).
  3. Caches the processed device list + verdicts in memory with a timestamp.
- `GET /api/devices` serves the cache. If the cache is older than **10 s** (e.g., manual Refresh right after an interval), it triggers a fresh fetch first, so Refresh still feels live. Concurrent requests share one in-flight fetch (no duplicate SOTI calls).
- `checkCalibrations` and event recording move out of the request handler into the poller so each sample is processed exactly once.
- Poll failures (SOTI down, token error) are logged and the previous cache is served with its original `lastUpdated`; detection simply has a gap.

### 2. Storage — activity event log (SQLite, `history.db`)

New table, mirroring the existing `calibration_events` pattern:

```sql
CREATE TABLE IF NOT EXISTS label_activity_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   INTEGER NOT NULL,
  device_name TEXT    NOT NULL,
  recorded_at TEXT    NOT NULL,   -- ISO 8601
  void_delta  INTEGER NOT NULL DEFAULT 0,
  valid_delta INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_activity_device_time
  ON label_activity_events(device_id, recorded_at);
```

- `device_void_state` gains a `last_valid_count` column (nullable `ALTER TABLE` migration, same pattern as the `reader_host_state` migration) so valid-counter deltas survive restarts.
- A row is written **only when a counter increased** since the last sample — idle printers write nothing, so the table stays small.
- **Negative deltas are skipped** (counter reset = calibration, already handled by `checkCalibrations`; a valid-counter reset likewise records no event).
- Events older than **30 days** are pruned at startup.

### 3. API shape

Each device in the `/api/devices` response gains:

```json
"printActivity": {
  "state": "voiding" | "ok" | "idle" | null,
  "voidsInWindow": 4,
  "lastVoidAt": "2026-07-30T18:04:11Z",
  "lastValidAt": "2026-07-30T17:52:03Z"
}
```

`state` is computed server-side so the frontend stays a pure renderer. `null` = counters unavailable.

### 4. Frontend (`public/app.js`, `index.html`, `style.css`)

- New **Print Activity** column header (sortable, `data-sort` like existing columns). Sort order groups VOIDING first, then OK, Idle, —.
- Cell rendering:
  - `VOIDING · 4 in 15m` — red badge (style consistent with existing `rfid-void-high`).
  - `OK · printing` — green badge.
  - `Idle` — gray text.
  - `—` — existing `cell-na` style.
- Tooltip on the cell shows last void time and last valid-label time.

## Error Handling

- SOTI fetch failure in the poller: log, keep serving last cache, no events recorded (gap, not false data).
- Device with null counters: verdict `null`, rendered as `—`.
- Server restart: last counter values persist in `device_void_state`; the first post-restart delta is computed against persisted values, so activity across a restart is still captured (as one event).
- Clock: all timestamps are server-side ISO strings; window math is server-side only.

## Testing

- Unit-testable pure function `computePrintActivity(events, now, windowMs)` covering: void-only recent → voiding; valid after void → ok; both in same delta → ok; nothing recent → idle; null counters → null; reset (negative delta) skipped.
- Manual verification: run a test print / deliberately void a label on a live printer and watch the column change within one poll.

## Out of Scope (YAGNI)

- Alerting/notifications when a printer starts voiding.
- Historical charts of void rate.
- Configurable window length in the UI (constant in server.js, easy to change later).
