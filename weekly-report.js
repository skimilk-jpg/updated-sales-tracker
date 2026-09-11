// Weekly partner KPI report for Doraji at The Well.
//
//   node weekly-report.js --dry-run      build only, write weekly-report-preview.html
//   node weekly-report.js                build and email
//   node weekly-report.js --week=2026-08-31   force a specific Monday (testing)
//
// Env: TM_API_KEY, REPORT_RECIPIENTS (comma-separated), REPORT_FROM,
//      RESEND_API_KEY or SENDGRID_API_KEY

const fs    = require('fs');
const https = require('https');
const F     = require('./lib/forecast');

const args     = process.argv.slice(2);
const DRY_RUN  = args.includes('--dry-run');
const weekArg  = (args.find(a => a.startsWith('--week=')) || '').split('=')[1];
const TM_KEY   = process.env.TM_API_KEY || 'N1j4dLYaqC1ZGrPHSJxekfC7YAtVRdgT';

const money = n => '$' + Math.round(n).toLocaleString('en-CA');
const pctStr = p => (p >= 0 ? '+' : '−') + Math.abs(p).toFixed(1) + '%';
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pretty = k => F.parseKey(k).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function weekKeys(monday) { return Array.from({ length: 7 }, (_, i) => F.addDays(monday, i)); }

function sumWeek(days, keys) {
  const t = { gross: 0, net: 0, tx: 0, discounts: 0, refunds: 0, tips: 0, covered: 0 };
  for (const k of keys) {
    const d = days[k];
    if (!d) continue;
    t.gross     += d.gross     || 0;
    t.net       += d.net       || 0;
    t.tx        += d.txCount   || 0;
    t.discounts += d.discounts || 0;
    t.refunds   += d.refunds   || 0;
    t.tips      += d.tips      || 0;
    t.covered++;
  }
  return t;
}

function channelMix(days, keys) {
  const mix = {};
  let anyData = false;
  for (const k of keys) {
    const chs = days[k] && days[k].channels;
    if (!chs) continue;
    anyData = true;
    for (const [name, c] of Object.entries(chs)) {
      const m = mix[name] || (mix[name] = { gross: 0, net: 0, tx: 0 });
      m.gross += c.gross || 0;
      m.net   += c.net   || 0;
      m.tx    += c.txCount || 0;
    }
  }
  return { anyData, rows: Object.entries(mix).sort((a, b) => b[1].net - a[1].net) };
}

async function send(subject, html, recipients, from) {
  const payloadResend = JSON.stringify({ from, to: recipients, subject, html });
  if (process.env.RESEND_API_KEY) {
    return post('api.resend.com', '/emails', payloadResend, {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    });
  }
  if (process.env.SENDGRID_API_KEY) {
    const body = JSON.stringify({
      personalizations: [{ to: recipients.map(e => ({ email: e })) }],
      from: { email: from }, subject,
      content: [{ type: 'text/html', value: html }],
    });
    return post('api.sendgrid.com', '/v3/mail/send', body, {
      Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
    });
  }
  throw new Error('No email provider configured (set RESEND_API_KEY or SENDGRID_API_KEY)');
}

