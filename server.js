require('dotenv').config();
const express  = require('express');
const path     = require('path');
const Database = require('better-sqlite3');
const { exec } = require('child_process');
const net      = require('net');
const https    = require('https');
const http     = require('http');
const crypto   = require('crypto');
const fs       = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const BASE_URL = process.env.SOTI_BASE_URL;
const CLIENT_ID = process.env.SOTI_CLIENT_ID;
const CLIENT_SECRET = process.env.SOTI_CLIENT_SECRET;
const USERNAME = process.env.SOTI_USERNAME;
const PASSWORD = process.env.SOTI_PASSWORD;

// ─── SQLite setup ─────────────────────────────────────────────────────────────

const db = new Database(path.join(__dirname, 'history.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS calibration_events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id        INTEGER NOT NULL,
    device_name      TEXT    NOT NULL,
    triggered_at     TEXT    NOT NULL,
    void_count_before INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS device_void_state (
    device_id        INTEGER PRIMARY KEY,
    device_name      TEXT    NOT NULL,
    last_void_count  INTEGER NOT NULL,
    updated_at       TEXT    NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reader_host_state (
    addr     TEXT PRIMARY KEY,
    label    TEXT    NOT NULL DEFAULT '',
    status   TEXT    NOT NULL DEFAULT 'idle',
    ever_up  INTEGER NOT NULL DEFAULT 0,
    history  TEXT    NOT NULL DEFAULT '[]',
    latency  INTEGER,
    checked  TEXT
  );
  CREATE TABLE IF NOT EXISTS reader_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cal_device ON calibration_events(device_id);
  CREATE INDEX IF NOT EXISTS idx_cal_time   ON calibration_events(triggered_at);
`);

// Migrate reader_host_state to add cached reader-API columns (firmware survives offline checks)
{
  const existingCols = db.prepare("PRAGMA table_info(reader_host_state)").all().map((c) => c.name);
  const addCol = (name, def) => {
    if (!existingCols.includes(name)) db.exec(`ALTER TABLE reader_host_state ADD COLUMN ${name} ${def}`);
  };
  addCol('firmware',        'TEXT');
  addCol('serial',          'TEXT');
  addCol('model',           'TEXT');
  addCol('antennas_total',  'INTEGER');
  addCol('antennas_active', 'INTEGER');
  addCol('temperature',     'REAL');
  addCol('api_seen_at',     'TEXT');
}

const stmt = {
  getVoidState:       db.prepare('SELECT * FROM device_void_state WHERE device_id = ?'),
  upsertVoidState:    db.prepare(`
    INSERT INTO device_void_state (device_id, device_name, last_void_count, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      device_name      = excluded.device_name,
      last_void_count  = excluded.last_void_count,
      updated_at       = excluded.updated_at
  `),
  insertCalibration:  db.prepare(`
    INSERT INTO calibration_events (device_id, device_name, triggered_at, void_count_before)
    VALUES (?, ?, ?, ?)
  `),
  getCalibrationCount: db.prepare('SELECT COUNT(*) as count FROM calibration_events WHERE device_id = ?'),
  getDeviceHistory:   db.prepare('SELECT * FROM calibration_events WHERE device_id = ? ORDER BY triggered_at DESC LIMIT 100'),
  getAllCalibrations:  db.prepare('SELECT * FROM calibration_events ORDER BY triggered_at DESC LIMIT 200'),
  loadReaderState:    db.prepare('SELECT * FROM reader_host_state'),
  upsertReaderState:  db.prepare(`
    INSERT INTO reader_host_state (
      addr, label, status, ever_up, history, latency, checked,
      firmware, serial, model, antennas_total, antennas_active, temperature, api_seen_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(addr) DO UPDATE SET
      label           = excluded.label,
      status          = excluded.status,
      ever_up         = excluded.ever_up,
      history         = excluded.history,
      latency         = excluded.latency,
      checked         = excluded.checked,
      firmware        = excluded.firmware,
      serial          = excluded.serial,
      model           = excluded.model,
      antennas_total  = excluded.antennas_total,
      antennas_active = excluded.antennas_active,
      temperature     = excluded.temperature,
      api_seen_at     = excluded.api_seen_at
  `),
  getSetting:    db.prepare('SELECT value FROM reader_settings WHERE key = ?'),
  upsertSetting: db.prepare(`
    INSERT INTO reader_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
};

// Detect void counter resets — each reset = one completed RFID calibration
function checkCalibrations(devices) {
  const now = new Date().toISOString();
  for (const device of devices) {
    if (device.voidCount === null) continue;

    const prev = stmt.getVoidState.get(device.id);
    const current = device.voidCount;

    if (prev && prev.last_void_count > 0 && current === 0) {
      stmt.insertCalibration.run(device.id, device.name, now, prev.last_void_count);
      console.log(`[calibration] ${device.name}: void count reset ${prev.last_void_count} → 0`);
    }

    stmt.upsertVoidState.run(device.id, device.name, current, now);
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

let tokenCache = { accessToken: null, expiresAt: null };

async function fetchToken() {
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    username: USERNAME,
    password: PASSWORD,
  });

  const res = await fetch(`${BASE_URL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token fetch failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  tokenCache.accessToken = data.access_token;
  tokenCache.expiresAt = Date.now() + (data.expires_in - 60) * 1000;
  console.log(`[auth] Token acquired, expires in ${data.expires_in}s`);
  return tokenCache.accessToken;
}

async function getToken() {
  if (tokenCache.accessToken && tokenCache.expiresAt && Date.now() < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }
  return await fetchToken();
}

// ─── Device processing ────────────────────────────────────────────────────────

function getProp(properties, id) {
  if (!Array.isArray(properties)) return null;
  const prop = properties.find((p) => p.id === id);
  return prop ? prop.value : null;
}

function resolveAlert(properties) {
  const type      = getProp(properties, 'Zebra-Alert#Type');
  const alertId   = getProp(properties, 'Zebra-Alert#Id');
  const timestamp = getProp(properties, 'Zebra-Alert#Timestamp');

  if (!type) return null;

  const isRealAlert =
    type === 'WARNING' ||
    (type === 'ALERT' &&
      alertId &&
      !alertId.endsWith('_CLEAR') &&
      alertId !== 'PQ JOB COMPLETED_SET');

  if (!isRealAlert) return null;
  return { type, id: alertId, timestamp };
}

function extractGroupLabel(deviceGroupPaths) {
  if (!Array.isArray(deviceGroupPaths) || deviceGroupPaths.length === 0) return 'Unknown';
  const p = deviceGroupPaths[0];
  const parts = p.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : p;
}

function processDevice(raw) {
  const props   = raw.properties || [];
  const alert   = resolveAlert(props);
  const battery = getProp(props, 'Zebra-Battery#power-percent_full');

  const voidRaw  = getProp(props, 'Zebra-Odometer-RFID#odometer-rfid-void_resettable');
  const validRaw = getProp(props, 'Zebra-Odometer-RFID#odometer-rfid-valid_resettable');

  return {
    id:               raw.id,
    name:             raw.name || '',
    model:            getProp(props, 'base-module#model-id') || raw.deviceTypeName || '',
    group:            extractGroupLabel(raw.deviceGroupPaths),
    groupPath:        (raw.deviceGroupPaths && raw.deviceGroupPaths[0]) || '',
    ip:               raw.activeIpAddress || '',
    status:           raw.connectionStatus === 1 ? 'Online' : 'Offline',
    connectionStatus: raw.connectionStatus,
    lastSeen:         raw.lastSeenTime || null,
    firmware:         getProp(props, 'base-module#version') || '',
    battery:          battery !== null ? battery : null,
    hasAlert:         alert !== null,
    alert:            alert,
    serial:           getProp(props, 'GenericDeviceState#serial-number') || '',
    description:      raw.description || '',
    voidCount:        voidRaw  !== null ? parseInt(voidRaw,  10) : null,
    validCount:       validRaw !== null ? parseInt(validRaw, 10) : null,
  };
}

function sortDevices(devices) {
  return [...devices].sort((a, b) => {
    if (a.connectionStatus !== b.connectionStatus) return a.connectionStatus - b.connectionStatus;
    return a.name.localeCompare(b.name);
  });
}

async function fetchDevices() {
  const token = await getToken();

  const res = await fetch(`${BASE_URL}/api/devices`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Devices fetch failed (${res.status}): ${text}`);
  }

  const raw = await res.json();
  return Array.isArray(raw) ? raw : [];
}

// ─── MobiControl ──────────────────────────────────────────────────────────────

const MC_BASE_URL      = process.env.MC_BASE_URL;
const MC_CLIENT_ID     = process.env.MC_CLIENT_ID;
const MC_CLIENT_SECRET = process.env.MC_CLIENT_SECRET;
const MC_USERNAME      = process.env.MC_USERNAME;
const MC_PASSWORD      = process.env.MC_PASSWORD;

let mcTokenCache = { accessToken: null, expiresAt: null };

async function fetchMcToken() {
  const body = new URLSearchParams({
    grant_type:    'password',
    client_id:     MC_CLIENT_ID,
    client_secret: MC_CLIENT_SECRET,
    username:      MC_USERNAME,
    password:      MC_PASSWORD,
  });
  const res = await fetch(`${MC_BASE_URL}/MobiControl/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MC token fetch failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  mcTokenCache.accessToken = data.access_token;
  mcTokenCache.expiresAt = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
  console.log(`[mc-auth] Token acquired, expires in ${data.expires_in}s`);
  return mcTokenCache.accessToken;
}

async function getMcToken() {
  if (mcTokenCache.accessToken && mcTokenCache.expiresAt && Date.now() < mcTokenCache.expiresAt) {
    return mcTokenCache.accessToken;
  }
  return fetchMcToken();
}

function coerce(obj, ...keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return null;
}

function processMcDevice(raw) {
  const id          = raw.DeviceId || '';
  const name        = raw.DeviceName || raw.PersonalizedName || '';
  const platform    = raw.Family || raw.Platform || '';
  const osVersion   = raw.OSVersion || '';
  // OEMVersion carries the actual device firmware/build string (e.g. Zebra "14-32-12.00-UG-U06-STD-HEL-04");
  // OSVersion is just the Android major version and isn't specific enough to track firmware updates.
  const firmware    = raw.OEMVersion || '';
  const serial      = raw.HardwareSerialNumber || raw.MobileSerialNumber || '';
  const ip          = raw.VpnIp || raw.HostName || '';
  const groupPath   = raw.Path || '';
  const lastCheckIn = raw.LastCheckInTime || null;
  const enrolled    = raw.EnrollmentTime || null;
  const agentVer    = raw.AgentVersion || '';
  const battery     = raw.BatteryStatus ?? null;
  const isOnline    = raw.IsAgentOnline === true;

  // Model: prefer "Manufacturer Model", fall back to either alone
  const model = [raw.Manufacturer, raw.Model].filter(Boolean).join(' ') || '';

  // User: LastLoggedOnUser may be a string, object, or null
  let userName = '';
  if (typeof raw.LastLoggedOnUser === 'string') {
    userName = raw.LastLoggedOnUser;
  } else if (raw.LastLoggedOnUser && typeof raw.LastLoggedOnUser === 'object') {
    userName = raw.LastLoggedOnUser.UserName || raw.LastLoggedOnUser.Email || '';
  }

  // Compliance
  let complianceStr = 'Unknown';
  if (raw.CompliancePolicyStatus) {
    // API returns "Compliant", "NonCompliant", "PendingEvaluation", etc.
    complianceStr = raw.CompliancePolicyStatus === 'NonCompliant' ? 'Non-Compliant' : raw.CompliancePolicyStatus;
  } else if (typeof raw.ComplianceStatus === 'boolean') {
    complianceStr = raw.ComplianceStatus ? 'Compliant' : 'Non-Compliant';
  }

  const groupParts = groupPath ? groupPath.split(/[/\\]/).filter(Boolean) : [];
  const group      = groupParts.length > 0 ? groupParts[groupParts.length - 1] : 'Unknown';

  return {
    id,
    name,
    platform,
    model,
    osVersion,
    firmware,
    serial,
    ip,
    group,
    groupPath,
    lastCheckIn,
    enrolled,
    agentVersion: agentVer,
    userName,
    battery: battery !== null ? Number(battery) : null,
    compliance: complianceStr,
    isOnline,
    status: isOnline ? 'Online' : 'Offline',
  };
}

async function fetchAllMcDevices() {
  const token = await getMcToken();
  const all = [];
  const take = 500;
  let skip = 0;

  while (true) {
    const res = await fetch(
      `${MC_BASE_URL}/MobiControl/api/devices?skip=${skip}&take=${take}`,
      { headers: { Authorization: `Bearer ${token}`, 'Accept-Language': 'en-US' } }
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MC devices fetch failed (${res.status}): ${text}`);
    }
    const raw  = await res.json();
    const page = Array.isArray(raw) ? raw : (raw.items || raw.devices || raw.data || []);
    all.push(...page);
    if (page.length < take) break;
    skip += take;
  }
  return all;
}

// ─── Ping Dashboard ───────────────────────────────────────────────────────────

let xlsx; // lazy-loaded after npm install

const PING_CHECK_PORTS   = [443, 5084];
const READER_ENDPOINTS   = ['/cloud/version', '/cloud/status', '/api/v1/config/readerConfig', '/api/v1/readerInfo', '/api/v1/status'];

const DEFAULT_PING_HOSTS = [
  { addr: '10.180.1.251', label: 'Inventory Joey #1 (Now 54)' },
  { addr: '10.180.1.252', label: 'Inventory Joey #2 (Now 52)' },
  { addr: '10.180.1.253', label: 'Inventory Joey #3' },
  { addr: '10.180.2.2',   label: 'OF Joey #11' },
  { addr: '10.180.2.1',   label: 'OF Joey #12' },
  { addr: '10.180.2.3',   label: 'OF Joey #14' },
  { addr: '10.180.2.5',   label: 'OF Joey #16' },
  { addr: '10.180.0.200', label: 'OF Joey #17' },
  { addr: '10.180.2.28',  label: 'OF Joey #18' },
  { addr: '10.180.2.7',   label: 'OF Joey #19' },
  { addr: '10.180.2.9',   label: 'OF Joey #20' },
  { addr: '10.180.2.10',  label: 'OF Joey #21' },
  { addr: '10.180.0.174', label: 'OF Joey #22' },
  { addr: '10.180.2.11',  label: 'OF Joey #23' },
  { addr: '10.180.2.12',  label: 'OF Joey #24' },
  { addr: '10.180.2.13',  label: 'OF Joey #25' },
  { addr: '10.180.2.14',  label: 'OF Joey #26' },
  { addr: '10.180.2.15',  label: 'OF Joey #27' },
  { addr: '10.180.0.238', label: 'OF Joey #28' },
  { addr: '10.180.2.17',  label: 'OF Joey #29' },
  { addr: '10.180.2.18',  label: 'OF Joey #30' },
  { addr: '10.180.2.19',  label: 'OF Joey #31' },
  { addr: '10.180.2.20',  label: 'OF Joey #32' },
  { addr: '10.180.2.21',  label: 'OF Joey #33' },
  { addr: '10.180.2.22',  label: 'OF Joey #34' },
  { addr: '10.180.1.254', label: 'OF Joey #35' },
  { addr: '10.180.2.24',  label: 'OF Joey #38' },
  { addr: '10.180.2.25',  label: 'OF Joey #39' },
  { addr: '10.180.2.26',  label: 'OF Joey #40' },
  { addr: '10.180.2.27',  label: 'Facilities RFID Reader' },
  { addr: '10.180.1.225', label: 'Unmounted RFID Reader' },
];

const pingState = {
  hosts:          DEFAULT_PING_HOSTS.map((h, i) => newPingHost(i + 1, h.addr, h.label)),
  nextId:         DEFAULT_PING_HOSTS.length + 1,
  autoInterval:   5,
  autoEnabled:    true,
  excelPath:      null,
  nextRunAt:      null,
  running:        false,
  autoTimer:      null,
  apiCredentials: { username: 'admin', password: 'change01' },
};

// Restore persisted credentials and reader state from DB
(function restoreReaderSettings() {
  const u = stmt.getSetting.get('api_username');
  const p = stmt.getSetting.get('api_password');
  if (u) pingState.apiCredentials.username = u.value;
  if (p) pingState.apiCredentials.password = p.value;
})();

(function restoreReaderState() {
  const savedRows = stmt.loadReaderState.all();
  const savedMap  = Object.fromEntries(savedRows.map(r => [r.addr, r]));
  for (const h of pingState.hosts) {
    const saved = savedMap[h.addr];
    if (!saved) continue;
    h.status  = saved.status === 'pending' ? 'idle' : saved.status;
    h.ever_up = !!saved.ever_up;
    h.history = JSON.parse(saved.history || '[]');
    h.latency = saved.latency != null ? saved.latency : null;
    h.checked = saved.checked || null;
    h.api     = cachedApiFromRow(saved);
  }
})();

// Rebuild an `api` object from a persisted DB row — used on startup so firmware/serial/etc.
// from the last successful reader-API check survive a server restart.
function cachedApiFromRow(saved) {
  const hasCached = !!(saved.firmware || saved.model || saved.serial || saved.antennas_total != null);
  if (!hasCached) return {};
  return {
    reachable:       false,
    auth_error:      false,
    firmware:        saved.firmware || null,
    serial:          saved.serial || null,
    model:           saved.model || null,
    antennas_total:  saved.antennas_total != null ? saved.antennas_total : null,
    antennas_active: saved.antennas_active != null ? saved.antennas_active : null,
    temperature:     saved.temperature != null ? saved.temperature : null,
    stale:           true,
    lastSeenAt:      saved.api_seen_at || null,
  };
}

// Merge a fresh reader-API result with the previously cached one — keep last-known
// firmware/serial/model/antennas/temperature across offline checks instead of
// blanking them out, but always reflect the current reachable/auth_error state.
function mergeApiResult(prevApi, freshApi) {
  const merged = { ...freshApi };
  const cachedFields = ['firmware', 'serial', 'model', 'antennas_total', 'antennas_active', 'temperature'];
  for (const f of cachedFields) {
    if (merged[f] == null && prevApi && prevApi[f] != null) merged[f] = prevApi[f];
  }
  const hasCached = cachedFields.some((f) => merged[f] != null);
  merged.stale      = !freshApi.reachable && hasCached;
  merged.lastSeenAt = freshApi.reachable ? new Date().toISOString() : ((prevApi && prevApi.lastSeenAt) || null);
  return merged;
}

function pingHost(addr) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const cmd   = isWin ? `ping -n 1 -w 3000 ${addr}` : `ping -c 1 -W 3 ${addr}`;
    exec(cmd, { timeout: 6000 }, (err, stdout = '') => {
      if (!stdout && err) return resolve({ up: false, latency: null });
      if (isWin) {
        if (!stdout.toUpperCase().includes('TTL=')) return resolve({ up: false, latency: null });
        const m = stdout.match(/time[=<](\d+)\s*ms/i);
        resolve({ up: true, latency: m ? parseInt(m[1]) : null });
      } else {
        if (err) return resolve({ up: false, latency: null });
        const m = stdout.match(/time[=<]([\d.]+)\s*ms/i);
        resolve({ up: true, latency: m ? Math.round(parseFloat(m[1])) : null });
      }
    });
  });
}

