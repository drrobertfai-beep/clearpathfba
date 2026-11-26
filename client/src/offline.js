// ClearPathFBA offline data-point queue — IndexedDB-backed.
//
// Persistence: IndexedDB database 'clearpathfba-offline', object store
// 'operations' (keyPath 'id'). Each row is a full operation record, forward
// compatible with future conflict resolution:
//
//   {
//     id:            client-generated uuid,
//     kind:          'data-point',
//     method:        'POST',
//     endpoint:      '/api/assessments/{assessmentId}/data-points',
//     body:          { target_behavior_id, recorded_at, measurement_type,
//                      value, setting, antecedent, consequence, notes },
//     assessment_id: assessmentId,
//     queued_at:     ISO timestamp,
//     attempts:      number of failed sync attempts,
//     last_error:    last failure message (null when never failed),
//   }
//
// The public API surface is unchanged from the localStorage version
// (getQueue / getState / subscribe / enqueuePoint / removeQueued /
// flushQueue, plus cacheBehaviors / getCachedBehaviors) so App.jsx callers
// keep working. getQueue()/getState() stay synchronous by reading an
// in-memory mirror; IndexedDB is the durable source of truth that survives
// reloads and is updated best-effort behind each mutation.
//
// Sync triggers:
//  - Background Sync (SyncManager) after each enqueue, tag 'clearpath-sync';
//    the service worker forwards the event to open pages via postMessage.
//  - window 'online' events remain the fallback for browsers without
//    SyncManager (and the primary path in most test environments).
//  - A manual 'Sync now' button in the UI calls flushQueue() directly.

const QUEUE_KEY = 'clearpath_offline_queue'; // legacy localStorage key (migrated once)
const BEHAVIOR_PREFIX = 'clearpath_behaviors_';
const USER_KEY = 'clearpath_user'; // session user written by App.jsx on sign-in
const SYNC_TAG = 'clearpath-sync';
const DB_NAME = 'clearpathfba-offline';
const DB_VERSION = 1;
const STORE = 'operations';

const listeners = new Set();
let dbPromise = null;      // cached IndexedDB open promise
let memoryQueue = [];      // in-memory mirror of persisted ops (FIFO by queued_at)
let flushing = false;

// --- Account ownership ---
// Every queued operation is stamped with the id of the account that created
// it, and only that account can see or replay it. On a shared clinic computer
// the next clinician to sign in must never be shown — or silently post under
// their own token — the previous clinician's unsynced ABC data.

export function currentAccountId() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw);
    return u && u.id != null ? String(u.id) : null;
  } catch { return null; }
}

// An operation belongs to an account only if it was stamped with that id.
// Unstamped records (written by a build without stamping) belong to nobody
// until initQueue adopts them for the signed-in account or drops them.
export function opBelongsTo(op, accountId) {
  if (!op || op.account_id == null || accountId == null) return false;
  return String(op.account_id) === String(accountId);
}

// The operations owned by the signed-in account (the only ones the UI shows
// and flushQueue replays).
function myOps() {
  const acct = currentAccountId();
  if (!acct) return [];
  return memoryQueue.filter((o) => opBelongsTo(o, acct));
}

// --- Pure helpers (unit-testable in Node without IndexedDB) ---

