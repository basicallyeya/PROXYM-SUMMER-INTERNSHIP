'use strict';
/* shared/db.js
   Persistent session history (IndexedDB), shared by recorder.js (writes
   a full record including the video blob when a recording finishes) and
   popup.js (reads the list to show in the Results screen). chrome.storage
   isn't used for this because video blobs can be many MB and exceed its
   quota; IndexedDB stores Blob values natively and the unlimitedStorage
   permission keeps Chrome from evicting them under storage pressure. */

const QA_DB_NAME    = 'qa_sessions_db';
const QA_DB_VERSION = 1;
const QA_STORE      = 'sessions';
const QA_MAX_SESSIONS = 15; // oldest sessions beyond this are pruned automatically

function qaDbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(QA_DB_NAME, QA_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(QA_STORE)) {
        db.createObjectStore(QA_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function qaGetAllRaw(db) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(QA_STORE, 'readonly');
    const req = tx.objectStore(QA_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });
}

async function qaPruneSessions(db) {
  const all = await qaGetAllRaw(db);
  if (all.length <= QA_MAX_SESSIONS) return;
  const sorted    = all.sort((a, b) => a.timestamp - b.timestamp);
  const toDelete  = sorted.slice(0, sorted.length - QA_MAX_SESSIONS);
  await new Promise((resolve, reject) => {
    const tx    = db.transaction(QA_STORE, 'readwrite');
    const store = tx.objectStore(QA_STORE);
    toDelete.forEach(s => store.delete(s.id));
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

async function qaSaveSession(record) {
  const db = await qaDbOpen();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(QA_STORE, 'readwrite');
    tx.objectStore(QA_STORE).put(record);
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
  await qaPruneSessions(db);
  db.close();
}

async function qaGetAllSessions() {
  const db  = await qaDbOpen();
  const all = await qaGetAllRaw(db);
  db.close();
  return all.sort((a, b) => b.timestamp - a.timestamp);
}

async function qaGetSession(id) {
  const db = await qaDbOpen();
  const record = await new Promise((resolve, reject) => {
    const tx  = db.transaction(QA_STORE, 'readonly');
    const req = tx.objectStore(QA_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });
  db.close();
  return record;
}

async function qaDeleteSession(id) {
  const db = await qaDbOpen();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(QA_STORE, 'readwrite');
    tx.objectStore(QA_STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
  db.close();
}
