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
    advsettings:  'Group Advanced Settings',
    mcapps:       'Enterprise App Catalog',
    profiles:     'Profile Detail',
    apppolicies:  'App Policy Detail',
    ping:         'RFID Reader Status',
    portals:      'Portal Availability Monitor',
  };

  // ─── Tab switching ───────────────────────────────────────────────────────────

  const MOBICONTROL_GROUP_TABS = ['mobicontrol', 'advsettings', 'mcapps', 'profiles', 'apppolicies'];

  function switchTab(name) {
    activeTab = name;

    document.querySelectorAll('.tab-btn[data-tab]').forEach((btn) => {
      const isActive = btn.dataset.tab === name;
      btn.classList.toggle('tab-btn--active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    document.querySelectorAll('.tab-dropdown-item').forEach((item) => {
      item.classList.toggle('tab-dropdown-item--active', item.dataset.tab === name);
    });
    const groupBtn = document.getElementById('mobicontrol-group-btn');
    if (groupBtn) groupBtn.classList.toggle('tab-btn--active', MOBICONTROL_GROUP_TABS.includes(name));

    document.querySelectorAll('.tab-content').forEach((div) => {
      div.classList.toggle('tab-content--active', div.id === 'tab-' + name);
    });

    if (name === 'mcapps') loadMcAppsIfNeeded();
    if (name === 'profiles' && !profilesTab.loaded) fetchProfilesList();
    if (name === 'apppolicies' && !appPoliciesTab.loaded) fetchAppPoliciesList();

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
    } else if (name === 'advsettings') {
      elCountdown.textContent   = 'No auto-refresh';
      elLastUpdated.textContent = mcAdvLastUpdatedText || 'Not loaded yet';
    } else if (name === 'mcapps') {
      elCountdown.textContent   = 'No auto-refresh';
      elLastUpdated.textContent = mcAppsLastUpdatedText || 'Not loaded yet';
    } else if (name === 'profiles') {
      elCountdown.textContent   = 'No auto-refresh';
      elLastUpdated.textContent = profilesTab.lastUpdatedText || 'Not loaded yet';
    } else if (name === 'apppolicies') {
      elCountdown.textContent   = 'No auto-refresh';
      elLastUpdated.textContent = appPoliciesTab.lastUpdatedText || 'Not loaded yet';
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

  // Renders a JS value as indented, HTML-escaped, syntax-colored JSON (keys, strings,
  // numbers, booleans/null each get their own span class — see .json-* in style.css).
  function highlightJson(value) {
    // Only escape &/</> here (not quotes) so the regex below can still match on literal " marks.
    const json = JSON.stringify(value, null, 2)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return json.replace(
      /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (match) => {
        let cls = 'json-number';
        if (/^"/.test(match))            cls = /:$/.test(match) ? 'json-key' : 'json-string';
        else if (/true|false/.test(match)) cls = 'json-boolean';
        else if (/null/.test(match))       cls = 'json-null';
        return `<span class="${cls}">${match}</span>`;
      }
    );
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
      if (connect.sort.key === 'printActivity') { va = activityRank(a.printActivity); vb = activityRank(b.printActivity); }
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

  function simplePrintBaseUrl() {
    if (!connect.simplePrintUrl) return null;
    try {
      const u = new URL(connect.simplePrintUrl);
      // The Simple Print helper runs alongside whatever machine is viewing the
      // dashboard, so route to it using the host the page was loaded from
      // (localhost or an IP) rather than whatever host is baked into the config.
      u.hostname = window.location.hostname;
      return u.toString().replace(/\/$/, '');
    } catch (_) {
      return connect.simplePrintUrl;
    }
  }

  function buildConnectRow(d) {
    const tr = document.createElement('tr');
    if (d.connectionStatus !== 1) tr.classList.add('row-offline');
    if (d.hasAlert)                tr.classList.add('row-alert');

    const printBase = simplePrintBaseUrl();
    const printHref = printBase && d.ip
      ? `${printBase}?labelName=${encodeURIComponent(d.name)}&ip=${encodeURIComponent(d.ip)}`
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
      `<td class="cell-activity">${buildActivityCell(d)}</td>`,
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

  const ACTIVITY_RANK = { voiding: 0, idle_voiding: 1, ok: 2, idle: 3 };

  function activityRank(pa) {
    if (!pa || !pa.state) return 4;
    return ACTIVITY_RANK[pa.state] ?? 4;
  }

  // relativeTime() returns an HTML fragment (with quoted attributes) for
  // invalid dates; that's fine when it lands in innerHTML but breaks a
  // title="" attribute, so the tooltip needs a plain-text fallback instead.
  function activityTimeLabel(iso) {
    if (!iso) return 'never';
    return isNaN(Date.parse(iso)) ? 'unknown' : relativeTime(new Date(iso));
  }

  function buildActivityCell(d) {
    const pa = d.printActivity;
    if (!pa || !pa.state) return '<span class="cell-na">—</span>';
    const lastVoid  = activityTimeLabel(pa.lastVoidAt);
    const lastValid = activityTimeLabel(pa.lastValidAt);
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
    expandedId:     null,
    detailCache:    {}, // { [deviceId]: { status: 'loading'|'loaded'|'error', data, error } }
    compareIds:     [], // up to 2 device ids selected for comparison
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
    e.compareBtn        = document.getElementById('mc-compare-btn');
    e.compareBtn.addEventListener('click', () => {
      if (mc.compareIds.length === 2) openDeviceCompareModal(mc.compareIds[0], mc.compareIds[1]);
    });

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
      populateMcAdvGroupSelect(mc.devices);
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
    sorted.forEach((d) => buildMcRow(d).forEach((row) => frag.appendChild(row)));
    mc.el.tableBody.innerHTML = '';
    mc.el.tableBody.appendChild(frag);

    mc.el.tableBody.querySelectorAll('tr[data-device-id]').forEach((row) => {
      row.addEventListener('click', () => toggleMcDeviceDetail(row.dataset.deviceId));
    });
    mc.el.tableBody.querySelectorAll('.view-profile-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigateToProfile(btn.dataset.profileId, btn.dataset.profileName);
      });
    });
    mc.el.tableBody.querySelectorAll('.mc-compare-checkbox').forEach((cb) => {
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => toggleCompareDevice(cb.dataset.deviceId, cb.checked));
    });
  }

  function toggleCompareDevice(deviceId, checked) {
    if (checked) {
      if (!mc.compareIds.includes(deviceId) && mc.compareIds.length < 2) mc.compareIds.push(deviceId);
    } else {
      mc.compareIds = mc.compareIds.filter((id) => id !== deviceId);
    }
    mc.el.compareBtn.textContent = `Compare (${mc.compareIds.length}/2)`;
    mc.el.compareBtn.disabled = mc.compareIds.length !== 2;
    renderMcTable();
  }

  function toggleMcDeviceDetail(deviceId) {
    if (mc.expandedId === deviceId) {
      mc.expandedId = null;
      renderMcTable();
      return;
    }
    mc.expandedId = deviceId;
    if (!mc.detailCache[deviceId]) {
      mc.detailCache[deviceId] = { status: 'loading' };
      fetchMcDeviceDetail(deviceId);
    }
    renderMcTable();
  }

  async function fetchMcDeviceDetail(deviceId) {
    try {
      const [detailRes, profilesRes] = await Promise.all([
        fetch(`/api/mc/devices/${encodeURIComponent(deviceId)}/detail`),
        fetch(`/api/mc/devices/${encodeURIComponent(deviceId)}/profiles`),
      ]);
      const data = await detailRes.json();
      if (!detailRes.ok) throw new Error(data.error || `Request failed (${detailRes.status})`);

      const profilesData = await profilesRes.json().catch(() => ({}));
      if (!profilesRes.ok) console.error('[mc device profiles]', profilesData.error || `HTTP ${profilesRes.status}`);
      data.profiles = profilesRes.ok ? (profilesData.profiles || []) : [];

      mc.detailCache[deviceId] = { status: 'loaded', data };
    } catch (e) {
      mc.detailCache[deviceId] = { status: 'error', error: e.message };
    }
    if (mc.expandedId === deviceId) renderMcTable();
  }

  function isProfileStatusHealthy(status) {
    return status === 'Installed';
  }

  function buildMcProfilesSection(profiles) {
    if (!profiles || !profiles.length) return '<h4>Profiles</h4><span class="cell-na">No profiles associated with this device</span>';

    const rows = profiles.map((p) => {
      const badProfile = !isProfileStatusHealthy(p.Status);
      const items = [
        ...(p.Configurations || []).map((c) => ({ label: c.DeviceConfigurationType && c.DeviceConfigurationType.ConfigurationType && c.DeviceConfigurationType.ConfigurationType.Name || c.Name || 'Configuration', status: c.Status })),
        ...(p.Packages || []).map((pkg) => ({ label: `${pkg.Name}${pkg.Version ? ` (${pkg.Version})` : ''}`, status: pkg.Status })),
      ];
      const itemsHtml = items.length
        ? `<ul class="mcapp-perm-list">${items.map((i) => {
            const bad = !isProfileStatusHealthy(i.status);
            return `<li>${bad ? '<span class="profile-status-bad">⚠</span> ' : ''}${esc(i.label)} — <strong${bad ? ' class="profile-status-bad"' : ''}>${esc(i.status)}</strong></li>`;
          }).join('')}</ul>`
        : '';
      return `
        <div class="detail-profile${badProfile ? ' detail-profile--bad' : ''}">
          <div class="detail-profile-header">
            ${badProfile ? '<span class="profile-status-bad">⚠</span> ' : ''}<strong>${esc(p.Name)}</strong>
            <span class="cell-na">v${esc(p.VersionNumber)}</span>
            <span class="badge${badProfile ? ' badge--compliance-unknown' : ' badge--online'}">${esc(p.Status)}</span>
            <button type="button" class="btn btn--sm view-profile-btn" data-profile-id="${esc(p.ReferenceId)}" data-profile-name="${esc(p.Name)}">View Profile</button>
          </div>
          ${itemsHtml}
        </div>`;
    }).join('');

    return `<h4>Profiles</h4>${rows}`;
  }

  function buildMcRow(d) {
    const tr = document.createElement('tr');
    tr.dataset.deviceId = d.id;
    tr.classList.add('row-clickable');
    if (!d.isOnline) tr.classList.add('row-offline');
    if (d.compliance && d.compliance.toLowerCase().includes('non')) tr.classList.add('row-alert');

    const isChecked = mc.compareIds.includes(d.id);
    const checkboxDisabled = !isChecked && mc.compareIds.length >= 2;
    tr.innerHTML = [
      `<td><input type="checkbox" class="mc-compare-checkbox" data-device-id="${esc(d.id)}" ${isChecked ? 'checked' : ''} ${checkboxDisabled ? 'disabled' : ''} aria-label="Select ${esc(d.name)} for comparison" /></td>`,
      `<td><span class="cell-name">${esc(d.name) || '<span class="cell-na">—</span>'}</span></td>`,
      `<td>${buildPlatformBadge(d.platform)}</td>`,
      `<td><span class="cell-model" title="${esc(d.model)}">${esc(d.model) || '<span class="cell-na">—</span>'}</span></td>`,
      `<td class="cell-group">${d.groupPath && d.groupPath !== d.group
          ? `<span class="group-tooltip" title="${esc(d.groupPath)}">${esc(d.group)}</span>`
          : esc(d.group) || '<span class="cell-na">—</span>'}</td>`,
      `<td>${buildStatusBadge(d.isOnline)}</td>`,
      `<td class="cell-os">${esc(d.osVersion) || '<span class="cell-na">—</span>'}</td>`,
      `<td class="cell-firmware" title="${esc(d.firmware)}">${esc(d.firmware) || '<span class="cell-na">—</span>'}</td>`,
      `<td class="cell-lastseen">${d.lastCheckIn ? relativeTime(new Date(d.lastCheckIn)) : '<span class="cell-na">—</span>'}</td>`,
      `<td class="cell-mc-user">${esc(d.userName) || '<span class="cell-na">—</span>'}</td>`,
      `<td>${buildComplianceBadge(d.compliance)}</td>`,
    ].join('');

    if (mc.expandedId !== d.id) return [tr];
    return [tr, buildMcDeviceDetailRow(d.id)];
  }

  function statRow(label, value) {
    if (value === null || value === undefined || value === '') return '';
    return `<div class="detail-stat"><span class="detail-stat-label">${esc(label)}</span><span class="detail-stat-value">${esc(String(value))}</span></div>`;
  }

  function formatBytes(n) {
    if (n === null || n === undefined) return null;
    const num = Number(n);
    if (!Number.isFinite(num)) return null;
    const gb = num / (1024 ** 3);
    return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(num / (1024 ** 2)).toFixed(0)} MB`;
  }

  function buildMcDeviceDetailRow(deviceId) {
    const tr = document.createElement('tr');
    tr.className = 'mc-detail-row';
    const entry = mc.detailCache[deviceId] || { status: 'loading' };

    let inner;
    if (entry.status === 'loading') {
      inner = '<span class="cell-na">Loading device detail&hellip;</span>';
    } else if (entry.status === 'error') {
      inner = `<span class="cell-na">Failed to load detail: ${esc(entry.error)}</span>`;
    } else {
      const detail = entry.data.detail || {};
      const mem    = detail.Memory || {};
      const av     = detail.Antivirus || {};
      const attrs  = entry.data.customAttributes || [];

      const storageSection = `
        <h4>Storage &amp; Battery</h4>
        <div class="detail-stat-grid">
          ${statRow('Battery', detail.BatteryStatus != null ? `${detail.BatteryStatus}%` : null)}
          ${statRow('Total Storage', formatBytes(mem.TotalStorage))}
          ${statRow('Available Storage', formatBytes(mem.AvailableStorage))}
          ${statRow('Total Memory', formatBytes(mem.TotalMemory))}
          ${statRow('Available Memory', formatBytes(mem.AvailableMemory))}
          ${statRow('Last Virus Scan', av.LastVirusScan ? relativeTime(new Date(av.LastVirusScan)) : null)}
          ${statRow('Infected Files', av.InfectedFilesCount)}
        </div>`;

      const securitySection = `
        <h4>Enrollment &amp; Security</h4>
        <div class="detail-stat-grid">
          ${statRow('Agent Version', detail.AgentVersion)}
          ${statRow('Android API Level', detail.AndroidApiLevel)}
          ${statRow('Device Admin', detail.AndroidDeviceAdmin)}
          ${statRow('SafetyNet Attestation', detail.SafetynetAttestationStatus)}
          ${statRow('Android Enterprise', detail.AndroidForWork && detail.AndroidForWork.AfwProvisionStage)}
          ${statRow('Enterprise Name', detail.AndroidForWork && detail.AndroidForWork.AndroidEnterpriseName)}
          ${statRow('Exchange Status', detail.ExchangeStatus)}
          ${statRow('Exchange Blocked', detail.ExchangeBlocked)}
        </div>`;

      const attrsSection = attrs.length
        ? `<h4>Custom Attributes</h4>
           <div class="detail-stat-grid">
             ${attrs.map((a) => statRow(a.Name, a.Value)).join('') || '<span class="cell-na">No values set</span>'}
           </div>`
        : '';

      inner = `
        <div class="mcapp-detail">
          ${storageSection}
          ${securitySection}
          ${buildMcProfilesSection(entry.data.profiles)}
          ${attrsSection}
          <h4>All Fields</h4>
          <pre class="mcapp-schema">${highlightJson(detail)}</pre>
        </div>`;
    }

    tr.innerHTML = `<td colspan="11">${inner}</td>`;
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

  let mcAdvRows = []; // all rows from the last successful fetch, before search filtering
  let mcAdvLastUpdatedText = '';

  function initMcAdvConfig() {
    const select = document.getElementById('mc-adv-group-select');
    const search = document.getElementById('mc-adv-search');
    select.addEventListener('change', fetchMcAdvConfig);
    search.addEventListener('input', () => renderMcAdvConfigTable(mcAdvRows));
  }

  // Populate the group dropdown from the actual groups present in the currently
  // loaded MobiControl devices — dedup by full groupPath (the value the API needs),
  // label shown is the leaf group name for readability.
  function populateMcAdvGroupSelect(devices) {
    const select = document.getElementById('mc-adv-group-select');
    const current = select.value;
    const byPath = new Map();
    devices.forEach((d) => {
      if (d.groupPath && !byPath.has(d.groupPath)) byPath.set(d.groupPath, d.group);
    });
    const entries = [...byPath.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    select.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select a group…';
    select.appendChild(placeholder);
    entries.forEach(([groupPath, label]) => {
      const opt = document.createElement('option');
      opt.value = groupPath;
      opt.textContent = `${label}  (${groupPath})`;
      opt.title = groupPath;
      select.appendChild(opt);
    });
    if (byPath.has(current)) select.value = current;
  }

  async function fetchMcAdvConfig() {
    const path  = document.getElementById('mc-adv-group-select').value;
    const body  = document.getElementById('mc-adv-config-body');
    const errEl = document.getElementById('mc-adv-config-error');
    errEl.classList.add('hidden');
    if (!path) {
      mcAdvRows = [];
      body.innerHTML = '<tr class="table-placeholder"><td colspan="6">Select a group above</td></tr>';
      updateMcAdvStats([]);
      return;
    }
    body.innerHTML = '<tr class="table-placeholder"><td colspan="6">Loading&hellip;</td></tr>';
    try {
      const url = `/api/mc/devicegroups/advanced-config?path=${encodeURIComponent(path)}`;
      const res  = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      mcAdvRows = (data.GroupSettings || []).flatMap((g) =>
        (g.GroupAdvancedSettings || []).map((s) => ({ family: g.TargetFamily, ...s }))
      );
      mcAdvLastUpdatedText = new Date().toLocaleTimeString();
      if (activeTab === 'advsettings') elLastUpdated.textContent = mcAdvLastUpdatedText;
      renderMcAdvConfigTable(mcAdvRows);
    } catch (e) {
      mcAdvRows = [];
      body.innerHTML = '';
      errEl.textContent = e.message;
      errEl.classList.remove('hidden');
      updateMcAdvStats([]);
    }
  }

  function updateMcAdvStats(rows) {
    const inherited = rows.filter((r) => r.IsInherited).length;
    document.getElementById('stat-adv-total').textContent      = rows.length;
    document.getElementById('stat-adv-inherited').textContent  = inherited;
    document.getElementById('stat-adv-overridden').textContent = rows.length - inherited;
  }

  function renderMcAdvConfigTable(rows) {
    updateMcAdvStats(rows);

    const body      = document.getElementById('mc-adv-config-body');
    const noResults = document.getElementById('mc-adv-no-results');
    const term      = document.getElementById('mc-adv-search').value.trim().toLowerCase();
    const filtered  = term
      ? rows.filter((r) => (r.SettingName || '').toLowerCase().includes(term) || (r.family || '').toLowerCase().includes(term))
      : rows;

    if (!rows.length) {
      noResults.classList.add('hidden');
      body.innerHTML = '<tr class="table-placeholder"><td colspan="6">No settings found</td></tr>';
      return;
    }
    if (!filtered.length) {
      body.innerHTML = '';
      noResults.classList.remove('hidden');
      return;
    }
    noResults.classList.add('hidden');
    body.innerHTML = filtered.map((r) => `
      <tr>
        <td>${r.family || ''}</td>
        <td>${r.SettingName || ''}</td>
        <td>${r.IsInherited ? 'Yes' : 'No'}</td>
        <td>${r.InheritsFrom || '<span class="cell-na">—</span>'}</td>
        <td>${r.LastUpdate ? new Date(r.LastUpdate).toLocaleString() : ''}</td>
        <td>${r.ConfiguredBy || '<span class="cell-na">—</span>'}</td>
      </tr>
    `).join('');
  }

  // ─── MobiControl Enterprise Apps ─────────────────────────────────────────────

  const MC_APPLIED_TO_REFRESH_MS = 15 * 60 * 1000; // 15 minutes

  let mcApps = [];
  let mcAppsLoaded = false;
  let mcAppsExpandedId = null;
  let mcAppliedTo = {};       // { [appId]: { status: 'idle'|'loading'|'loaded'|'error', data, error, lastUpdatedText } }
  let mcAppliedToTimer = null; // auto-refresh timer for whichever row is currently expanded
  let mcAppliedToPolicyExpanded = {}; // { [`${appId}::${policyKey}`]: boolean } — explicit user toggle overrides
  let mcAppActiveStatus = {};       // { [appId]: { active, policies } } — populated after the main list loads
  let mcAppActiveStatusLoaded = false;
  let mcAppsLastUpdatedText = '';
  let mcAppConfigsByPolicy = {};    // { [appId]: { status: 'idle'|'loading'|'loaded'|'error', data, error } } — Google Play apps only

  const MCAPPS_COLUMNS = [
    { key: 'icon',     label: 'Icon',        index: 1 },
    { key: 'name',     label: 'App Name',    index: 2 },
    { key: 'platform', label: 'Platform',    index: 3 },
    { key: 'version',  label: 'Version',     index: 4 },
    { key: 'author',   label: 'Author',      index: 5 },
    { key: 'pkg',      label: 'Package ID',  index: 6 },
    { key: 'origin',   label: 'Origin',      index: 7 },
    { key: 'perms',    label: 'Permissions', index: 8 },
    { key: 'status',   label: 'Status',      index: 9 },
  ];

  let mcAppsHiddenCols = new Set(); // column keys currently hidden
  let mcAppsSort = { key: null, dir: 'asc' };
  let mcAppsSavedViews = [];
  let mcAppsActiveViewId = null; // id of the saved view currently applied, or null for the default view

  // Generic click-to-open dropdown wiring (button toggles, outside click / Escape closes).
  function setupDropdown(btnId, dropdownId) {
    const btn = document.getElementById(btnId);
    const dropdown = document.getElementById(dropdownId);
    if (!btn || !dropdown) return;

    function close() {
      dropdown.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
    }
    function toggle() {
      const isOpen = !dropdown.classList.contains('hidden');
      if (isOpen) close();
      else { dropdown.classList.remove('hidden'); btn.setAttribute('aria-expanded', 'true'); }
    }
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    document.addEventListener('click', (e) => {
      if (!dropdown.classList.contains('hidden') && !dropdown.contains(e.target) && e.target !== btn) close();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    return { close, toggle };
  }

  function initMcApps() {
    document.getElementById('mcapps-search').addEventListener('input', () => renderMcAppsTable(mcApps));
    document.getElementById('mcapps-source-filter').addEventListener('change', () => renderMcAppsTable(mcApps));

    setupDropdown('mcapps-columns-btn', 'mcapps-columns-dropdown');
    setupDropdown('mcapps-views-btn', 'mcapps-views-dropdown');

    renderMcAppsColumnsMenu();
    document.getElementById('mcapps-save-view-btn').addEventListener('click', saveMcAppsView);

    document.querySelectorAll('#mcapps-table th[data-sort-mcapp]').forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.dataset.sortMcapp;
        if (mcAppsSort.key === key) mcAppsSort.dir = mcAppsSort.dir === 'asc' ? 'desc' : 'asc';
        else { mcAppsSort.key = key; mcAppsSort.dir = 'asc'; }
        updateMcAppsSortHeaders();
        renderMcAppsTable(mcApps);
      });
    });

    loadMcAppsViews();
  }

  function renderMcAppsColumnsMenu() {
    const dropdown = document.getElementById('mcapps-columns-dropdown');
    dropdown.innerHTML = MCAPPS_COLUMNS.map((c) => `
      <label class="tab-dropdown-checkbox-item">
        <input type="checkbox" data-col-key="${c.key}" ${mcAppsHiddenCols.has(c.key) ? '' : 'checked'} />
        ${esc(c.label)}
      </label>
    `).join('');
    dropdown.querySelectorAll('input[data-col-key]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const key = cb.dataset.colKey;
        if (cb.checked) mcAppsHiddenCols.delete(key);
        else mcAppsHiddenCols.add(key);
        applyMcAppsColumnVisibility();
      });
    });
  }

  function applyMcAppsColumnVisibility() {
    const table = document.getElementById('mcapps-table');
    MCAPPS_COLUMNS.forEach((c) => table.classList.toggle(`hide-col-${c.index}`, mcAppsHiddenCols.has(c.key)));
  }

  function updateMcAppsSortHeaders() {
    document.querySelectorAll('#mcapps-table th[data-sort-mcapp]').forEach((th) => {
      th.classList.remove('sort-asc', 'sort-desc');
      const icon = th.querySelector('.sort-icon');
      if (icon) icon.textContent = '↕';
    });
    if (!mcAppsSort.key) return;
    const active = document.querySelector(`#mcapps-table th[data-sort-mcapp="${mcAppsSort.key}"]`);
    if (!active) return;
    active.classList.add(mcAppsSort.dir === 'asc' ? 'sort-asc' : 'sort-desc');
    const icon = active.querySelector('.sort-icon');
    if (icon) icon.textContent = mcAppsSort.dir === 'asc' ? '↑' : '↓';
  }

  function sortMcApps(apps) {
    if (!mcAppsSort.key) return apps;
    const key = mcAppsSort.key;
    return [...apps].sort((a, b) => {
      let va, vb;
      if (key === '_permsCount') {
        va = mcAppPermissions(a).length; vb = mcAppPermissions(b).length;
      } else if (key === '_active') {
        const idA = a.ReferenceId || a.AppPackageId || '';
        const idB = b.ReferenceId || b.AppPackageId || '';
        va = mcAppActiveStatus[idA] && mcAppActiveStatus[idA].active ? 1 : 0;
        vb = mcAppActiveStatus[idB] && mcAppActiveStatus[idB].active ? 1 : 0;
      } else {
        va = a[key]; vb = b[key];
      }
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return mcAppsSort.dir === 'asc' ? cmp : -cmp;
    });
  }

  // ─── Saved views (Apps tab) — shared across all technicians via the server ────

  function currentMcAppsViewConfig() {
    return {
      search: document.getElementById('mcapps-search').value,
      source: document.getElementById('mcapps-source-filter').value,
      sortKey: mcAppsSort.key,
      sortDir: mcAppsSort.dir,
      hiddenCols: [...mcAppsHiddenCols],
    };
  }

  function applyMcAppsViewConfig(config, viewId) {
    document.getElementById('mcapps-search').value = config.search || '';
    document.getElementById('mcapps-source-filter').value = config.source || '';
    mcAppsSort = { key: config.sortKey || null, dir: config.sortDir || 'asc' };
    mcAppsHiddenCols = new Set(config.hiddenCols || []);
    mcAppsActiveViewId = viewId != null ? String(viewId) : null;
    renderMcAppsColumnsMenu();
    applyMcAppsColumnVisibility();
    updateMcAppsSortHeaders();
    updateMcAppsViewsButton();
    renderMcAppsViewsMenu();
    renderMcAppsTable(mcApps);
  }

  function updateMcAppsViewsButton() {
    const btn = document.getElementById('mcapps-views-btn');
    const active = mcAppsSavedViews.find((v) => String(v.id) === mcAppsActiveViewId);
    btn.innerHTML = active
      ? `<span class="tab-dropdown-item-dot" style="opacity:1;display:inline-block;margin-right:2px"></span>View: ${esc(active.name)} <span class="tab-chevron">▾</span>`
      : `Views <span class="tab-chevron">▾</span>`;
  }

  async function loadMcAppsViews() {
    try {
      const res = await fetch('/api/views/mcapps');
      const data = await res.json();
      mcAppsSavedViews = data.views || [];
    } catch (_) {
      mcAppsSavedViews = [];
    }
    renderMcAppsViewsMenu();
  }

  function renderMcAppsViewsMenu() {
    const list = document.getElementById('mcapps-views-list');
    updateMcAppsViewsButton();

    const defaultRow = `
      <button type="button" class="tab-dropdown-item ${mcAppsActiveViewId === null ? 'tab-dropdown-item--active' : ''}" data-view-default>
        <span class="tab-dropdown-item-dot"></span>Default (all columns, no filter)
      </button>`;

    if (!mcAppsSavedViews.length) {
      list.innerHTML = defaultRow + '<div class="tab-dropdown-empty">No saved views yet</div>';
    } else {
      list.innerHTML = defaultRow + mcAppsSavedViews.map((v) => `
        <div class="tab-dropdown-view-row">
          <button type="button" class="tab-dropdown-item ${mcAppsActiveViewId === String(v.id) ? 'tab-dropdown-item--active' : ''}" data-view-id="${v.id}">
            <span class="tab-dropdown-item-dot"></span>${esc(v.name)}
          </button>
          <button type="button" class="tab-dropdown-view-delete" data-view-delete="${v.id}" title="Delete view">✕</button>
        </div>
      `).join('');
    }

    const defaultBtn = list.querySelector('[data-view-default]');
    if (defaultBtn) defaultBtn.addEventListener('click', () => {
      applyMcAppsViewConfig({ search: '', source: '', sortKey: null, sortDir: 'asc', hiddenCols: [] }, null);
      document.getElementById('mcapps-views-dropdown').classList.add('hidden');
    });
    list.querySelectorAll('[data-view-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const view = mcAppsSavedViews.find((v) => String(v.id) === btn.dataset.viewId);
        if (view) applyMcAppsViewConfig(view.config, view.id);
        document.getElementById('mcapps-views-dropdown').classList.add('hidden');
      });
    });
    list.querySelectorAll('[data-view-delete]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.viewDelete;
        if (mcAppsActiveViewId === String(id)) mcAppsActiveViewId = null;
        try {
          await fetch(`/api/views/mcapps/${id}`, { method: 'DELETE' });
          await loadMcAppsViews();
        } catch (_) {}
      });
    });
  }

  async function saveMcAppsView() {
    const name = window.prompt('Name this view (e.g. "Active Android apps"):');
    if (!name || !name.trim()) return;
    try {
      const res = await fetch('/api/views/mcapps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), config: currentMcAppsViewConfig() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save view');
      mcAppsActiveViewId = String(data.id);
      await loadMcAppsViews();
    } catch (e) {
      alert('Could not save view: ' + e.message);
    }
  }

  async function loadMcAppsIfNeeded() {
    if (mcAppsLoaded) return;
    await fetchMcApps();
  }

  async function fetchMcApps() {
    const body    = document.getElementById('mcapps-table-body');
    const banner  = document.getElementById('mcapps-error-banner');
    const message = document.getElementById('mcapps-error-message');
    hideError(banner);
    body.innerHTML = '<tr class="table-placeholder"><td colspan="9">Loading apps&hellip;</td></tr>';
    try {
      const [entRes, playRes, iosEntRes, appleStoreRes, macEntRes] = await Promise.all([
        fetch('/api/mc/apps/enterprise'),
        fetch('/api/mc/apps/googleplay'),
        fetch('/api/mc/apps/ios-enterprise'),
        fetch('/api/mc/apps/apple-appstore'),
        fetch('/api/mc/apps/macos-enterprise'),
      ]);
      const entData        = await entRes.json();
      const playData       = await playRes.json().catch(() => ({}));
      const iosEntData     = await iosEntRes.json().catch(() => ({}));
      const appleStoreData = await appleStoreRes.json().catch(() => ({}));
      const macEntData     = await macEntRes.json().catch(() => ({}));
      if (!entRes.ok) throw new Error(entData.error || `Request failed (${entRes.status})`);

      const entApps  = (entData.apps || []).map((a) => ({ ...a, _source: 'Enterprise', platform: 'android' }));
      // Play Store lookup failing (e.g. older MobiControl without the endpoint) shouldn't
      // block the enterprise catalog from showing — just log it and carry on with entApps only.
      const playApps = playRes.ok ? (playData.apps || []).map((a) => ({ ...a, _source: 'GooglePlayStore', platform: 'android' })) : [];
      if (!playRes.ok) console.error('[mcapps googleplay]', playData.error || `HTTP ${playRes.status}`);

      // Same treatment for iOS — an older MobiControl version (pre-2025.1.0) or a
      // permissions gap shouldn't block the rest of the catalog from rendering.
      const iosEntApps = iosEntRes.ok ? (iosEntData.apps || []).map((a) => ({ ...a, _source: 'Enterprise', platform: 'ios' })) : [];
      if (!iosEntRes.ok) console.error('[mcapps ios-enterprise]', iosEntData.error || `HTTP ${iosEntRes.status}`);

      // Public Apple App Store apps assigned via an "Apple" family app policy — the
      // iOS counterpart of Google Play Store apps.
      const appleStoreApps = appleStoreRes.ok ? (appleStoreData.apps || []).map((a) => ({ ...a, _source: 'AppleAppStore', platform: 'ios' })) : [];
      if (!appleStoreRes.ok) console.error('[mcapps apple-appstore]', appleStoreData.error || `HTTP ${appleStoreRes.status}`);

      const macEntApps = macEntRes.ok ? (macEntData.apps || []).map((a) => ({ ...a, _source: 'Enterprise', platform: 'macos' })) : [];
      if (!macEntRes.ok) console.error('[mcapps macos-enterprise]', macEntData.error || `HTTP ${macEntRes.status}`);

      mcApps = [...entApps, ...playApps, ...iosEntApps, ...appleStoreApps, ...macEntApps];
      mcAppsLoaded = true;
      mcAppsLastUpdatedText = new Date().toLocaleTimeString();
      if (activeTab === 'mcapps') elLastUpdated.textContent = mcAppsLastUpdatedText;
      renderMcAppsTable(mcApps);
      fetchMcAppActiveStatus(); // slower bulk lookup — table renders first, statuses fill in after
    } catch (e) {
      body.innerHTML = '';
      showError(banner, message, e.message);
    }
  }

  async function fetchMcAppActiveStatus() {
    try {
      const [entRes, playRes, appleRes] = await Promise.all([
        fetch('/api/mc/apps/enterprise/active-status'),
        fetch('/api/mc/apps/googleplay/active-status'),
        fetch('/api/mc/apps/apple/active-status'),
      ]);
      const entData   = await entRes.json();
      const playData  = await playRes.json().catch(() => ({}));
      const appleData = await appleRes.json().catch(() => ({}));
      if (!entRes.ok) throw new Error(entData.error || `Request failed (${entRes.status})`);
      if (!appleRes.ok) console.error('[mcapps apple active-status]', appleData.error || `HTTP ${appleRes.status}`);

      mcAppActiveStatus = {
        ...(entData.statuses || {}),
        ...(playRes.ok ? (playData.statuses || {}) : {}),
        ...(appleRes.ok ? (appleData.statuses || {}) : {}),
      };
      mcAppActiveStatusLoaded = true;
      renderMcAppsTable(mcApps);
    } catch (e) {
      console.error('[mcapps active-status]', e.message);
      mcAppActiveStatusLoaded = true; // stop showing "Checking…" even on failure
      renderMcAppsTable(mcApps);
    }
  }

  function updateMcAppsStats(apps) {
    const configurable = apps.filter((a) => a.AppConfigurationSchema).length;
    const androidCount = apps.filter((a) => a.platform === 'android').length;
    const iosCount      = apps.filter((a) => a.platform === 'ios').length;
    const macCount      = apps.filter((a) => a.platform === 'macos').length;
    document.getElementById('stat-mcapps-total').textContent         = apps.length;
    document.getElementById('stat-mcapps-configurable').textContent  = configurable;
    document.getElementById('stat-mcapps-android').textContent       = androidCount;
    document.getElementById('stat-mcapps-ios').textContent           = iosCount;
    document.getElementById('stat-mcapps-macos').textContent         = macCount;
  }

  function renderMcAppsTable(apps) {
    updateMcAppsStats(apps);

    const body      = document.getElementById('mcapps-table-body');
    const noResults = document.getElementById('mcapps-no-results');
    const term      = document.getElementById('mcapps-search').value.trim().toLowerCase();
    const source    = document.getElementById('mcapps-source-filter').value;
    const bySource  = source ? apps.filter((a) => a._source === source) : apps;
    const filtered  = term
      ? bySource.filter((a) => {
          const id     = a.ReferenceId || a.AppPackageId || '';
          const active = mcAppActiveStatus[id] ? mcAppActiveStatus[id].active : false;
          const statusText = active ? 'active' : 'inactive';
          return (a.AppName || '').toLowerCase().includes(term) ||
            (a.AppPackageId || '').toLowerCase().includes(term) ||
            (a.AppAuthor || '').toLowerCase().includes(term) ||
            statusText.includes(term);
        })
      : bySource;

    if (!apps.length) {
      noResults.classList.add('hidden');
      body.innerHTML = '<tr class="table-placeholder"><td colspan="9">No apps found</td></tr>';
      return;
    }
    if (!filtered.length) {
      body.innerHTML = '';
      noResults.classList.remove('hidden');
      return;
    }
    noResults.classList.add('hidden');
    const sorted = sortMcApps(filtered);
    body.innerHTML = sorted.map((a) => buildMcAppRows(a)).join('');

    body.querySelectorAll('tr[data-app-id]').forEach((row) => {
      row.addEventListener('click', () => {
        const clickedId = row.dataset.appId;
        mcAppsExpandedId = mcAppsExpandedId === clickedId ? null : clickedId;
        clearMcAppliedToTimer();
        renderMcAppsTable(apps);
      });
    });

    body.querySelectorAll('[data-applied-to-action]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const appId = btn.dataset.appliedToAction;
        fetchMcAppliedTo(appId, apps);
      });
    });

    body.querySelectorAll('.view-app-schema-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const appId = btn.dataset.appId;
        const app = apps.find((a) => (a.ReferenceId || a.AppPackageId) === appId);
        if (!app || !app.AppConfigurationSchema) return;
        let parsed = null;
        try { parsed = JSON.parse(app.AppConfigurationSchema); } catch (_) {}
        if (parsed !== null) openConfigViewerModal(`${app.AppName} — Configuration Schema`, parsed);
      });
    });

    body.querySelectorAll('.view-app-config-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const appId = btn.dataset.appId;
        const app = apps.find((a) => (a.ReferenceId || a.AppPackageId) === appId);
        if (!app || !app.AppConfiguration) return;
        let parsed = null;
        try { parsed = JSON.parse(app.AppConfiguration); } catch (_) {}
        if (parsed !== null) openConfigViewerModal(`${app.AppName} — Applied Configuration`, parsed);
      });
    });

    body.querySelectorAll('[data-config-by-policy-action]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const appId = btn.dataset.configByPolicyAction;
        fetchMcAppConfigsByPolicy(appId, apps);
      });
    });

    body.querySelectorAll('.view-app-policy-config-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const appId = btn.dataset.appId;
        const app = apps.find((a) => (a.ReferenceId || a.AppPackageId) === appId);
        const state = mcAppConfigsByPolicy[appId];
        if (!app || !state || state.status !== 'loaded') return;
        const c = (state.data.configs || [])[Number(btn.dataset.configIndex)];
        if (!c || !c.appConfiguration) return;
        let parsed = null;
        try { parsed = JSON.parse(c.appConfiguration); } catch (_) {}
        if (parsed !== null) openConfigViewerModal(`${app.AppName} — ${c.policyName}`, parsed);
      });
    });

    body.querySelectorAll('.view-policy-log-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openPolicyLogsModal(btn.dataset.policyRef, btn.dataset.policyName);
      });
    });

    body.querySelectorAll('.mcapp-log-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openMcAppLogsModal(btn.dataset.logApp, btn.dataset.logDevice, btn.dataset.logRule);
      });
    });

    body.querySelectorAll('.applied-to-policy-toggle').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = el.dataset.policyToggle;
        const currentlyExpanded = mcAppliedToPolicyExpanded[key] ?? el.querySelector('.applied-to-chevron').textContent === '▾';
        mcAppliedToPolicyExpanded[key] = !currentlyExpanded;
        renderMcAppsTable(apps);
      });
    });

    body.querySelectorAll('.export-app-assignments-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const appId = btn.dataset.appId;
        const app   = apps.find((a) => (a.ReferenceId || a.AppPackageId) === appId);
        const state = mcAppliedTo[appId];
        if (!app || !state || state.status !== 'loaded') return;

        const groups  = (state.data.groups  || []).filter((g) => !g.excluded);
        const devices = (state.data.devices || []).filter((d) => !d.excluded);
        const rows = [
          ...groups.flatMap((g) => devicesForGroupPath(g.path).map((d) => ({
            App: app.AppName, Policy: g.policyName, Group: g.path, Device: d.name, AssignmentType: 'Group',
          }))),
          ...devices.map((d) => ({
            App: app.AppName, Policy: d.policyName, Group: d.parentPath, Device: d.deviceName, AssignmentType: 'Individual',
          })),
        ];
        downloadCsv(`${app.AppName}-assignments.csv`, rows);
      });
    });
  }

  function clearMcAppliedToTimer() {
    if (mcAppliedToTimer) { clearInterval(mcAppliedToTimer); mcAppliedToTimer = null; }
  }

  async function fetchMcAppliedTo(appId, apps) {
    mcAppliedTo[appId] = { ...(mcAppliedTo[appId] || {}), status: 'loading' };
    renderMcAppsTable(apps);

    // Applied-to devices are cross-referenced against the MobiControl device list;
    // make sure it's actually loaded (user may not have visited the Devices tab yet).
    if (!mc.devices.length) await refreshMc();

    const app = mcApps.find((a) => (a.ReferenceId || a.AppPackageId) === appId);
    let endpoint;
    if (app && app._source === 'GooglePlayStore') endpoint = `/api/mc/apps/googleplay/${encodeURIComponent(appId)}/applied-to`;
    else if (app && app.platform === 'ios') endpoint = `/api/mc/apps/apple/${encodeURIComponent(appId)}/applied-to`;
    else endpoint = `/api/mc/apps/enterprise/${encodeURIComponent(appId)}/applied-to`;

    try {
      const res  = await fetch(endpoint);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      mcAppliedTo[appId] = {
        status: 'loaded',
        data,
        lastUpdatedText: new Date(data.lastUpdated).toLocaleTimeString(),
      };
      clearMcAppliedToTimer();
      mcAppliedToTimer = setInterval(() => fetchMcAppliedTo(appId, mcApps), MC_APPLIED_TO_REFRESH_MS);
    } catch (e) {
      mcAppliedTo[appId] = { status: 'error', error: e.message };
    }
    renderMcAppsTable(apps);
  }

  // Which per-policy configs endpoint applies to a given app, or null if this
  // app's platform/source doesn't have one (falls back to the static single-value view).
  function mcAppConfigsEndpoint(app) {
    if (!app) return null;
    if (app._source === 'GooglePlayStore') return `/api/mc/apps/googleplay/${encodeURIComponent(app.AppPackageId)}/configs`;
    if (app._source === 'Enterprise' && app.platform === 'android') return `/api/mc/apps/enterprise/${encodeURIComponent(app.ReferenceId)}/configs`;
    if ((app._source === 'AppleAppStore' || app._source === 'Enterprise') && app.platform === 'ios') return `/api/mc/apps/apple/${encodeURIComponent(app.ReferenceId)}/configs`;
    return null;
  }

  async function fetchMcAppConfigsByPolicy(appId, apps) {
    mcAppConfigsByPolicy[appId] = { status: 'loading' };
    renderMcAppsTable(apps);

    const app = apps.find((a) => (a.ReferenceId || a.AppPackageId) === appId);
    const endpoint = mcAppConfigsEndpoint(app);
    if (!endpoint) {
      mcAppConfigsByPolicy[appId] = { status: 'error', error: 'No per-policy config lookup available for this app' };
      renderMcAppsTable(apps);
      return;
    }

    try {
      const res  = await fetch(endpoint);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      mcAppConfigsByPolicy[appId] = { status: 'loaded', data };
    } catch (e) {
      mcAppConfigsByPolicy[appId] = { status: 'error', error: e.message };
    }
    renderMcAppsTable(apps);
  }

  function buildAppConfigsByPolicyBlock(appId) {
    const state = mcAppConfigsByPolicy[appId];
    if (!state || state.status === 'idle') {
      return `<button type="button" class="btn-clear" data-config-by-policy-action="${esc(appId)}">Show configuration by policy</button>`;
    }
    if (state.status === 'loading') {
      return '<span class="cell-na">Loading configuration per policy&hellip;</span>';
    }
    if (state.status === 'error') {
      return `<span class="cell-na">Failed to load: ${esc(state.error)}</span>
        <button type="button" class="btn-clear" data-config-by-policy-action="${esc(appId)}">Retry</button>`;
    }

    const configs = state.data.configs || [];
    if (!configs.length) {
      return '<span class="cell-na">No policy currently includes this app</span>';
    }

    return configs.map((c, i) => {
      let parsed = null;
      if (c.appConfiguration) { try { parsed = JSON.parse(c.appConfiguration); } catch (_) {} }
      const perms = c.permissions || [];
      const permsList = perms.length
        ? `<ul class="mcapp-perm-list">${perms.map((p) => `
            <li>
              <strong>${esc(p.name)}</strong>${p.description ? ` — ${esc(p.description)}` : ''}
              <span class="badge${p.state === 'Allow' ? ' badge--online' : ' badge--compliance-fail'}" style="margin-left:6px;">${esc(p.state)}</span>
            </li>`).join('')}</ul>`
        : '<span class="cell-na">No permissions set by this policy</span>';

      return `
        <div class="detail-profile" style="margin-bottom:8px;">
          <div class="detail-profile-header">
            <strong>${esc(c.policyName)}</strong>
            <span class="badge${c.policyStatus === 'Assigned' ? ' badge--online' : ' badge--compliance-unknown'}">${esc(c.policyStatus)}</span>
            <button type="button" class="btn btn--sm view-policy-log-btn" data-policy-ref="${esc(c.policyReferenceId)}" data-policy-name="${esc(c.policyName)}">View Full Policy Log</button>
            ${parsed !== null ? `<button type="button" class="btn btn--sm view-app-policy-config-btn" data-app-id="${esc(appId)}" data-config-index="${i}">Fullscreen / Export</button>` : ''}
          </div>
          <div style="margin:6px 0;"><strong style="font-size:0.8rem;">Permissions</strong>${permsList}</div>
          ${parsed !== null
            ? `<pre class="mcapp-schema">${highlightJson(parsed)}</pre>`
            : '<span class="cell-na">No configuration set by this policy</span>'}
        </div>`;
    }).join('');
  }

  // Devices explicitly targeted by group (respecting subgroups) — cross-referenced
  // against the already-loaded MobiControl device list rather than a second API call.
  function devicesForGroupPath(groupPath) {
    return mc.devices.filter((d) =>
      d.groupPath === groupPath || (d.groupPath || '').startsWith(groupPath + '\\'));
  }

  function buildMcAppIconCell(a) {
    let src = null;
    if (a._source === 'GooglePlayStore' && a.AppIconUrl) src = a.AppIconUrl;
    else if (a._source === 'AppleAppStore' && a._appleIconReferenceId) src = `/api/mc/apps/apple/${encodeURIComponent(a._appleIconReferenceId)}/icon`;
    else if (a.platform === 'ios' && a.ReferenceId) src = `/api/mc/apps/ios-enterprise/${encodeURIComponent(a.ReferenceId)}/icon`;
    else if (a.platform === 'macos' && a.ReferenceId) src = `/api/mc/apps/macos-enterprise/${encodeURIComponent(a.ReferenceId)}/icon`;
    else if (a.ReferenceId) src = `/api/mc/apps/enterprise/${encodeURIComponent(a.ReferenceId)}/icon`;
    if (!src) return '<span class="mcapp-icon-placeholder"></span>';
    return `<img class="mcapp-icon" src="${esc(src)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'), {className:'mcapp-icon-placeholder'}))" />`;
  }

  function buildAppStatusBadge(appId) {
    if (!mcAppActiveStatusLoaded) return '<span class="cell-na">Checking&hellip;</span>';
    const entry  = mcAppActiveStatus[appId];
    const active = !!(entry && entry.active);
    return active
      ? '<span class="badge badge--online"><span class="badge-dot"></span>Active</span>'
      : '<span class="badge badge--compliance-unknown">Inactive</span>';
  }

  function mcAppPermissions(a) {
    return a._source === 'GooglePlayStore' ? (a.AvailableAppPermissions || []) : (a.Permissions || []);
  }

  function mcAppOriginLabel(a) {
    if (a._source === 'GooglePlayStore') return 'Google Play';
    if (a._source === 'AppleAppStore') return 'App Store';
    return a.AppOriginType || '';
  }

  function buildMcAppRows(a) {
    const id         = a.ReferenceId || a.AppPackageId || '';
    const perms      = mcAppPermissions(a);
    const isExpanded = mcAppsExpandedId === id;

    const mainRow = `
      <tr data-app-id="${esc(id)}" class="row-clickable">
        <td>${buildMcAppIconCell(a)}</td>
        <td>${esc(a.AppName) || '<span class="cell-na">—</span>'}</td>
        <td>${buildPlatformBadge(a.platform)}</td>
        <td>${esc(a.AppVersion) || '<span class="cell-na">—</span>'}</td>
        <td>${esc(a.AppAuthor) || '<span class="cell-na">—</span>'}</td>
        <td>${esc(a.AppPackageId) || '<span class="cell-na">—</span>'}</td>
        <td>${esc(mcAppOriginLabel(a)) || '<span class="cell-na">—</span>'}</td>
        <td>${perms.length}</td>
        <td>${buildAppStatusBadge(id)}</td>
      </tr>`;

    if (!isExpanded) return mainRow;

    const permsList = perms.length
      ? `<ul class="mcapp-perm-list">${perms.map((p) =>
          `<li><strong>${esc(p.Name)}</strong>${p.Description ? ` — ${esc(p.Description)}` : ''}</li>`).join('')}</ul>`
      : '<span class="cell-na">No permissions listed</span>';

    const supportsPolicyConfigs = mcAppConfigsEndpoint(a) !== null;

    let configSectionHtml;
    if (supportsPolicyConfigs) {
      configSectionHtml = `
        <h4>Configuration by Policy</h4>
        <p class="cell-na">This app can be configured differently by each policy that includes it — shown separately below.</p>
        ${buildAppConfigsByPolicyBlock(id)}`;
    } else {
      let configBlock = '<span class="cell-na">No configuration applied</span>';
      let configViewBtn = '';
      if (a.AppConfiguration) {
        let parsed = null;
        try { parsed = JSON.parse(a.AppConfiguration); } catch (_) {}
        const html = parsed !== null ? highlightJson(parsed) : esc(a.AppConfiguration);
        configBlock = `<pre class="mcapp-schema">${html}</pre>`;
        if (parsed !== null) configViewBtn = `<button type="button" class="btn btn--sm view-app-config-btn" data-app-id="${esc(id)}">Fullscreen / Export</button>`;
      }

      let schemaBlock = '<span class="cell-na">No configuration schema</span>';
      let schemaViewBtn = '';
      if (a.AppConfigurationSchema) {
        let parsed = null;
        try { parsed = JSON.parse(a.AppConfigurationSchema); } catch (_) {}
        const html = parsed !== null ? highlightJson(parsed) : esc(a.AppConfigurationSchema);
        schemaBlock = `<pre class="mcapp-schema">${html}</pre>`;
        if (parsed !== null) schemaViewBtn = `<button type="button" class="btn btn--sm view-app-schema-btn" data-app-id="${esc(id)}">Fullscreen / Export</button>`;
      }

      configSectionHtml = `
        <div class="detail-profile-header" style="justify-content:flex-start;"><h4 style="margin:0;">Applied Configuration</h4>${configViewBtn}</div>
        ${configBlock}
        <div class="detail-profile-header" style="justify-content:flex-start;"><h4 style="margin:0;">Configuration Schema</h4>${schemaViewBtn}</div>
        ${schemaBlock}`;
    }

    return mainRow + `
      <tr class="mcapp-detail-row">
        <td colspan="9">
          <div class="mcapp-detail">
            ${a.AppDescription ? `<p>${esc(a.AppDescription)}</p>` : ''}
            <h4>Permissions</h4>
            ${permsList}
            ${configSectionHtml}
            <h4>Applied To</h4>
            ${buildAppliedToBlock(id, a.AppPackageId)}
          </div>
        </td>
      </tr>`;
  }

  function buildAppliedToBlock(appId, appPackageId) {
    const state = mcAppliedTo[appId];
    // Per-device log lookups (appFeedbackDetails) are confirmed to only work for
    // Android Enterprise apps — Google Play and Apple apps return "invalid reference"
    // errors even with correct device/policy IDs, so hide the button for those.
    const logApp = mcApps.find((a) => (a.ReferenceId || a.AppPackageId) === appId) || {};
    const supportsLogs = logApp._source === 'Enterprise' && logApp.platform === 'android';

    if (!state || state.status === 'idle') {
      return `<button type="button" class="btn-clear" data-applied-to-action="${esc(appId)}">Show where this is applied</button>`;
    }
    if (state.status === 'loading') {
      return '<span class="cell-na">Loading applied groups &amp; devices&hellip;</span>';
    }
    if (state.status === 'error') {
      return `
        <div style="color: var(--color-offline); margin-bottom: 8px;">${esc(state.error)}</div>
        <button type="button" class="btn-clear" data-applied-to-action="${esc(appId)}">Retry</button>`;
    }

    const { data, lastUpdatedText } = state;
    const groups  = (data.groups  || []).filter((g) => !g.excluded);
    const devices = (data.devices || []).filter((d) => !d.excluded);

    if (!groups.length && !devices.length) {
      return `
        <span class="cell-na">Not currently assigned to any group or device.</span>
        <div class="mcapp-applied-footer">
          Last checked ${esc(lastUpdatedText)}
          <button type="button" class="btn-clear" data-applied-to-action="${esc(appId)}">Refresh</button>
        </div>`;
    }

    const exportBtn = `<button type="button" class="btn btn--sm export-app-assignments-btn" data-app-id="${esc(appId)}">Export</button>`;

    // Group everything by policy first — a policy is the actual unit of assignment,
    // so seeing "this policy covers these groups/devices" beats reading a policy
    // badge on every individual group/device row.
    const byPolicy = new Map();
    const policyKeyOf = (p) => p.policyReferenceId || p.policyName || 'unknown';
    groups.forEach((g) => {
      const key = policyKeyOf(g);
      if (!byPolicy.has(key)) byPolicy.set(key, { policyName: g.policyName, groups: [], devices: [] });
      byPolicy.get(key).groups.push(g);
    });
    devices.forEach((d) => {
      const key = policyKeyOf(d);
      if (!byPolicy.has(key)) byPolicy.set(key, { policyName: d.policyName, groups: [], devices: [] });
      byPolicy.get(key).devices.push(d);
    });

    const policyEntries = [...byPolicy.entries()];
    const singlePolicy = policyEntries.length === 1;

    const policyBlocks = policyEntries.map(([policyKey, entry]) => {
      const groupTotal  = entry.groups.reduce((sum, g) => sum + devicesForGroupPath(g.path).length, 0);
      const totalDevices = groupTotal + entry.devices.length;
      const stateKey = `${appId}::${policyKey}`;
      const isExpanded = mcAppliedToPolicyExpanded[stateKey] ?? singlePolicy;

      const groupBlocks = entry.groups.map((g) => {
        const groupDevices = devicesForGroupPath(g.path)
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        const deviceItems = groupDevices.length
          ? `<ul class="mcapp-perm-list">${groupDevices.map((d) => `
              <li>${esc(d.name)}
                ${supportsLogs ? `<button type="button" class="mcapp-log-btn" data-log-app="${esc(appPackageId)}" data-log-device="${esc(d.id)}" data-log-rule="${esc(g.policyReferenceId)}">View logs</button>` : ''}
              </li>`).join('')}</ul>`
          : '<span class="cell-na">No matching devices currently online in our device list</span>';
        return `
          <div class="mcapp-group-block">
            <div class="mcapp-group-path">${esc(g.path)} <span class="cell-na">(${groupDevices.length} device${groupDevices.length === 1 ? '' : 's'})</span></div>
            ${deviceItems}
          </div>`;
      }).join('');

      const sortedDevices = entry.devices.slice().sort((a, b) => (a.deviceName || '').localeCompare(b.deviceName || '', undefined, { numeric: true }));
      const individualBlock = entry.devices.length
        ? `<div class="mcapp-group-block">
            <div class="mcapp-group-path">Individually assigned devices</div>
            <ul class="mcapp-perm-list">${sortedDevices.map((d) => `
              <li>${esc(d.deviceName)} <span class="cell-na">(${esc(d.parentPath)})</span>
                ${supportsLogs ? `<button type="button" class="mcapp-log-btn" data-log-app="${esc(appPackageId)}" data-log-device="${esc(d.deviceId)}" data-log-rule="${esc(d.policyReferenceId)}">View logs</button>` : ''}
              </li>`).join('')}</ul>
          </div>`
        : '';

      return `
        <div class="detail-profile" style="margin-bottom:8px;">
          <div class="detail-profile-header applied-to-policy-toggle" data-policy-toggle="${esc(stateKey)}" style="cursor:pointer;">
            <span class="applied-to-chevron">${isExpanded ? '▾' : '▸'}</span>
            <strong>${esc(entry.policyName)}</strong>
            <span class="cell-na">(${entry.groups.length} group${entry.groups.length === 1 ? '' : 's'}, ${entry.devices.length} individual device${entry.devices.length === 1 ? '' : 's'}, ${totalDevices} total)</span>
          </div>
          ${isExpanded ? `<div style="margin-top:8px;">${groupBlocks}${individualBlock}</div>` : ''}
        </div>`;
    }).join('');

    return `
      <div style="text-align:right;margin-bottom:6px;">${exportBtn}</div>
      ${policyBlocks}
      <div class="mcapp-applied-footer">
        Last checked ${esc(lastUpdatedText)} · auto-refreshes every 15 min
        <button type="button" class="btn-clear" data-applied-to-action="${esc(appId)}">Refresh</button>
      </div>`;
  }

  // ─── App Logs modal ──────────────────────────────────────────────────────────

  const mcAppLogsModal = { appId: null, deviceId: null, ruleReferenceId: null, el: {} };

  function initMcAppLogsModal() {
    const e = mcAppLogsModal.el;
    e.backdrop = document.getElementById('mcapp-logs-modal-backdrop');
    e.title    = document.getElementById('mcapp-logs-modal-title');
    e.start    = document.getElementById('mcapp-logs-start');
    e.end      = document.getElementById('mcapp-logs-end');
    e.severity = document.getElementById('mcapp-logs-severity');
    e.fetchBtn = document.getElementById('mcapp-logs-fetch');
    e.errorEl  = document.getElementById('mcapp-logs-error');
    e.body     = document.getElementById('mcapp-logs-body');
    e.closeBtn = document.getElementById('mcapp-logs-modal-close');

    e.closeBtn.addEventListener('click', closeMcAppLogsModal);
    e.backdrop.addEventListener('click', (ev) => { if (ev.target === e.backdrop) closeMcAppLogsModal(); });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !e.backdrop.classList.contains('hidden')) closeMcAppLogsModal();
    });
    e.fetchBtn.addEventListener('click', fetchMcAppLogs);
  }

  function openMcAppLogsModal(appId, deviceId, ruleReferenceId) {
    mcAppLogsModal.appId = appId;
    mcAppLogsModal.deviceId = deviceId;
    mcAppLogsModal.ruleReferenceId = ruleReferenceId;

    const e = mcAppLogsModal.el;
    const app = mcApps.find((a) => a.AppPackageId === appId || a.ReferenceId === appId);
    e.title.textContent = app ? `Application Logs — ${app.AppName}` : 'Application Logs';
    e.errorEl.classList.add('hidden');
    e.body.innerHTML = '<div class="cell-na" style="padding:16px 0;">Pick a date range and click Load Logs.</div>';
    e.severity.value = '';

    if (!deviceId || !ruleReferenceId) {
      e.errorEl.textContent = 'Missing device or policy reference — cannot look up logs for this entry.';
      e.errorEl.classList.remove('hidden');
    }

    e.backdrop.classList.remove('hidden');
  }

  function closeMcAppLogsModal() {
    mcAppLogsModal.el.backdrop.classList.add('hidden');
  }

  async function fetchMcAppLogs() {
    const e = mcAppLogsModal.el;
    const { appId, deviceId, ruleReferenceId } = mcAppLogsModal;
    if (!deviceId || !ruleReferenceId) return;

    const startVal = e.start.value;
    const endVal   = e.end.value;
    if (!startVal || !endVal) {
      e.errorEl.textContent = 'Start and end date/time are required.';
      e.errorEl.classList.remove('hidden');
      return;
    }

    const severities = e.severity.value ? [e.severity.value] : [];
    e.errorEl.classList.add('hidden');
    e.body.innerHTML = '<div class="cell-na" style="padding:16px 0;">Loading&hellip;</div>';

    try {
      const params = new URLSearchParams({
        deviceId,
        ruleReferenceId,
        startDate: new Date(startVal).toISOString(),
        endDate: new Date(endVal).toISOString(),
      });
      severities.forEach((s) => params.append('severities', s));

      const res  = await fetch(`/api/mc/apps/enterprise/${encodeURIComponent(appId)}/logs?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      renderMcAppLogs(data.logs || []);
    } catch (err) {
      e.body.innerHTML = '';
      e.errorEl.textContent = err.message;
      e.errorEl.classList.remove('hidden');
    }
  }

  function renderMcAppLogs(logs) {
    const body = mcAppLogsModal.el.body;
    if (!logs.length) {
      body.innerHTML = '<div class="cell-na" style="padding:16px 0;">No log entries found for this range.</div>';
      return;
    }
    body.innerHTML = `
      <table class="printer-table">
        <thead><tr><th>Timestamp</th><th>Severity</th><th>Configuration</th><th>Message</th></tr></thead>
        <tbody>
          ${logs.map((l) => `
            <tr>
              <td class="cell-lastseen">${l.Timestamp ? new Date(l.Timestamp).toLocaleString() : '<span class="cell-na">—</span>'}</td>
              <td>${buildLogSeverityBadge(l.Severity)}</td>
              <td>${esc(l.Configuration) || '<span class="cell-na">—</span>'}</td>
              <td>${esc(l.Message) || '<span class="cell-na">—</span>'}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  function buildLogSeverityBadge(severity) {
    if (severity === 'Error') return '<span class="badge badge--compliance-fail">Error</span>';
    if (severity === 'Info')  return '<span class="badge badge--compliance-ok">Info</span>';
    return '<span class="badge badge--compliance-unknown">Unspecified</span>';
  }

  // ─── Full Policy Log modal ───────────────────────────────────────────────────
  // Shows every logged event for a policy across ALL devices, not scoped to one
  // device like the Application Logs modal above.

  const policyLogsModal = { policyReferenceId: null, el: {} };

  function initPolicyLogsModal() {
    const e = policyLogsModal.el;
    e.backdrop = document.getElementById('policy-logs-modal-backdrop');
    e.title    = document.getElementById('policy-logs-modal-title');
    e.start    = document.getElementById('policy-logs-start');
    e.end      = document.getElementById('policy-logs-end');
    e.severity = document.getElementById('policy-logs-severity');
    e.fetchBtn = document.getElementById('policy-logs-fetch');
    e.errorEl  = document.getElementById('policy-logs-error');
    e.body     = document.getElementById('policy-logs-body');
    e.closeBtn = document.getElementById('policy-logs-modal-close');

    e.closeBtn.addEventListener('click', closePolicyLogsModal);
    e.backdrop.addEventListener('click', (ev) => { if (ev.target === e.backdrop) closePolicyLogsModal(); });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !e.backdrop.classList.contains('hidden')) closePolicyLogsModal();
    });
    e.fetchBtn.addEventListener('click', fetchPolicyLogs);
  }

  function openPolicyLogsModal(policyReferenceId, policyName) {
    policyLogsModal.policyReferenceId = policyReferenceId;
    const e = policyLogsModal.el;
    e.title.textContent = `Policy Log — ${policyName}`;
    e.errorEl.classList.add('hidden');
    e.body.innerHTML = '<div class="cell-na" style="padding:16px 0;">Pick a date range and click Load Logs.</div>';
    e.severity.value = '';
    e.backdrop.classList.remove('hidden');
  }

  function closePolicyLogsModal() {
    policyLogsModal.el.backdrop.classList.add('hidden');
  }

  async function fetchPolicyLogs() {
    const e = policyLogsModal.el;
    const { policyReferenceId } = policyLogsModal;
    if (!policyReferenceId) return;

    const startVal = e.start.value;
    const endVal   = e.end.value;
    if (!startVal || !endVal) {
      e.errorEl.textContent = 'Start and end date/time are required.';
      e.errorEl.classList.remove('hidden');
      return;
    }

    e.errorEl.classList.add('hidden');
    e.body.innerHTML = '<div class="cell-na" style="padding:16px 0;">Loading&hellip;</div>';

    try {
      const params = new URLSearchParams({
        startDate: new Date(startVal).toISOString(),
        endDate: new Date(endVal).toISOString(),
      });
      if (e.severity.value) params.append('logSeverities', e.severity.value);

      const res  = await fetch(`/api/mc/apps/policies/${encodeURIComponent(policyReferenceId)}/logs?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      renderPolicyLogs(data.logs || []);
    } catch (err) {
      e.body.innerHTML = '';
      e.errorEl.textContent = err.message;
      e.errorEl.classList.remove('hidden');
    }
  }

  function renderPolicyLogs(logs) {
    const body = policyLogsModal.el.body;
    if (!logs.length) {
      body.innerHTML = '<div class="cell-na" style="padding:16px 0;">No log entries found for this range.</div>';
      return;
    }
    body.innerHTML = `
      <table class="printer-table">
        <thead><tr><th>Timestamp</th><th>Severity</th><th>Source</th><th>Message</th></tr></thead>
        <tbody>
          ${logs.map((l) => `
            <tr>
              <td class="cell-lastseen">${l.TimeStamp ? new Date(l.TimeStamp).toLocaleString() : '<span class="cell-na">—</span>'}</td>
              <td>${buildEventSeverityBadge(l.EventSeverity)}</td>
              <td>${esc(l.SourceName) || '<span class="cell-na">—</span>'}</td>
              <td>${esc(l.Message) || '<span class="cell-na">—</span>'}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  // Downloads an array of flat objects as a CSV file — used for sharing app/policy
  // assignment data with people who just want to open it in Excel, not JSON.
  function downloadCsv(filename, rows) {
    if (!rows.length) return;
    const headers = Object.keys(rows[0]);
    const escCsv = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(','), ...rows.map((r) => headers.map((h) => escCsv(r[h])).join(','))];
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = filename.replace(/[^a-z0-9-_. ]+/gi, '_');
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ─── Configuration Viewer modal ──────────────────────────────────────────────

  const configViewerModal = { el: {}, currentLabel: '', currentJson: '' };

  function initConfigViewerModal() {
    const e = configViewerModal.el;
    e.backdrop    = document.getElementById('config-viewer-modal-backdrop');
    e.title       = document.getElementById('config-viewer-modal-title');
    e.body        = document.getElementById('config-viewer-body');
    e.closeBtn    = document.getElementById('config-viewer-modal-close');
    e.copyBtn     = document.getElementById('config-viewer-copy');
    e.downloadBtn = document.getElementById('config-viewer-download');

    e.closeBtn.addEventListener('click', closeConfigViewerModal);
    e.backdrop.addEventListener('click', (ev) => { if (ev.target === e.backdrop) closeConfigViewerModal(); });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !e.backdrop.classList.contains('hidden')) closeConfigViewerModal();
    });

    e.copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(configViewerModal.currentJson);
        e.copyBtn.textContent = 'Copied!';
        setTimeout(() => { e.copyBtn.textContent = 'Copy JSON'; }, 1500);
      } catch (_) {
        e.copyBtn.textContent = 'Copy failed';
        setTimeout(() => { e.copyBtn.textContent = 'Copy JSON'; }, 1500);
      }
    });

    e.downloadBtn.addEventListener('click', () => {
      const blob = new Blob([configViewerModal.currentJson], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url;
      a.download = `${(configViewerModal.currentLabel || 'configuration').replace(/[^a-z0-9-_]+/gi, '_')}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  }

  function openConfigViewerModal(label, fields) {
    const e = configViewerModal.el;
    configViewerModal.currentLabel = label;
    configViewerModal.currentJson  = JSON.stringify(fields, null, 2);
    e.title.textContent = label;
    e.body.innerHTML = highlightJson(fields);
    e.backdrop.classList.remove('hidden');
  }

  function closeConfigViewerModal() {
    configViewerModal.el.backdrop.classList.add('hidden');
  }

  // ─── Device Compare modal ────────────────────────────────────────────────────

  const deviceCompareModal = { el: {} };

  function initDeviceCompareModal() {
    const e = deviceCompareModal.el;
    e.backdrop = document.getElementById('device-compare-modal-backdrop');
    e.title    = document.getElementById('device-compare-modal-title');
    e.errorEl  = document.getElementById('device-compare-error');
    e.body     = document.getElementById('device-compare-body');
    e.closeBtn = document.getElementById('device-compare-modal-close');

    e.closeBtn.addEventListener('click', closeDeviceCompareModal);
    e.backdrop.addEventListener('click', (ev) => { if (ev.target === e.backdrop) closeDeviceCompareModal(); });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !e.backdrop.classList.contains('hidden')) closeDeviceCompareModal();
    });
  }

  function closeDeviceCompareModal() {
    deviceCompareModal.el.backdrop.classList.add('hidden');
  }

  async function openDeviceCompareModal(idA, idB) {
    const e = deviceCompareModal.el;
    const deviceA = mc.devices.find((d) => d.id === idA);
    const deviceB = mc.devices.find((d) => d.id === idB);
    e.title.textContent = `Compare Devices — ${deviceA ? deviceA.name : idA} vs ${deviceB ? deviceB.name : idB}`;
    e.errorEl.classList.add('hidden');
    e.body.innerHTML = '<div class="cell-na" style="padding:16px 0;">Loading profile comparison&hellip;</div>';
    e.backdrop.classList.remove('hidden');

    try {
      const [resA, resB] = await Promise.all([
        fetch(`/api/mc/devices/${encodeURIComponent(idA)}/profiles`),
        fetch(`/api/mc/devices/${encodeURIComponent(idB)}/profiles`),
      ]);
      const dataA = await resA.json();
      const dataB = await resB.json();
      if (!resA.ok) throw new Error(dataA.error || `Request failed (${resA.status})`);
      if (!resB.ok) throw new Error(dataB.error || `Request failed (${resB.status})`);

      renderDeviceCompare(deviceA, deviceB, dataA.profiles || [], dataB.profiles || []);
    } catch (err) {
      e.body.innerHTML = '';
      e.errorEl.textContent = err.message;
      e.errorEl.classList.remove('hidden');
    }
  }

  function renderDeviceCompare(deviceA, deviceB, profilesA, profilesB) {
    const e = deviceCompareModal.el;
    const byNameA = new Map(profilesA.map((p) => [p.Name, p]));
    const byNameB = new Map(profilesB.map((p) => [p.Name, p]));
    const allNames = [...new Set([...byNameA.keys(), ...byNameB.keys()])].sort();

    const rows = allNames.map((name) => {
      const pA = byNameA.get(name);
      const pB = byNameB.get(name);
      const statusA = pA ? pA.Status : 'Not present';
      const statusB = pB ? pB.Status : 'Not present';
      const isDiff = statusA !== statusB;
      return `
        <tr class="${isDiff ? 'compare-row--diff' : ''}">
          <td>${esc(name)}</td>
          <td>${pA ? esc(statusA) : '<span class="cell-na">Not present</span>'}</td>
          <td>${pB ? esc(statusB) : '<span class="cell-na">Not present</span>'}</td>
        </tr>`;
    }).join('');

    const diffCount = allNames.filter((name) => (byNameA.get(name) ? byNameA.get(name).Status : 'Not present') !== (byNameB.get(name) ? byNameB.get(name).Status : 'Not present')).length;

    e.body.innerHTML = `
      <p class="cell-na">${diffCount ? `${diffCount} profile${diffCount === 1 ? '' : 's'} differ between these devices — highlighted below.` : 'No differences found — both devices have identical profile status.'}</p>
      <table class="printer-table">
        <thead>
          <tr>
            <th>Profile</th>
            <th class="compare-col-header">${esc(deviceA ? deviceA.name : 'Device A')}</th>
            <th class="compare-col-header">${esc(deviceB ? deviceB.name : 'Device B')}</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="3"><span class="cell-na">No profiles found on either device</span></td></tr>'}</tbody>
      </table>`;
  }

  // ─── MobiControl Profiles tab ────────────────────────────────────────────────

  const profilesTab = {
    lastUpdatedText: '',
    all:    [],
    loaded: false,
    sort:   { key: 'Name', dir: 'asc' },
  };

  function initProfilesList() {
    document.getElementById('profiles-list-search').addEventListener('input', renderProfilesList);
    document.getElementById('profiles-list-family-filter').addEventListener('change', renderProfilesList);
    document.getElementById('profiles-list-refresh').addEventListener('click', fetchProfilesList);
    document.getElementById('profiles-back-btn').addEventListener('click', showProfilesList);

    document.querySelectorAll('#profiles-list-table th[data-sort-profiles]').forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.dataset.sortProfiles;
        if (profilesTab.sort.key === key) profilesTab.sort.dir = profilesTab.sort.dir === 'asc' ? 'desc' : 'asc';
        else { profilesTab.sort.key = key; profilesTab.sort.dir = 'asc'; }
        renderProfilesList();
      });
    });
  }

  function showProfilesList() {
    document.getElementById('profiles-summary-grid').classList.remove('hidden');
    document.getElementById('profiles-list-section').classList.remove('hidden');
    document.getElementById('profiles-detail').classList.add('hidden');
    if (!profilesTab.loaded) fetchProfilesList();
  }

  async function fetchProfilesList() {
    const tbody = document.getElementById('profiles-list-table-body');
    tbody.innerHTML = '<tr class="table-placeholder"><td colspan="5">Loading profiles&hellip;</td></tr>';
    hideError(document.getElementById('profiles-error-banner'));
    try {
      const res  = await fetch('/api/mc/profiles');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

      profilesTab.all = data.profiles || [];
      profilesTab.loaded = true;
      profilesTab.lastUpdatedText = data.lastUpdated ? new Date(data.lastUpdated).toLocaleTimeString() : new Date().toLocaleTimeString();
      if (activeTab === 'profiles') elLastUpdated.textContent = profilesTab.lastUpdatedText;

      populateSelectFromData(document.getElementById('profiles-list-family-filter'), profilesTab.all.map((p) => p.DeviceFamily));

      updateProfilesStats(profilesTab.all);
      renderProfilesList();
    } catch (e) {
      tbody.innerHTML = '';
      showError(document.getElementById('profiles-error-banner'), document.getElementById('profiles-error-message'), e.message);
    }
  }

  function updateProfilesStats(profiles) {
    const assigned  = profiles.filter((p) => p.Status === 'Assigned').length;
    const disabled  = profiles.filter((p) => p.Status === 'Disabled' || p.Status === 'Draft').length;
    const attention = profiles.filter((p) => p.HasError || p.HasIncompleteVersion).length;
    document.getElementById('stat-profiles-total').textContent     = profiles.length;
    document.getElementById('stat-profiles-assigned').textContent  = assigned;
    document.getElementById('stat-profiles-disabled').textContent  = disabled;
    document.getElementById('stat-profiles-attention').textContent = attention;

    const familyCounts = {};
    profiles.forEach((p) => {
      const fam = p.DeviceFamily || 'Unknown';
      familyCounts[fam] = (familyCounts[fam] || 0) + 1;
    });
    const familyCardsEl = document.getElementById('profiles-family-cards');
    familyCardsEl.innerHTML = Object.keys(familyCounts).sort().map((fam) => `
      <div class="card card--total">
        <div class="card-label">${esc(fam)} Profiles</div>
        <div class="card-value">${familyCounts[fam]}</div>
      </div>`).join('');
  }

  function renderProfilesList() {
    const tbody   = document.getElementById('profiles-list-table-body');
    const noRes   = document.getElementById('profiles-list-no-results');
    const term    = document.getElementById('profiles-list-search').value.trim().toLowerCase();
    const family  = document.getElementById('profiles-list-family-filter').value;

    let filtered = profilesTab.all;
    if (family) filtered = filtered.filter((p) => p.DeviceFamily === family);
    if (term)   filtered = filtered.filter((p) => (p.Name || '').toLowerCase().includes(term));

    const { key, dir } = profilesTab.sort;
    const sorted = [...filtered].sort((a, b) => {
      let va = a[key], vb = b[key];
      if (key === 'LastModified') { va = va ? new Date(va).getTime() : 0; vb = vb ? new Date(vb).getTime() : 0; }
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return dir === 'asc' ? cmp : -cmp;
    });

    if (!profilesTab.all.length) {
      noRes.classList.add('hidden');
      tbody.innerHTML = '<tr class="table-placeholder"><td colspan="5">No profiles found</td></tr>';
      return;
    }
    if (!sorted.length) {
      tbody.innerHTML = '';
      noRes.classList.remove('hidden');
      return;
    }
    noRes.classList.add('hidden');
    tbody.innerHTML = sorted.map((p) => {
      const badProfile = p.HasError || p.HasIncompleteVersion;
      return `
      <tr class="row-clickable${badProfile ? ' row-alert' : ''}" data-profile-id="${esc(p.ReferenceId)}" data-profile-name="${esc(p.Name)}">
        <td>${badProfile ? '<span class="profile-status-bad">⚠</span> ' : ''}${esc(p.Name)}</td>
        <td>${esc(p.DeviceFamily) || '<span class="cell-na">—</span>'}</td>
        <td>${esc(p.Status) || '<span class="cell-na">—</span>'}</td>
        <td>${esc(p.ActiveVersionNumber)}</td>
        <td class="cell-lastseen">${p.LastModified ? relativeTime(new Date(p.LastModified)) : '<span class="cell-na">—</span>'}</td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('tr[data-profile-id]').forEach((row) => {
      row.addEventListener('click', () => navigateToProfile(row.dataset.profileId, row.dataset.profileName));
    });
  }

  function navigateToProfile(referenceId, name) {
    switchTab('profiles');
    document.getElementById('profiles-summary-grid').classList.add('hidden');
    document.getElementById('profiles-list-section').classList.add('hidden');
    const detailEl = document.getElementById('profiles-detail');
    const contentEl = document.getElementById('profiles-detail-content');
    detailEl.classList.remove('hidden');
    contentEl.innerHTML = `<div class="mcapp-detail"><span class="cell-na">Loading ${esc(name)}&hellip;</span></div>`;
    hideError(document.getElementById('profiles-error-banner'));
    fetchProfileDetail(referenceId, name);
  }

  function buildEventSeverityBadge(severity) {
    if (severity === 'Error')   return '<span class="badge badge--compliance-fail">Error</span>';
    if (severity === 'Warning') return '<span class="badge badge--compliance-unknown">Warning</span>';
    return '<span class="badge badge--compliance-ok">Information</span>';
  }

  async function fetchProfileDetail(referenceId, name) {
    const banner  = document.getElementById('profiles-error-banner');
    const message = document.getElementById('profiles-error-message');
    const detailEl = document.getElementById('profiles-detail-content');
    try {
      const [profRes, versRes, logsRes, payloadsRes] = await Promise.all([
        fetch(`/api/mc/profiles/${encodeURIComponent(referenceId)}`),
        fetch(`/api/mc/profiles/${encodeURIComponent(referenceId)}/versions`),
        fetch(`/api/mc/profiles/${encodeURIComponent(referenceId)}/logs`),
        fetch(`/api/mc/profiles/${encodeURIComponent(referenceId)}/payloads`),
      ]);
      const profData = await profRes.json();
      if (!profRes.ok) throw new Error(profData.error || `Request failed (${profRes.status})`);

      const versData     = await versRes.json().catch(() => ({}));
      const logsData     = await logsRes.json().catch(() => ({}));
      const payloadsData = await payloadsRes.json().catch(() => ({}));
      const profile   = profData.profile || {};
      const versions  = versRes.ok ? (versData.versions || []) : [];
      const logs      = logsRes.ok ? (logsData.logs || []) : [];
      const payloadInfo = payloadsRes.ok ? (payloadsData.payloadInfo || {}) : {};
      const configurations = payloadInfo.Payloads || [];

      const statusBad = profile.HasError || profile.HasIncompleteVersion;

      detailEl.innerHTML = `
        <div class="mcapp-detail">
          <div class="detail-profile-header" style="margin-bottom:12px;">
            ${statusBad ? '<span class="profile-status-bad">⚠</span> ' : ''}<strong style="font-size:1.05rem;">${esc(profile.Name || name)}</strong>
            <span class="badge${statusBad ? ' badge--compliance-unknown' : ' badge--online'}">${esc(profile.Status) || '—'}</span>
          </div>
          ${profile.Description ? `<p>${esc(profile.Description)}</p>` : ''}

          <h4>Overview</h4>
          <div class="detail-stat-grid">
            ${statRow('Device Family', profile.DeviceFamily)}
            ${statRow('Active Version', profile.ActiveVersionNumber)}
            ${statRow('Draft Version', profile.DraftVersionNumber)}
            ${statRow('Has Error', profile.HasError)}
            ${statRow('Has Incomplete Version', profile.HasIncompleteVersion)}
            ${statRow('Installation Priority', profile.InstallationPriority)}
            ${statRow('Assigned By', profile.AssignedBy)}
            ${statRow('Assigned Date', profile.AssignedDate ? new Date(profile.AssignedDate).toLocaleString() : null)}
            ${statRow('Last Modified By', profile.LastModifiedBy)}
            ${statRow('Last Modified', profile.LastModified ? new Date(profile.LastModified).toLocaleString() : null)}
          </div>

          <h4>Configurations</h4>
          ${configurations.length ? configurations.map((c, i) => {
            const label = c.UserSpecifiedName || c['$type'] || 'Configuration';
            const { '$type': _t, UserSpecifiedName: _n, ...fields } = c;
            const hasFields = Object.keys(fields).length > 0;
            return `
              <div class="detail-profile" style="margin-bottom:8px;">
                <div class="detail-profile-header">
                  <strong>${esc(label)}</strong>
                  ${hasFields ? `<button type="button" class="btn btn--sm view-config-btn" data-config-index="${i}" style="margin-left:auto;">Fullscreen / Export</button>` : ''}
                </div>
                ${hasFields ? `<pre class="mcapp-schema">${highlightJson(fields)}</pre>` : ''}
              </div>`;
          }).join('') : '<span class="cell-na">No configurations found (this profile may only deploy packages)</span>'}

          <h4>Versions</h4>
          ${versions.length ? `
            <table class="printer-table">
              <thead><tr><th>Version</th><th>Status</th><th>Payloads</th><th>Packages</th><th>Modified</th><th>Modified By</th></tr></thead>
              <tbody>
                ${versions.map((v) => `
                  <tr>
                    <td>${esc(v.VersionNumber)}</td>
                    <td>${esc(v.ProfileVersionStatus)}</td>
                    <td>${esc(v.PayloadsCount)}</td>
                    <td>${esc(v.PackagesCount)}</td>
                    <td class="cell-lastseen">${v.ModifiedByDate ? new Date(v.ModifiedByDate).toLocaleString() : '<span class="cell-na">—</span>'}</td>
                    <td>${esc(v.ModifiedBy) || '<span class="cell-na">—</span>'}</td>
                  </tr>`).join('')}
              </tbody>
            </table>` : '<span class="cell-na">No version history</span>'}

          <h4>Recent Logs</h4>
          ${logs.length ? `
            <table class="printer-table">
              <thead><tr><th>Timestamp</th><th>Severity</th><th>Source</th><th>Message</th></tr></thead>
              <tbody>
                ${logs.map((l) => `
                  <tr>
                    <td class="cell-lastseen">${l.Timestamp ? new Date(l.Timestamp).toLocaleString() : '<span class="cell-na">—</span>'}</td>
                    <td>${buildEventSeverityBadge(l.EventSeverity)}</td>
                    <td>${esc(l.SourceName) || '<span class="cell-na">—</span>'}</td>
                    <td>${esc(l.Message) || '<span class="cell-na">—</span>'}</td>
                  </tr>`).join('')}
              </tbody>
            </table>` : '<span class="cell-na">No logs available</span>'}
        </div>`;

      detailEl.querySelectorAll('.view-config-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const c = configurations[Number(btn.dataset.configIndex)];
          const label = c.UserSpecifiedName || c['$type'] || 'Configuration';
          const { '$type': _t, UserSpecifiedName: _n, ...fields } = c;
          openConfigViewerModal(`${profile.Name || name} — ${label}`, fields);
        });
      });

      profilesTab.lastUpdatedText = new Date().toLocaleTimeString();
      if (activeTab === 'profiles') elLastUpdated.textContent = profilesTab.lastUpdatedText;
    } catch (e) {
      detailEl.innerHTML = '';
      showError(banner, message, e.message);
    }
  }

  // ─── MobiControl App Policies tab ────────────────────────────────────────────

  const appPoliciesTab = {
    lastUpdatedText: '',
    all:    [],
    loaded: false,
    sort:   { key: 'Name', dir: 'asc' },
    currentPolicyId: null,
  };

  function initAppPoliciesList() {
    document.getElementById('apppolicies-list-search').addEventListener('input', renderAppPoliciesList);
    document.getElementById('apppolicies-list-family-filter').addEventListener('change', renderAppPoliciesList);
    document.getElementById('apppolicies-list-refresh').addEventListener('click', fetchAppPoliciesList);
    document.getElementById('apppolicies-back-btn').addEventListener('click', showAppPoliciesList);

    document.querySelectorAll('#apppolicies-list-table th[data-sort-apppolicies]').forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.dataset.sortApppolicies;
        if (appPoliciesTab.sort.key === key) appPoliciesTab.sort.dir = appPoliciesTab.sort.dir === 'asc' ? 'desc' : 'asc';
        else { appPoliciesTab.sort.key = key; appPoliciesTab.sort.dir = 'asc'; }
        renderAppPoliciesList();
      });
    });
  }

  function showAppPoliciesList() {
    document.getElementById('apppolicies-summary-grid').classList.remove('hidden');
    document.getElementById('apppolicies-list-section').classList.remove('hidden');
    document.getElementById('apppolicies-detail').classList.add('hidden');
    if (!appPoliciesTab.loaded) fetchAppPoliciesList();
  }

  async function fetchAppPoliciesList() {
    const tbody = document.getElementById('apppolicies-list-table-body');
    tbody.innerHTML = '<tr class="table-placeholder"><td colspan="5">Loading app policies&hellip;</td></tr>';
    hideError(document.getElementById('apppolicies-error-banner'));
    try {
      const res  = await fetch('/api/mc/apps/policies');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

      appPoliciesTab.all = data.policies || [];
      appPoliciesTab.loaded = true;
      appPoliciesTab.lastUpdatedText = data.lastUpdated ? new Date(data.lastUpdated).toLocaleTimeString() : new Date().toLocaleTimeString();
      if (activeTab === 'apppolicies') elLastUpdated.textContent = appPoliciesTab.lastUpdatedText;

      populateSelectFromData(document.getElementById('apppolicies-list-family-filter'), appPoliciesTab.all.map((p) => p.Family));

      updateAppPoliciesStats(appPoliciesTab.all);
      renderAppPoliciesList();
    } catch (e) {
      tbody.innerHTML = '';
      showError(document.getElementById('apppolicies-error-banner'), document.getElementById('apppolicies-error-message'), e.message);
    }
  }

  function updateAppPoliciesStats(policies) {
    const assigned = policies.filter((p) => p.Status === 'Assigned').length;
    const disabled = policies.filter((p) => p.Status === 'Disabled' || p.Status === 'Draft').length;
    document.getElementById('stat-apppolicies-total').textContent    = policies.length;
    document.getElementById('stat-apppolicies-assigned').textContent = assigned;
    document.getElementById('stat-apppolicies-disabled').textContent = disabled;

    const familyCounts = {};
    policies.forEach((p) => {
      const fam = p.Family || 'Unknown';
      familyCounts[fam] = (familyCounts[fam] || 0) + 1;
    });
    document.getElementById('apppolicies-family-cards').innerHTML = Object.keys(familyCounts).sort().map((fam) => `
      <div class="card card--total">
        <div class="card-label">${esc(fam)} Policies</div>
        <div class="card-value">${familyCounts[fam]}</div>
      </div>`).join('');
  }

  function renderAppPoliciesList() {
    const tbody  = document.getElementById('apppolicies-list-table-body');
    const noRes  = document.getElementById('apppolicies-list-no-results');
    const term   = document.getElementById('apppolicies-list-search').value.trim().toLowerCase();
    const family = document.getElementById('apppolicies-list-family-filter').value;

    let filtered = appPoliciesTab.all;
    if (family) filtered = filtered.filter((p) => p.Family === family);
    if (term)   filtered = filtered.filter((p) => (p.Name || '').toLowerCase().includes(term));

    const { key, dir } = appPoliciesTab.sort;
    const sorted = [...filtered].sort((a, b) => {
      let va = a[key], vb = b[key];
      if (key === 'LastModified') { va = va ? new Date(va).getTime() : 0; vb = vb ? new Date(vb).getTime() : 0; }
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return dir === 'asc' ? cmp : -cmp;
    });

    if (!appPoliciesTab.all.length) {
      noRes.classList.add('hidden');
      tbody.innerHTML = '<tr class="table-placeholder"><td colspan="5">No app policies found</td></tr>';
      return;
    }
    if (!sorted.length) {
      tbody.innerHTML = '';
      noRes.classList.remove('hidden');
      return;
    }
    noRes.classList.add('hidden');
    tbody.innerHTML = sorted.map((p) => `
      <tr class="row-clickable" data-policy-id="${esc(p.ReferenceId)}" data-policy-name="${esc(p.Name)}" data-policy-family="${esc(p.Family)}">
        <td>${esc(p.Name)}</td>
        <td>${esc(p.Family)}</td>
        <td>${esc(p.Apps)}</td>
        <td>${esc(p.Status) || '<span class="cell-na">—</span>'}</td>
        <td class="cell-lastseen">${p.LastModified ? relativeTime(new Date(p.LastModified)) : '<span class="cell-na">—</span>'}</td>
      </tr>`).join('');

    tbody.querySelectorAll('tr[data-policy-id]').forEach((row) => {
      row.addEventListener('click', () => navigateToAppPolicy(row.dataset.policyId, row.dataset.policyName, row.dataset.policyFamily));
    });
  }

  function navigateToAppPolicy(referenceId, name, family) {
    switchTab('apppolicies');
    document.getElementById('apppolicies-summary-grid').classList.add('hidden');
    document.getElementById('apppolicies-list-section').classList.add('hidden');
    const detailEl  = document.getElementById('apppolicies-detail');
    const contentEl = document.getElementById('apppolicies-detail-content');
    detailEl.classList.remove('hidden');
    contentEl.innerHTML = `<div class="mcapp-detail"><span class="cell-na">Loading ${esc(name)}&hellip;</span></div>`;
    hideError(document.getElementById('apppolicies-error-banner'));
    appPoliciesTab.currentPolicyId = referenceId;
    fetchAppPolicyDetail(referenceId, name, family);
  }

  async function fetchAppPolicyDetail(referenceId, name, family) {
    const banner   = document.getElementById('apppolicies-error-banner');
    const message  = document.getElementById('apppolicies-error-message');
    const contentEl = document.getElementById('apppolicies-detail-content');
    try {
      const policy = appPoliciesTab.all.find((p) => p.ReferenceId === referenceId) || { Name: name, Family: family };

      // Devices-within-group resolution is cross-referenced against the MobiControl
      // device list — make sure it's actually loaded (user may not have visited Devices yet).
      if (!mc.devices.length) await refreshMc();

      const [appsRes, appliedRes] = await Promise.all([
        fetch(`/api/mc/apps/policies/${encodeURIComponent(referenceId)}/apps?family=${encodeURIComponent(family)}`),
        fetch(`/api/mc/apps/policies/${encodeURIComponent(referenceId)}/applied-to`),
      ]);
      const appsData    = await appsRes.json().catch(() => ({}));
      const appliedData = await appliedRes.json().catch(() => ({}));
      const apps    = appsRes.ok ? (appsData.apps || []) : [];
      const groups  = appliedRes.ok ? (appliedData.groups || []) : [];
      const devices = appliedRes.ok ? (appliedData.devices || []) : [];

      const statusOk = policy.Status === 'Assigned';

      const groupsWithDevices = groups.map((path) => ({
        path,
        devices: devicesForGroupPath(path).slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
      }));

      // Flat export rows: every resolved device (from groups + individually assigned),
      // one row per device, so this can be shared/opened in Excel.
      const exportRows = [
        ...groupsWithDevices.flatMap((g) => g.devices.map((d) => ({
          Policy: policy.Name, Group: g.path, Device: d.name, AssignmentType: 'Group',
        }))),
        ...devices.map((d) => ({
          Policy: policy.Name, Group: d.parentPath, Device: d.deviceName, AssignmentType: 'Individual',
        })),
      ];

      contentEl.innerHTML = `
        <div class="mcapp-detail">
          <div class="detail-profile-header" style="margin-bottom:12px;">
            <strong style="font-size:1.05rem;">${esc(policy.Name)}</strong>
            <span class="badge${statusOk ? ' badge--online' : ' badge--compliance-unknown'}">${esc(policy.Status) || '—'}</span>
            <span class="badge">${esc(policy.Family)}</span>
          </div>
          ${policy.Description ? `<p>${esc(policy.Description)}</p>` : ''}

          <h4>Overview</h4>
          <div class="detail-stat-grid">
            ${statRow('Family', policy.Family)}
            ${statRow('Apps', policy.Apps)}
            ${statRow('Created By', policy.CreatedBy)}
            ${statRow('Created Date', policy.CreatedDate ? new Date(policy.CreatedDate).toLocaleString() : null)}
            ${statRow('Assigned By', policy.AssignedBy)}
            ${statRow('Assigned Date', policy.AssignedDate ? new Date(policy.AssignedDate).toLocaleString() : null)}
            ${statRow('Last Modified By', policy.LastModifiedBy)}
            ${statRow('Last Modified', policy.LastModified ? new Date(policy.LastModified).toLocaleString() : null)}
          </div>

          <h4>Apps Pushed by This Policy</h4>
          ${apps.length ? `
            <ul class="mcapp-perm-list">
              ${apps.map((a) => `<li><strong>${esc(a.name)}</strong>${a.version ? ` (v${esc(a.version)})` : ''} <span class="cell-na">— ${esc(a.packageId)} · ${esc(a.source)}</span></li>`).join('')}
            </ul>` : '<span class="cell-na">No apps found for this policy</span>'}

          <div class="detail-profile-header" style="justify-content:flex-start;">
            <h4 style="margin:0;">Assigned To</h4>
            ${exportRows.length ? `<button type="button" class="btn btn--sm export-policy-assignments-btn">Export</button>` : ''}
          </div>
          ${(groupsWithDevices.length || devices.length) ? `
            ${groupsWithDevices.map((g) => `
              <div class="mcapp-group-block">
                <div class="mcapp-group-path">${esc(g.path)} <span class="cell-na">(${g.devices.length} device${g.devices.length === 1 ? '' : 's'})</span></div>
                ${g.devices.length
                  ? `<ul class="mcapp-perm-list">${g.devices.map((d) => `<li>${esc(d.name)}</li>`).join('')}</ul>`
                  : '<span class="cell-na">No matching devices currently in our device list</span>'}
              </div>`).join('')}
            ${devices.length ? `
              <div class="detail-profile-header" style="margin:8px 0 4px;"><strong style="font-size:0.8rem;">Individually Assigned Devices</strong></div>
              <ul class="mcapp-perm-list">${devices.slice().sort((a, b) => (a.deviceName || '').localeCompare(b.deviceName || '', undefined, { numeric: true }))
                .map((d) => `<li>${esc(d.deviceName)} <span class="cell-na">(${esc(d.parentPath)})</span></li>`).join('')}</ul>` : ''}
          ` : '<span class="cell-na">Not currently assigned to any group or device.</span>'}

          <h4>Policy Log</h4>
          <p class="cell-na">Every logged event for this policy, across all devices.</p>
          <div class="filter-bar" style="box-shadow:none;padding:0 0 12px 0;">
            <label class="modal-field">
              Start <input type="datetime-local" id="apppolicy-log-start" />
            </label>
            <label class="modal-field">
              End <input type="datetime-local" id="apppolicy-log-end" />
            </label>
            <label class="modal-field">
              Severity
              <select id="apppolicy-log-severity" class="filter-select">
                <option value="">All Severities</option>
                <option value="Information">Information</option>
                <option value="Warning">Warning</option>
                <option value="Error">Error</option>
              </select>
            </label>
            <button type="button" id="apppolicy-log-fetch" class="btn btn--sm">Load Logs</button>
          </div>
          <div id="apppolicy-log-error" class="no-results hidden" style="padding:16px;"></div>
          <div id="apppolicy-log-body">
            <div class="cell-na" style="padding:16px 0;">Pick a date range and click Load Logs.</div>
          </div>
        </div>`;

      document.getElementById('apppolicy-log-fetch').addEventListener('click', () => fetchAppPolicyLogs(referenceId));

      const exportBtn = contentEl.querySelector('.export-policy-assignments-btn');
      if (exportBtn) exportBtn.addEventListener('click', () => downloadCsv(`${policy.Name}-assignments.csv`, exportRows));

      appPoliciesTab.lastUpdatedText = new Date().toLocaleTimeString();
      if (activeTab === 'apppolicies') elLastUpdated.textContent = appPoliciesTab.lastUpdatedText;
    } catch (e) {
      contentEl.innerHTML = '';
      showError(banner, message, e.message);
    }
  }

  async function fetchAppPolicyLogs(referenceId) {
    const startEl = document.getElementById('apppolicy-log-start');
    const endEl   = document.getElementById('apppolicy-log-end');
    const sevEl   = document.getElementById('apppolicy-log-severity');
    const errorEl = document.getElementById('apppolicy-log-error');
    const bodyEl  = document.getElementById('apppolicy-log-body');

    if (!startEl.value || !endEl.value) {
      errorEl.textContent = 'Start and end date/time are required.';
      errorEl.classList.remove('hidden');
      return;
    }
    errorEl.classList.add('hidden');
    bodyEl.innerHTML = '<div class="cell-na" style="padding:16px 0;">Loading&hellip;</div>';

    try {
      const params = new URLSearchParams({
        startDate: new Date(startEl.value).toISOString(),
        endDate: new Date(endEl.value).toISOString(),
      });
      if (sevEl.value) params.append('logSeverities', sevEl.value);

      const res  = await fetch(`/api/mc/apps/policies/${encodeURIComponent(referenceId)}/logs?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

      const logs = data.logs || [];
      bodyEl.innerHTML = logs.length ? `
        <table class="printer-table">
          <thead><tr><th>Timestamp</th><th>Severity</th><th>Source</th><th>Message</th></tr></thead>
          <tbody>
            ${logs.map((l) => `
              <tr>
                <td class="cell-lastseen">${l.TimeStamp ? new Date(l.TimeStamp).toLocaleString() : '<span class="cell-na">—</span>'}</td>
                <td>${buildEventSeverityBadge(l.EventSeverity)}</td>
                <td>${esc(l.SourceName) || '<span class="cell-na">—</span>'}</td>
                <td>${esc(l.Message) || '<span class="cell-na">—</span>'}</td>
              </tr>`).join('')}
          </tbody>
        </table>` : '<div class="cell-na" style="padding:16px 0;">No log entries found for this range.</div>';
    } catch (e) {
      bodyEl.innerHTML = '';
      errorEl.textContent = e.message;
      errorEl.classList.remove('hidden');
    }
  }

  function initPing() {
    const e = pingTab.el;
    e.sTotal       = document.getElementById('ping-s-total');
    e.sUp          = document.getElementById('ping-s-up');
    e.sDown        = document.getElementById('ping-s-down');
    e.sUnreachable = document.getElementById('ping-s-unreachable');
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
    const up          = hosts.filter(h => h.status === 'up').length;
    const offline     = hosts.filter(h => h.status === 'down' && h.ever_up).length;
    const unreachable = hosts.filter(h => h.status === 'down' && !h.ever_up).length;
    const api         = hosts.filter(h => h.api && h.api.reachable && !h.api.auth_error).length;
    const lats        = hosts.filter(h => h.latency != null).map(h => h.latency);
    const avg         = lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : null;
    const e           = pingTab.el;
    e.sTotal.textContent       = hosts.length;
    e.sUp.textContent          = up;
    e.sDown.textContent        = offline;
    e.sUnreachable.textContent = unreachable;
    e.sApi.textContent         = api;
    e.sLat.textContent         = avg != null ? avg + 'ms' : '—';
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
    const defs = [{ p: '443', label: 'SSL' }, { p: '5084', label: 'LLRP' }];
    return '<div class="port-tags">' + defs.map(d => {
      const v   = ports[d.p];
      const cls = v === true ? 'port-open' : v === false ? 'port-closed' : 'port-none';
      return `<span class="port-tag ${cls}" title="Port ${d.p}">${d.label}</span>`;
    }).join('') + '</div>';
  }

  function buildApiInfo(api) {
    if (!api || !Object.keys(api).length) return '<span class="cell-na">—</span>';
    if (api.auth_error) return '<span class="api-auth-err">401 · check credentials</span>';

    const hasData = api.firmware || api.antennas_total != null || api.temperature != null;
    if (!api.reachable && !hasData) return '<span class="cell-na">—</span>';

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
    if (!parts.length) return api.reachable ? '<span class="api-ok">✓ reachable</span>' : '<span class="cell-na">—</span>';

    const cls   = api.stale ? 'ping-api-info ping-api-info--stale' : 'ping-api-info';
    const title = api.stale ? ` title="Cached — last confirmed ${api.lastSeenAt ? esc(api.lastSeenAt) : 'unknown'}"` : '';
    const tag   = api.stale ? '<span class="api-stale-tag">cached</span>' : '';
    return `<div class="${cls}"${title}>` + parts.join('<span class="api-sep">&nbsp;·&nbsp;</span>') + tag + '</div>';
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
    document.querySelectorAll('.tab-btn[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // MobiControl grouped dropdown (Devices / Advanced Settings)
    const groupBtn      = document.getElementById('mobicontrol-group-btn');
    const groupDropdown = document.getElementById('mobicontrol-dropdown');

    function closeMcDropdown() {
      groupDropdown.classList.add('hidden');
      groupBtn.setAttribute('aria-expanded', 'false');
    }
    function toggleMcDropdown() {
      const isOpen = !groupDropdown.classList.contains('hidden');
      if (isOpen) closeMcDropdown();
      else {
        groupDropdown.classList.remove('hidden');
        groupBtn.setAttribute('aria-expanded', 'true');
      }
    }

    groupBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMcDropdown(); });

    groupDropdown.querySelectorAll('.tab-dropdown-item').forEach((item) => {
      item.addEventListener('click', () => {
        switchTab(item.dataset.tab);
        closeMcDropdown();
      });
    });

    document.addEventListener('click', (e) => {
      if (!groupDropdown.classList.contains('hidden') && !groupDropdown.contains(e.target) && e.target !== groupBtn) {
        closeMcDropdown();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMcDropdown();
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
    initMcAdvConfig();
    initMcApps();
    initMcAppLogsModal();
    initPolicyLogsModal();
    initDeviceCompareModal();
    initConfigViewerModal();
    initProfilesList();
    initAppPoliciesList();
    initPing();
    initPortals();
  });

})();
