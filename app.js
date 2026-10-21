"use strict";

const LOOKUP_URL =
  "https://itunes.apple.com/lookup?id=213334232&media=podcast&entity=podcastEpisode&limit=200";
const SKIP_SECONDS = 10;
const SAVE_EVERY_SECONDS = 5;

const $ = (id) => document.getElementById(id);
const audio = $("audio");
const seek = $("seek");

let episodes = [];      // [{guid, title, date, durationSec, url, art, description}]
let current = null;     // episode currently loaded into <audio>
let chapters = [];      // chapters for `current`, in episode time
let ads = [];           // ad breaks in the stream for `current`, in file time [{start, end}]
let dragging = false;   // true while the user is dragging the seek bar
let lastSaved = 0;
let chapterAbort = null;
let resumeAt = null;    // episode-time position to apply once the audio (and ad map) is ready
let adsSettled = false; // ad detection finished (or isn't possible) for `current`
let streamInfo = null;  // { url, tagSize } from the ID3 read, used for ad detection

// ---------- time model ----------
// The stream served to browsers has ads stitched in, but chapter times, the
// iTunes duration and saved progress are all in *episode time* (ads removed).
// audio.currentTime / the seek bar are in *file time*.

function toEpisodeTime(f) {
  let t = f;
  for (const ad of ads) {
    if (f <= ad.start) break;
    t -= Math.min(f, ad.end) - ad.start;
  }
  return Math.max(0, t);
}

function toFileTime(e) {
  let f = e;
  for (const ad of ads) {
    // An ad inserted at or before this moment of the episode plays first.
    if (ad.start <= f) f += ad.end - ad.start;
    else break;
  }
  return f;
}

const adAt = (f) => ads.find((ad) => f >= ad.start && f < ad.end);

function fileDuration() {
  return isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
}

// Episode length without ads, matching the episode list.
function episodeDuration() {
  const f = fileDuration();
  if (!f) return current?.durationSec || 0;
  return toEpisodeTime(f);
}

// ---------- helpers ----------

function fmtTime(sec, round = false) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = round ? Math.round(sec) : Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
// Durations are rounded (2706.99 s -> 45:07), elapsed times floored.
const fmtDuration = (sec) => fmtTime(sec, true);

const fmtDate = (d) =>
  d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

// Measured episode lengths, so the list shows exactly what the player shows.
const durations = JSON.parse(localStorage.getItem("durations") || "{}");
const listDuration = (ep) => durations[ep.guid] || ep.durationSec;
function rememberDuration(guid, sec) {
  if (!sec || Math.abs((durations[guid] || 0) - sec) < 0.5) return;
  durations[guid] = Math.round(sec * 10) / 10;
  localStorage.setItem("durations", JSON.stringify(durations));
}

// Progress lives in progress.js (local storage, synced by sync.js when signed in).
// Positions are stored in episode time so they survive different ad loads.
const getPos = (guid) => Progress.get(guid).pos;
const isDone = (guid) => Progress.get(guid).done;
const FINISHED_WITHIN_SECONDS = 60; // counts as played once this close to the end

function setDone(guid, done) {
  Progress.setDone(guid, done);
  if (current && current.guid === guid) updateDoneButton();
}

