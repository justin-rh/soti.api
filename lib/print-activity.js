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