function post(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
    }, res => {
      let s = '';
      res.on('data', c => s += c);
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300)
        ? resolve(s)
        : reject(new Error(`Email API ${res.statusCode}: ${s.slice(0, 200)}`)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const sales = JSON.parse(fs.readFileSync('sales-data.json', 'utf8'));
  const days  = sales.days;

  const today       = F.dateKey(new Date());
  const thisMonday  = F.mondayOf(today);
  const repMonday   = weekArg || F.addDays(thisMonday, -7);
  const repKeys     = weekKeys(repMonday);
  const prevKeys    = weekKeys(F.addDays(repMonday, -7));
  const aheadMonday = F.addDays(repMonday, 7);
  const aheadKeys   = weekKeys(aheadMonday);

  console.log(`Report week : ${repMonday} → ${repKeys[6]}`);
  console.log(`Week ahead  : ${aheadMonday} → ${aheadKeys[6]}`);

  // Weather spans calibration history through the forecast week.
  const histStart = F.addDays(today, -730);
  console.log('Fetching weather...');
  const weather = await F.fetchWeather(histStart, F.addDays(today, -1));
  console.log(`  ${Object.keys(weather).length} days of weather`);

  // Ticketmaster only serves upcoming events, so past weeks come from the archive
  // that fetch-events.js accumulates daily. Live fetch covers the week ahead.
  console.log('Loading events...');
  const live = await F.fetchEvents(TM_KEY, F.addDays(today, -1), F.addDays(today, 120));
  const merged = new Map();
  let archivedCount = 0;
  if (fs.existsSync('events-data.json')) {
    try {
      const arch = JSON.parse(fs.readFileSync('events-data.json', 'utf8'));
      for (const e of Object.values(arch.events || {})) { merged.set(`${e.date}|${e.name}`, e); archivedCount++; }
    } catch (e) { console.warn('  events archive unreadable:', e.message); }
  }
  for (const e of live) merged.set(`${e.date}|${e.name}`, e);
  const events = [...merged.values()];
  console.log(`  ${events.length} events (${archivedCount} archived, ${live.length} live)`);

  const archiveCovers = repKeys.some(k => events.some(e => e.date === k));
  if (!archiveCovers) console.log('  note: no event coverage for the report week');

  console.log('Calibrating model...');
  const cal = F.calibrate(days, weather, events);
  if (!cal) throw new Error('Not enough sales history to calibrate (need 14+ days)');
  console.log(`  base ${money(cal.overall)}/day from ${cal.sampleSize} days, event lift ${cal.eventLift.toFixed(2)}x`);

  // ── actuals vs forecast ──
  const act  = sumWeek(days, repKeys);
  const prev = sumWeek(days, prevKeys);
  const rows = repKeys.map(k => {
    const d = days[k];
    const f = F.predictForecast(k, cal, weather, events);
    const actualNet = d ? (d.net || 0) : null;
    return {
      key: k, dowName: DOW[F.dow(k)], date: pretty(k),
      gross: d ? d.gross : null,
      net: actualNet,
      tx: d ? d.txCount : null,
      forecast: f.sales,
      variance: actualNet != null ? actualNet - f.sales : null,
      events: f.events || [],
    };
  });

  const fcTotal = rows.reduce((a, r) => a + r.forecast, 0);
  const netVar  = act.net - fcTotal;
  const netVarPct = fcTotal ? (netVar / fcTotal) * 100 : 0;
  const wowPct = prev.net ? ((act.net - prev.net) / prev.net) * 100 : null;

  // ── best day ──
  const withActual = rows.filter(r => r.net != null);
  const best = withActual.slice().sort((a, b) => b.net - a.net)[0];
  const bestDowAvg = best ? cal.dowAvgs[F.dow(best.key)] : 0;
  const bestVsTypical = best && bestDowAvg ? ((best.net - bestDowAvg) / bestDowAvg) * 100 : 0;
  const bestHomeGame = best && best.events.some(e =>
    e.type === 'sports' && F.HOME_TEAMS.some(t => e.name.toLowerCase().includes(t)));

  // ── channel mix ──
  const mix = channelMix(days, repKeys);

  // ── week ahead ──
  const ahead = aheadKeys.map(k => {
    const f = F.predictForecast(k, cal, weather, events);
    return {
      key: k, dowName: DOW[F.dow(k)], date: pretty(k),
      forecast: f.sales, label: F.salesLabel(f.sales, cal.tiers),
      weather: weather[k] || null,
      events: (f.events || []).filter(e => e.impact === 'high' || e.type === 'sports'),
    };
  });
  const aheadTotal = ahead.reduce((a, d) => a + d.forecast, 0);

  const html = render({
    repMonday, repKeys, act, prev, rows, fcTotal, netVar, netVarPct, wowPct,
    best, bestVsTypical, bestHomeGame, mix, ahead, aheadTotal, aheadMonday, cal,
    archiveCovers, updatedAt: sales.updatedAt,
  });

  const subject = `Doraji Weekly KPI — ${pretty(repMonday)}–${pretty(repKeys[6])} · Net ${money(act.net)} (${pctStr(netVarPct)} vs forecast)`;

  if (DRY_RUN) {
    fs.writeFileSync('weekly-report-preview.html', html);
    console.log(`\nSubject: ${subject}`);
    console.log('Wrote weekly-report-preview.html');
    return;
  }

  const recipients = (process.env.REPORT_RECIPIENTS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!recipients.length) throw new Error('REPORT_RECIPIENTS not set');
  const from = process.env.REPORT_FROM || 'reports@doraji.ca';
  await send(subject, html, recipients, from);
  console.log(`Sent to ${recipients.join(', ')}`);
}