function checkTcpPort(addr, port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(3000);
    sock.connect(port, addr, () => { sock.destroy(); resolve(true); });
    sock.on('error',   () => { sock.destroy(); resolve(false); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

async function checkAllPorts(addr) {
  const results = await Promise.all(PING_CHECK_PORTS.map(p => checkTcpPort(addr, p)));
  return Object.fromEntries(PING_CHECK_PORTS.map((p, i) => [String(p), results[i]]));
}

function md5hex(str) { return crypto.createHash('md5').update(str).digest('hex'); }

function buildDigestAuth(method, uri, username, password, wwwAuth) {
  const realm     = wwwAuth.match(/realm="([^"]+)"/)?.[1]    || '';
  const nonce     = wwwAuth.match(/nonce="([^"]+)"/)?.[1]    || '';
  const qop       = wwwAuth.match(/qop="?([^",\s]+)/)?.[1]   || '';
  const opaque    = wwwAuth.match(/opaque="([^"]+)"/)?.[1]   || '';
  const algorithm = wwwAuth.match(/algorithm=([^\s,]+)/i)?.[1] || 'MD5';
  const nc        = '00000001';
  const cnonce    = crypto.randomBytes(8).toString('hex');
  let ha1 = md5hex(`${username}:${realm}:${password}`);
  if (algorithm.toUpperCase() === 'MD5-SESS')
    ha1 = md5hex(`${ha1}:${nonce}:${cnonce}`);
  const ha2  = md5hex(`${method}:${uri}`);
  const resp = qop === 'auth' || qop === 'auth-int'
    ? md5hex(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5hex(`${ha1}:${nonce}:${ha2}`);
  let h = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${resp}"`;
  if (qop)    h += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (opaque) h += `, opaque="${opaque}"`;
  return h;
}

function rawHttpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { rejectUnauthorized: false, headers, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function rawHttpPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const mod    = url.startsWith('https') ? https : http;
    const u      = new URL(url);
    const opts   = {
      hostname: u.hostname, port: u.port || (url.startsWith('https') ? 443 : 80),
      path: u.pathname + u.search, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      rejectUnauthorized: false,
    };
    const req = mod.request(opts, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// Login candidates for Zebra RFID readers (FXR90 / CloudConnect)
const LOGIN_CANDIDATES = [
  // Zebra CloudConnect — GET with HTTP Basic auth header (confirmed working on FXR90)
  { path: '/cloud/localRestLogin', method: 'get',
    authFn: (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') },
  // Zebra CloudConnect — form-encoded (most common)
  { path: '/cloud/localRestLogin', method: 'post', ct: 'application/x-www-form-urlencoded',
    bodyFn: (u, p) => `username=${encodeURIComponent(u)}&password=${encodeURIComponent(p)}` },
  // Zebra CloudConnect — JSON variant
  { path: '/cloud/localRestLogin', method: 'post', ct: 'application/json',
    bodyFn: (u, p) => JSON.stringify({ username: u, password: p }) },
  // Zebra CloudConnect — Basic auth header on the POST, empty body
  { path: '/cloud/localRestLogin', method: 'post', ct: 'application/json', bodyFn: () => '',
    authFn: (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') },
  // Standard REST login paths — JSON
  { path: '/api/v1/auth/login',  method: 'post', ct: 'application/json', bodyFn: (u, p) => JSON.stringify({ username: u, password: p }) },
  { path: '/api/v1/login',       method: 'post', ct: 'application/json', bodyFn: (u, p) => JSON.stringify({ username: u, password: p }) },
  { path: '/api/v1/user/login',  method: 'post', ct: 'application/json', bodyFn: (u, p) => JSON.stringify({ username: u, password: p }) },
];

async function tryTokenLogin(scheme, addr, username, password) {
  for (const c of LOGIN_CANDIDATES) {
    const url  = `${scheme}://${addr}${c.path}`;
    const hdrs = { Accept: 'application/json' };
    if (c.ct)     hdrs['Content-Type']  = c.ct;
    if (c.authFn) hdrs['Authorization'] = c.authFn(username, password);
    try {
      const r = c.method === 'get'
        ? await rawHttpGet(url, hdrs)
        : await rawHttpPost(url, c.bodyFn(username, password), hdrs);
      if (r.status === 200) {
        try {
          const data = JSON.parse(r.body);
          // Zebra CloudConnect returns { code: 0, message: "<jwt>" } on success
          const token = data.token || data.access_token || data.authToken || data.sessionToken || data.bearerToken
            || (data.code === 0 && typeof data.message === 'string' ? data.message : null);
          if (token) return { type: 'bearer', value: `Bearer ${token}` };
        } catch (_) {}
        const setCookie = r.headers['set-cookie'];
        if (setCookie) {
          const cookieVal = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0].trim();
          if (cookieVal) return { type: 'cookie', value: cookieVal };
        }
      }
    } catch (_) {}
  }
  return null;
}

function parseZebraBody(data, out) {
  const cfg  = data.readerConfig || data;
  const info = cfg.readerInfo || cfg.reader || data.readerInfo || {};

  // Merge across endpoints — only overwrite a field when this body actually has it,
  // since /cloud/status and /cloud/version each carry a different subset.
  const firmware = info.firmwareVersion || info.firmware || cfg.firmwareVersion || data.firmwareVersion
    || data.readerApplication || null;
  if (firmware) out.firmware = firmware;

  const serial = info.serialNumber || info.serial || cfg.serialNumber || data.serialNumber || null;
  if (serial) out.serial = serial;

  const model = info.model || info.name || cfg.model || data.model || null;
  if (model) out.model = model;

  const temp = cfg.temperature ?? info.temperature ?? data.temperature;
  if (temp != null) {
    const t = parseFloat(temp);
    if (!Number.isNaN(t)) out.temperature = t;
  }

  // Zebra CloudConnect /cloud/status returns antennas as an object keyed by antenna
  // number (e.g. { "1": "connected", "2": "disconnected" }), not an array.
  const antsRaw = cfg.antennas || cfg.antennaConfigurations || data.antennas;
  if (Array.isArray(antsRaw) && antsRaw.length) {
    out.antennas_total  = antsRaw.length;
    out.antennas_active = antsRaw.filter(a => a.status === 'connected' || a.isEnabled === true || a.enabled === true).length || null;
  } else if (antsRaw && typeof antsRaw === 'object') {
    const values = Object.values(antsRaw);
    if (values.length) {
      out.antennas_total  = values.length;
      out.antennas_active = values.filter(v => v === 'connected').length || null;
    }
  }
}

async function fetchReaderApi(addr) {
  const { username, password } = pingState.apiCredentials;
  const out = {
    reachable: false, auth_error: false,
    firmware: null, serial: null, model: null,
    antennas_total: null, antennas_active: null, temperature: null,
  };
  for (const scheme of ['https', 'http']) {
    // Try token/session login first
    const session = await tryTokenLogin(scheme, addr, username, password);
    let gotData = false;

    // Query every known endpoint and merge — different endpoints carry different
    // fields (e.g. /cloud/version has firmware, /cloud/status has antennas/temp).
    for (const endpoint of READER_ENDPOINTS) {
      const url = `${scheme}://${addr}${endpoint}`;
      // Build request headers based on auth method available
      const headers = { Accept: 'application/json' };
      if (session && session.type === 'bearer') headers['Authorization'] = session.value;
      else if (session && session.type === 'cookie') headers['Cookie'] = session.value;
      else headers['Authorization'] = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

      try {
        let res = await rawHttpGet(url, headers);

        // If token auth failed, fall back to HTTP Basic / Digest
        if (res.status === 401 && session) {
          headers['Authorization'] = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
          delete headers['Cookie'];
          res = await rawHttpGet(url, headers);
        }

        if (res.status === 401) {
          const wwwAuth = res.headers['www-authenticate'] || '';
          if (wwwAuth.toLowerCase().includes('digest')) {
            const dig = buildDigestAuth('GET', endpoint, username, password, wwwAuth);
            res = await rawHttpGet(url, { Authorization: dig, Accept: 'application/json' });
          }
          if (res.status === 401) { out.reachable = true; if (!gotData) out.auth_error = true; continue; }
        }

        if (res.status === 200) {
          out.reachable  = true;
          out.auth_error = false;
          gotData = true;
          try { parseZebraBody(JSON.parse(res.body), out); } catch(_) {}
        }
      } catch(_) { break; }
    }

    if (out.reachable) return out;
  }
  return out;
}

function newPingHost(id, addr, label = '') {
  return {
    id, addr, label,
    status: 'idle', latency: null, checked: null,
    history: [], ever_up: false,
    ports: Object.fromEntries(PING_CHECK_PORTS.map(p => [String(p), null])),
    api: {},
  };
}

async function checkSingleHost(hid) {
  const h = pingState.hosts.find(x => x.id === hid);
  if (!h) return;
  h.status = 'pending';
  const [{ up, latency }, ports] = await Promise.all([pingHost(h.addr), checkAllPorts(h.addr)]);
  const freshApi = ports['443'] ? await fetchReaderApi(h.addr) : { reachable: false };
  const target = pingState.hosts.find(x => x.id === hid);
  if (!target) return;
  target.status  = up ? 'up' : 'down';
  target.latency = latency;
  target.checked = new Date().toLocaleTimeString('en-US', { hour12: false });
  target.history = [...target.history, up ? 'up' : 'down'].slice(-10);
  if (up) target.ever_up = true;
  target.ports   = ports;
  target.api     = mergeApiResult(target.api, freshApi);
  stmt.upsertReaderState.run(
    target.addr, target.label || '', target.status,
    target.ever_up ? 1 : 0, JSON.stringify(target.history),
    target.latency, target.checked,
    target.api.firmware || null, target.api.serial || null, target.api.model || null,
    target.api.antennas_total != null ? target.api.antennas_total : null,
    target.api.antennas_active != null ? target.api.antennas_active : null,
    target.api.temperature != null ? target.api.temperature : null,
    target.api.lastSeenAt || null
  );
}

async function runAllPingHosts() {
  if (pingState.running) return;
  pingState.running = true;
  try {
    await Promise.all(pingState.hosts.map(h => checkSingleHost(h.id)));
    if (pingState.excelPath) await savePingExcel().catch(e => console.error('[ping excel save]', e.message));
  } finally {
    pingState.running = false;
    schedulePingRun();
  }
}

function schedulePingRun() {
  if (pingState.autoTimer) clearTimeout(pingState.autoTimer);
  if (!pingState.autoEnabled) { pingState.nextRunAt = null; return; }
  const ms = pingState.autoInterval * 60 * 1000;
  pingState.nextRunAt = Date.now() + ms;
  pingState.autoTimer = setTimeout(() => runAllPingHosts(), ms);
}

function getXlsx() {
  if (!xlsx) xlsx = require('xlsx');
  return xlsx;
}

function loadPingExcel(filePath) {
  const X   = getXlsx();
  const wb  = X.readFile(filePath);
  const ws  = wb.Sheets[wb.SheetNames[0]];
  const rows = X.utils.sheet_to_json(ws, { header: 1 });
  if (!rows.length) return 0;
  const header = rows[0].map(v => String(v || '').trim().toLowerCase());
  let ipCol = header.findIndex(h => ['ip','address','host','ip address','hostname'].includes(h));
  if (ipCol < 0) ipCol = 0;
  const nameCol = header.findIndex(h => h === 'name');
  let added = 0;
  for (let i = 1; i < rows.length; i++) {
    const addr = String(rows[i][ipCol] || '').trim();
    if (!addr) continue;
    if (pingState.hosts.some(h => h.addr === addr)) continue;
    const label = nameCol >= 0 ? String(rows[i][nameCol] || '').trim() : '';
    pingState.hosts.push(newPingHost(pingState.nextId++, addr, label));
    added++;
  }
  pingState.excelPath = filePath;
  return added;
}

async function savePingExcel() {
  if (!pingState.excelPath || !fs.existsSync(pingState.excelPath)) return;
  const X    = getXlsx();
  const wb   = X.readFile(pingState.excelPath);
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = X.utils.sheet_to_json(ws, { header: 1 });
  if (!rows.length) return;
  const header = rows[0].map(v => String(v || '').trim().toLowerCase());
  let ipCol = header.findIndex(h => ['ip','address','host','ip address','hostname'].includes(h));
  if (ipCol < 0) ipCol = 0;
  let sCol = header.findIndex(h => ['status','ping status'].includes(h));
  let lCol = header.findIndex(h => ['latency','latency (ms)','ms'].includes(h));
  let cCol = header.findIndex(h => ['last checked','checked','timestamp'].includes(h));
  if (sCol < 0) { sCol = rows[0].length; rows[0].push('Status'); }
  if (lCol < 0) { lCol = rows[0].length; rows[0].push('Latency (ms)'); }
  if (cCol < 0) { cCol = rows[0].length; rows[0].push('Last Checked'); }
  const hostMap = Object.fromEntries(pingState.hosts.map(h => [h.addr, h]));
  for (let i = 1; i < rows.length; i++) {
    const addr = String(rows[i][ipCol] || '').trim();
    const h = hostMap[addr];
    if (h) {
      rows[i][sCol] = h.status;
      rows[i][lCol] = h.latency;
      rows[i][cCol] = h.checked || '';
    }
  }
  const newWs = X.utils.aoa_to_sheet(rows);
  wb.Sheets[wb.SheetNames[0]] = newWs;
  X.writeFile(wb, pingState.excelPath);
}

// ─── Express ──────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  res.json({
    simplePrintUrl:    process.env.SIMPLE_PRINT_URL    || '',
    pingDashboardUrl:  process.env.PING_DASHBOARD_URL  || 'http://localhost:5000',
  });
});

app.get('/api/devices', async (req, res) => {
  try {
    const rawDevices = await fetchDevices();
    const processed  = rawDevices.map(processDevice);
    const sorted     = sortDevices(processed);

    // Detect calibrations before enriching with counts
    checkCalibrations(sorted);

    const enriched = sorted.map((d) => ({
      ...d,
      calibrationCount: d.voidCount !== null
        ? stmt.getCalibrationCount.get(d.id).count
        : null,
    }));

    const online  = enriched.filter((d) => d.connectionStatus === 1).length;
    const offline = enriched.filter((d) => d.connectionStatus !== 1).length;
    const alerts  = enriched.filter((d) => d.hasAlert).length;

    res.json({
      summary: { total: enriched.length, online, offline, alerts },
      devices: enriched,
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[/api/devices]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/history/:deviceId', (req, res) => {
  const deviceId = parseInt(req.params.deviceId, 10);
  if (isNaN(deviceId)) return res.status(400).json({ error: 'invalid deviceId' });
  res.json(stmt.getDeviceHistory.all(deviceId));
});

app.get('/api/calibrations', (req, res) => {
  res.json(stmt.getAllCalibrations.all());
});

app.post('/api/devices/:id/action', async (req, res) => {
  const deviceId = parseInt(req.params.id, 10);
  const { actionId, inputs } = req.body;

  if (!actionId) return res.status(400).json({ error: 'actionId required' });

  try {
    const token = await getToken();
    const response = await fetch(`${BASE_URL}/api/devices/actions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceIds: [deviceId],
        inputAction: { Id: actionId, Inputs: inputs || {} },
      }),
    });

    const text = await response.text();
    if (!response.ok) return res.status(response.status).json({ error: text });
    res.json({ ok: true, result: text ? JSON.parse(text) : null });
  } catch (err) {
    console.error('[/api/devices/:id/action]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/mc/devices', async (req, res) => {
  if (!MC_BASE_URL || !MC_CLIENT_ID || !MC_CLIENT_SECRET || !MC_USERNAME || !MC_PASSWORD) {
    return res.status(503).json({ error: 'MobiControl credentials not fully configured in .env (need MC_CLIENT_ID, MC_CLIENT_SECRET, MC_USERNAME, MC_PASSWORD)' });
  }
  try {
    const raw     = await fetchAllMcDevices();
    const devices = raw.map(processMcDevice);
    devices.sort((a, b) => {
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const online       = devices.filter((d) => d.isOnline).length;
    const offline      = devices.filter((d) => !d.isOnline).length;
    const nonCompliant = devices.filter((d) => d.compliance && d.compliance.toLowerCase().includes('non')).length;
    res.json({
      summary: { total: devices.length, online, offline, nonCompliant },
      devices,
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[/api/mc/devices]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Ping Routes ──────────────────────────────────────────────────────────────

app.get('/api/ping/hosts', (req, res) => {
  const secsLeft = pingState.nextRunAt
    ? Math.max(0, Math.floor((pingState.nextRunAt - Date.now()) / 1000))
    : null;
  res.json({
    hosts:         pingState.hosts,
    auto_enabled:  pingState.autoEnabled,
    auto_interval: pingState.autoInterval,
    excel_path:    pingState.excelPath,
    next_run_in:   secsLeft,
  });
});

app.post('/api/ping/run', (req, res) => {
  runAllPingHosts();
  res.json({ ok: true });
});

app.post('/api/ping/run/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!pingState.hosts.find(h => h.id === id)) return res.status(404).json({ error: 'not found' });
  checkSingleHost(id);
  res.json({ ok: true });
});

app.post('/api/ping/hosts/add', (req, res) => {
  const addr = (req.body.addr || '').trim();
  if (!addr) return res.status(400).json({ error: 'empty' });
  if (pingState.hosts.some(h => h.addr === addr)) return res.status(409).json({ error: 'duplicate' });
  pingState.hosts.push(newPingHost(pingState.nextId++, addr));
  res.json({ ok: true });
});

app.delete('/api/ping/hosts/:id', (req, res) => {
  const id = parseInt(req.params.id);
  pingState.hosts = pingState.hosts.filter(h => h.id !== id);
  res.json({ ok: true });
});

app.post('/api/ping/excel/load', (req, res) => {
  const filePath = (req.body.path || '').trim();
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: `File not found: ${filePath}` });
  try {
    const added = loadPingExcel(filePath);
    res.json({ ok: true, added });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ping/excel/save', async (req, res) => {
  try {
    await savePingExcel();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ping/settings', (req, res) => {
  const { auto_enabled, auto_interval, api_username, api_password } = req.body;
  if (auto_enabled  !== undefined) pingState.autoEnabled  = Boolean(auto_enabled);
  if (auto_interval !== undefined) pingState.autoInterval = parseInt(auto_interval) || 5;
  if (api_username  !== undefined) {
    pingState.apiCredentials.username = api_username;
    stmt.upsertSetting.run('api_username', api_username);
  }
  if (api_password  !== undefined) {
    pingState.apiCredentials.password = api_password;
    stmt.upsertSetting.run('api_password', api_password);
  }
  schedulePingRun();
  res.json({ ok: true });
});

app.get('/api/ping/probe-debug/:addr', async (req, res) => {
  const username = req.query.username || pingState.apiCredentials.username;
  const password = req.query.password || pingState.apiCredentials.password;
  const addr     = req.params.addr;
  const passwordHint = password.length > 2 ? password[0] + '*'.repeat(password.length - 2) + password.slice(-1) : '**';
  const output  = { addr, username, passwordHint, discovery: [], loginAttempts: [], probeResults: [] };

  // Discovery: GET various paths with no auth to see what's exposed
  const discoverPaths = ['/', '/cloud/', '/api/', '/api/v1/', '/cloud/localRestLogin',
    '/api/v1/readerInfo', '/api/v1/status', '/api/v1/mgmt/readerInfo', '/api/v1/mgmt/status',
    '/api/v1/reader/info', '/api/v1/reader/status', '/data/readerinfo.json'];
  for (const p of discoverPaths) {
    const url = `https://${addr}${p}`;
    try {
      const r = await rawHttpGet(url, { Accept: 'application/json, text/html' });
      output.discovery.push({ path: p, status: r.status, contentType: r.headers['content-type'] || null, bodySnippet: r.body.slice(0, 150) });
    } catch (e) { output.discovery.push({ path: p, error: e.message }); }
  }

  for (const scheme of ['https', 'http']) {
    const loginResults = [];
    const basicHdr = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    // All body/header variants + query-param variant
    const attempts = [
      { label: 'POST form-encoded',   method: 'post', url: `${scheme}://${addr}/cloud/localRestLogin`, body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`, ct: 'application/x-www-form-urlencoded' },
      { label: 'POST JSON',           method: 'post', url: `${scheme}://${addr}/cloud/localRestLogin`, body: JSON.stringify({ username, password }), ct: 'application/json' },
      { label: 'POST Basic header',   method: 'post', url: `${scheme}://${addr}/cloud/localRestLogin`, body: '', ct: 'application/json', auth: basicHdr },
      { label: 'POST query params',   method: 'post', url: `${scheme}://${addr}/cloud/localRestLogin?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`, body: '', ct: 'application/json' },
      { label: 'GET query params',    method: 'get',  url: `${scheme}://${addr}/cloud/localRestLogin?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}` },
      { label: 'GET Basic header',    method: 'get',  url: `${scheme}://${addr}/cloud/localRestLogin`, auth: basicHdr },
    ];
    for (const a of attempts) {
      try {
        let r;
        const hdrs = { Accept: 'application/json' };
        if (a.auth) hdrs['Authorization'] = a.auth;
        if (a.method === 'post') { hdrs['Content-Type'] = a.ct; r = await rawHttpPost(a.url, a.body, hdrs); }
        else                     { r = await rawHttpGet(a.url, hdrs); }
        loginResults.push({ label: a.label, status: r.status, bodySnippet: r.body.slice(0, 200), setCookie: r.headers['set-cookie'] || null });
      } catch (e) { loginResults.push({ label: a.label, error: e.message }); }
    }
    output.loginAttempts.push({ scheme, results: loginResults });
    if (scheme === 'http') break; // HTTP always fails (port 80 closed), skip for brevity
  }

  res.json(output);
});

app.get('/api/ping/export/csv', (req, res) => {
  const lines = ['Host,Name,Status,Latency (ms),Last Checked,Port 443,Port 5084,Firmware,Serial,Model,Antennas,Temp (C),History'];
  for (const h of pingState.hosts) {
    const p  = h.ports || {};
    const a  = h.api   || {};
    const ps = port => p[String(port)] === true ? 'open' : p[String(port)] === false ? 'closed' : '';
    const ants = a.antennas_total != null
      ? (a.antennas_active != null ? `${a.antennas_active}/${a.antennas_total}` : String(a.antennas_total))
      : '';
    lines.push([
      h.addr, h.label || '', h.status,
      h.latency != null ? h.latency : '', h.checked || '',
      ps(443), ps(5084),
      a.firmware || '', a.serial || '', a.model || '',
      ants, a.temperature != null ? a.temperature : '',
      h.history.join(' '),
    ].join(','));
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=ping_results.csv');
  res.send(lines.join('\n'));
});

// ─── Portals ────────────────────────────────────────────────────────────────

function newPortal(id, url, label, location) {
  return { id, url, label, location: location || '', status: 'idle', httpCode: null, latency: null, checked: null, history: [], ever_up: false };
}

const DEFAULT_PORTALS = [
  { url: 'https://10.180.2.81/', label: 'Portal #1',  location: '' },
  { url: 'https://10.180.2.82/', label: 'Portal #2',  location: '' },
  { url: 'https://10.180.2.83/', label: 'Portal #3',  location: '' },
  { url: 'https://10.180.2.84/', label: 'Portal #4',  location: '' },
  { url: 'https://10.180.2.85/', label: 'Portal #5',  location: '' },
  { url: 'https://10.180.0.150', label: 'Portal #6',  location: 'Autostore - West' },
  { url: 'https://10.180.2.50',  label: 'Portal #7',  location: 'Autostore - East' },
  { url: 'https://10.180.1.218', label: 'Portal #8',  location: 'K1 - North' },
  { url: 'https://10.180.2.89',  label: 'Portal #9',  location: 'K1 - South' },
  { url: 'https://10.180.2.64',  label: 'Portal #10', location: 'WH4' },
];

const portalState = {
  portals:      DEFAULT_PORTALS.map((p, i) => newPortal(i + 1, p.url, p.label, p.location)),
  autoInterval: 5,
  autoEnabled:  true,
  nextRunAt:    null,
  running:      false,
  autoTimer:    null,
};

function checkSinglePortal(pid) {
  const p = portalState.portals.find(x => x.id === pid);
  if (!p) return Promise.resolve();
  p.status = 'pending';
  const start = Date.now();
  return new Promise((resolve) => {
    const mod = p.url.startsWith('https') ? https : http;
    const req = mod.get(p.url, { rejectUnauthorized: false }, (res) => {
      res.resume();
      p.httpCode = res.statusCode;
      p.latency  = Date.now() - start;
      p.status   = res.statusCode < 500 ? 'up' : 'down';
      p.ever_up  = p.ever_up || p.status === 'up';
      p.checked  = new Date().toLocaleTimeString();
      p.history  = [...(p.history || []).slice(-9), p.status === 'up' ? 'up' : 'dn'];
      resolve();
    });
    req.on('error', () => {
      p.status   = 'down';
      p.httpCode = null;
      p.latency  = null;
      p.checked  = new Date().toLocaleTimeString();
      p.history  = [...(p.history || []).slice(-9), 'dn'];
      resolve();
    });
    req.setTimeout(8000, () => req.destroy());
  });
}

async function runAllPortals() {
  if (portalState.running) return;
  portalState.running = true;
  try {
    await Promise.all(portalState.portals.map(p => checkSinglePortal(p.id)));
  } finally {
    portalState.running = false;
    schedulePortalRun();
  }
}

function schedulePortalRun() {
  if (portalState.autoTimer) clearTimeout(portalState.autoTimer);
  if (!portalState.autoEnabled) { portalState.nextRunAt = null; return; }
  const ms = portalState.autoInterval * 60 * 1000;
  portalState.nextRunAt = Date.now() + ms;
  portalState.autoTimer = setTimeout(() => runAllPortals(), ms);
}

app.get('/api/portals', (req, res) => {
  const nextRunIn = portalState.nextRunAt
    ? Math.max(0, Math.round((portalState.nextRunAt - Date.now()) / 1000)) : null;
  res.json({
    portals:       portalState.portals,
    auto_enabled:  portalState.autoEnabled,
    auto_interval: portalState.autoInterval,
    next_run_in:   nextRunIn,
  });
});

app.post('/api/portals/run', (req, res) => {
  res.json({ ok: true });
  runAllPortals();
});

app.post('/api/portals/run/:id', (req, res) => {
  const pid = parseInt(req.params.id);
  res.json({ ok: true });
  checkSinglePortal(pid);
});

app.post('/api/portals/settings', (req, res) => {
  const { auto_enabled, auto_interval } = req.body;
  if (typeof auto_enabled  === 'boolean') portalState.autoEnabled  = auto_enabled;
  if (typeof auto_interval === 'number')  portalState.autoInterval = auto_interval;
  schedulePortalRun();
  res.json({ ok: true });
});

// Start auto-schedulers
schedulePingRun();
schedulePortalRun();

app.listen(PORT, () => {
  console.log(`SOTI Dashboard running at http://localhost:${PORT}`);
});
