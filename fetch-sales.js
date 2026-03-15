const https = require('https');
const fs    = require('fs');

const TOKEN       = process.env.SQUARE_TOKEN;
const LOCATION_ID = 'LAN90KWFK5QXV';
const BEGIN_TIME  = '2024-06-27T00:00:00Z';

if (!TOKEN) { console.error('SQUARE_TOKEN not set'); process.exit(1); }

function squareRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: 'connect.squareup.com', path, method,
        headers: {
          'Authorization': `Bearer ${TOKEN}`,
          'Square-Version': '2024-01-18',
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

async function fetchAllOrders() {
  const orders = [];
  let cursor = null;
  const endTime = new Date().toISOString();
  do {
    const body = {
      location_ids: [LOCATION_ID],
      query: {
        filter: {
          date_time_filter: { created_at: { start_at: BEGIN_TIME, end_at: endTime } },
          state_filter: { states: ['COMPLETED'] }
        }
      },
      limit: 500,
      ...(cursor ? { cursor } : {})
    };
    const { status, data } = await squareRequest('POST', '/v2/orders/search', body);
    if (status !== 200) throw new Error(`Orders search returned ${status}: ${JSON.stringify(data).slice(0, 200)}`);
    orders.push(...(data.orders || []));
    cursor = data.cursor || null;
    if (cursor) await new Promise(r => setTimeout(r, 150));
  } while (cursor);
  return orders;
}

async function fetchAllRefunds() {
  const refunds = [];
  let cursor = null;
  const endTime = new Date().toISOString();
  do {
    const p = new URLSearchParams({
      location_id: LOCATION_ID, begin_time: BEGIN_TIME, end_time: endTime, limit: 200,
      ...(cursor ? { cursor } : {})
    });
    const { status, data } = await squareRequest('GET', `/v2/refunds?${p}`);
    if (status !== 200) break;
    refunds.push(...(data.refunds || []));
    cursor = data.cursor || null;
    if (cursor) await new Promise(r => setTimeout(r, 150));
  } while (cursor);
  return refunds;
}

async function main() {
  const daily = {};

  // --- Orders (gross and net sales — matches Square dashboard) ---
  console.log('Fetching orders...');
  const orders = await fetchAllOrders();
  for (const o of orders) {
    const date = toTorontoDate(o.created_at);
    if (!daily[date]) daily[date] = { gross: 0, discounts: 0, net: 0, tips: 0, tax: 0, refunds: 0, txCount: 0 };

    // Gross = sum of line item prices before discounts (Square's definition)
    let orderGross = 0;
    for (const item of (o.line_items || [])) {
      orderGross += (item.gross_sales_money?.amount || 0);
    }

    const orderDiscounts = (o.total_discount_money?.amount || 0);
    const orderTips      = (o.total_tip_money?.amount      || 0);
    const orderTax       = (o.total_tax_money?.amount      || 0);

    daily[date].gross     += orderGross;
    daily[date].discounts += orderDiscounts;
    daily[date].tips      += orderTips;
    daily[date].tax       += orderTax;
    daily[date].txCount   += 1;
  }
  console.log(`  ${orders.length} orders across ${Object.keys(daily).length} days`);

  // --- Refunds ---
  console.log('Fetching refunds...');
  try {
    const refunds = await fetchAllRefunds();
    for (const r of refunds) {
      if (r.status !== 'COMPLETED') continue;
      const date = toTorontoDate(r.created_at);
      if (daily[date]) daily[date].refunds += (r.amount_money?.amount || 0);
    }
    console.log(`  ${refunds.length} refunds processed`);
  } catch(e) {
    console.warn('  Refunds fetch failed (non-fatal):', e.message);
  }

  // --- Round all values and calculate net ---
  // Net Sales = Gross - Discounts - Refunds  (Square's definition)
  const cents = v => Math.round(v) / 100;
  for (const k of Object.keys(daily)) {
    const d = daily[k];
    d.gross     = cents(d.gross);
    d.discounts = cents(d.discounts);
    d.tips      = cents(d.tips);
    d.tax       = cents(d.tax);
    d.refunds   = cents(d.refunds);
    d.net       = Math.round(Math.max(0, d.gross - d.discounts - d.refunds) * 100) / 100;
  }

  const output = { updatedAt: new Date().toISOString(), days: daily };
  fs.writeFileSync('sales-data.json', JSON.stringify(output));
  console.log(`Done — saved ${Object.keys(daily).length} days to sales-data.json`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
