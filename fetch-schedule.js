const https = require('https');
const fs    = require('fs');

const API_KEY = process.env.CONNECTEAM_API_KEY;
if (!API_KEY) { console.error('CONNECTEAM_API_KEY not set'); process.exit(1); }

function connecteamRequest(method, path, body, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));
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
        // Follow redirects
        if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
          const loc = res.headers.location;
          const newPath = loc.startsWith('http') ? new URL(loc).pathname + new URL(loc).search : loc;
          res.resume();
          return resolve(connecteamRequest(method, newPath, body, redirectCount + 1));
        }
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
          catch(e) { resolve({ status: res.statusCode, data: {} }); }
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

function classifyByText(text) {
  const t = text.toLowerCase();
  if (t.includes('server') || t.includes('assistant general manager') ||
      t.includes('foh') || t.includes('front of house') || t.includes('front')) return 'foh';
  if (t.includes('head cook') || t.includes('shift supervisor') ||
      t.includes('kitchen staff') || t.includes('kitchen') ||
      t.includes('cook') || t.includes('boh')) return 'boh';
  return null;
}

function classifyByTitle(title) {
  const t = (title || '').toLowerCase();
  if (t === 'assistant general manager') return 'foh';
  if (t === 'head cook' || t === 'shift supervisor' || t === 'kitchen staff') return 'boh';
  return null;
}

function getDeptType(shift, userMap = {}, userTitleMap = {}) {
  // 1. Try shift title first
  const titleType = classifyByText(shift.title || '');
  if (titleType) return titleType;

  // 2. Try classifying each assigned user by their job title (overrides department)
  const userIds = shift.assignedUserIds || (shift.userId ? [shift.userId] : []);
  for (const uid of userIds) {
    const jobTitle = userTitleMap[uid] || '';
    const byTitle = classifyByTitle(jobTitle);
    if (byTitle) return byTitle;
  }

  // 3. Try classifying by user department
  for (const uid of userIds) {
    const dept = userMap[uid] || '';
    const byDept = classifyByText(dept);
    if (byDept) return byDept;
  }

  // 4. Fallback
  const fallback = (shift.departmentName || shift.department?.name || shift.department || '');
  return classifyByText(fallback) || 'other';
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

async function fetchUserDeptMap() {
  const endpoints = ['/v1/users', '/users/v1/users', '/user/v1/users', '/v1/members'];
  for (const ep of endpoints) {
    const { status, data } = await connecteamRequest('GET', ep);
    console.log(`Users endpoint ${ep} → ${status}: FULL=`, JSON.stringify(data).slice(0, 800));
    if (status === 200) {
      // Paginate through all users
      const allUsers = [];
      let cursor = null;
      let firstData = data;
      do {
        const d = cursor ? null : firstData;
        let pageData = d;
        if (cursor) {
          const params = new URLSearchParams({ cursor });
          const r = await connecteamRequest('GET', `${ep}?${params}`);
          pageData = r.data;
        }
        const inner = pageData.data || pageData;
        const batch = inner.users || inner.members || inner.employees || inner.data ||
                      (Array.isArray(inner) ? inner : Object.values(inner).find(v => Array.isArray(v)) || []);
        allUsers.push(...batch);
        cursor = inner.cursor || inner.nextCursor || pageData.cursor || null;
        if (cursor) await new Promise(r => setTimeout(r, 150));
      } while (cursor);

      if (!allUsers.length) { console.warn('Users endpoint returned empty array'); continue; }
      // Also try fetching with archived users included
      if (allUsers.length < 20) {
        const r2 = await connecteamRequest('GET', `${ep}?includeArchived=true`);
        if (r2.status === 200) {
          const i2 = r2.data.data || r2.data;
          const archived = i2.users || i2.members || i2.data || (Array.isArray(i2) ? i2 : []);
          for (const u of archived) {
            if (!allUsers.find(x => (x.userId||x.id) === (u.userId||u.id))) allUsers.push(u);
          }
        }
      }
      console.log(`Loaded ${allUsers.length} users total`);

      const deptMap  = {};
      const titleMap = {};
      for (const user of allUsers) {
        const id = user.userId || user.id || user._id;
        const fields = user.customFields || [];
        const deptField  = fields.find(f => f.name === 'Department');
        const titleField = fields.find(f => f.name === 'Title');
        const dept  = deptField?.value?.[0]?.value || deptField?.value || '';
        const title = titleField?.value || '';
        if (id) { deptMap[id] = dept.toLowerCase(); titleMap[id] = title.toLowerCase(); }
      }
      console.log('User→dept+title sample:', JSON.stringify(Object.entries(deptMap).slice(0, 8).map(([id]) => [id, deptMap[id], titleMap[id]])));
      return { deptMap, titleMap };
    }
  }
  console.warn('No users endpoint found — classifying by shift title only');
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
    const { deptMap: userMap, titleMap: userTitleMap } = await fetchUserDeptMap();
    const shifts  = await fetchAllShifts(id, startDate, endDate);

    // Find user IDs in shifts that are missing from the map and fetch them individually
    const missingIds = [...new Set(shifts.flatMap(s => s.assignedUserIds || []).filter(uid => !userMap[uid]))];
    if (missingIds.length) {
      console.log(`Fetching ${missingIds.length} missing users individually...`);
      for (const uid of missingIds) {
        const { status, data } = await connecteamRequest('GET', `/users/v1/users/${uid}`);
        if (status === 200) {
          const u = data.data || data;
          const fields = u.customFields || [];
          const deptField  = fields.find(f => f.name === 'Department');
          const titleField = fields.find(f => f.name === 'Title');
          userMap[uid]      = (deptField?.value?.[0]?.value || deptField?.value || '').toLowerCase();
          userTitleMap[uid] = (titleField?.value || '').toLowerCase();
          console.log(`  User ${uid}: dept="${userMap[uid]}" title="${userTitleMap[uid]}"`);
        } else {
          console.warn(`  Could not fetch user ${uid}: ${status}`);
        }
        await new Promise(r => setTimeout(r, 100));
      }
    }
    console.log(`Total: ${shifts.length} shifts`);

    for (const shift of shifts) {
      const assignedUsers = shift.assignedUserIds || shift.users || (shift.userId ? [shift.userId] : []);
      if (!assignedUsers || assignedUsers.length === 0) continue;

      const startMs = shift.startTime > 1e10 ? shift.startTime : shift.startTime * 1000;
      const date = toTorontoDate(new Date(startMs).toISOString());
      if (!daily[date]) daily[date] = { headcount: 0, foh: 0, boh: 0, other: 0, totalHours: 0 };

      const type  = getDeptType(shift, userMap, userTitleMap);
      const hours = calcHours(shift);
      // Debug: log March 14 shifts
      if (date === '2026-03-14') console.log(`  Mar14 shift: title="${shift.title}" userIds=${JSON.stringify(assignedUsers)} dept=${assignedUsers.map(u=>userMap[u]||'?')} title=${assignedUsers.map(u=>userTitleMap[u]||'?')} → ${type}`);
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