function savePos() {
  if (!current || !isFinite(audio.currentTime) || resumeAt !== null) return;
  const pos = toEpisodeTime(audio.currentTime);
  Progress.setPos(current.guid, pos);
  lastSaved = audio.currentTime;
  const d = episodeDuration();
  if (d && d - pos <= FINISHED_WITHIN_SECONDS && !isDone(current.guid)) {
    setDone(current.guid, true);
  }
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// ---------- episode list ----------

function toEpisode(r) {
  return {
    guid: r.episodeGuid || String(r.trackId),
    title: r.trackName,
    date: new Date(r.releaseDate),
    durationSec: (r.trackTimeMillis || 0) / 1000,
    url: r.episodeUrl,
    art: r.artworkUrl600 || r.artworkUrl160,
    description: r.shortDescription || r.description || "",
  };
}

async function loadEpisodes() {
  const status = $("list-status");
  // Show cached list immediately, then refresh from the network.
  const cached = localStorage.getItem("episodes");
  if (cached && !episodes.length) {
    episodes = JSON.parse(cached).map((e) => ({ ...e, date: new Date(e.date) }));
    renderList();
  }
  status.textContent = episodes.length ? "" : "Loading episodes…";
  try {
    const resp = await fetch(LOOKUP_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    episodes = data.results
      .filter((r) => r.wrapperType === "podcastEpisode" && r.episodeUrl)
      .map(toEpisode)
      .sort((a, b) => b.date - a.date);
    localStorage.setItem("episodes", JSON.stringify(episodes));
    status.textContent = "";
    renderList();
  } catch (err) {
    status.textContent = episodes.length
      ? `Couldn't refresh (${err.message}). Showing saved list.`
      : `Couldn't load episodes (${err.message}).`;
  }
}

function renderList() {
  const ul = $("episodes");
  ul.replaceChildren(
    ...episodes.map((ep) => {
      const pos = getPos(ep.guid);
      const done = isDone(ep.guid);
      const len = listDuration(ep);
      const pct = len ? Math.min(100, (pos / len) * 100) : 0;
      let progress = "";
      if (done) progress = " · ✓ Played";
      else if (pos > 0) progress = ` · ${fmtDuration(Math.max(0, len - pos))} left`;
      const meta = `${fmtDate(ep.date)} · ${fmtDuration(len)}${progress}`;
      const btn = el("button", { type: "button" },
        el("span", { className: "ep-name", textContent: ep.title }),
        el("span", { className: "ep-meta", textContent: meta }),
      );
      if (pct > 0 && !done) {
        const bar = el("span", { className: "ep-progress" }, el("span"));
        bar.firstChild.style.width = `${pct}%`;
        btn.append(bar);
      }
      btn.addEventListener("click", () => { location.hash = `ep=${encodeURIComponent(ep.guid)}`; });
      return el("li", { className: done ? "done" : "" }, btn);
    }),
  );
}

// ---------- player ----------

function openEpisode(ep) {
  $("ep-title").textContent = ep.title;
  document.title = ep.title;
  if (current && current.guid === ep.guid) {
    // Already loaded; keep playing. If it was finished and left at the end, rewind.
    if (audio.paused && isDone(ep.guid) && episodeDuration() - toEpisodeTime(audio.currentTime) <= FINISHED_WITHIN_SECONDS) seekTo(0);
    return;
  }

  if (current) savePos();
  current = ep;
  chapters = [];
  ads = [];
  adsSettled = false;
  streamInfo = null;
  renderChapters();

  audio.src = ep.url;
  let resume = getPos(ep.guid);
  // A finished episode reopened from near its end starts again from the beginning.
  if (isDone(ep.guid) && listDuration(ep) - resume <= FINISHED_WITHIN_SECONDS) resume = 0;
  // Start ~2s before where we left off, for context. Applied once the audio and ad map are ready.
  resumeAt = resume > 0 ? Math.max(0, resume - 2) : null;
  seek.max = 0;
  seek.value = 0;
  updateTimes();
  updateDoneButton();
  setupMediaSession();
  loadChapters(ep);
}

async function loadChapters(ep) {
  if (chapterAbort) chapterAbort.abort();
  chapterAbort = new AbortController();
  const signal = chapterAbort.signal;
  $("chapter-status").textContent = "Loading chapters…";
  try {
    const info = await ID3.readChapters(ep.url, signal);
    if (current !== ep) return;
    streamInfo = { url: info.url, tagSize: info.tagSize };
    // The first chapter on these episodes is the intro jingle, titled with the episode name.
    chapters = info.chapters.map((c, i) => ({
      ...c,
      title: i === 0 && (c.title === ep.title || !c.title) ? "Intro" : c.title || `Chapter ${i + 1}`,
    }));
    $("chapter-status").textContent = chapters.length ? "" : "No chapters in this episode.";
  } catch (err) {
    if (err.name === "AbortError") return;
    $("chapter-status").textContent = `Couldn't load chapters (${err.message}).`;
  }
  renderChapters();
  detectAds(ep, signal);
}

// Locate stitched-in ads so chapter markers and times line up (see ads.js).
async function detectAds(ep, signal) {
  if (!fileDuration()) await new Promise((r) => audio.addEventListener("loadedmetadata", r, { once: true }));
  if (current !== ep || signal.aborted) return;
  const cacheKey = `ads:${ep.guid}`;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
    if (cached && Math.abs(cached.fileDuration - fileDuration()) < 0.5) {
      ads = cached.ads;
    } else if (streamInfo) {
      const found = await Ads.detect(streamInfo.url, streamInfo.tagSize, fileDuration(), signal);
      if (current !== ep) return;
      ads = found || [];
      if (found) localStorage.setItem(cacheKey, JSON.stringify({ fileDuration: fileDuration(), ads }));
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    ads = []; // play on with unadjusted times
  }
  adsSettled = true;
  rememberDuration(ep.guid, episodeDuration());
  applyResume();
  renderTrack();
  syncUi();
}

// Seek to the saved position once metadata and the ad map are ready.
// `force` applies it immediately (e.g. the user pressed play first).
function applyResume(force = false) {
  if (resumeAt === null || !fileDuration() || (!adsSettled && !force)) return;
  audio.currentTime = toFileTime(resumeAt);
  resumeAt = null;
  syncUi();
}

function chapterIndexAt(t) {
  let idx = -1;
  for (let i = 0; i < chapters.length; i++) if (chapters[i].start <= t + 0.25) idx = i;
  return idx;
}

function renderChapters() {
  const ol = $("chapters");
  ol.replaceChildren(
    ...chapters.map((c, i) => {
      const btn = el("button", { type: "button" },
        el("span", { className: "ch-time", textContent: fmtTime(c.start) }),
        el("span", { className: "ch-title", textContent: c.title }),
      );
      btn.addEventListener("click", () => {
        resumeAt = null;
        seekTo(toFileTime(c.start));
        audio.play();
      });
      const li = el("li", {}, btn);
      li.dataset.i = i;
      return li;
    }),
  );
  renderTrack();
  highlightChapter(true);
}

// ---------- seek bar track: one segment per chapter, ads shown striped ----------

function renderTrack() {
  const track = $("seek-track");
  const total = fileDuration();
  if (!total) return track.replaceChildren();

  // Chapter boundaries in file time, then cut the ad breaks out as their own segments.
  const starts = chapters.length ? chapters.map((c) => toFileTime(c.start)) : [0];
  starts[0] = 0;
  const pieces = [];
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : total;
    let from = start;
    for (const ad of ads) {
      if (ad.end <= from || ad.start >= end) continue;
      if (ad.start > from) pieces.push({ start: from, end: ad.start, chapter: i });
      from = Math.min(end, ad.end);
    }
    if (from < end) pieces.push({ start: from, end, chapter: i });
  });
  for (const ad of ads) pieces.push({ start: ad.start, end: Math.min(ad.end, total), ad: true });
  pieces.sort((a, b) => a.start - b.start);

  track.replaceChildren(
    ...pieces.filter((p) => p.end - p.start > 2).map((p) => {
      const seg = el("div", { className: p.ad ? "seg ad" : "seg" }, el("div", { className: "fill" }));
      seg.style.left = `${(p.start / total) * 100}%`;
      seg.style.width = `calc(${((p.end - p.start) / total) * 100}% - 2px)`;
      seg.dataset.start = p.start;
      seg.dataset.end = p.end;
      if (!p.ad) seg.dataset.chapter = p.chapter;
      return seg;
    }),
  );
  updateTrackFill();
}

