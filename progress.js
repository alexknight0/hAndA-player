// Listening progress store. Saved locally, and synced through an optional
// backend (see sync.js) when one is attached.
//
// Each episode has { pos, done, t }: position in seconds, played flag, and the
// time (ms) it was last changed. Devices are merged per episode by taking
// whichever copy changed most recently.
"use strict";

const Progress = (() => {
  const STORE_KEY = "progress";
  const PUSH_DELAY_MS = 15000; // batch up position saves while playing

  let data = load();
  let backend = null;          // { push(entries) => Promise }
  let dirty = new Set();       // guids changed locally since the last push
  let pushTimer = null;
  const listeners = { change: [] };

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

  const persist = () => localStorage.setItem(STORE_KEY, JSON.stringify(data));
  const get = (guid) => data[guid] || { pos: 0, done: false, t: 0 };

  function update(guid, changes) {
    const prev = get(guid);
    const next = { ...prev, ...changes };
    if (next.pos === prev.pos && next.done === prev.done) return;
    data[guid] = { ...next, t: Date.now() };
    persist();
    dirty.add(guid);
    schedulePush();
  }

  function schedulePush() {
    if (!backend) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(flush, PUSH_DELAY_MS);
  }

  // Send pending local changes to the backend now.
  function flush() {
    clearTimeout(pushTimer);
    if (!backend || !dirty.size) return;
    const entries = Object.fromEntries([...dirty].map((g) => [g, data[g]]));
    dirty = new Set();
    backend.push(entries).catch(() => {
      for (const g of Object.keys(entries)) dirty.add(g); // retry next time
    });
  }

  // Merge a remote progress map in. Newer remote entries replace local ones;
  // local entries that are newer (or missing remotely) are queued for pushing.
  function applyRemote(remote) {
    let changed = false;
    for (const [guid, entry] of Object.entries(remote || {})) {
      if (!data[guid] || (entry.t || 0) > (data[guid].t || 0)) {
        data[guid] = entry;
        dirty.delete(guid);
        changed = true;
      }
    }
    for (const [guid, entry] of Object.entries(data)) {
      if (!remote?.[guid] || (entry.t || 0) > (remote[guid].t || 0)) dirty.add(guid);
    }
    if (changed) {
      persist();
      emit("change");
    }
    flush();
  }

  function attach(newBackend) {
    backend = newBackend;
  }

  function detach() {
    clearTimeout(pushTimer);
    backend = null;
  }

  function on(event, fn) { listeners[event].push(fn); }
  function emit(event, arg) { for (const fn of listeners[event]) fn(arg); }

  return {
    get,
    setPos: (guid, pos) => update(guid, { pos: Math.floor(pos) }),
    setDone: (guid, done) => update(guid, { done: Boolean(done) }),
    applyRemote, attach, detach, flush, on,
  };
})();
