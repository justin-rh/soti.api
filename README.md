# RFID Dashboard

Internal operations dashboard for monitoring RFID readers, portal availability, SOTI Connect printers, and MobiControl devices.

## Tabs

### SOTI Connect
Displays all printers managed by SOTI Connect with status, battery, firmware, group, alerts, and RFID void/calibration counts. Supports search, filter by status/group, sortable columns, and per-device actions (Check In / Test Print).

### MobiControl
Shows all MDM-enrolled devices from MobiControl with online/offline status, OS version, compliance state, last check-in, and assigned user. Filterable by platform, status, compliance, and group.

### Readers
Monitors Zebra FXR90 RFID readers by IP. Each host is checked via:
- **ICMP ping** — latency and reachability
- **TCP port check** — ports 80 (HTTP), 443 (SSL), 5084 (LLRP)
- **REST API probe** — firmware, serial, model, antenna count, temperature (HTTP Basic + Digest auth)

Comes pre-loaded with 31 reader hosts. Additional hosts can be added manually or loaded from an Excel file. Results can be exported to CSV.

### Portals
Monitors 10 internal web portals via HTTPS GET. Reports HTTP status code, response time, and reachability history. Self-signed certificates are accepted.

| Portal | URL | Location |
|--------|-----|----------|
| Portal #1 | https://10.180.2.81/ | — |
| Portal #2 | https://10.180.2.82/ | — |
| Portal #3 | https://10.180.2.83/ | — |
| Portal #4 | https://10.180.2.84/ | — |
| Portal #5 | https://10.180.2.85/ | — |
| Portal #6 | https://10.180.0.150 | Autostore - West |
| Portal #7 | https://10.180.2.50 | Autostore - East |
| Portal #8 | https://10.180.1.218 | K1 - North |
| Portal #9 | https://10.180.2.89 | K1 - South |
| Portal #10 | https://10.180.2.64 | WH4 |

## Setup

**Requirements:** Node.js 18+

```bash
npm install
```

Copy `.env.example` to `.env` and fill in your credentials (see Configuration below), then:

```bash
npm start
```

Open `http://localhost:3000`.

## Configuration

Create a `.env` file in the project root:

```env
# Server
PORT=3000

# SOTI Connect
SOTI_BASE_URL=https://your-tenant.soticonnect.cloud/Connect
SOTI_CLIENT_ID=your-client-id
SOTI_CLIENT_SECRET=your-client-secret
SOTI_USERNAME=your-api-username
SOTI_PASSWORD=your-api-password

# MobiControl
MC_BASE_URL=https://your-tenant.mobicontrolcloud.com
MC_CLIENT_ID=your-client-id
MC_CLIENT_SECRET=your-client-secret
MC_USERNAME=your-api-username
MC_PASSWORD=your-api-password

# Simple Print integration (optional)
SIMPLE_PRINT_URL=http://localhost:3002
```

> **Never commit `.env`** — it contains credentials.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/devices` | SOTI Connect printers |
| POST | `/api/devices/:id/action` | Trigger printer action |
| GET | `/api/mc/devices` | MobiControl devices |
| GET | `/api/ping/hosts` | Reader host list + status |
| POST | `/api/ping/run` | Run all reader checks |
| POST | `/api/ping/run/:id` | Check a single reader |
| POST | `/api/ping/hosts/add` | Add a host |
| DELETE | `/api/ping/hosts/:id` | Remove a host |
| POST | `/api/ping/excel/load` | Load hosts from Excel |
| POST | `/api/ping/excel/save` | Save results to Excel |
| POST | `/api/ping/settings` | Update auto-run interval / credentials |
| GET | `/api/ping/export/csv` | Download CSV export |
| GET | `/api/portals` | Portal list + status |
| POST | `/api/portals/run` | Run all portal checks |
| POST | `/api/portals/run/:id` | Check a single portal |
| POST | `/api/portals/settings` | Update portal auto-run interval |
