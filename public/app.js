/* =========================================================
   RFID Dashboard — Connect + MobiControl
   ========================================================= */

(function () {
  'use strict';

  const REFRESH_INTERVAL = 60;

  // ─── Shared state ────────────────────────────────────────────────────────────

  let activeTab = 'connect';

  // Header DOM refs (shared)
  let elLastUpdated, elCountdown, elRefreshBtn, elRefreshIndicator, elHeaderSubtitle;

  const TAB_SUBTITLES = {
    connect:      'Printer Monitoring Dashboard',
    mobicontrol:  'MDM Device Dashboard',
    ping:         'RFID Reader Status',
    portals:      'Portal Availability Monitor',
  };

  // ─── Tab switching ───────────────────────────────────────────────────────────

  function switchTab(name) {
    activeTab = name;

    document.querySelectorAll('.tab-btn').forEach((btn) => {
      const isActive = btn.dataset.tab === name;
      btn.classList.toggle('tab-btn--active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    document.querySelectorAll('.tab-content').forEach((div) => {
      div.classList.toggle('tab-content--active', div.id === 'tab-' + name);
    });

    if (elHeaderSubtitle) elHeaderSubtitle.textContent = TAB_SUBTITLES[name] || '';

    // Sync header meta to active tab state
    if (name === 'ping') {
      const secsLeft = pingTab.nextRunMs > 0
        ? Math.max(0, Math.floor((pingTab.nextRunMs - Date.now()) / 1000)) : null;
      elCountdown.textContent   = pingTab.autoEnabled && secsLeft != null ? fmtPingCd(secsLeft) : '—';
      elLastUpdated.textContent = pingTab.lastRunText || '—';
    } else if (name === 'portals') {
      const secsLeft = portalsTab.nextRunMs > 0
        ? Math.max(0, Math.floor((portalsTab.nextRunMs - Date.now()) / 1000)) : null;
      elCountdown.textContent   = portalsTab.autoEnabled && secsLeft != null ? fmtPingCd(secsLeft) : '—';
      elLastUpdated.textContent = portalsTab.lastRunText || '—';
    } else {
      const st = name === 'connect' ? connect : mc;
      elCountdown.textContent   = st.countdownValue + 's';
      elLastUpdated.textContent = st.lastUpdatedText || '—';
    }
  }

  // ─── Shared utilities ────────────────────────────────────────────────────────

  function esc(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function relativeTime(date) {
    if (!(date instanceof Date) || isNaN(date)) return '<span class="cell-na">—</span>';
    const diff = Math.floor((Date.now() - date.getTime()) / 1000);
    if (diff < 0)         return 'just now';
    if (diff < 60)        return diff + 's ago';
    if (diff < 3600)      return Math.floor(diff / 60) + ' min ago';
    if (diff < 86400)     return Math.floor(diff / 3600) + ' hr' + (Math.floor(diff / 3600) !== 1 ? 's' : '') + ' ago';
    if (diff < 86400 * 7) return Math.floor(diff / 86400) + ' day' + (Math.floor(diff / 86400) !== 1 ? 's' : '') + ' ago';
    return date.toLocaleDateString();
  }

  function buildStatusBadge(isOnline) {
    if (isOnline) return '<span class="badge badge--online"><span class="badge-dot"></span>Online</span>';
    return '<span class="badge badge--offline"><span class="badge-dot"></span>Offline</span>';
  }

  function buildBatteryCell(battery) {
    if (battery === null || battery === undefined) return '<span class="battery-na">—</span>';
    const pct = parseFloat(battery);
    let cls = 'battery-high';
    if (pct < 20) cls = 'battery-low';
    else if (pct < 50) cls = 'battery-mid';
    return `<span class="${cls}">${Math.round(pct)}%</span>`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //   SOTI CONNECT TAB
  // ═══════════════════════════════════════════════════════════════════════════

  const connect = {
    devices:        [],
    countdownValue: REFRESH_INTERVAL,
    countdownTimer: null,
    lastUpdatedText: '',
    sort:           { key: null, dir: 'asc' },
    simplePrintUrl: '',
    el:             {},
  };

  function initConnect() {
    const e = connect.el;
    e.errorBanner     = document.getElementById('error-banner');
    e.errorMessage    = document.getElementById('error-message');
    e.statTotal       = document.getElementById('stat-total');
    e.statOnline      = document.getElementById('stat-online');
    e.statOffline     = document.getElementById('stat-offline');
    e.statAlerts      = document.getElementById('stat-alerts');
    e.filterSearch    = document.getElementById('filter-search');
    e.filterStatus    = document.getElementById('filter-status');
    e.filterGroup     = document.getElementById('filter-group');
    e.btnClear        = document.getElementById('clear-filters');
    e.tableBody       = document.getElementById('table-body');
    e.noResults       = document.getElementById('no-results');
    e.rowCount        = document.getElementById('row-count');
    e.tableHeaders    = document.querySelectorAll('#printer-table th[data-sort]');

    e.filterSearch.addEventListener('input', renderConnectTable);
    e.filterStatus.addEventListener('change', renderConnectTable);
    e.filterGroup.addEventListener('change', renderConnectTable);
    e.btnClear.addEventListener('click', () => {
      e.filterSearch.value = '';
      e.filterStatus.value = '';
      e.filterGroup.value  = '';
      renderConnectTable();
    });
    e.tableBody.addEventListener('click', handleConnectActionClick);

    e.tableHeaders.forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (connect.sort.key === key) {
          connect.sort.dir = connect.sort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          connect.sort.key = key;
          connect.sort.dir = 'asc';
        }
        updateConnectSortHeaders();
        renderConnectTable();
      });
    });

    startConnectCountdown();
    refreshConnect();
  }

  function startConnectCountdown() {
    if (connect.countdownTimer) clearInterval(connect.countdownTimer);
    connect.countdownTimer = setInterval(() => {
      connect.countdownValue = Math.max(0, connect.countdownValue - 1);
      if (activeTab === 'connect') elCountdown.textContent = connect.countdownValue + 's';
      if (connect.countdownValue <= 0) refreshConnect();
    }, 1000);
  }

  async function refreshConnect() {
    connect.countdownValue = REFRESH_INTERVAL;
    if (activeTab === 'connect') {
      elCountdown.textContent = connect.countdownValue + 's';
      setRefreshing(true);
    }

    try {
      // Load config once
      if (!connect.simplePrintUrl) {
        try {
          const cfgRes = await fetch('/api/config');
          if (cfgRes.ok) {
            const cfg = await cfgRes.json();
            connect.simplePrintUrl = cfg.simplePrintUrl || '';
          }
        } catch (_) {}
      }

      const res = await fetch('/api/devices');
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();

      connect.devices = data.devices || [];
      connect.lastUpdatedText = data.lastUpdated ? new Date(data.lastUpdated).toLocaleTimeString() : '';

      if (activeTab === 'connect') {
        elLastUpdated.textContent = connect.lastUpdatedText;
        hideError(connect.el.errorBanner);
      }

      updateConnectSummary(data.summary);
      populateSelectFromData(connect.el.filterGroup, connect.devices.map((d) => d.group));
      renderConnectTable();
    } catch (err) {
      showError(connect.el.errorBanner, connect.el.errorMessage, err.message);
      if (connect.devices.length > 0) renderConnectTable();
    } finally {
      if (activeTab === 'connect') setRefreshing(false);
    }
  }

  function updateConnectSummary(s) {
    if (!s) return;
    connect.el.statTotal.textContent   = s.total   ?? '—';
    connect.el.statOnline.textContent  = s.online  ?? '—';
    connect.el.statOffline.textContent = s.offline ?? '—';
    connect.el.statAlerts.textContent  = s.alerts  ?? '—';
  }

  function updateConnectSortHeaders() {
    connect.el.tableHeaders.forEach((th) => {
      th.classList.remove('sort-asc', 'sort-desc');
      const icon = th.querySelector('.sort-icon');
      if (icon) icon.textContent = '↕';
    });
    if (!connect.sort.key) return;
    const active = document.querySelector(`#printer-table th[data-sort="${connect.sort.key}"]`);
    if (!active) return;
    active.classList.add(connect.sort.dir === 'asc' ? 'sort-asc' : 'sort-desc');
    const icon = active.querySelector('.sort-icon');
    if (icon) icon.textContent = connect.sort.dir === 'asc' ? '↑' : '↓';
  }

  function filterConnectDevices(devices) {
    const q      = connect.el.filterSearch.value.trim().toLowerCase();
    const status = connect.el.filterStatus.value;
    const group  = connect.el.filterGroup.value;
    return devices.filter((d) => {
      if (q) {
        if (![d.name, d.model, d.ip, d.serial, d.description].join(' ').toLowerCase().includes(q)) return false;
      }
      if (status === 'alert') { if (!d.hasAlert) return false; }
      else if (status) { if (d.status !== status) return false; }
      if (group && d.group !== group) return false;
      return true;
    });
  }

  function sortConnectDevices(devices) {
    if (!connect.sort.key) return devices;
    return [...devices].sort((a, b) => {
      let va = a[connect.sort.key];
      let vb = b[connect.sort.key];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (connect.sort.key === 'battery') { va = parseFloat(va) || 0; vb = parseFloat(vb) || 0; }
      if (connect.sort.key === 'status')  { va = va === 'Online' ? 0 : 1; vb = vb === 'Online' ? 0 : 1; }
      if (connect.sort.key === 'lastSeen') { va = va ? new Date(va).getTime() : 0; vb = vb ? new Date(vb).getTime() : 0; }
      let cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return connect.sort.dir === 'asc' ? cmp : -cmp;
    });
  }

  function renderConnectTable() {
    const filtered = filterConnectDevices(connect.devices);
    const sorted   = sortConnectDevices(filtered);
    const table    = document.getElementById('printer-table');

    if (sorted.length === 0 && connect.devices.length > 0) {
      connect.el.noResults.classList.remove('hidden');
      table.style.display = 'none';
    } else {
      connect.el.noResults.classList.add('hidden');
      table.style.display = '';
    }

    connect.el.rowCount.textContent = connect.devices.length > 0
      ? `Showing ${sorted.length} of ${connect.devices.length} printers` : '';

    const frag = document.createDocumentFragment();
    sorted.forEach((d) => frag.appendChild(buildConnectRow(d)));
    connect.el.tableBody.innerHTML = '';
    connect.el.tableBody.appendChild(frag);
  }

  function buildConnectRow(d) {
    const tr = document.createElement('tr');
    if (d.connectionStatus !== 1) tr.classList.add('row-offline');
    if (d.hasAlert)                tr.classList.add('row-alert');

    const printHref = connect.simplePrintUrl && d.ip
      ? `${connect.simplePrintUrl}?labelName=${encodeURIComponent(d.name)}&ip=${encodeURIComponent(d.ip)}`
      : null;

    tr.innerHTML = [
      `<td>${printHref ? `<a href="${printHref}" target="_blank" rel="noopener" class="cell-name-link">${esc(d.name)}</a>` : `<span class="cell-name">${esc(d.name)}</span>`}</td>`,
      `<td><span class="cell-model" title="${esc(d.model)}">${esc(d.model) || '<span class="cell-na">—</span>'}</span></td>`,
      `<td class="cell-group">${buildGroupCell(d)}</td>`,
      `<td class="cell-ip">${printHref ? `<a href="${printHref}" target="_blank" rel="noopener" class="cell-ip-link">${esc(d.ip)}</a>` : esc(d.ip) || '<span class="cell-na">—</span>'}</td>`,
      `<td>${buildStatusBadge(d.connectionStatus === 1)}</td>`,
      `<td class="cell-battery">${buildBatteryCell(d.battery)}</td>`,
      `<td class="cell-lastseen">${relativeTime(new Date(d.lastSeen))}</td>`,
      `<td class="cell-firmware">${esc(d.firmware) || '<span class="cell-na">—</span>'}</td>`,
      `<td class="cell-description">${esc(d.description) || '<span class="cell-na">—</span>'}</td>`,
      `<td>${buildAlertCell(d)}</td>`,
      `<td class="cell-rfid">${buildRfidCell(d)}</td>`,
      `<td class="cell-actions">${buildConnectActionButtons(d)}</td>`,
    ].join('');
    return tr;
  }

  function buildGroupCell(d) {
    if (!d.group || d.group === 'Unknown') return '<span class="cell-na">—</span>';
    if (d.groupPath && d.groupPath !== d.group)
      return `<span class="group-tooltip" title="${esc(d.groupPath)}">${esc(d.group)}</span>`;
    return esc(d.group);
  }

  function buildAlertCell(d) {
    if (!d.hasAlert || !d.alert) return '<span class="cell-na">—</span>';
    const cls   = d.alert.type === 'WARNING' ? 'cell-alert-text' : 'cell-alert-text alert-critical';
    const title = d.alert.timestamp ? esc(d.alert.type + ' — ' + d.alert.timestamp) : esc(d.alert.type);
    return `<span class="${cls}" title="${title}">${esc(d.alert.id || d.alert.type)}</span>`;
  }

  function buildRfidCell(d) {
    if (d.voidCount === null || d.voidCount === undefined) return '<span class="cell-na">—</span>';
    let voidCls = 'rfid-void-ok';
    if (d.voidCount >= 5)      voidCls = 'rfid-void-high';
    else if (d.voidCount >= 3) voidCls = 'rfid-void-warn';
    const calPart = d.calibrationCount > 0
      ? ` <span class="rfid-cal-count" title="${d.calibrationCount} calibration${d.calibrationCount !== 1 ? 's' : ''} logged">${d.calibrationCount} cal.</span>`
      : '';
    return `<span class="${voidCls}" title="${d.voidCount} void label${d.voidCount !== 1 ? 's' : ''} since last calibration">${d.voidCount} void</span>${calPart}`;
  }

  function buildConnectActionButtons(d) {
    if (d.connectionStatus !== 1)
      return `<button class="btn-action btn-checkin" data-id="${d.id}" data-action="base-module#checkin" title="Ask printer to re-establish SOTI connection">Check In</button>`;
    return `<button class="btn-action btn-testprint" data-id="${d.id}" data-action="GenericPrinterState#print-test-page" title="Print a test page">Test Print</button>`;
  }

  function handleConnectActionClick(e) {
    const btn = e.target.closest('.btn-action');
    if (!btn) return;
    const { id, action } = btn.dataset;
    if (!id || !action) return;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = '…';
    fetch(`/api/devices/${id}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionId: action }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          btn.textContent = '✓'; btn.classList.add('btn-action--done');
          setTimeout(() => { btn.textContent = original; btn.classList.remove('btn-action--done'); btn.disabled = false; }, 3000);
        } else {
          btn.textContent = '✗'; btn.classList.add('btn-action--err'); btn.title = data.error || 'Failed';
          setTimeout(() => { btn.textContent = original; btn.classList.remove('btn-action--err'); btn.disabled = false; }, 4000);
        }
      })
      .catch(() => { btn.textContent = '✗'; btn.disabled = false; });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //   MOBICONTROL TAB
  // ═══════════════════════════════════════════════════════════════════════════

  const mc = {
    devices:        [],
    countdownValue: REFRESH_INTERVAL,
    countdownTimer: null,
    lastUpdatedText: '',
    sort:           { key: null, dir: 'asc' },
    el:             {},
  };

  function initMobiControl() {
    const e = mc.el;
    e.errorBanner       = document.getElementById('mc-error-banner');
    e.errorMessage      = document.getElementById('mc-error-message');
    e.statTotal         = document.getElementById('stat-mc-total');
    e.statOnline        = document.getElementById('stat-mc-online');
    e.statOffline       = document.getElementById('stat-mc-offline');
    e.statNonCompliant  = document.getElementById('stat-mc-noncompliant');
    e.filterSearch      = document.getElementById('mc-filter-search');
    e.filterPlatform    = document.getElementById('mc-filter-platform');
    e.filterStatus      = document.getElementById('mc-filter-status');
    e.filterCompliance  = document.getElementById('mc-filter-compliance');
    e.filterGroup       = document.getElementById('mc-filter-group');
    e.btnClear          = document.getElementById('mc-clear-filters');
    e.tableBody         = document.getElementById('mc-table-body');
    e.noResults         = document.getElementById('mc-no-results');
    e.rowCount          = document.getElementById('mc-row-count');
    e.tableHeaders      = document.querySelectorAll('#mc-table th[data-sort-mc]');

    e.filterSearch.addEventListener('input', renderMcTable);
    e.filterPlatform.addEventListener('change', renderMcTable);
    e.filterStatus.addEventListener('change', renderMcTable);
    e.filterCompliance.addEventListener('change', renderMcTable);
    e.filterGroup.addEventListener('change', renderMcTable);
    e.btnClear.addEventListener('click', () => {
      e.filterSearch.value     = '';
      e.filterPlatform.value   = '';
      e.filterStatus.value     = '';
      e.filterCompliance.value = '';
      e.filterGroup.value      = '';
      renderMcTable();
    });

    e.tableHeaders.forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.dataset.sortMc;
        if (mc.sort.key === key) {
          mc.sort.dir = mc.sort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          mc.sort.key = key;
          mc.sort.dir = 'asc';
        }
        updateMcSortHeaders();
        renderMcTable();
      });
    });

    startMcCountdown();
    refreshMc();
  }

  function startMcCountdown() {
    if (mc.countdownTimer) clearInterval(mc.countdownTimer);
    mc.countdownTimer = setInterval(() => {
      mc.countdownValue = Math.max(0, mc.countdownValue - 1);
      if (activeTab === 'mobicontrol') elCountdown.textContent = mc.countdownValue + 's';
      if (mc.countdownValue <= 0) refreshMc();
    }, 1000);
  }

  async function refreshMc() {
    mc.countdownValue = REFRESH_INTERVAL;
    if (activeTab === 'mobicontrol') {
      elCountdown.textContent = mc.countdownValue + 's';
      setRefreshing(true);
    }
    try {
      const res = await fetch('/api/mc/devices');
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();

      mc.devices = data.devices || [];
      mc.lastUpdatedText = data.lastUpdated ? new Date(data.lastUpdated).toLocaleTimeString() : '';

      if (activeTab === 'mobicontrol') {
        elLastUpdated.textContent = mc.lastUpdatedText;
        hideError(mc.el.errorBanner);
      }

      updateMcSummary(data.summary);
      populateSelectFromData(mc.el.filterGroup, mc.devices.map((d) => d.group));
      populateSelectFromData(mc.el.filterPlatform, mc.devices.map((d) => d.platform));
      renderMcTable();
    } catch (err) {
      showError(mc.el.errorBanner, mc.el.errorMessage, err.message);
      if (mc.devices.length > 0) renderMcTable();
    } finally {
      if (activeTab === 'mobicontrol') setRefreshing(false);
    }
  }

  function updateMcSummary(s) {
    if (!s) return;
    mc.el.statTotal.textContent        = s.total        ?? '—';
    mc.el.statOnline.textContent       = s.online       ?? '—';
    mc.el.statOffline.textContent      = s.offline      ?? '—';
    mc.el.statNonCompliant.textContent = s.nonCompliant ?? '—';
  }

  function updateMcSortHeaders() {
    mc.el.tableHeaders.forEach((th) => {
      th.classList.remove('sort-asc', 'sort-desc');
      const icon = th.querySelector('.sort-icon');
      if (icon) icon.textContent = '↕';
    });
    if (!mc.sort.key) return;
    const active = document.querySelector(`#mc-table th[data-sort-mc="${mc.sort.key}"]`);
    if (!active) return;
    active.classList.add(mc.sort.dir === 'asc' ? 'sort-asc' : 'sort-desc');
    const icon = active.querySelector('.sort-icon');
    if (icon) icon.textContent = mc.sort.dir === 'asc' ? '↑' : '↓';
  }

  function filterMcDevices(devices) {
    const q          = mc.el.filterSearch.value.trim().toLowerCase();
    const platform   = mc.el.filterPlatform.value;
    const status     = mc.el.filterStatus.value;
    const compliance = mc.el.filterCompliance.value;
    const group      = mc.el.filterGroup.value;

    return devices.filter((d) => {
      if (q && ![d.name, d.model, d.serial, d.userName, d.ip].join(' ').toLowerCase().includes(q)) return false;
      if (platform && d.platform !== platform) return false;
      if (status && d.status !== status) return false;
      if (compliance && d.compliance !== compliance) return false;
      if (group && d.group !== group) return false;
      return true;
    });
  }

  function sortMcDevices(devices) {
    if (!mc.sort.key) return devices;
    return [...devices].sort((a, b) => {
      let va = a[mc.sort.key];
      let vb = b[mc.sort.key];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (mc.sort.key === 'battery')     { va = parseFloat(va) || 0; vb = parseFloat(vb) || 0; }
      if (mc.sort.key === 'status')      { va = va === 'Online' ? 0 : 1; vb = vb === 'Online' ? 0 : 1; }
      if (mc.sort.key === 'lastCheckIn') { va = va ? new Date(va).getTime() : 0; vb = vb ? new Date(vb).getTime() : 0; }
      let cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return mc.sort.dir === 'asc' ? cmp : -cmp;
    });
  }

  function renderMcTable() {
    const filtered = filterMcDevices(mc.devices);
    const sorted   = sortMcDevices(filtered);
    const table    = document.getElementById('mc-table');

    if (sorted.length === 0 && mc.devices.length > 0) {
      mc.el.noResults.classList.remove('hidden');
      table.style.display = 'none';
    } else {
      mc.el.noResults.classList.add('hidden');
      table.style.display = '';
    }

    mc.el.rowCount.textContent = mc.devices.length > 0
      ? `Showing ${sorted.length} of ${mc.devices.length} devices` : '';

    const frag = document.createDocumentFragment();
    sorted.forEach((d) => frag.appendChild(buildMcRow(d)));
    mc.el.tableBody.innerHTML = '';
    mc.el.tableBody.appendChild(frag);
  }

  function buildMcRow(d) {
    const tr = document.createElement('tr');
    if (!d.isOnline) tr.classList.add('row-offline');
    if (d.compliance && d.compliance.toLowerCase().includes('non')) tr.classList.add('row-alert');

    tr.innerHTML = [
      `<td><span class="cell-name">${esc(d.name) || '<span class="cell-na">—</span>'}</span></td>`,
      `<td>${buildPlatformBadge(d.platform)}</td>`,
      `<td><span class="cell-model" title="${esc(d.model)}">${esc(d.model) || '<span class="cell-na">—</span>'}</span></td>`,
      `<td class="cell-group">${d.groupPath && d.groupPath !== d.group
          ? `<span class="group-tooltip" title="${esc(d.groupPath)}">${esc(d.group)}</span>`
          : esc(d.group) || '<span class="cell-na">—</span>'}</td>`,
      `<td>${buildStatusBadge(d.isOnline)}</td>`,
      `<td class="cell-firmware">${esc(d.osVersion) || '<span class="cell-na">—</span>'}</td>`,
      `<td class="cell-lastseen">${d.lastCheckIn ? relativeTime(new Date(d.lastCheckIn)) : '<span class="cell-na">—</span>'}</td>`,
      `<td class="cell-mc-user">${esc(d.userName) || '<span class="cell-na">—</span>'}</td>`,
      `<td>${buildComplianceBadge(d.compliance)}</td>`,
    ].join('');
    return tr;
  }

  const PLATFORM_COLORS = {
    android: { bg: '#dcfce7', color: '#15803d' },
    ios:     { bg: '#dbeafe', color: '#1d4ed8' },
    windows: { bg: '#e0f2fe', color: '#0369a1' },
    macos:   { bg: '#f3e8ff', color: '#7e22ce' },
    linux:   { bg: '#fef9c3', color: '#854d0e' },
  };

  function buildPlatformBadge(platform) {
    if (!platform) return '<span class="cell-na">—</span>';
    const key = platform.toLowerCase().split(/[^a-z]/)[0];
    const style = PLATFORM_COLORS[key];
    if (style)
      return `<span class="badge" style="background:${style.bg};color:${style.color}">${esc(platform)}</span>`;
    return `<span class="badge badge--platform-other">${esc(platform)}</span>`;
  }

  function buildComplianceBadge(compliance) {
    if (!compliance || compliance === 'Unknown')
      return '<span class="badge badge--compliance-unknown">Unknown</span>';
    if (compliance.toLowerCase().includes('non'))
      return `<span class="badge badge--compliance-fail">${esc(compliance)}</span>`;
    return `<span class="badge badge--compliance-ok">${esc(compliance)}</span>`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //   PING MONITOR TAB
  // ═══════════════════════════════════════════════════════════════════════════

  const pingTab = {
    hosts:        [],
    autoEnabled:  true,
    autoInterval: 5,
    excelLoaded:  false,
    lastRunText:  '',
    nextRunMs:    0,       // absolute ms timestamp of next server auto-run
    cdTimer:      null,    // 1s countdown tick
    pollTimer:    null,    // 3s status poll
    el:           {},
  };

  function fmtPingCd(secs) {
    if (secs <= 0) return '—';
    const m = Math.floor(secs / 60), s = secs % 60;
    return m > 0 ? `${m}m ${String(s).padStart(2,'0')}s` : `${s}s`;
  }

  function pingToast(msg, err = false) {
    const el = document.getElementById('ping-toast');
    el.textContent = msg;
    el.className   = 'show' + (err ? ' err' : '');
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.className = ''; }, 3000);
  }

  function initPing() {
    const e = pingTab.el;
    e.sTotal       = document.getElementById('ping-s-total');
    e.sUp          = document.getElementById('ping-s-up');
    e.sDown        = document.getElementById('ping-s-down');
    e.sApi         = document.getElementById('ping-s-api');
    e.sLat         = document.getElementById('ping-s-lat');
    e.excelPath    = document.getElementById('ping-excel-path');
    e.excelBadge   = document.getElementById('ping-excel-badge');
    e.excelSaveBtn = document.getElementById('ping-excel-save-btn');
    e.csvBtn       = document.getElementById('ping-csv-btn');
    e.autoChk      = document.getElementById('ping-auto-chk');
    e.intervalSel  = document.getElementById('ping-interval-sel');
    e.runBtn       = document.getElementById('ping-run-btn');
    e.addInput     = document.getElementById('ping-add-input');
    e.addBtn       = document.getElementById('ping-add-btn');
    e.apiUser      = document.getElementById('ping-api-user');
    e.apiPass      = document.getElementById('ping-api-pass');
    e.authBtn      = document.getElementById('ping-auth-btn');
    e.tbody        = document.getElementById('ping-tbody');
    e.lastRun      = document.getElementById('ping-last-run');
    e.rowCount     = document.getElementById('ping-row-count');

    document.getElementById('ping-excel-load-btn').addEventListener('click', pingLoadExcel);
    e.excelSaveBtn.addEventListener('click', pingSaveExcel);
    e.csvBtn.addEventListener('click', () => { window.location.href = '/api/ping/export/csv'; });
    e.runBtn.addEventListener('click', triggerPingRun);
    e.autoChk.addEventListener('change', pingUpdateSettings);
    e.intervalSel.addEventListener('change', pingUpdateSettings);
    e.addInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') pingAddHost(); });
    e.addBtn.addEventListener('click', pingAddHost);
    e.authBtn.addEventListener('click', pingApplyAuth);

    startPingPoll();
  }

  function startPingPoll() {
    if (pingTab.pollTimer) clearInterval(pingTab.pollTimer);
    pingTab.pollTimer = setInterval(fetchPingHosts, 3000);
    fetchPingHosts();
  }

  function startPingCdTick(nextRunIn) {
    if (pingTab.cdTimer) clearInterval(pingTab.cdTimer);
    if (!nextRunIn || !pingTab.autoEnabled) { pingTab.nextRunMs = 0; return; }
    pingTab.nextRunMs = Date.now() + nextRunIn * 1000;
    pingTab.cdTimer = setInterval(() => {
      if (activeTab !== 'ping') return;
      const secsLeft = Math.max(0, Math.floor((pingTab.nextRunMs - Date.now()) / 1000));
      elCountdown.textContent = pingTab.autoEnabled ? fmtPingCd(secsLeft) : '—';
      if (secsLeft <= 0) clearInterval(pingTab.cdTimer);
    }, 1000);
  }

  async function fetchPingHosts() {
    try {
      const res  = await fetch('/api/ping/hosts');
      const data = await res.json();
      pingTab.hosts        = data.hosts        || [];
      pingTab.autoEnabled  = data.auto_enabled;
      pingTab.autoInterval = data.auto_interval;
      pingTab.excelLoaded  = !!data.excel_path;

      pingTab.el.autoChk.checked        = pingTab.autoEnabled;
      pingTab.el.intervalSel.value      = String(pingTab.autoInterval);
      pingTab.el.excelBadge.classList.toggle('hidden', !pingTab.excelLoaded);
      pingTab.el.excelSaveBtn.style.display = pingTab.excelLoaded ? '' : 'none';

      renderPingStats(pingTab.hosts);
      renderPingTable(pingTab.hosts);

      if (data.next_run_in !== undefined && data.next_run_in !== null) {
        startPingCdTick(data.next_run_in);
        if (activeTab === 'ping') {
          elCountdown.textContent = pingTab.autoEnabled ? fmtPingCd(data.next_run_in) : '—';
        }
      } else if (activeTab === 'ping') {
        elCountdown.textContent = '—';
      }
    } catch(_) {}
  }

  function renderPingStats(hosts) {
    const up    = hosts.filter(h => h.status === 'up').length;
    const down  = hosts.filter(h => ['down','pending'].includes(h.status)).length;
    const api   = hosts.filter(h => h.api && h.api.reachable && !h.api.auth_error).length;
    const lats  = hosts.filter(h => h.latency != null).map(h => h.latency);
    const avg   = lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : null;
    const e     = pingTab.el;
    e.sTotal.textContent = hosts.length;
    e.sUp.textContent    = up;
    e.sDown.textContent  = down;
    e.sApi.textContent   = api;
    e.sLat.textContent   = avg != null ? avg + 'ms' : '—';
  }

  function renderPingTable(hosts) {
    const tbody = pingTab.el.tbody;
    pingTab.el.rowCount.textContent = hosts.length > 0 ? `${hosts.length} host${hosts.length !== 1 ? 's' : ''}` : '';

    if (!hosts.length) {
      tbody.innerHTML = `<tr class="table-placeholder"><td colspan="10">No hosts yet — load an Excel file or add a host above</td></tr>`;
      return;
    }

    const frag = document.createDocumentFragment();
    hosts.forEach((h, i) => {
      const tr = document.createElement('tr');
      if (h.status === 'down') tr.classList.add('row-offline');

      tr.innerHTML = [
        `<td style="color:var(--color-text-muted);font-family:var(--font-mono);font-size:11px">${i + 1}</td>`,
        `<td class="ping-addr">${esc(h.addr)}</td>`,
        `<td style="font-size:0.8rem;color:var(--color-text-muted)">${h.label ? esc(h.label) : '<span class="cell-na">—</span>'}</td>`,
        `<td>${buildPingStatusBadge(h)}</td>`,
        `<td>${buildPortTags(h.ports)}</td>`,
        `<td>${buildApiInfo(h.api)}</td>`,
        `<td class="ping-latency ${latClass(h.latency)}">${h.latency != null ? h.latency + 'ms' : '—'}</td>`,
        `<td class="ping-checked">${h.checked || '—'}</td>`,
        `<td>${buildMiniHist(h.history)}</td>`,
        `<td><div class="ping-row-actions">
          <button class="btn btn--sm" data-ping-check="${h.id}">check</button>
          <button class="btn btn--sm" style="color:var(--color-offline);border-color:rgba(239,68,68,.3)" data-ping-delete="${h.id}">✕</button>
        </div></td>`,
      ].join('');
      frag.appendChild(tr);
    });
    tbody.innerHTML = '';
    tbody.appendChild(frag);
  }

  function buildPingStatusBadge(h) {
    if (h.status === 'pending') return '<span class="ping-badge ping-badge--pending">checking</span>';
    if (h.status === 'idle')    return '<span class="ping-badge ping-badge--idle">idle</span>';
    if (h.status === 'up')      return '<span class="ping-badge ping-badge--up">online</span>';
    if (h.ever_up)              return '<span class="ping-badge ping-badge--warn">offline</span>';
    return '<span class="ping-badge ping-badge--down">unreachable</span>';
  }

  function buildPortTags(ports) {
    if (!ports || !Object.keys(ports).length) return '<span class="cell-na">—</span>';
    const defs = [{ p: '80', label: 'HTTP' }, { p: '443', label: 'SSL' }, { p: '5084', label: 'LLRP' }];
    return '<div class="port-tags">' + defs.map(d => {
      const v   = ports[d.p];
      const cls = v === true ? 'port-open' : v === false ? 'port-closed' : 'port-none';
      return `<span class="port-tag ${cls}" title="Port ${d.p}">${d.label}</span>`;
    }).join('') + '</div>';
  }

  function buildApiInfo(api) {
    if (!api || !Object.keys(api).length || (!api.reachable && !api.auth_error))
      return '<span class="cell-na">—</span>';
    if (api.auth_error) return '<span class="api-auth-err">401 · check credentials</span>';
    const parts = [];
    if (api.firmware)            parts.push(`<span class="api-fw">FW&nbsp;${esc(api.firmware)}</span>`);
    if (api.antennas_total != null) {
      const txt = api.antennas_active != null
        ? `${api.antennas_active}/${api.antennas_total}\xa0ant`
        : `${api.antennas_total}\xa0ant`;
      parts.push(`<span class="api-ant">${txt}</span>`);
    }
    if (api.temperature != null) {
      const t   = parseFloat(api.temperature);
      const cls = t > 70 ? 'temp-hot' : t > 50 ? 'temp-warm' : 'temp-ok';
      parts.push(`<span class="${cls}">${t.toFixed(1)}°C</span>`);
    }
    if (!parts.length) return '<span class="api-ok">✓ reachable</span>';
    return '<div class="ping-api-info">' + parts.join('<span class="api-sep">&nbsp;·&nbsp;</span>') + '</div>';
  }

  function buildMiniHist(history) {
    if (!history || !history.length) return '<span class="cell-na">—</span>';
    return '<div class="mini-hist">' +
      history.map(h => `<span class="h-${h}" title="${h}"></span>`).join('') + '</div>';
  }

  function latClass(ms) {
    if (ms == null) return '';
    if (ms < 100)   return 'fast';
    if (ms < 300)   return 'slow';
    return '';
  }

  // Event delegation for per-row ping actions
  document.addEventListener('click', (ev) => {
    const checkBtn  = ev.target.closest('[data-ping-check]');
    const deleteBtn = ev.target.closest('[data-ping-delete]');
    if (checkBtn) {
      const id = parseInt(checkBtn.dataset.pingCheck);
      fetch(`/api/ping/run/${id}`, { method: 'POST' });
      const row = checkBtn.closest('tr');
      setTimeout(fetchPingHosts, 500);
    }
    if (deleteBtn) {
      const id = parseInt(deleteBtn.dataset.pingDelete);
      fetch(`/api/ping/hosts/${id}`, { method: 'DELETE' }).then(fetchPingHosts);
    }
  });

  async function triggerPingRun() {
    const btn = pingTab.el.runBtn;
    btn.disabled = true; btn.textContent = '⏳ Running…';
    await fetch('/api/ping/run', { method: 'POST' });
    pingTab.el.lastRun.textContent = 'Last run: ' + new Date().toLocaleTimeString();
    if (activeTab === 'ping') pingTab.lastRunText = new Date().toLocaleTimeString();
    // Fast-poll until no 'pending' status
    let ticks = 0;
    const t = setInterval(async () => {
      await fetchPingHosts();
      ticks++;
      const stillPending = pingTab.hosts.some(h => h.status === 'pending');
      if (!stillPending || ticks > 60) {
        clearInterval(t);
        btn.disabled = false; btn.textContent = '▶ Run all';
      }
    }, 500);
  }

  async function pingAddHost() {
    const addr = pingTab.el.addInput.value.trim();
    if (!addr) return;
    const r    = await fetch('/api/ping/hosts/add', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addr }),
    });
    const data = await r.json();
    if (data.error) { pingToast(data.error, true); return; }
    pingTab.el.addInput.value = '';
    pingToast('Host added');
    fetchPingHosts();
  }

  async function pingLoadExcel() {
    const filePath = pingTab.el.excelPath.value.trim();
    if (!filePath) { pingToast('Enter a file path first', true); return; }
    const r    = await fetch('/api/ping/excel/load', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    });
    const data = await r.json();
    if (data.error) { pingToast(data.error, true); return; }
    pingToast(`Loaded ${data.added} hosts from Excel`);
    fetchPingHosts();
  }

  async function pingSaveExcel() {
    const r    = await fetch('/api/ping/excel/save', { method: 'POST' });
    const data = await r.json();
    if (data.error) { pingToast(data.error, true); return; }
    pingToast('Saved to Excel');
  }

  async function pingUpdateSettings() {
    const auto_enabled  = pingTab.el.autoChk.checked;
    const auto_interval = parseInt(pingTab.el.intervalSel.value);
    await fetch('/api/ping/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto_enabled, auto_interval }),
    });
    if (!auto_enabled && activeTab === 'ping') elCountdown.textContent = '—';
    fetchPingHosts();
  }

  async function pingApplyAuth() {
    const api_username = pingTab.el.apiUser.value.trim();
    const api_password = pingTab.el.apiPass.value;
    if (!api_username) { pingToast('Username required', true); return; }
    const r    = await fetch('/api/ping/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_username, api_password }),
    });
    const data = await r.json();
    if (data.error) { pingToast(data.error, true); return; }
    pingToast('Credentials updated — re-run checks to apply');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //   PORTALS TAB
  // ═══════════════════════════════════════════════════════════════════════════

  const portalsTab = {
    portals:      [],
    autoEnabled:  true,
    autoInterval: 5,
    lastRunText:  '',
    nextRunMs:    0,
    cdTimer:      null,
    pollTimer:    null,
    el:           {},
  };

  function initPortals() {
    const e = portalsTab.el;
    e.sTotal      = document.getElementById('portal-s-total');
    e.sUp         = document.getElementById('portal-s-up');
    e.sDown       = document.getElementById('portal-s-down');
    e.sLat        = document.getElementById('portal-s-lat');
    e.autoChk     = document.getElementById('portal-auto-chk');
    e.intervalSel = document.getElementById('portal-interval-sel');
    e.runBtn      = document.getElementById('portal-run-btn');
    e.tbody       = document.getElementById('portal-tbody');
    e.lastRun     = document.getElementById('portal-last-run');
    e.rowCount    = document.getElementById('portal-row-count');

    e.runBtn.addEventListener('click', triggerPortalsRun);
    e.autoChk.addEventListener('change', portalsUpdateSettings);
    e.intervalSel.addEventListener('change', portalsUpdateSettings);

    startPortalsPoll();
  }

  function startPortalsPoll() {
    if (portalsTab.pollTimer) clearInterval(portalsTab.pollTimer);
    portalsTab.pollTimer = setInterval(fetchPortals, 3000);
    fetchPortals();
  }

  function startPortalsCdTick(nextRunIn) {
    if (portalsTab.cdTimer) clearInterval(portalsTab.cdTimer);
    if (!nextRunIn || !portalsTab.autoEnabled) { portalsTab.nextRunMs = 0; return; }
    portalsTab.nextRunMs = Date.now() + nextRunIn * 1000;
    portalsTab.cdTimer = setInterval(() => {
      if (activeTab !== 'portals') return;
      const secsLeft = Math.max(0, Math.floor((portalsTab.nextRunMs - Date.now()) / 1000));
      elCountdown.textContent = portalsTab.autoEnabled ? fmtPingCd(secsLeft) : '—';
      if (secsLeft <= 0) clearInterval(portalsTab.cdTimer);
    }, 1000);
  }

  async function fetchPortals() {
    try {
      const res  = await fetch('/api/portals');
      const data = await res.json();
      portalsTab.portals      = data.portals       || [];
      portalsTab.autoEnabled  = data.auto_enabled;
      portalsTab.autoInterval = data.auto_interval;

      portalsTab.el.autoChk.checked    = portalsTab.autoEnabled;
      portalsTab.el.intervalSel.value  = String(portalsTab.autoInterval);

      renderPortalsStats(portalsTab.portals);
      renderPortalsTable(portalsTab.portals);

      if (data.next_run_in !== undefined && data.next_run_in !== null) {
        startPortalsCdTick(data.next_run_in);
        if (activeTab === 'portals')
          elCountdown.textContent = portalsTab.autoEnabled ? fmtPingCd(data.next_run_in) : '—';
      } else if (activeTab === 'portals') {
        elCountdown.textContent = '—';
      }
    } catch(_) {}
  }

  function renderPortalsStats(portals) {
    const up   = portals.filter(p => p.status === 'up').length;
    const down = portals.filter(p => ['down', 'pending'].includes(p.status)).length;
    const lats = portals.filter(p => p.latency != null).map(p => p.latency);
    const avg  = lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : null;
    const e    = portalsTab.el;
    e.sTotal.textContent = portals.length;
    e.sUp.textContent    = up;
    e.sDown.textContent  = down;
    e.sLat.textContent   = avg != null ? avg + 'ms' : '—';
  }

  function renderPortalsTable(portals) {
    const tbody = portalsTab.el.tbody;
    portalsTab.el.rowCount.textContent = portals.length > 0 ? `${portals.length} portal${portals.length !== 1 ? 's' : ''}` : '';

    if (!portals.length) {
      tbody.innerHTML = `<tr class="table-placeholder"><td colspan="10">No portals configured</td></tr>`;
      return;
    }

    const frag = document.createDocumentFragment();
    portals.forEach((p, i) => {
      const tr = document.createElement('tr');
      if (p.status === 'down') tr.classList.add('row-offline');

      const httpBadge = p.httpCode != null
        ? `<span class="port-tag ${p.httpCode < 400 ? 'port-open' : p.httpCode < 500 ? 'port-tag--warn' : 'port-closed'}">${p.httpCode}</span>`
        : '<span class="cell-na">—</span>';

      tr.innerHTML = [
        `<td style="color:var(--color-text-muted);font-family:var(--font-mono);font-size:11px">${i + 1}</td>`,
        `<td style="font-size:0.82rem">${p.location ? esc(p.location) : '<span class="cell-na">—</span>'}</td>`,
        `<td style="font-size:0.82rem;font-weight:500">${esc(p.label)}</td>`,
        `<td class="ping-addr" style="font-size:0.78rem">${esc(p.url)}</td>`,
        `<td>${buildPortalStatusBadge(p)}</td>`,
        `<td>${httpBadge}</td>`,
        `<td class="ping-latency ${latClass(p.latency)}">${p.latency != null ? p.latency + 'ms' : '—'}</td>`,
        `<td class="ping-checked">${p.checked || '—'}</td>`,
        `<td>${buildMiniHist(p.history)}</td>`,
        `<td><button class="btn btn--sm" data-portal-check="${p.id}">check</button></td>`,
      ].join('');
      frag.appendChild(tr);
    });
    tbody.innerHTML = '';
    tbody.appendChild(frag);
  }

  function buildPortalStatusBadge(p) {
    if (p.status === 'pending') return '<span class="ping-badge ping-badge--pending">checking</span>';
    if (p.status === 'idle')    return '<span class="ping-badge ping-badge--idle">idle</span>';
    if (p.status === 'up')      return '<span class="ping-badge ping-badge--up">online</span>';
    if (p.ever_up)              return '<span class="ping-badge ping-badge--warn">offline</span>';
    return '<span class="ping-badge ping-badge--down">unreachable</span>';
  }

  // Event delegation for portal per-row check
  document.addEventListener('click', (ev) => {
    const checkBtn = ev.target.closest('[data-portal-check]');
    if (checkBtn) {
      const id = parseInt(checkBtn.dataset.portalCheck);
      fetch(`/api/portals/run/${id}`, { method: 'POST' });
      setTimeout(fetchPortals, 500);
    }
  });

  async function triggerPortalsRun() {
    const btn = portalsTab.el.runBtn;
    btn.disabled = true; btn.textContent = '⏳ Running…';
    await fetch('/api/portals/run', { method: 'POST' });
    portalsTab.el.lastRun.textContent = 'Last run: ' + new Date().toLocaleTimeString();
    if (activeTab === 'portals') portalsTab.lastRunText = new Date().toLocaleTimeString();
    let ticks = 0;
    const t = setInterval(async () => {
      await fetchPortals();
      ticks++;
      const stillPending = portalsTab.portals.some(p => p.status === 'pending');
      if (!stillPending || ticks > 60) {
        clearInterval(t);
        btn.disabled = false; btn.textContent = '▶ Run all';
      }
    }, 500);
  }

  async function portalsUpdateSettings() {
    const auto_enabled  = portalsTab.el.autoChk.checked;
    const auto_interval = parseInt(portalsTab.el.intervalSel.value);
    await fetch('/api/portals/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto_enabled, auto_interval }),
    });
    if (!auto_enabled && activeTab === 'portals') elCountdown.textContent = '—';
    fetchPortals();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //   Shared helpers
  // ═══════════════════════════════════════════════════════════════════════════

  function setRefreshing(on) {
    elRefreshBtn.disabled = on;
    elRefreshIndicator.classList.toggle('hidden', !on);
  }

  function showError(banner, msgEl, msg) {
    msgEl.textContent = 'API error: ' + msg + '. Showing last known data.';
    banner.classList.remove('hidden');
  }

  function hideError(banner) {
    banner.classList.add('hidden');
  }

  function populateSelectFromData(selectEl, values) {
    const current = selectEl.value;
    const unique  = [...new Set(values.filter(Boolean))].sort();
    const first   = selectEl.options[0]; // "All …" option
    selectEl.innerHTML = '';
    selectEl.appendChild(first);
    unique.forEach((v) => {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = v;
      selectEl.appendChild(opt);
    });
    if (unique.includes(current)) selectEl.value = current;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //   Init
  // ═══════════════════════════════════════════════════════════════════════════

  document.addEventListener('DOMContentLoaded', () => {
    elLastUpdated      = document.getElementById('last-updated');
    elCountdown        = document.getElementById('countdown');
    elRefreshBtn       = document.getElementById('refresh-btn');
    elRefreshIndicator = document.getElementById('refresh-indicator');
    elHeaderSubtitle   = document.getElementById('header-subtitle');

    // Tab buttons
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Global refresh button dispatches to active tab
    elRefreshBtn.addEventListener('click', () => {
      if (activeTab === 'connect')          refreshConnect();
      else if (activeTab === 'mobicontrol') refreshMc();
      else if (activeTab === 'ping')        triggerPingRun();
      else if (activeTab === 'portals')     triggerPortalsRun();
    });

    initConnect();
    initMobiControl();
    initPing();
    initPortals();
  });

})();
