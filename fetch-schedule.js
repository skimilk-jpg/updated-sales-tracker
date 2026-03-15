const https = require('https');
const fs    = require('fs');

const API_KEY = process.env.CONNECTEAM_API_KEY;
if (!API_KEY) { console.error('CONNECTEAM_API_KEY not set'); process.exit(1); }

// Department name matching (case-insensitive)
const FOH_DEPT = 'front of house';
const BOH_DEPT = 'kitchen';

function connecteamRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: 'api.connecteam.com', path, method,
        headers: {
          'X-API-KEY': API_KEY,
          'Content-Type': 'application/json',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
        }
      },
      res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
          catch(e) { reject(new Error(`Parse error: ${data.slice(0, 200)}`)); }
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function toTorontoDate(isoStr) {
  return new Date(isoStr).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
}

function getDeptType(shift) {
  // Check all possible locations Connecteam may put department info
  const dept = (
    shift.departmentName ||
    shift.department?.name ||
    shift.department ||
    shift.job?.departmentName ||
    shift.job?.department?.name ||
    ''
  ).toLowerCase();

  if (dept.includes(FOH_DEPT)) return 'foh';
  if (dept.includes(BOH_DEPT)) return 'boh';
  return 'other';
}

function calcHours(shift) {
  const start = shift.startTime || shift.start;
  const end   = shift.endTime   || shift.end;
  if (!start || !end) return 0;
  return Math.max(0, (new Date(end) - new Date(start)) / 3600000);
}

async function fetchSchedulers() {
  const { status, data } = await connecteamRequest('GET', '/scheduler/v1/schedulers');
  console.log('Schedulers API response:', JSON.stringify(data).slice(0, 500));
  if (status !== 200) throw new Error(`Schedulers fetch returned ${status}: ${JSON.stringify(data).slice(0, 200)}`);
  // Handle all possible response shapes
  const raw = data.schedulers || data.data || data.result || data.items || data;
  return Array.isArray(raw) ? raw : Object.values(raw).filter(v => v && typeof v === 'object');
}

async function fetchShiftsForScheduler(schedulerId, startDate, endDate) {
  const shifts = [];
  let cursor = null;
  do {
    const params = new URLSearchParams({ startDate, endDate, limit: 200, ...(cursor ? { cursor } : {}) });
    const { status, data } = await connecteamRequest('GET', `/scheduler/v1/schedulers/${schedulerId}/shifts?${params}`);
    if (status !== 200) {
      console.warn(`  Scheduler ${schedulerId} returned ${status} — skipping`);
      break;
    }
    const batch = data.shifts || data.data || [];
    shifts.push(...batch);
    cursor = data.cursor || data.nextCursor || null;
    if (cursor) await new Promise(r => setTimeout(r, 150));
  } while (cursor);
  return shifts;
}

async function main() {
  // Fetch 90 days back (history) + 30 days forward (upcoming schedule)
  const now   = new Date();
  const start = new Date(now); start.setDate(start.getDate() - 90);
  const end   = new Date(now); end.setDate(end.getDate() + 30);
  const startDate = start.toISOString().slice(0, 10);
  const endDate   = end.toISOString().slice(0, 10);

  console.log(`Fetching schedule ${startDate} → ${endDate}...`);

  const schedulers = await fetchSchedulers();
  console.log(`Found ${schedulers.length} scheduler(s):`, schedulers.map(s => s.name || s.id).join(', '));

  const daily = {};

  for (const scheduler of schedulers) {
    const id = scheduler.id || scheduler._id;
    console.log(`  Fetching shifts for: ${scheduler.name || id}`);
    const shifts = await fetchShiftsForScheduler(id, startDate, endDate);
    console.log(`  ${shifts.length} shifts`);

    for (const shift of shifts) {
      // Skip unassigned/open shifts
      const assignedUsers = shift.users || (shift.userId ? [{ id: shift.userId }] : []);
      if (assignedUsers.length === 0) continue;

      const date = toTorontoDate(shift.startTime || shift.start || shift.date);
      if (!daily[date]) daily[date] = { headcount: 0, foh: 0, boh: 0, other: 0, totalHours: 0 };

      const type  = getDeptType(shift);
      const hours = calcHours(shift);
      const count = assignedUsers.length;

      daily[date].headcount  += count;
      daily[date][type]      += count;
      daily[date].totalHours += hours * count;
    }
  }

  // Round hours to 1 decimal
  for (const k of Object.keys(daily)) {
    daily[k].totalHours = Math.round(daily[k].totalHours * 10) / 10;
  }

  const output = { updatedAt: new Date().toISOString(), days: daily };
  fs.writeFileSync('schedule-data.json', JSON.stringify(output));
  console.log(`Done — saved ${Object.keys(daily).length} days to schedule-data.json`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
