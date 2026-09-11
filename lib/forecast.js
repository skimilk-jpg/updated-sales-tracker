// Node port of the forecasting model that runs in index.html.
// Keep the bucket boundaries and multipliers here in sync with calibrateFromSquare()
// and predictDayForecast() in index.html — the weekly report is only credible if it
// reproduces the same numbers the dashboard shows.

const https = require('https');

const LAT = 43.6432, LNG = -79.3960; // The Well, 444 Front St W
const TM_API_BASE = 'https://app.ticketmaster.com/discovery/v2/events.json';
const TM_PRO_TEAMS    = ['maple leafs', 'raptors', 'blue jays', 'toronto fc', 'argonauts'];
const TM_SPORT_VENUES = ['scotiabank arena', 'rogers centre', 'bmo field'];
const HOME_TEAMS      = ['raptors', 'maple leafs', 'blue jays'];

// ─── date helpers (UTC-noon anchored so DST never shifts the day) ───
function parseKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, 12)); }
function dateKey(dt) { return dt.toISOString().slice(0, 10); }
function addDays(k, n) { const d = parseKey(k); d.setUTCDate(d.getUTCDate() + n); return dateKey(d); }
function dow(k) { return parseKey(k).getUTCDay(); }        // 0=Sun
function month(k) { return parseKey(k).getUTCMonth(); }

// Monday of the week containing k
function mondayOf(k) { const wd = dow(k); return addDays(k, wd === 0 ? -6 : 1 - wd); }

function getJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let s = '';
      res.on('data', c => s += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${s.slice(0, 160)}`));
        try { resolve(JSON.parse(s)); } catch (e) { reject(new Error(`Parse error: ${s.slice(0, 160)}`)); }
      });
    }).on('error', reject);
  });
}

// ─── weather ──────────────────────────────────────────────────────
// Archive lags a few days, so the forecast endpoint (past_days=7) fills the gap
// and wins on overlap — same precedence the dashboard uses.
async function fetchWeather(startKey, endKey) {
  const out = {};
  const archive = await getJSON(
    `https://archive-api.open-meteo.com/v1/archive?latitude=${LAT}&longitude=${LNG}` +
    `&start_date=${startKey}&end_date=${endKey}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code,windspeed_10m_max` +
    `&timezone=America%2FToronto`
  ).catch(() => null);

  if (archive && archive.daily) {
    const d = archive.daily;
    for (let i = 0; i < d.time.length; i++) {
      if (d.temperature_2m_max[i] == null) continue;
      out[d.time[i]] = {
        maxTemp: Math.round(d.temperature_2m_max[i]),
        minTemp: Math.round(d.temperature_2m_min[i] ?? 0),
        precip:  d.precipitation_sum[i] || 0,
        wind:    Math.round(d.windspeed_10m_max[i] || 0),
        code:    d.weather_code[i] ?? 0,
      };
    }
  }

  const fc = await getJSON(
    `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LNG}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code,windspeed_10m_max,precipitation_probability_max` +
    `&timezone=America%2FToronto&forecast_days=16&past_days=7`
  ).catch(() => null);

  if (fc && fc.daily) {
    const d = fc.daily;
    for (let i = 0; i < d.time.length; i++) {
      if (d.temperature_2m_max[i] == null) continue;
      out[d.time[i]] = {
        maxTemp:   Math.round(d.temperature_2m_max[i]),
        minTemp:   Math.round(d.temperature_2m_min[i] ?? 0),
        precip:    d.precipitation_sum[i] || 0,
        precipPct: d.precipitation_probability_max ? d.precipitation_probability_max[i] : null,
        wind:      Math.round(d.windspeed_10m_max[i] || 0),
        code:      d.weather_code[i] ?? 0,
        forecast:  true,
      };
    }
  }
  return out;
}

// ─── events (Ticketmaster, same classification as the dashboard) ──
// 'Scotiabank' matches both Scotiabank Arena (19,800 seats, drives real foot traffic)
// and Scotiabank Theatre (a multiplex whose screens each list separately — TIFF alone
// posts 30+ per day). Counting cinema screenings as arena events inflates the forecast
// badly, so match the arena explicitly and reject cinema auditoriums.
function isMajorVenue(venue) {
  if (venue.includes('cinema') || venue.includes('theatre cinema')) return false;
  return venue.includes('scotiabank arena') || venue.includes('rogers centre') ||
         venue.includes('budweiser stage')  || venue.includes('bmo field');
}