function updateTrackFill() {
  const f = dragging ? Number(seek.value) : audio.currentTime;
  const active = String(chapterIndexAt(toEpisodeTime(f)));
  for (const seg of $("seek-track").children) {
    const { start, end } = seg.dataset;
    const pct = Math.max(0, Math.min(1, (f - start) / (end - start))) * 100;
    seg.firstChild.style.width = `${pct}%`;
    seg.classList.toggle("active", seg.dataset.chapter === active && !adAt(f));
  }
}

let activeChapter = -2;
let inAd = false;
function highlightChapter(force = false) {
  const f = dragging ? Number(seek.value) : audio.currentTime;
  const idx = chapterIndexAt(toEpisodeTime(f));
  const ad = Boolean(adAt(f));
  if (idx === activeChapter && ad === inAd && !force) return;
  activeChapter = idx;
  inAd = ad;
  for (const li of $("chapters").children) li.classList.toggle("active", Number(li.dataset.i) === idx);
  $("current-chapter").textContent = ad ? "Ad break" : idx >= 0 ? chapters[idx].title : "";
  updateMediaMetadata();
}

// Refresh times, seek bar and chapter highlight from the current position.
function syncUi() {
  if (!dragging) seek.value = audio.currentTime;
  seek.max = Math.floor(fileDuration()) || 0;
  updateTimes();
  updateTrackFill();
  highlightChapter();
  updatePositionState();
}

