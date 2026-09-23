/* Noir Lords — the demo's online season.

   The demo ships with online play switched off (js/edition.js) and this is the
   one thing that can switch it back on, for a week at a time, without shipping
   a build. A season is a free promotion: the doors open, demo players queue in
   the same pool as everyone else, and when the season closes the Online panel
   goes away again.

   WHY IT IS A FETCH AND NOT A DATE IN THE SOURCE

   A schedule compiled into the build fixes the calendar at upload time, and the
   whole point of a promotion is reacting to the week it is in. So the answer
   comes off a file that can be edited in a few seconds:

     { "demoOnline": { "open": true, "until": "2026-10-06T00:00:00Z" } }

   Flipping the promotion is editing `open`. Nothing else in the game changes,
   and no depot is uploaded.

   HOW IT IS READ, WHICH IS NOT THE SAME ON BOTH PLATFORMS

   The desktop game runs from file://, where Chromium refuses fetch() and
   XMLHttpRequest outright — the same wall that makes locales executable scripts
   rather than json (js/i18n.js). So on desktop the main process does the read
   with plain node https and hands the answer over the bridge, which is also
   where it belongs: preload.js's rule is that the page names what it wants and
   main.js decides where to get it, so the renderer never supplies a URL for the
   main process to fetch.

   Mobile is a Capacitor WebView on an https origin, so it fetches directly.

   SEASON_URL is exported for main.js, which requires this file rather than
   keeping a second copy of the address. Two copies of a URL is two URLs the day
   one of them is edited. Nothing here may touch window, Storage or t() at load
   time, because that require happens in bare node.

   FAILING CLOSED, WITH A CACHE IN FRONT OF IT

   A player who cannot reach the file keeps whatever it said last, for GRACE_DAYS
   — a promotion must not collapse because a CDN blinked mid-season. After that
   the answer is "closed", because the alternative is a build that stays open
   forever the moment the file stops answering.

   `until` is the other half of the same idea and the more important one: it is
   enforced locally, so a season ends on time on a machine that never reaches the
   network again. Without it, pulling the plug on the file would freeze the last
   fetched answer in place for GRACE_DAYS rather than ending it.

   Both are read against the local clock, which a player can set. That is
   accepted, exactly as it is for the daily allowance (js/allowance.js): this is
   a product boundary, not a security one. Anyone who wants the demo's online
   play badly enough to move their clock can unpack the asar and flip the flag
   instead.

   ?season=open and ?season=closed override everything, for testing and for
   tools/editioncheck.js, in the same way ?edition= does. */

/* The file the promotion is edited in. Raw github, a gist, Cloudflare Pages —
   anything that answers a GET with json over https and is cheap to edit. It has
   to be reachable from a game that is already installed, so whatever is chosen
   here is chosen for the life of the build that carries it.

   NOT SET YET. Until this is a real address every fetch fails, every fetch
   failing means no cache, and no cache means the season is closed — so the demo
   behaves exactly as it does today and nothing is half-open in the meantime. */
const SEASON_URL = '';