// Build the canonical operation record for a queued data point.
export function buildOperation(payload) {
  const assessmentId = payload.assessment_id;
  return {
    id: (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : String(Date.now()) + '-' + Math.random().toString(36).slice(2),
    kind: 'data-point',
    method: 'POST',
    endpoint: `/api/assessments/${assessmentId}/data-points`,
    body: {
      target_behavior_id: payload.target_behavior_id,
      recorded_at: payload.recorded_at,
      measurement_type: payload.measurement_type,
      value: payload.value,
      setting: payload.setting || '',
      antecedent: payload.antecedent || '',
      consequence: payload.consequence || '',
      notes: payload.notes || '',
    },
    assessment_id: assessmentId,
    account_id: payload.account_id != null ? String(payload.account_id) : currentAccountId(),
    queued_at: payload.queued_at || new Date().toISOString(),
    attempts: 0,
    last_error: null,
  };
}

// Map a legacy localStorage queue entry (pre-IndexedDB shape) to an operation
// record. Preserves the original clientUuid as id and queued_at timestamp so
// queued points survive the upgrade intact.
export function legacyToOperation(entry) {
  return {
    id: entry.clientUuid,
    kind: 'data-point',
    method: 'POST',
    endpoint: `/api/assessments/${entry.assessment_id}/data-points`,
    body: {
      target_behavior_id: entry.target_behavior_id,
      recorded_at: entry.recorded_at,
      measurement_type: entry.measurement_type,
      value: entry.value,
      setting: entry.setting || '',
      antecedent: entry.antecedent || '',
      consequence: entry.consequence || '',
      notes: entry.notes || '',
    },
    assessment_id: entry.assessment_id,
    account_id: currentAccountId(),
    queued_at: entry.queued_at,
    attempts: 0,
    last_error: null,
  };
}

// Map an operation record to the legacy UI-facing shape App.jsx renders
// (clientUuid, assessment_id, target_behavior_id, recorded_at, measurement_type,
// value, setting, antecedent, consequence, notes) plus the full operation
// fields. Keeps the queue-row UI and cancel-by-clientUuid path unchanged.
export function operationToView(op) {
  return {
    ...op,
    clientUuid: op.id,
    assessment_id: op.assessment_id,
    target_behavior_id: op.body.target_behavior_id,
    recorded_at: op.body.recorded_at,
    measurement_type: op.body.measurement_type,
    value: op.body.value,
    setting: op.body.setting,
    antecedent: op.body.antecedent,
    consequence: op.body.consequence,
    notes: op.body.notes,
  };
}

// FIFO ordering: oldest queued_at first, id as a stable tiebreaker.
export function sortOps(ops) {
  return [...ops].sort((a, b) =>
    a.queued_at < b.queued_at ? -1 : a.queued_at > b.queued_at ? 1
      : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );
}

// Dedupe legacy entries against operation ids already present in the queue.
// Returns only the operations that still need importing.
export function dedupeOperations(legacyEntries, existingIds) {
  const seen = new Set(existingIds || []);
  const out = [];
  for (const e of legacyEntries || []) {
    if (!e || !e.clientUuid || seen.has(e.clientUuid)) continue;
    seen.add(e.clientUuid);
    out.push(legacyToOperation(e));
  }
  return out;
}

// --- IndexedDB plumbing ---

function openDB() {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') {
    dbPromise = Promise.reject(new Error('IndexedDB unavailable'));
    return dbPromise;
  }
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('queued_at', 'queued_at', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => { dbPromise = null; reject(new Error('IndexedDB open blocked')); };
  });
  return dbPromise;
}