function seekTo(f) {
  f = Math.max(0, Math.min(fileDuration() || Infinity, f));
  audio.currentTime = f;
  seek.value = f;
  syncUi();
  savePos();
}

function updateTimes() {
  const f = dragging ? Number(seek.value) : resumeAt !== null ? toFileTime(resumeAt) : audio.currentTime;
  $("time-cur").textContent = fmtTime(resumeAt !== null && !dragging ? resumeAt : toEpisodeTime(f));
  $("time-dur").textContent = fmtDuration(episodeDuration());
}

function updateDoneButton() {
  if (!current) return;
  const done = isDone(current.guid);
  $("mark-done").textContent = done ? "✓ Played — mark as unplayed" : "Mark as played";
  $("mark-done").setAttribute("aria-pressed", String(done));
}

function updatePlayButton() {
  const playing = !audio.paused;
  $("play").textContent = playing ? "❚❚" : "▶";
  $("play").setAttribute("aria-label", playing ? "Pause" : "Play");
}

// ---------- lock screen / notification controls ----------

function updateMediaMetadata() {
  if (!("mediaSession" in navigator) || !current) return;
  const ch = chapters[activeChapter];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: inAd ? "Ad break" : ch ? ch.title : current.title,
    artist: ch || inAd ? current.title : "Hamish & Andy",
    album: "Hamish & Andy",
    artwork: current.art ? [{ src: current.art, sizes: "600x600", type: "image/jpeg" }] : [],
  });
}

// The lock screen works in file time, since that's what it scrubs through.
function updatePositionState() {
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  const d = fileDuration();
  if (!d) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: d,
      playbackRate: audio.playbackRate,
      position: Math.min(audio.currentTime, d),
    });
  } catch { /* ignore invalid states during loading */ }
}

function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  updateMediaMetadata();
  const handlers = {
    play: () => play(),
    pause: () => audio.pause(),
    seekbackward: (e) => seekTo(audio.currentTime - (e.seekOffset || SKIP_SECONDS)),
    seekforward: (e) => seekTo(audio.currentTime + (e.seekOffset || SKIP_SECONDS)),
    seekto: (e) => seekTo(e.seekTime),
    // Previous/next track buttons jump between chapters.
    previoustrack: () => {
      const t = toEpisodeTime(audio.currentTime);
      const i = chapterIndexAt(t);
      // Within 3s of a chapter start, go to the previous chapter; otherwise restart this one.
      const target = i >= 0 && t - chapters[i].start < 3 ? i - 1 : i;
      seekTo(target >= 0 ? toFileTime(chapters[target].start) : 0);
    },
    nexttrack: () => {
      const next = chapters[chapterIndexAt(toEpisodeTime(audio.currentTime)) + 1];
      if (next) seekTo(toFileTime(next.start));
    },
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { ms.setActionHandler(action, fn); } catch { /* unsupported action */ }
  }
}

// ---------- events ----------

function play() {
  applyResume(true); // don't wait for ad detection if the user is ready to listen
  return audio.play();
}