const Season = (() => {
  'use strict';

  const GRACE_DAYS = 7;          // how long a cached answer outlives the fetch
  const DEADLINE_MS = 2500;      // how long boot will wait for the network
  const KEY = 'season';          // survives a Burn; see wipeEverything

  /* What the last successful read said, once init() has settled. Held here
     rather than re-read per call because Edition.has() is asked while screens
     are drawing. */
  let settled = null;            // { open, until } or null for "closed"
  let initPromise = null;
  let clock = () => Date.now();

  const asBool = v => v === true;
  const asTime = v => {
    if (typeof v !== 'string') return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  };

  /* The query string override, or null when there is none. */
  function forced() {
    try {
      const q = new URLSearchParams(location.search).get('season');
      if (q === 'open') return { open: true, until: null };
      if (q === 'closed') return { open: false, until: null };
    } catch (_) {}
    return null;
  }

  /* One shape in, one shape out, whatever the file happens to contain. A
     malformed or half-written file reads as closed rather than as an error.

     An `until` that is THERE BUT UNREADABLE is malformed, and is the reason
     this is not two lines. Absent means an open-ended season, which is a real
     thing to want; "2026-13-40" means somebody mistyped a date, and reading
     that as open-ended would turn a typo into a promotion that never ends. The
     two cases look identical after Date.parse, so they are told apart before
     it. */
  function parse(raw) {
    const d = raw && raw.demoOnline;
    if (!d || typeof d !== 'object') return null;
    let until = null;
    if (d.until !== undefined && d.until !== null) {
      until = asTime(d.until);
      if (until === null) return null;
    }
    return { open: asBool(d.open), until };
  }

  /* Is this record open AT THIS MOMENT? Separate from parsing, because the same
     record is asked again later in the session. */
  function live(rec) {
    if (!rec || !rec.open) return false;
    if (rec.until !== null && rec.until <= clock()) return false;
    return true;
  }

  function readCache() {
    let rec = null;
    try { rec = typeof Storage !== 'undefined' ? Storage.get(KEY, null) : null; } catch (_) {}
    if (!rec || typeof rec !== 'object') return null;
    const at = Number(rec.at);
    if (!Number.isFinite(at)) return null;
    if (clock() - at > GRACE_DAYS * 86400000) return null;
    return { open: asBool(rec.open), until: rec.until === null ? null : Number(rec.until) };
  }

  function writeCache(rec) {
    try {
      if (typeof Storage === 'undefined') return;
      Storage.set(KEY, { open: rec.open, until: rec.until, at: clock() });
    } catch (_) {}
  }

  /* Only the demo has a season. The full game has online play outright, and so
     does the phone, which only ever ships the full edition — for both of them
     there is nothing a fetch could decide, and making one at every launch would
     be a request on someone's connection for an answer that is never read.

     The ?season= override is checked BEFORE this, because that one is for
     testing and has to work wherever it is pointed.

     Asked at init rather than at load: js/edition.js is the next script after
     this one and does not exist yet while this file is being evaluated. */
  function wanted() {
    return typeof Edition === 'undefined' || Edition.demo();
  }

  /* Desktop: the main process has already done the read, or is doing it now.
     Mobile: the WebView can do it itself. A plain browser over file:// has
     neither and says so by answering null. */
  async function fetchRecord() {
    const bridge = (typeof window !== 'undefined' && window.nl) ? window.nl : null;
    if (bridge && bridge.season) {
      try {
        const r = await bridge.season.get();
        return r && r.ok ? parse(r.data) : null;
      } catch (_) { return null; }
    }
    if (!SEASON_URL) return null;
    if (typeof fetch !== 'function') return null;
    try {
      const res = await fetch(SEASON_URL, { cache: 'no-store' });
      if (!res || !res.ok) return null;
      return parse(await res.json());
    } catch (_) { return null; }
  }

  /* Settles before the first screen is drawn, because the menu decides whether
     to draw the Online panel synchronously (js/menu.js) and editionTrim removes
     what the edition does not carry. A season that arrived late would mean a
     player staring at a menu that is about to change under them.

     The deadline is what keeps that promise on a bad network: past it, boot
     continues on the cached answer. A fetch that lands afterwards still updates
     the cache, so it is the next launch that sees it. */
  function init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      const override = forced();
      if (override) { settled = override; return live(settled); }
      if (!wanted()) { settled = null; return false; }

      const cached = readCache();
      settled = cached;

      let done = false;
      const landed = fetchRecord().then(rec => {
        done = true;
        if (rec) { writeCache(rec); settled = rec; }
        return rec;
      });
      await Promise.race([
        landed,
        new Promise(r => setTimeout(r, DEADLINE_MS))
      ]);
      /* The race resolving does not mean the fetch lost — it may have finished
         first. Only fall back to the cache when it genuinely has not landed. */
      if (!done) settled = cached;
      return live(settled);
    })();
    return initPromise;
  }

  return {
    SEASON_URL,
    GRACE_DAYS,
    init,
    /* The question every caller actually asks. Synchronous, and answers false
       until init() has settled — a screen drawn before the season is known is
       drawn as the demo normally is, which is the safe way round. */
    demoOnline: () => live(settled),
    /* When the open season ends, as a timestamp, or null when it has no end or
       there is no season. For wording that wants to say how long is left. */
    until: () => (live(settled) && settled.until !== null ? settled.until : null),
    /* For tools/editioncheck.js, which walks a season across its own end. */
    setClock(fn) { clock = typeof fn === 'function' ? fn : () => Date.now(); },
    /* For tests that need a second init with different conditions. */
    reset() { settled = null; initPromise = null; }
  };
})();

if (typeof module !== 'undefined' && module.exports)
  module.exports = { Season, SEASON_URL };
