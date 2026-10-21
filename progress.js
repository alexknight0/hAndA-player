// Listening progress store, with optional sync to a private GitHub Gist.
//
// Each episode has { pos, done, t }: position in seconds, played flag, and the
// time (ms) it was last changed. Devices are merged per episode by taking
// whichever copy changed most recently.
"use strict";

const Progress = (() => {
  const STORE_KEY = "progress";
  const TOKEN_KEY = "gh-token";
  const GIST_ID_KEY = "gh-gist-id";
  const LAST_SYNC_KEY = "gh-last-sync";
  const GIST_FILE = "handa-player-progress.json";
  const API = "https://api.github.com";
  const PUSH_DELAY_MS = 15000; // batch up position saves while playing

  let data = load();
  let lastRemote = null;       // last progress map seen on the Gist
  let pushTimer = null;
  let inflight = null;
  const listeners = { change: [], status: [] };

  // ---------- local storage ----------

  function load() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORE_KEY));
      if (stored && typeof stored === "object") return stored;
    } catch { /* fall through to migration */ }
    // Migrate from the older per-key format (pos:<guid>, done:<guid>).
    const migrated = {};
    for (let i = 0; i < localStorage.length; i++) {
      const m = localStorage.key(i).match(/^(pos|done):(.+)$/);
      if (!m) continue;
      const entry = (migrated[m[2]] ||= { pos: 0, done: false, t: 1 });
      if (m[1] === "pos") entry.pos = Number(localStorage.getItem(m[0])) || 0;
      else entry.done = localStorage.getItem(m[0]) === "1";
    }
    return migrated;
  }

  function persist() {
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
  }

  const get = (guid) => data[guid] || { pos: 0, done: false, t: 0 };

  function update(guid, changes) {
    const prev = get(guid);
    const next = { ...prev, ...changes };
    if (next.pos === prev.pos && next.done === prev.done) return;
    data[guid] = { ...next, t: Date.now() };
    persist();
    schedulePush();
  }

  // ---------- merging ----------

  function merge(a, b) {
    const out = { ...a };
    for (const [guid, entry] of Object.entries(b || {})) {
      if (!out[guid] || (entry.t || 0) > (out[guid].t || 0)) out[guid] = entry;
    }
    return out;
  }

  const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
  const sortKeys = (o) => Object.fromEntries(Object.entries(o || {}).sort(([x], [y]) => (x < y ? -1 : 1)));

  // ---------- GitHub Gist API ----------

  const token = () => localStorage.getItem(TOKEN_KEY);
  const enabled = () => Boolean(token());

  async function gh(path, opts = {}) {
    const resp = await fetch(API + path, {
      ...opts,
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token()}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    if (resp.status === 401) throw new Error("GitHub rejected the token");
    if (!resp.ok) throw new Error(`GitHub error ${resp.status}`);
    return resp.json();
  }

  const fileBody = (map) => JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(map, null, 1) } } });

  // Find the existing progress Gist, or create a new secret one.
  async function gistId() {
    let id = localStorage.getItem(GIST_ID_KEY);
    if (id) return id;
    for (let page = 1; page <= 10 && !id; page++) {
      const gists = await gh(`/gists?per_page=100&page=${page}`);
      id = gists.find((g) => g.files && g.files[GIST_FILE])?.id;
      if (gists.length < 100) break;
    }
    if (!id) {
      const created = await gh("/gists", {
        method: "POST",
        body: JSON.stringify({
          description: "hAndA player listening progress",
          public: false,
          ...JSON.parse(fileBody(data)),
        }),
      });
      id = created.id;
    }
    localStorage.setItem(GIST_ID_KEY, id);
    return id;
  }

  async function readRemote(id) {
    const gist = await gh(`/gists/${id}`);
    const file = gist.files && gist.files[GIST_FILE];
    if (!file) return {};
    const text = file.truncated ? await (await fetch(file.raw_url, { cache: "no-store" })).text() : file.content;
    try { return JSON.parse(text) || {}; } catch { return {}; }
  }

  // Pull remote, merge into local, push back if the remote is missing anything.
  async function syncNow() {
    if (!enabled()) return;
    if (inflight) return inflight;
    clearTimeout(pushTimer);
    inflight = (async () => {
      emit("status", { state: "syncing" });
      try {
        let id;
        try {
          id = await gistId();
          lastRemote = await readRemote(id);
        } catch (err) {
          // Gist was deleted: forget it and start a fresh one.
          if (!/ 404$/.test(err.message)) throw err;
          localStorage.removeItem(GIST_ID_KEY);
          id = await gistId();
          lastRemote = await readRemote(id);
        }
        const merged = merge(data, lastRemote);
        const localChanged = !same(merged, data);
        data = merged;
        persist();
        if (!same(merged, lastRemote)) {
          await gh(`/gists/${id}`, { method: "PATCH", body: fileBody(merged) });
          lastRemote = merged;
        }
        localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
        emit("status", { state: "ok", at: Date.now() });
        if (localChanged) emit("change");
        return true;
      } catch (err) {
        emit("status", { state: "error", message: err.message });
        return false;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function schedulePush() {
    if (!enabled()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(syncNow, PUSH_DELAY_MS);
  }

  // Best-effort push when the page is being hidden/closed: no time for a
  // round trip, so send local merged with the last known remote copy.
  function flushOnExit() {
    const id = localStorage.getItem(GIST_ID_KEY);
    if (!enabled() || !id || !lastRemote) return;
    const merged = merge(lastRemote, data);
    if (same(merged, lastRemote)) return;
    clearTimeout(pushTimer);
    fetch(`${API}/gists/${id}`, {
      method: "PATCH",
      keepalive: true,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token()}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: fileBody(merged),
    }).catch(() => {});
    lastRemote = merged;
  }

  // ---------- setup ----------

  // Returns true if the token works; on failure the token is discarded.
  async function connect(newToken) {
    localStorage.setItem(TOKEN_KEY, newToken.trim());
    localStorage.removeItem(GIST_ID_KEY);
    lastRemote = null;
    let error = "";
    const capture = (s) => { if (s.state === "error") error = s.message; };
    listeners.status.unshift(capture);
    const ok = await syncNow();
    listeners.status.splice(listeners.status.indexOf(capture), 1);
    if (!ok) {
      disconnect();
      emit("status", { state: "off", message: `Couldn't connect: ${error}` });
    }
    return ok;
  }

  function disconnect() {
    clearTimeout(pushTimer);
    for (const k of [TOKEN_KEY, GIST_ID_KEY, LAST_SYNC_KEY]) localStorage.removeItem(k);
    lastRemote = null;
    emit("status", { state: "off" });
  }

  function on(event, fn) { listeners[event].push(fn); }
  function emit(event, arg) { for (const fn of listeners[event]) fn(arg); }

  const lastSync = () => Number(localStorage.getItem(LAST_SYNC_KEY)) || 0;

  return {
    get,
    setPos: (guid, pos) => update(guid, { pos: Math.floor(pos) }),
    setDone: (guid, done) => update(guid, { done: Boolean(done) }),
    syncNow, flushOnExit, connect, disconnect, enabled, lastSync, on,
  };
})();
