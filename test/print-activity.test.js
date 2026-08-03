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