// Run a transaction over the operations store. fn(store) returns the request
// whose result is resolved on completion.
function tx(mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let out;
    try { out = fn(store); } catch (err) { t.abort(); reject(err); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function getAllOps() {
  return tx('readonly', (s) => s.getAll());
}
function putOp(op) {
  return tx('readwrite', (s) => s.put(op));
}
function deleteOp(id) {
  return tx('readwrite', (s) => s.delete(id));
}

// --- Initialization + one-time migration from localStorage ---

async function initQueue() {
  let loaded = [];
  try {
    loaded = await getAllOps();
  } catch {
    loaded = [];
  }
  // Merge, never clobber: a point enqueued before the initial read finished
  // (e.g. the user captures data the instant the app boots) must survive.
  const seen = new Set(loaded.map((o) => o.id));
  memoryQueue = sortOps([...loaded, ...memoryQueue.filter((o) => !seen.has(o.id))]);
  try { await migrateLegacy(); } catch {}
  try { await adoptOrphanOps(); } catch {}
  emit();
}

// Operations written before account stamping shipped carry no account_id. If a
// session is still open (same browser session, no sign-out in between) they
// belong to that account, so stamp them; if nobody is signed in, they are
// stale PHI on a shared device and are deleted.
async function adoptOrphanOps() {
  const acct = currentAccountId();
  const orphans = memoryQueue.filter((o) => o.account_id == null);
  if (!orphans.length) return;
  if (!acct) {
    memoryQueue = memoryQueue.filter((o) => o.account_id != null);
    for (const op of orphans) { try { await deleteOp(op.id); } catch {} }
    return;
  }
  const ids = new Set(orphans.map((o) => o.id));
  memoryQueue = sortOps(memoryQueue.map((o) => (ids.has(o.id) ? { ...o, account_id: acct } : o)));
  for (const op of memoryQueue.filter((o) => ids.has(o.id))) {
    try { await putOp(op); } catch {}
  }
}

// One-time migration: import any entries left in the old localStorage queue
// (written before this version shipped) into IndexedDB as kind 'data-point'
// operation records, then clear the localStorage key. Only clears after the
// IndexedDB write succeeds. Entries whose id already exists are skipped.
async function migrateLegacy() {
  let raw = null;
  try { raw = localStorage.getItem(QUEUE_KEY); } catch {}
  if (!raw) return 0;
  let legacy = [];
  try { legacy = JSON.parse(raw); } catch {}
  if (!Array.isArray(legacy) || !legacy.length) {
    try { localStorage.removeItem(QUEUE_KEY); } catch {}
    return 0;
  }
  const toAdd = dedupeOperations(legacy, memoryQueue.map((o) => o.id));
  if (toAdd.length) {
    await tx('readwrite', (s) => {
      const reqs = toAdd.map((op) => s.put(op));
      return reqs[reqs.length - 1];
    });
    memoryQueue = sortOps([...memoryQueue, ...toAdd]);
  }
  try { localStorage.removeItem(QUEUE_KEY); } catch {}
  emit();
  return toAdd.length;
}

// --- Public API (unchanged surface) ---

export function getQueue() {
  return myOps().map(operationToView);
}
export function getQueueCounts(ops) {
  return {
    pending: ops.filter((o) => o.status !== 'conflicted').length,
    conflicted: ops.filter((o) => o.status === 'conflicted').length,
  };
}
export function getState() {
  const counts = getQueueCounts(myOps());
  return { online: typeof navigator !== 'undefined' ? navigator.onLine : true, ...counts };
}
export function getConflicts() { return myOps().filter((o) => o.status === 'conflicted').map(operationToView); }

export function buildEditOperation({ kind, endpoint, body, record, queued_at, account_id }) {
  const now = queued_at || new Date().toISOString();
  return { id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(36).slice(2), kind, method: 'PUT', endpoint, body: { ...body, base_updated_at: record?.updated_at }, record_id: record?.id, account_id: account_id != null ? String(account_id) : currentAccountId(), queued_at: now, created_at: now, attempts: 0, last_error: null, status: 'pending', server_record: null };
}
export function enqueueEdit(payload) {
  const op = buildEditOperation(payload); memoryQueue = sortOps([...memoryQueue, op]); emit(); putOp(op).catch(() => {}); requestBackgroundSync(); return operationToView(op);
}
export async function resolveConflict(id, choice) {
  const op = myOps().find((x) => x.id === id);
  if (!op || op.status !== 'conflicted') return { ok: false, error: 'Conflict no longer exists.' };
  if (choice === 'server') { removeQueued(id); return { ok: true, record: op.server_record }; }
  const token = localStorage.getItem('clearpath_token');
  const body = { ...op.body, base_updated_at: op.server_record?.updated_at };
  try {
    const r = await fetch(op.endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw Object.assign(new Error(e.error || 'Could not apply your edit.'), { status: r.status }); }
    const record = await r.json(); removeQueued(id); return { ok: true, record };
  } catch (e) { return { ok: false, error: e.message, status: e.status }; }
}
function emit() {
  const s = getState();
  listeners.forEach((fn) => { try { fn(s); } catch {} });
}
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
// would send it) plus assessment_id. The operation record gets a client uuid
// and queued_at here. Best-effort: the in-memory mirror updates synchronously
// (so the UI reacts immediately); persistence to IndexedDB happens behind it.
export function enqueuePoint(payload) {
  const op = buildOperation(payload);
  memoryQueue = sortOps([...memoryQueue, op]);
  emit();
  putOp(op).catch(() => {});
  requestBackgroundSync();
  return operationToView(op);
}

export function removeQueued(uuid) {
  // Only the owning account may cancel a queued record.
  const op = myOps().find((o) => o.id === uuid);
  if (!op) return;
  memoryQueue = memoryQueue.filter((o) => o.id !== uuid);
  emit();
  deleteOp(uuid).catch(() => {});
}

function recordFailure(op, message, extra = {}) {
  const updated = { ...op, attempts: (op.attempts || 0) + 1, last_error: message, ...extra };
  const idx = memoryQueue.findIndex((o) => o.id === op.id);
  if (idx !== -1) memoryQueue[idx] = updated;
  emit();
  putOp(updated).catch(() => {});
}

// POST each queued operation with the session token. Success → remove from
// queue. 401/403 → stop (session expired). Network error → record the attempt,
// stop (server unreachable; next online event / sync / manual retry). Other
// HTTP errors → record the attempt, keep going so one bad row doesn't block
// the rest. Returns { synced, failed, stopped }.
//
// Only the signed-in account's own operations are replayed: another account's
// queued records are never posted under this session's token (the server would
// reject them anyway, silently, since they belong to another organization).
export async function flushQueue() {
  if (flushing) return { skipped: true, synced: 0, failed: 0, stopped: null };
  flushing = true;
  try {
    const mine = myOps();
    if (!mine.length) return { synced: 0, failed: 0, stopped: null };
    const token = localStorage.getItem('clearpath_token');
    if (!token) return { synced: 0, failed: mine.length, stopped: 'auth' };
    let synced = 0, failed = 0, stopped = null;
    for (const op of mine) {
      if (op.status === 'conflicted') continue;
      try {
        const r = await fetch(op.endpoint, {
          method: op.method || 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(op.body),
        });
        if (r.ok) { removeQueued(op.id); synced++; }
        else if (r.status === 409) {
          const data = await r.json().catch(() => ({}));
          recordFailure(op, data.error || 'Conflict detected', { status: 'conflicted', server_record: data, conflict: true });
          failed++;
        }
        else if (r.status === 401 || r.status === 403) { stopped = 'auth'; break; }
        else { recordFailure(op, `HTTP ${r.status}`); failed++; }
      } catch (err) {
        recordFailure(op, (err && err.message) ? err.message : String(err));
        stopped = 'network';
        break;
      }
    }
    return { synced, failed, stopped };
  } finally { flushing = false; }
}

// --- Background Sync ---
// Register a one-shot sync after each enqueue (best-effort). The service
// worker forwards 'sync' events for our tag to open pages, which flush the
// queue. Browsers without SyncManager fall back to the window 'online' event.
function requestBackgroundSync() {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    if (typeof window === 'undefined' || !('SyncManager' in window)) return;
    navigator.serviceWorker.ready
      .then((reg) => reg.sync.register(SYNC_TAG).catch(() => {}))
      .catch(() => {});
  } catch {}
}

// Service worker forwards sync events via postMessage. No-op when offline
// (nothing to reach) or when a flush is already running (flushQueue's guard).
if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === SYNC_TAG && navigator.onLine) {
      flushQueue();
    }
  });
}