function classifyTMEvent(e) {
  const seg   = ((e.classifications && e.classifications[0] && e.classifications[0].segment && e.classifications[0].segment.name) || '').toLowerCase();
  const name  = (e.name || '').toLowerCase();
  const venue = ((e._embedded && e._embedded.venues && e._embedded.venues[0] && e._embedded.venues[0].name) || '').toLowerCase();
  if (seg === 'sports') {
    const isProTeam  = TM_PRO_TEAMS.some(t => name.includes(t));
    const isProVenue = TM_SPORT_VENUES.some(v => venue.includes(v));
    return (isProTeam || isProVenue) ? 'sports' : null;
  }
  if (seg === 'music' || seg === 'arts & theatre') return isMajorVenue(venue) ? 'concert' : null;
  if (seg === 'miscellaneous') return isMajorVenue(venue) ? 'festival' : null;
  return null;
}

function tmImpact(e) {
  const venue = ((e._embedded && e._embedded.venues && e._embedded.venues[0] && e._embedded.venues[0].name) || '').toLowerCase();
  return (venue.includes('scotiabank') || venue.includes('rogers centre')) ? 'high' : 'medium';
}

async function fetchEvents(apiKey, startKey, endKey) {
  if (!apiKey) return [];
  const categories = [
    { classificationName: 'Sports',         radius: 5 },
    { classificationName: 'Music',          radius: 3 },
    { classificationName: 'Arts & Theatre', radius: 3 },
  ];
  const page = (cat, p) => {
    const params = new URLSearchParams({
      apikey: apiKey, countryCode: 'CA', size: '200',
      latlong: `${LAT},${LNG}`, unit: 'km',
      startDateTime: `${startKey}T00:00:00Z`,
      endDateTime:   `${endKey}T23:59:59Z`,
      ...cat, radius: String(cat.radius),
      ...(p ? { page: String(p) } : {}),
    });
    return getJSON(`${TM_API_BASE}?${params}`);
  };

  const raw = [];
  for (const cat of categories) {
    let first;
    try { first = await page(cat, 0); } catch (e) { console.warn(`  TM ${cat.classificationName} failed: ${e.message}`); continue; }
    raw.push(...((first._embedded && first._embedded.events) || []));
    const totalPages = Math.min((first.page && first.page.totalPages) || 1, 5);
    for (let p = 1; p < totalPages; p++) {
      try {
        const more = await page(cat, p);
        raw.push(...((more._embedded && more._embedded.events) || []));
      } catch (e) { break; }
      await new Promise(r => setTimeout(r, 120));
    }
  }

  const seen = new Set(), out = [];
  for (const e of raw) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const type = classifyTMEvent(e);
    if (!type) continue;
    out.push({
      date:   e.dates.start.localDate,
      name:   e.name,
      type,
      venue:  (e._embedded && e._embedded.venues && e._embedded.venues[0] && e._embedded.venues[0].name) || '',
      impact: tmImpact(e),
    });
  }
  return out;
}

// ─── calibration (port of calibrateFromSquare) ────────────────────
function calibrate(days, weather, events) {
  const getNet = k => { const s = days[k]; return typeof s === 'number' ? s : ((s && (s.net ?? s.gross)) || 0); };
  const valid = Object.keys(days).filter(k => getNet(k) > 200);
  if (valid.length < 14) return null;

  const allVals = valid.map(getNet).sort((a, b) => a - b);
  const pct = p => allVals[Math.floor(allVals.length * p)];
  const tiers = {
    bad:         Math.round(pct(0.10) / 50) * 50,
    min:         Math.round(pct(0.25) / 50) * 50,
    strong:      Math.round(pct(0.75) / 50) * 50,
    exceptional: Math.round(pct(0.90) / 50) * 50,
  };

  const overall = allVals.reduce((a, b) => a + b, 0) / allVals.length;
  const mean = b => b.reduce((a, c) => a + c, 0) / b.length;

  const dowBuckets = Array.from({ length: 7 }, () => []);
  for (const k of valid) dowBuckets[dow(k)].push(getNet(k));
  const dowAvgs = dowBuckets.map(b => b.length > 2 ? mean(b) : overall);

  const monthBuckets = Array.from({ length: 12 }, () => []);
  for (const k of valid) monthBuckets[month(k)].push(getNet(k));
  const monthAvgs = monthBuckets.map(b => b.length > 2 ? mean(b) : overall);

  const tempBuckets = Array.from({ length: 7 }, () => []);
  const condBuckets = Array.from({ length: 6 }, () => []);
  for (const k of valid) {
    const w = weather[k];
    if (!w) continue;
    const norm = getNet(k) / dowAvgs[dow(k)];
    const t = w.maxTemp, c = w.code;
    tempBuckets[t < -10 ? 0 : t < 0 ? 1 : t < 5 ? 2 : t < 12 ? 3 : t < 18 ? 4 : t < 26 ? 5 : 6].push(norm);
    condBuckets[c <= 2 ? 0 : c <= 3 ? 1 : c <= 55 ? 2 : c <= 67 ? 3 : c <= 77 ? 4 : 5].push(norm);
  }
  const bMult = b => b.length >= 3 ? mean(b) : 1;

  const gameDates = new Set(events
    .filter(e => e.type === 'sports' && HOME_TEAMS.some(t => e.name.toLowerCase().includes(t)))
    .map(e => e.date));
  const gameVals   = valid.filter(k => gameDates.has(k)).map(k => getNet(k) / dowAvgs[dow(k)]);
  const noGameVals = valid.filter(k => !gameDates.has(k)).map(k => getNet(k) / dowAvgs[dow(k)]);
  const gameMult   = gameVals.length   >= 3 ? mean(gameVals)   : 1;
  const noGameBase = noGameVals.length >= 3 ? mean(noGameVals) : 1;

  return {
    overall, dowAvgs, monthAvgs,
    tempMult: tempBuckets.map(bMult),
    condMult: condBuckets.map(bMult),
    eventLift: noGameBase > 0 ? gameMult / noGameBase : 1,
    sampleSize: valid.length,
    tiers,
  };
}

