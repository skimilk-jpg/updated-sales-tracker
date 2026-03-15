const https = require('https');
const fs    = require('fs');

const API_KEY = process.env.CONNECTEAM_API_KEY;
if (!API_KEY) { console.error('CONNECTEAM_API_KEY not set'); process.exit(1); }

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

function getDeptType(shift, jobMap = {}) {
  // First try to classify using the job's department (most reliable)
  const jobId   = shift.jobId || shift.job?.id;
  const jobDept = jobId ? (jobMap[jobId] || '') : '';

  const text = (jobDept ||
    shift.title || shift.departmentName || shift.department?.name ||
    shift.department || shift.job?.departmentName || shift.job?.name || ''
  ).toLowerCase();

  // Front of House positions
  if (text.includes('server') || text.includes('assistant general manager') ||
      text.includes('foh') || text.includes('front of house') || text.includes('front')) return 'foh';

  // Kitchen positions
  if (text.includes('head cook') || text.includes('kitchen staff') ||
      text.includes('shift supervisor') || text.includes('kitchen') ||
      text.includes('cook') || text.includes('boh')) return 'boh';

  return 'other';
}

function calcHours(shift) {
  const start = shift.startTime || shift.start;
  const end   = shift.endTime   || shift.end;
  if (!start || !end) return 0;
  const startMs = start > 1e10 ? start : start * 1000;
  const endMs   = end   > 1e10 ? end   : end   * 1000;
  return Math.max(0, (endMs - startMs) / 3600000);
}

async function fetchSchedulers() {
  const { status, data } = await connecteamRequest('GET', '/scheduler/v1/schedulers');
  if (status !== 200) throw new Error(`Schedulers fetch returned ${status}: ${JSON.stringify(data).slice(0, 200)}`);
  const raw = (data.data && data.data.schedulers) || data.schedulers || data.data || [];
  return Array.isArray(raw) ? raw : [];
}

async function fetchJobMap(schedulerId) {
  // Try several possible job endpoints
  const endpoints = [
    `/scheduler/v1/jobs`,
    `/scheduler/v1/schedulers/${schedulerId}/job-titles`,
    `/scheduler/v1/job-titles`,
  ];
  for (const ep of endpoints) {
    const { status, data } = await connecteamRequest('GET', ep);
    console.log(`Jobs endpoint ${ep} → ${status}:`, JSON.stringify(data).slice(0, 400));
    if (status === 200) {
      const inner = data.data || data;
      const jobs  = inner.jobs || inner.jobTitles || inner.data || (Array.isArray(inner) ? inner : []);
      const map   = {};
      for (const job of jobs) {
        const id   = job.id || job.jobId || job._id;
        const dept = (job.departmentName || job.department?.name || job.department || job.name || '').toLowerCase();
        if (id) map[id] = dept;
      }
      console.log('Job→dept map:', JSON.stringify(map).slice(0, 400));
      return map;
    }
  }
  // If no jobs endpoint works, build map from shift titles using jobId
  console.warn('No jobs endpoint found — will classify by shift title only');
  return {};
}

async function fetchShiftsForMonth(schedulerId, startDate, endDate) {
  const shifts = [];
  let cursor = null;
  do {
    const params = new URLSearchParams({
      startTime: Math.floor(new Date(startDate + 'T00:00:00').getTime() / 1000),
      endTime:   Math.floor(new Date(endDate   + 'T23:59:59').getTime() / 1000),
      limit: 200,
      ...(cursor ? { cursor } : {})
    });
    const { status, data } = await connecteamRequest('GET', `/scheduler/v1/schedulers/${schedulerId}/shifts?${params}`);
    if (status !== 200) {
      console.warn(`    ${startDate} returned ${status}: ${JSON.stringify(data).slice(0, 200)}`);
      break;
    }
    const inner = data.data || data;
    const batch = inner.shifts || inner.data || [];
    shifts.push(...batch);
    cursor = inner.cursor || inner.nextCursor || inner.next || data.cursor || null;
    if (cursor) await new Promise(r => setTimeout(r, 150));
  } while (cursor);
  return shifts;
}

async function fetchAllShifts(schedulerId, startDate, endDate) {
  // Fetch month-by-month to stay under the 200-shift-per-request limit
  const allShifts = [];
  const cur = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate   + 'T00:00:00');

  while (cur <= end) {
    const monthStart = cur.toISOString().slice(0, 10);
    const lastDay    = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
    const monthEnd   = lastDay.toISOString().slice(0, 10);
    const chunkEnd   = monthEnd < endDate ? monthEnd : endDate;

    console.log(`  Fetching ${monthStart} → ${chunkEnd}...`);
    const batch = await fetchShiftsForMonth(schedulerId, monthStart, chunkEnd);
    console.log(`    ${batch.length} shifts`);
    allShifts.push(...batch);

    // Advance to first day of next month
    cur.setMonth(cur.getMonth() + 1);
    cur.setDate(1);
    await new Promise(r => setTimeout(r, 200));
  }
  return allShifts;
}

async function main() {
  // 90 days back (history) + 30 days forward (upcoming schedule)
  const now   = new Date();
  const start = new Date(now); start.setDate(start.getDate() - 90);
  const end   = new Date(now); end.setDate(end.getDate() + 30);
  const startDate = start.toISOString().slice(0, 10);
  const endDate   = end.toISOString().slice(0, 10);

  console.log(`Fetching schedule ${startDate} → ${endDate}...`);

  const schedulers = await fetchSchedulers();
  console.log(`Found ${schedulers.length} scheduler(s):`, schedulers.map(s => s.name || s.schedulerId).join(', '));

  const daily = {};

  for (const scheduler of schedulers) {
    const id = scheduler.schedulerId || scheduler.id || scheduler._id;
    console.log(`Fetching shifts for: ${scheduler.name || id} (id: ${id})`);
    const jobMap = await fetchJobMap(id);
    const shifts = await fetchAllShifts(id, startDate, endDate);
    console.log(`Total: ${shifts.length} shifts`);

    for (const shift of shifts) {
      const assignedUsers = shift.assignedUserIds || shift.users || (shift.userId ? [shift.userId] : []);
      if (!assignedUsers || assignedUsers.length === 0) continue;

      const startMs = shift.startTime > 1e10 ? shift.startTime : shift.startTime * 1000;
      const date = toTorontoDate(new Date(startMs).toISOString());
      if (!daily[date]) daily[date] = { headcount: 0, foh: 0, boh: 0, other: 0, totalHours: 0 };

      const type  = getDeptType(shift, jobMap);
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
