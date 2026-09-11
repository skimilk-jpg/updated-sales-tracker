// Archives Toronto events near The Well into events-data.json.
//
// Ticketmaster's Discovery API only returns UPCOMING events — once a date passes it
// disappears from the feed. That means event history can never be back-filled, and
// any model calibrated against it (home-game lift) sees an empty past. This script
// runs daily and merges today's upcoming window into a file that only ever grows,
// so event history accumulates from the day it is first run.

const fs = require('fs');
const F  = require('./lib/forecast');

const OUT = 'events-data.json';
// Falls back to the key already embedded in index.html — this is a static site, so
// that key is public either way. Set TM_API_KEY as a repo secret to rotate it.
const TM_KEY = process.env.TM_API_KEY || 'N1j4dLYaqC1ZGrPHSJxekfC7YAtVRdgT';

async function main() {

  let archive = { updatedAt: null, events: {} };
  if (fs.existsSync(OUT)) {
    try { archive = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {
      console.warn('Existing archive unreadable, starting fresh:', e.message);
    }
  }
  if (!archive.events) archive.events = {};
  const before = Object.keys(archive.events).length;

  const today = F.dateKey(new Date());
  const fresh = await F.fetchEvents(TM_KEY, F.addDays(today, -1), F.addDays(today, 180));
  console.log(`Fetched ${fresh.length} classified events`);

  // Key on date+name so re-runs update rather than duplicate.
  let added = 0;
  for (const e of fresh) {
    const id = `${e.date}|${e.name}`;
    if (!archive.events[id]) added++;
    archive.events[id] = e;
  }

  archive.updatedAt = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(archive));
  console.log(`Archive: ${before} → ${Object.keys(archive.events).length} events (+${added} new)`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