// ─── prediction (port of predictDayForecast) ──────────────────────
// Returns the pure model estimate for a date — never the actual — so it stays
// a fair comparison against what really happened.
function predictForecast(k, cal, weather, events) {
  const dowNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  if (!cal || !(cal.overall > 0)) return { sales: 0, factors: [] };

  const wd = dow(k), mo = month(k);
  const factors = [];
  let base = cal.overall;

  const dowMult = cal.dowAvgs[wd] / cal.overall;
  base *= dowMult;
  factors.push({ label: `Day: ${dowNames[wd]}`, delta: Math.round(cal.dowAvgs[wd] - cal.overall) });

  const monthMult = cal.monthAvgs[mo] > 0 ? cal.monthAvgs[mo] / cal.overall : 1;
  const beforeMonth = base;
  base *= monthMult;
  factors.push({ label: 'Seasonality', delta: Math.round(base - beforeMonth) });

  const w = weather[k];
  if (w && cal.tempMult && cal.condMult) {
    const t = w.maxTemp, c = w.code;
    const ti = t < -10 ? 0 : t < 0 ? 1 : t < 5 ? 2 : t < 12 ? 3 : t < 18 ? 4 : t < 26 ? 5 : 6;
    const ci = c <= 2 ? 0 : c <= 3 ? 1 : c <= 55 ? 2 : c <= 67 ? 3 : c <= 77 ? 4 : 5;
    const before = base;
    base *= (cal.tempMult[ti] + cal.condMult[ci]) / 2;
    factors.push({ label: `Weather: ${w.maxTemp}°C`, delta: Math.round(base - before) });
  }

  const dayEvents = events.filter(e => e.date === k);
  const hasHomeGame = dayEvents.some(e => e.type === 'sports' && HOME_TEAMS.some(t => e.name.toLowerCase().includes(t)));
  const before = base;
  // Cap the per-event bump: a day can stack several listings (doubleheader plus a
  // concert) and an uncapped sum lets event count, not trading history, drive the number.
  if (hasHomeGame && cal.eventLift > 1) base *= cal.eventLift;
  else if (dayEvents.length > 0) base += Math.min(dayEvents.length, 3) * 80;
  if (dayEvents.length) factors.push({ label: hasHomeGame ? 'Home game' : `${dayEvents.length} event(s)`, delta: Math.round(base - before) });

  return { sales: Math.round(Math.max(400, base) / 50) * 50, factors, events: dayEvents };
}

function salesLabel(sales, tiers) {
  if (!tiers) return '';
  if (sales >= tiers.exceptional) return 'Exceptional';
  if (sales >= tiers.strong)      return 'Strong';
  if (sales >= tiers.min)         return 'Average';
  if (sales >= tiers.bad)         return 'Below Average';
  return 'Slow';
}

module.exports = {
  LAT, LNG, HOME_TEAMS,
  parseKey, dateKey, addDays, dow, month, mondayOf,
  fetchWeather, fetchEvents, calibrate, predictForecast, salesLabel,
};
