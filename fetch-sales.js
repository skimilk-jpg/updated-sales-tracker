const https = require('https');
const fs    = require('fs');

const TOKEN       = process.env.SQUARE_TOKEN;
const LOCATION_ID = 'LAN90KWFK5QXV';
const BEGIN_TIME  = '2024-06-27T00:00:00Z';

if (!TOKEN) { console.error('SQUARE_TOKEN not set'); process.exit(1); }

function squareGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'connect.squareup.com', path, method: 'GET',
        headers: { 'Authorization': `Bearer ${TOKEN}`, 'Square-Version': '2024-01-18' } },
      res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
          catch(e) { reject(new Error(`Parse error: ${body.slice(0,200)}`)); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function fetchAll(endpoint) {
  const items  = [];
  let   cursor = null;
  const end    = new Date().toISOString();
  do {
    const p = new URLSearchParams({
      location_id: LOCATION_ID, begin_time: BEGIN_TIME, end_time: end, limit: 200,
      ...(cursor ? { cursor } : {})
    });
    const { status, data } = await squareGet(`/v2/${endpoint}?${p}`);
    if (status !== 200) throw new Error(`Square /${endpoint} returned ${status}: ${JSON.stringify(data).slice(0,200)}`);
    const key = endpoint === 'payments' ? 'payments' : 'refunds';
    items.push(...(data[key] || []));
    cursor = data.cursor || null;
    if (cursor) await new Promise(r => setTimeout(r, 100)); // gentle rate limit
  } while (cursor);
  return items;
}

function toTorontoDate(isoStr) {
  return new Date(isoStr).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
}

async function main() {
  const daily = {};

  // --- Payments ---
  // gross = amount_money (food + tax, before tip) — matches Square's Gross/Net Sales report
  // tips  = tip_money (stored separately)
  // total = total_money (gross + tips, what was actually charged to card)
  console.log('Fetching payments...');
  const payments = await fetchAll('payments');
  for (const p of payments) {
    if (p.status !== 'COMPLETED') continue;
    const date = toTorontoDate(p.created_at);
    if (!daily[date]) daily[date] = { gross: 0, tips: 0, total: 0, refunds: 0, txCount: 0 };
    daily[date].gross   += (p.amount_money?.amount || 0) / 100;
    daily[date].tips    += (p.tip_money?.amount    || 0) / 100;
    daily[date].total   += (p.total_money?.amount  || 0) / 100;
    daily[date].txCount += 1;
  }
  console.log(`  ${payments.length} payments across ${Object.keys(daily).length} days`);

  // --- Refunds ---
  console.log('Fetching refunds...');
  try {
    const refunds = await fetchAll('refunds');
    for (const r of refunds) {
      if (r.status !== 'COMPLETED') continue;
      const date = toTorontoDate(r.created_at);
      if (!daily[date]) daily[date] = { gross: 0, refunds: 0, txCount: 0 };
      daily[date].refunds += (r.amount_money?.amount || 0) / 100;
    }
    console.log(`  ${refunds.length} refunds processed`);
  } catch(e) {
    console.warn('  Refunds fetch failed (non-fatal):', e.message);
  }

  // --- Round and calculate net ---
  for (const k of Object.keys(daily)) {
    const d = daily[k];
    d.gross   = Math.round(d.gross   * 100) / 100;
    d.tips    = Math.round(d.tips    * 100) / 100;
    d.total   = Math.round(d.total   * 100) / 100;
    d.refunds = Math.round(d.refunds * 100) / 100;
    d.net     = Math.round(Math.max(0, d.gross - d.refunds) * 100) / 100;
  }

  const output = { updatedAt: new Date().toISOString(), days: daily };
  fs.writeFileSync('sales-data.json', JSON.stringify(output));
  console.log(`Done — saved ${Object.keys(daily).length} days to sales-data.json`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
