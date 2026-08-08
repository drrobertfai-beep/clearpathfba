// ClearPathFBA offline data-point queue.
//
// Storage: localStorage under 'clearpath_offline_queue' — a JSON array of
// pending points. Fine for MVP volumes (a few hundred points ≈ tens of KB);
// IndexedDB is the noted upgrade path for large queues / offline edits.
// Target-behavior caches live in 'clearpath_behaviors_<assessmentId>' so the
// data-entry form can be used offline after one successful online load.
//
// This module is UI-framework-agnostic: it exposes a tiny pub/sub so the app
// can render connection state + pending count reactively.

const QUEUE_KEY = 'clearpath_offline_queue';
const BEHAVIOR_PREFIX = 'clearpath_behaviors_';
const listeners = new Set();
let flushing = false;

export function getQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function setQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); emit(); }

export function getState() {
  return { online: typeof navigator !== 'undefined' ? navigator.onLine : true, pending: getQueue().length };
}

function emit() { const s = getState(); listeners.forEach(fn => { try { fn(s); } catch {} }); }
function onConn() { emit(); }

// Subscribe to connection + queue changes. Returns an unsubscribe function.
export function subscribe(fn) {
  listeners.add(fn);
  window.addEventListener('online', onConn);
  window.addEventListener('offline', onConn);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('online', onConn);
    window.removeEventListener('offline', onConn);
  };
}

// A queueable failure = network-level: fetch TypeError (DNS/TCP drop), explicit
// offline, or a 5xx from the API (server unreachable / proxy error). 4xx
// (validation, auth) are NOT queueable — they must surface to the user.
export function isNetworkError(err) {
  if (err instanceof TypeError) return true;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (err && typeof err.status === 'number' && err.status >= 500) return true;
  return false;
}

// Enqueue a point for later sync. Payload is the POST-ready body (as the UI
// would send it) plus assessment_id; clientUuid + queued_at are added here.
export function enqueuePoint(payload) {
  const q = getQueue();
  const entry = {
    clientUuid: (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : String(Date.now()) + '-' + Math.random().toString(36).slice(2),
    queued_at: new Date().toISOString(),
    ...payload,
  };
  q.push(entry);
  setQueue(q);
  return entry;
}

export function removeQueued(uuid) { setQueue(getQueue().filter(e => e.clientUuid !== uuid)); }

// POST each queued point with the session token. Success → remove from queue.
// 401/403 → stop (session expired). Network error → stop (server unreachable;
// next online event / manual sync retries). Other HTTP errors → keep + continue
// so one bad row doesn't block the rest.
export async function flushQueue() {
  if (flushing) return { skipped: true, synced: 0, failed: 0, stopped: null };
  flushing = true;
  try {
    const q = getQueue();
    if (!q.length) return { synced: 0, failed: 0, stopped: null };
    const token = localStorage.getItem('clearpath_token');
    if (!token) return { synced: 0, failed: q.length, stopped: 'auth' };
    let synced = 0, failed = 0, stopped = null;
    for (const entry of [...q]) {
      try {
        const r = await fetch(`/api/assessments/${entry.assessment_id}/data-points`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            target_behavior_id: entry.target_behavior_id,
            recorded_at: entry.recorded_at,
            measurement_type: entry.measurement_type,
            value: entry.value,
            setting: entry.setting || '',
            antecedent: entry.antecedent || '',
            consequence: entry.consequence || '',
            notes: entry.notes || '',
          }),
        });
        if (r.ok) { removeQueued(entry.clientUuid); synced++; }
        else if (r.status === 401 || r.status === 403) { stopped = 'auth'; break; }
        else { failed++; }
      } catch { stopped = 'network'; break; }
    }
    return { synced, failed, stopped };
  } finally { flushing = false; }
}

// --- Target-behavior cache (for offline data entry) ---
export function cacheBehaviors(assessmentId, behaviors) {
  try { localStorage.setItem(BEHAVIOR_PREFIX + assessmentId, JSON.stringify(behaviors || [])); } catch {}
}
export function getCachedBehaviors(assessmentId) {
  try {
    const raw = localStorage.getItem(BEHAVIOR_PREFIX + assessmentId);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