// --- Target-behavior cache (for offline data entry) ---
// Scoped by account so cached client data does not outlive the session that
// cached it on a shared computer.
function behaviorKey(assessmentId, accountId) {
  const acct = accountId === undefined ? currentAccountId() : accountId;
  return `${BEHAVIOR_PREFIX}${acct == null ? 'anon' : acct}_${assessmentId}`;
}
export function cacheBehaviors(assessmentId, behaviors) {
  try { localStorage.setItem(behaviorKey(assessmentId), JSON.stringify(behaviors || [])); } catch {}
}
export function getCachedBehaviors(assessmentId) {
  try {
    const raw = localStorage.getItem(behaviorKey(assessmentId));
    if (raw) return JSON.parse(raw);
    // Cache written before account scoping: adopt it for the signed-in account.
    const legacyKey = BEHAVIOR_PREFIX + assessmentId;
    const legacyRaw = localStorage.getItem(legacyKey);
    if (!legacyRaw) return null;
    const parsed = JSON.parse(legacyRaw);
    try { localStorage.setItem(behaviorKey(assessmentId), legacyRaw); localStorage.removeItem(legacyKey); } catch {}
    return parsed;
  } catch { return null; }
}

// Delete everything this device holds for one account: its queued operations
// (IndexedDB + the in-memory mirror) and its cached client data. Called on
// sign-out so unsynced PHI does not stay readable on a shared computer.
export async function purgeAccount(accountId) {
  const id = accountId == null ? currentAccountId() : String(accountId);
  // Unstamped leftovers belong to no account and are purged with any sign-out.
  const doomed = memoryQueue.filter((o) => o.account_id == null || (id != null && String(o.account_id) === id));
  memoryQueue = memoryQueue.filter((o) => !doomed.includes(o));
  emit();
  for (const op of doomed) {
    try { await deleteOp(op.id); } catch {}
  }
  if (typeof localStorage !== 'undefined') {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k) keys.push(k); }
      for (const k of keys) {
        const scoped = id != null && k.startsWith(`${BEHAVIOR_PREFIX}${id}_`);
        const legacyUnscoped = /^clearpath_behaviors_\d+$/.test(k);
        if (scoped || legacyUnscoped) localStorage.removeItem(k);
      }
    } catch {}
  }
  return { purged: doomed.length };
}

// Kick off the initial load + migration on app boot (browser only; Node test
// imports skip this). emit() after load refreshes any subscribers that read
// the queue before IndexedDB finished opening.
if (typeof window !== 'undefined' && typeof indexedDB !== 'undefined' && typeof localStorage !== 'undefined') {
  initQueue();
}
