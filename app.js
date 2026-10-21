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
let chapters = [];      // chapters for `current`
let dragging = false;   // true while the user is dragging the seek bar
let lastSaved = 0;
let chapterAbort = null;
let pendingResume = 0;  // resume position to apply once audio metadata has loaded

// ---------- helpers ----------

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

const fmtDate = (d) =>
  d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

const posKey = (guid) => `pos:${guid}`;
const getPos = (guid) => Number(localStorage.getItem(posKey(guid))) || 0;

function savePos() {
  if (!current || !isFinite(audio.currentTime)) return;
  localStorage.setItem(posKey(current.guid), String(Math.floor(audio.currentTime)));
  lastSaved = audio.currentTime;
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
      const pct = ep.durationSec ? Math.min(100, (pos / ep.durationSec) * 100) : 0;
      const meta = `${fmtDate(ep.date)} · ${fmtTime(ep.durationSec)}` +
        (pos > 0 ? ` · ${fmtTime(pos)} listened` : "");
      const btn = el("button", { type: "button" },
        el("span", { className: "ep-name", textContent: ep.title }),
        el("span", { className: "ep-meta", textContent: meta }),
      );
      if (pct > 0) {
        const bar = el("span", { className: "ep-progress" }, el("span"));
        bar.firstChild.style.width = `${pct}%`;
        btn.append(bar);
      }
      btn.addEventListener("click", () => { location.hash = `ep=${encodeURIComponent(ep.guid)}`; });
      return el("li", {}, btn);
    }),
  );
}

// ---------- player ----------

function openEpisode(ep) {
  $("ep-title").textContent = ep.title;
  document.title = ep.title;
  if (current && current.guid === ep.guid) return; // already loaded; keep playing

  if (current) savePos();
  current = ep;
  chapters = [];
  renderChapters();

  audio.src = ep.url;
  const resume = getPos(ep.guid);
  // Start ~2s before where we left off, for context. Applied once metadata loads.
  pendingResume = resume > 0 ? Math.max(0, resume - 2) : 0;
  seek.max = Math.floor(ep.durationSec) || 0;
  seek.value = resume;
  updateTimes(resume);
  setupMediaSession();
  loadChapters(ep);
}

async function loadChapters(ep) {
  if (chapterAbort) chapterAbort.abort();
  chapterAbort = new AbortController();
  $("chapter-status").textContent = "Loading chapters…";
  try {
    const list = await ID3.readChapters(ep.url, chapterAbort.signal);
    if (current !== ep) return;
    // The first chapter on these episodes is the intro jingle, titled with the episode name.
    chapters = list.map((c, i) => ({
      ...c,
      title: i === 0 && (c.title === ep.title || !c.title) ? "Intro" : c.title || `Chapter ${i + 1}`,
    }));
    $("chapter-status").textContent = chapters.length ? "" : "No chapters in this episode.";
  } catch (err) {
    if (err.name === "AbortError") return;
    $("chapter-status").textContent = `Couldn't load chapters (${err.message}).`;
  }
  renderChapters();
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
        seekTo(c.start);
        audio.play();
      });
      const li = el("li", {}, btn);
      li.dataset.i = i;
      return li;
    }),
  );
  highlightChapter();
}

let activeChapter = -2;
function highlightChapter(force = false) {
  const t = dragging ? Number(seek.value) : audio.currentTime;
  const idx = chapterIndexAt(t);
  if (idx === activeChapter && !force) return;
  activeChapter = idx;
  for (const li of $("chapters").children) li.classList.toggle("active", Number(li.dataset.i) === idx);
  $("current-chapter").textContent = idx >= 0 ? chapters[idx].title : "";
  updateMediaMetadata();
}

function duration() {
  return isFinite(audio.duration) && audio.duration > 0 ? audio.duration : current?.durationSec || 0;
}

function seekTo(t) {
  t = Math.max(0, Math.min(duration() || Infinity, t));
  audio.currentTime = t;
  seek.value = t;
  updateTimes(t);
  highlightChapter();
  updatePositionState();
  savePos();
}

function updateTimes(t) {
  $("time-cur").textContent = fmtTime(t);
  $("time-dur").textContent = fmtTime(duration());
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
    title: ch ? ch.title : current.title,
    artist: ch ? current.title : "Hamish & Andy",
    album: "Hamish & Andy",
    artwork: current.art ? [{ src: current.art, sizes: "600x600", type: "image/jpeg" }] : [],
  });
}

function updatePositionState() {
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  const d = duration();
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
    play: () => audio.play(),
    pause: () => audio.pause(),
    seekbackward: (e) => seekTo(audio.currentTime - (e.seekOffset || SKIP_SECONDS)),
    seekforward: (e) => seekTo(audio.currentTime + (e.seekOffset || SKIP_SECONDS)),
    seekto: (e) => seekTo(e.seekTime),
    // Previous/next track buttons jump between chapters.
    previoustrack: () => {
      const i = chapterIndexAt(audio.currentTime);
      // Within 3s of a chapter start, go to the previous chapter; otherwise restart this one.
      const target = i >= 0 && audio.currentTime - chapters[i].start < 3 ? i - 1 : i;
      seekTo(target >= 0 ? chapters[target].start : 0);
    },
    nexttrack: () => {
      const next = chapters[chapterIndexAt(audio.currentTime) + 1];
      if (next) seekTo(next.start);
    },
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { ms.setActionHandler(action, fn); } catch { /* unsupported action */ }
  }
}

// ---------- events ----------

$("play").addEventListener("click", () => (audio.paused ? audio.play() : audio.pause()));
$("back10").addEventListener("click", () => seekTo(audio.currentTime - SKIP_SECONDS));
$("fwd10").addEventListener("click", () => seekTo(audio.currentTime + SKIP_SECONDS));
$("back").addEventListener("click", () => { location.hash = ""; });
$("refresh").addEventListener("click", loadEpisodes);

// Seek bar: preview while dragging, seek when released.
seek.addEventListener("input", () => {
  dragging = true;
  updateTimes(Number(seek.value));
  highlightChapter();
});
seek.addEventListener("change", () => {
  dragging = false;
  seekTo(Number(seek.value));
});

audio.addEventListener("loadedmetadata", () => {
  if (pendingResume) {
    audio.currentTime = pendingResume;
    pendingResume = 0;
  }
  seek.max = Math.floor(duration());
  updateTimes(audio.currentTime);
  updatePositionState();
});
audio.addEventListener("timeupdate", () => {
  if (!dragging) {
    seek.value = audio.currentTime;
    updateTimes(audio.currentTime);
    highlightChapter();
  }
  if (Math.abs(audio.currentTime - lastSaved) >= SAVE_EVERY_SECONDS) savePos();
});
audio.addEventListener("play", () => { updatePlayButton(); updatePositionState(); });
audio.addEventListener("pause", () => { updatePlayButton(); savePos(); });
audio.addEventListener("ended", () => { updatePlayButton(); savePos(); });
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