function render(d) {
  const varColor = d.netVarPct >= 0 ? '#16a34a' : '#dc2626';
  const c = {
    bg: '#f5f3ef', card: '#ffffff', border: '#e5e0d8',
    text: '#3d362e', muted: '#7a6e65', accent: '#c4903a',
  };
  const th = `style="text-align:left;padding:8px 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${c.muted};border-bottom:2px solid ${c.border}"`;
  const td = `style="padding:9px 10px;font-size:13px;color:${c.text};border-bottom:1px solid ${c.border}"`;
  const tdR = `style="padding:9px 10px;font-size:13px;color:${c.text};border-bottom:1px solid ${c.border};text-align:right"`;

  const dailyRows = d.rows.map(r => {
    const vc = r.variance == null ? c.muted : r.variance >= 0 ? '#16a34a' : '#dc2626';
    const vtxt = r.variance == null ? '—'
      : (r.variance >= 0 ? '+' : '−') + money(Math.abs(r.variance));
    return `<tr>
      <td ${td}><strong>${r.dowName}</strong> <span style="color:${c.muted}">${r.date}</span></td>
      <td ${tdR}>${r.gross == null ? '—' : money(r.gross)}</td>
      <td ${tdR}><strong>${r.net == null ? '—' : money(r.net)}</strong></td>
      <td ${tdR}>${r.tx == null ? '—' : r.tx.toLocaleString('en-CA')}</td>
      <td ${tdR}>${money(r.forecast)}</td>
      <td style="padding:9px 10px;font-size:13px;border-bottom:1px solid ${c.border};text-align:right;color:${vc};font-weight:600">${vtxt}</td>
    </tr>`;
  }).join('');

  const channelBlock = d.mix.anyData
    ? `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed;word-wrap:break-word">
         <tr><th ${th} width="40%">Channel</th><th ${th} width="22%" style="text-align:right">Net Sales</th><th ${th} width="18%" style="text-align:right">Orders</th><th ${th} width="20%" style="text-align:right">Share</th></tr>
         ${d.mix.rows.map(([name, m]) => {
           const share = d.act.net ? (m.net / d.act.net) * 100 : 0;
           return `<tr><td ${td}>${name}</td><td ${tdR}>${money(m.net)}</td><td ${tdR}>${m.tx}</td><td ${tdR}>${share.toFixed(1)}%</td></tr>`;
         }).join('')}
       </table>`
    : `<div style="padding:14px;background:#fdf6e7;border:1px solid #f0e0bb;border-radius:8px;font-size:13px;color:${c.text}">
         <strong>Channel data not yet available.</strong> Order-source capture was added to the sync on
         ${pretty(F.dateKey(new Date()))}; channel breakdown will populate from the next sync forward.
       </div>`;

  const aheadRows = d.ahead.map(a => {
    const ev = a.events.length ? a.events.slice(0, 2).map(e => e.name).join(', ').slice(0, 44) : '—';
    const w = a.weather ? `${a.weather.maxTemp}°C` : '—';
    return `<tr>
      <td ${td}><strong>${a.dowName}</strong> <span style="color:${c.muted}">${a.date}</span></td>
      <td ${tdR}><strong>${money(a.forecast)}</strong></td>
      <td ${td}>${a.label}</td>
      <td ${tdR}>${w}</td>
      <td style="padding:9px 10px;font-size:12px;color:${c.muted};border-bottom:1px solid ${c.border}">${ev}</td>
    </tr>`;
  }).join('');

  const bigEvents = d.ahead.flatMap(a => a.events.map(e => ({ ...e, dayLabel: `${a.dowName} ${a.date}` })));

  return `<!doctype html><html><body style="margin:0;padding:0;background:${c.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${c.bg};padding:24px 12px">
<tr><td align="center">
<table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;background:${c.card};border:1px solid ${c.border};border-radius:14px;overflow:hidden">

  <tr><td style="padding:24px 26px 18px;border-bottom:1px solid ${c.border}">
    <div style="font-size:19px;font-weight:800;color:${c.text}">Doraji at The Well — Weekly KPI Report</div>
    <div style="font-size:13px;color:${c.muted};margin-top:4px">${pretty(d.repMonday)} – ${pretty(d.repKeys[6])}, ${F.parseKey(d.repKeys[6]).getUTCFullYear()} · 444 Front St W, Toronto</div>
  </td></tr>

  <tr><td style="padding:20px 26px 4px">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td width="33%" style="padding:12px;background:${c.bg};border:1px solid ${c.border};border-radius:10px">
        <div style="font-size:10px;color:${c.muted};text-transform:uppercase;letter-spacing:.07em;font-weight:700">Gross Sales</div>
        <div style="font-size:22px;font-weight:800;color:${c.text};margin-top:3px">${money(d.act.gross)}</div>
      </td><td width="8"></td>
      <td width="33%" style="padding:12px;background:${c.bg};border:1px solid ${c.border};border-radius:10px">
        <div style="font-size:10px;color:${c.muted};text-transform:uppercase;letter-spacing:.07em;font-weight:700">Net Sales</div>
        <div style="font-size:22px;font-weight:800;color:${c.text};margin-top:3px">${money(d.act.net)}</div>
      </td><td width="8"></td>
      <td width="33%" style="padding:12px;background:${c.bg};border:1px solid ${c.border};border-radius:10px">
        <div style="font-size:10px;color:${c.muted};text-transform:uppercase;letter-spacing:.07em;font-weight:700">vs Forecast</div>
        <div style="font-size:22px;font-weight:800;color:${varColor};margin-top:3px">${pctStr(d.netVarPct)}</div>
      </td>
    </tr></table>
    <div style="font-size:12px;color:${c.muted};margin-top:10px;line-height:1.6">
      Forecast for the week was <strong style="color:${c.text}">${money(d.fcTotal)}</strong> net;
      actual came in <strong style="color:${varColor}">${d.netVar >= 0 ? 'ahead by' : 'behind by'} ${money(Math.abs(d.netVar))}</strong>.
      ${d.wowPct != null ? `Week over week, net sales are <strong style="color:${d.wowPct >= 0 ? '#16a34a' : '#dc2626'}">${pctStr(d.wowPct)}</strong> vs ${money(d.prev.net)} the prior week.` : ''}
      ${d.act.tx ? `${d.act.tx.toLocaleString('en-CA')} transactions, average ticket ${money(d.act.gross / d.act.tx)}.` : ''}
    </div>
  </td></tr>

  <tr><td style="padding:22px 26px 4px">
    <div style="font-size:13px;font-weight:800;color:${c.text};margin-bottom:10px">Daily Detail — Actual vs Forecast</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed;word-wrap:break-word">
      <tr><th ${th} width="22%">Day</th><th ${th} width="16%" style="text-align:right">Gross</th><th ${th} width="16%" style="text-align:right">Net</th><th ${th} width="12%" style="text-align:right">Txns</th><th ${th} width="17%" style="text-align:right">Forecast</th><th ${th} width="17%" style="text-align:right">Variance</th></tr>
      ${dailyRows}
    </table>
  </td></tr>

  <tr><td style="padding:22px 26px 4px">
    <div style="font-size:13px;font-weight:800;color:${c.text};margin-bottom:10px">Channel Mix</div>
    ${channelBlock}
  </td></tr>

  ${d.best ? `<tr><td style="padding:22px 26px 4px">
    <div style="font-size:13px;font-weight:800;color:${c.text};margin-bottom:10px">Best Day — ${d.best.dowName} ${d.best.date}</div>
    <div style="padding:14px 16px;background:${c.bg};border:1px solid ${c.border};border-left:3px solid ${c.accent};border-radius:8px;font-size:13px;color:${c.text};line-height:1.65">
      <strong>${money(d.best.net)} net</strong> on ${d.best.tx} transactions —
      ${Math.abs(d.bestVsTypical).toFixed(0)}% ${d.bestVsTypical >= 0 ? 'above' : 'below'} a typical ${d.best.dowName}.
      ${d.best.events.length
        ? `<br><span style="color:${c.muted}">Events that day:</span> ${d.best.events.map(e => `${e.name}${e.venue ? ` <span style="color:${c.muted}">(${e.venue})</span>` : ''}`).join(', ')}.
           ${d.bestHomeGame
             ? (d.cal.eventLift > 1.01
                 ? `<br>A home game fell on this date, and the model attributes roughly <strong>${((d.cal.eventLift - 1) * 100).toFixed(0)}%</strong> uplift to home games — event traffic likely contributed materially.`
                 : `<br>A home game fell on this date. The model does not yet have enough overlapping game-day history to size that effect, so treat the link as directional.`)
             : `<br><span style="color:${c.muted}">No home game — the uplift looks driven by the day itself rather than city events.</span>`}`
        : d.archiveCovers
          ? `<br><span style="color:${c.muted}">No tracked city events that day; performance appears organic.</span>`
          : `<br><span style="color:${c.muted}">City-event history is not yet available for this week, so no event attribution can be made. Event archiving began ${pretty(F.dateKey(new Date()))} and will cover future reports.</span>`}
    </div>
  </td></tr>` : ''}

  <tr><td style="padding:22px 26px 4px">
    <div style="font-size:13px;font-weight:800;color:${c.text};margin-bottom:4px">Week Ahead — Forecast</div>
    <div style="font-size:12px;color:${c.muted};margin-bottom:10px">${pretty(d.aheadMonday)} – ${pretty(d.ahead[6].key)} · projected net <strong style="color:${c.text}">${money(d.aheadTotal)}</strong></div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed;word-wrap:break-word">
      <tr><th ${th} width="21%">Day</th><th ${th} width="16%" style="text-align:right">Forecast</th><th ${th} width="16%">Outlook</th><th ${th} width="11%" style="text-align:right">High</th><th ${th} width="36%">Events</th></tr>
      ${aheadRows}
    </table>
  </td></tr>

  <tr><td style="padding:22px 26px 8px">
    <div style="font-size:13px;font-weight:800;color:${c.text};margin-bottom:10px">City Events to Watch</div>
    ${bigEvents.length
      ? `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed;word-wrap:break-word">
          ${bigEvents.slice(0, 10).map(e => `<tr>
            <td ${td} width="20%"><strong>${e.dayLabel}</strong></td>
            <td ${td} width="52%">${e.name}</td>
            <td width="28%" style="padding:9px 10px;font-size:12px;color:${c.muted};border-bottom:1px solid ${c.border}">${e.venue}</td>
          </tr>`).join('')}
         </table>`
      : `<div style="font-size:13px;color:${c.muted}">No major sports or arena events within walking distance next week.</div>`}
  </td></tr>

  <tr><td style="padding:16px 26px 24px;border-top:1px solid ${c.border}">
    <div style="font-size:11px;color:${c.muted};line-height:1.6">
      Sales from Square POS · Forecast model calibrated on ${d.cal.sampleSize} days of trading history ·
      Events from Ticketmaster within 3–5 km of The Well · Weather from Open-Meteo.<br>
      Data last synced ${new Date(d.updatedAt).toLocaleString('en-CA', { timeZone: 'America/Toronto' })} Toronto time.
    </div>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