$("play").addEventListener("click", () => (audio.paused ? play() : audio.pause()));
$("back10").addEventListener("click", () => { applyResume(true); seekTo(audio.currentTime - SKIP_SECONDS); });
$("fwd10").addEventListener("click", () => { applyResume(true); seekTo(audio.currentTime + SKIP_SECONDS); });
$("back").addEventListener("click", () => { location.hash = ""; });
$("refresh").addEventListener("click", loadEpisodes);
$("mark-done").addEventListener("click", () => setDone(current.guid, !isDone(current.guid)));

// Seek bar: preview while dragging, seek when released.
seek.addEventListener("input", () => {
  dragging = true;
  resumeAt = null;
  updateTimes();
  updateTrackFill();
  highlightChapter();
});
seek.addEventListener("change", () => {
  dragging = false;
  seekTo(Number(seek.value));
});

audio.addEventListener("loadedmetadata", () => {
  renderTrack();
  applyResume();
  syncUi();
});
audio.addEventListener("timeupdate", () => {
  if (!dragging && resumeAt === null) syncUi();
  if (Math.abs(audio.currentTime - lastSaved) >= SAVE_EVERY_SECONDS) savePos();
});
audio.addEventListener("play", () => { updatePlayButton(); updatePositionState(); });
audio.addEventListener("pause", () => { updatePlayButton(); savePos(); });
audio.addEventListener("ended", () => { updatePlayButton(); savePos(); setDone(current.guid, true); });
audio.addEventListener("error", () => {
  $("chapter-status").textContent = "Couldn't play this episode. Check your connection and try again.";
});

// Keyboard shortcuts (handy on desktop): space = play/pause, arrows = ±10s.
document.addEventListener("keydown", (e) => {
  if ($("player-view").hidden || e.target.tagName === "INPUT") return;
  if (e.key === " ") { e.preventDefault(); $("play").click(); }
  else if (e.key === "ArrowLeft") $("back10").click();
  else if (e.key === "ArrowRight") $("fwd10").click();
});

window.addEventListener("pagehide", savePos);
document.addEventListener("visibilitychange", () => { if (document.hidden) savePos(); });

// ---------- sync (wired up in sync.js) ----------

// Another device changed something: refresh the list and, if the loaded
// episode is paused, jump to its synced position.
Progress.on("change", () => {
  if (!$("list-view").hidden) renderList();
  if (current) {
    updateDoneButton();
    const pos = getPos(current.guid);
    if (audio.paused && Math.abs(pos - toEpisodeTime(audio.currentTime)) > 5) {
      resumeAt = pos;
      applyResume();
      updateTimes();
    }
  }
});

// ---------- routing (#ep=<guid> shows the player; empty hash shows the list) ----------

async function route() {
  const m = location.hash.match(/^#ep=(.+)$/);
  if (m) {
    if (!episodes.length) await loadEpisodes();
    const ep = episodes.find((e) => e.guid === decodeURIComponent(m[1]));
    if (ep) {
      $("list-view").hidden = true;
      $("player-view").hidden = false;
      window.scrollTo(0, 0);
      openEpisode(ep);
      return;
    }
  }
  $("player-view").hidden = true;
  $("list-view").hidden = false;
  document.title = "H&A Player";
  renderList(); // refresh "listened" progress
}

// ---------- password gate ----------
// Cosmetic only: keeps casual visitors from seeing the content. Anyone can read
// this source (or the public podcast feed) directly.
const PASSWORD = "alex";
const UNLOCK_KEY = "unlocked";

function startApp() {
  document.body.classList.remove("locked");
  window.addEventListener("hashchange", route);
  loadEpisodes().then(route);
}

if (localStorage.getItem(UNLOCK_KEY) === "1") {
  startApp();
} else {
  $("gate-pw").focus();
  $("gate").addEventListener("submit", (e) => {
    e.preventDefault();
    if ($("gate-pw").value === PASSWORD) {
      localStorage.setItem(UNLOCK_KEY, "1"); // remember on this device
      startApp();
    } else {
      $("gate-error").textContent = "Wrong password.";
      $("gate-pw").select();
    }
  });
}
