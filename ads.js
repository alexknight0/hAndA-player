// Finds the ads that the podcast host stitches into the episode stream.
//
// Browsers are served the MP3 with pre-, mid- and post-roll ads inserted, but the
// ID3 chapter times (and the iTunes duration) refer to the ad-free episode. On
// episodes since ~Oct 2024, the show's MP3 frames have the "original" header bit
// set and the ad frames don't, and everything is CBR 128 kbps / 44.1 kHz
// (exactly 16000 bytes per second). So tiny Range requests at known times tell
// us whether that moment is show or ad, without downloading the file.
"use strict";

const Ads = (() => {
  const BYTES_PER_SEC = 16000;
  const STEP = 30;          // seconds between coarse samples (ad breaks are 40 s+)
  const PRECISION = 0.05;   // seconds; one MP3 frame is ~0.026 s
  const CONCURRENCY = 6;
  const PROBE_BYTES = 1500; // a few MP3 frames

  // true = show audio, false = ad, null = not the expected MP3 format.
  async function kindAt(url, tagSize, t, signal) {
    const start = tagSize + Math.floor(t * BYTES_PER_SEC);
    const resp = await fetch(url, { headers: { Range: `bytes=${start}-${start + PROBE_BYTES - 1}` }, signal });
    if (resp.status !== 206) throw new Error(`range request failed (HTTP ${resp.status})`);
    const b = new Uint8Array(await resp.arrayBuffer());
    for (let i = 0; i + 4 < b.length; i++) {
      if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
      // Expect MPEG-1 Layer III, 128 kbps, 44.1 kHz.
      if ((b[i + 1] & 0x1e) !== 0x1a || b[i + 2] >> 4 !== 9 || ((b[i + 2] >> 2) & 3) !== 0) continue;
      // Confirm the next frame header so a stray 0xFF in audio data isn't mistaken for a frame.
      const next = i + 417 + ((b[i + 2] >> 1) & 1);
      if (next + 1 < b.length && !(b[next] === 0xff && (b[next + 1] & 0xe0) === 0xe0)) continue;
      return Boolean(b[i + 3] & 0x04);
    }
    return null;
  }

  async function mapLimit(items, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
    return out;
  }

  // Returns ad ranges [{start, end}] in file seconds ([] = no ads), or null if
  // they can't be detected (older episodes don't mark show frames).
  async function detect(url, tagSize, fileDuration, signal) {
    // Quick check: older episodes have no frames marked as show audio, so stop early.
    const spot = await mapLimit([0.3, 0.5, 0.7].map((x) => x * fileDuration), (t) => kindAt(url, tagSize, t, signal));
    if (!spot.includes(true)) return null;

    const last = fileDuration - 0.1;
    const times = [];
    for (let t = 0.5; t < last; t += STEP) times.push(t);
    times.push(last);

    const kinds = await mapLimit(times, (t) => kindAt(url, tagSize, t, signal));
    if (kinds.includes(null) || !kinds.includes(true)) return null;
    if (!kinds.includes(false)) return [];

    // Binary-search each show/ad transition down to about one frame.
    const edgeIdx = [];
    for (let i = 1; i < times.length; i++) if (kinds[i] !== kinds[i - 1]) edgeIdx.push(i);
    const edges = await Promise.all(edgeIdx.map(async (i) => {
      let lo = times[i - 1];
      let hi = times[i];
      const loKind = kinds[i - 1];
      while (hi - lo > PRECISION) {
        const mid = (lo + hi) / 2;
        const k = await kindAt(url, tagSize, mid, signal);
        if (k === null) throw new Error("unexpected MP3 frame");
        if (k === loKind) lo = mid;
        else hi = mid;
      }
      return { t: hi, adStarts: loKind === true };
    }));

    const ads = [];
    let open = kinds[0] === false ? 0 : null;
    for (const e of edges) {
      if (e.adStarts) open = e.t;
      else if (open !== null) {
        ads.push({ start: open, end: e.t });
        open = null;
      }
    }
    if (open !== null) ads.push({ start: open, end: fileDuration });
    return ads;
  }

  return { detect };
})();
