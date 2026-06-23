'use strict';
/* popup.js, clean delegation model
   - Checks permissions via navigator.permissions first (no tab if already granted)
   - Opens permissions tab only when needed
   - Background receives PERMISSIONS_DONE and opens the recorder tab
   - Popup can be closed after recorder tab opens */

const state = {
  micOn: true, camOn: false, ctrlBarOn: true,
  quality: '720', mode: 'desktop', countdownSec: 3,
  priority: 'medium',
  layer: '', environment: '', testType: '', sprint: '',
  tags: [],
  rules: [],
};

/* ─── Screen router ─── */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + id);
  if (el) el.classList.add('active');
  document.querySelectorAll('.tab-btn[data-screen]').forEach(b =>
    b.classList.toggle('active', b.dataset.screen === id));
  if (id === 'results') loadResults();
  if (id === 'notes') loadNotes();
}

function toast(msg, ms = 4000) {
  let t = document.getElementById('qa-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'qa-toast';
    t.style.cssText = 'position:fixed;bottom:14px;left:50%;transform:translateX(-50%);background:#16223A;border:1px solid rgba(148,163,253,.25);color:white;padding:9px 16px;border-radius:10px;font-size:11.5px;font-weight:500;z-index:9999;white-space:nowrap;box-shadow:0 8px 24px rgba(0,0,0,.5);pointer-events:none;transition:opacity .3s';
    document.body.appendChild(t);
  }
  t.textContent = msg; t.style.opacity = '1';
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.style.opacity = '0'; }, ms);
}

/* ─── Validation ─── */
function validated() {
  const n = document.getElementById('tester-name').value.trim();
  const s = document.getElementById('session-title').value.trim();
  return { name: n, title: s, ok: n.length > 0 && s.length > 0 };
}
function shakeEmpty() {
  ['tester-name','session-title'].forEach(id => {
    const el = document.getElementById(id);
    if (!el.value.trim()) {
      el.classList.add('input-error'); el.focus();
      setTimeout(() => el.classList.remove('input-error'), 2000);
      return false;
    }
  });
}

/* ─── Current tab helper (shared by notes count + notes screen) ─── */
function getCurrentTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => resolve(tabs[0] || null));
  });
}
function hostOf(tab) {
  if (!tab || !tab.url) return null;
  try { return new URL(tab.url).hostname || tab.url; } catch (_) { return null; }
}

/* ─── Nav ─── */
document.querySelectorAll('.tab-btn[data-screen]').forEach(el => {
  el.addEventListener('click', () => {
    if (el.dataset.screen === 'record-setup' && !validated().ok) {
      showScreen('idle'); toast('Please enter your name and session title first'); shakeEmpty(); return;
    }
    showScreen(el.dataset.screen);
  });
});
document.querySelectorAll('[data-screen]:not(.tab-btn)').forEach(el => {
  el.addEventListener('click', () => showScreen(el.dataset.screen));
});
document.getElementById('btn-start').addEventListener('click', () => {
  if (!validated().ok) { toast('Please enter your name and session title first'); shakeEmpty(); return; }
  showScreen('record-setup');
});
document.getElementById('btn-back').addEventListener('click', () => showScreen('idle'));

/* ─── Quality ─── */
document.querySelectorAll('.q-tag').forEach(t => {
  t.addEventListener('click', () => {
    if (t.dataset.q === 'mp4') { t.classList.toggle('selected'); return; }
    document.querySelectorAll('.q-tag:not([data-q="mp4"])').forEach(x => x.classList.remove('selected'));
    t.classList.add('selected'); state.quality = t.dataset.q;
  });
});

/* ─── Countdown stepper ─── */
document.getElementById('cnt-minus').addEventListener('click', () => {
  if (state.countdownSec > 0) state.countdownSec--;
  document.getElementById('cnt-value').textContent = state.countdownSec;
});
document.getElementById('cnt-plus').addEventListener('click', () => {
  if (state.countdownSec < 10) state.countdownSec++;
  document.getElementById('cnt-value').textContent = state.countdownSec;
});

/* ─── Toggles ─── */
function makeToggle(id, key, iconSel) {
  document.getElementById(id).addEventListener('click', () => {
    state[key] = !state[key];
    document.getElementById(id).classList.toggle('on', state[key]);
    if (iconSel) { const el = document.querySelector(iconSel); if (el) el.classList.toggle('on', state[key]); }
  });
}
makeToggle('toggle-mic',     'micOn',     '#opt-mic .option-icon');
makeToggle('toggle-cam',     'camOn',     '#icon-cam');
makeToggle('toggle-ctrlbar', 'ctrlBarOn', '#icon-ctrlbar');

/* ══════════════════════════════════════════════════════════════
   NOTES
   Stored in chrome.storage.local under 'qa_notes', keyed by tab
   hostname: { [host]: [{ id, text, ts }, ...] }
══════════════════════════════════════════════════════════════ */
function fmtNoteDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' at ' +
         d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function refreshNotesCount() {
  getCurrentTab().then(tab => {
    const el = document.getElementById('notes-count');
    if (!el) return;
    const host = hostOf(tab);
    if (!host) { el.textContent = 'Not available on this page'; return; }
    chrome.storage.local.get(['qa_notes'], (r) => {
      const notes = (r.qa_notes && r.qa_notes[host]) || [];
      el.textContent = notes.length > 0 ? `${notes.length} note${notes.length > 1 ? 's' : ''} on this page` : 'No notes on this page';
    });
  });
}

function loadNotes() {
  getCurrentTab().then(tab => {
    const host = hostOf(tab);
    const hostEl = document.getElementById('notes-host');
    const composeEl = document.querySelector('.note-compose');
    if (hostEl) hostEl.textContent = host || 'This page';
    if (composeEl) composeEl.style.display = host ? '' : 'none';
    renderNotesList(host);
  });
}

function renderNotesList(host) {
  const list = document.getElementById('notes-list');
  if (!list) return;
  if (!host) {
    list.innerHTML = '<p class="notes-empty">Notes are not available on this kind of page.</p>';
    return;
  }
  chrome.storage.local.get(['qa_notes'], (r) => {
    const notes = (r.qa_notes && r.qa_notes[host]) || [];
    if (notes.length === 0) {
      list.innerHTML = '<p class="notes-empty">No notes yet for this page.</p>';
      return;
    }
    list.innerHTML = '';
    notes.slice().reverse().forEach(note => {
      const row = document.createElement('div');
      row.className = 'note-item';
      row.innerHTML = `
        <div class="note-item-body">
          <p class="note-item-text"></p>
          <p class="note-item-meta">${fmtNoteDate(note.ts)}</p>
        </div>
        <button class="note-item-del" title="Delete note">
          <svg viewBox="0 0 20 20" fill="none"><path d="M4 6h12M8 6V4.5a1 1 0 011-1h2a1 1 0 011 1V6m-7 0l.6 9.4a1.5 1.5 0 001.5 1.6h4.8a1.5 1.5 0 001.5-1.6L15 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>`;
      row.querySelector('.note-item-text').textContent = note.text;
      row.querySelector('.note-item-del').addEventListener('click', () => deleteNote(host, note.id));
      list.appendChild(row);
    });
  });
}

function deleteNote(host, id) {
  chrome.storage.local.get(['qa_notes'], (r) => {
    const notes = r.qa_notes || {};
    notes[host] = (notes[host] || []).filter(n => n.id !== id);
    chrome.storage.local.set({ qa_notes: notes }, () => {
      renderNotesList(host);
      refreshNotesCount();
    });
  });
}

document.getElementById('btn-add-note').addEventListener('click', () => {
  const input = document.getElementById('note-input');
  const text = input.value.trim();
  if (!text) { input.focus(); return; }
  getCurrentTab().then(tab => {
    const host = hostOf(tab);
    if (!host) { toast("Notes aren't available on this page"); return; }
    chrome.storage.local.get(['qa_notes'], (r) => {
      const notes = r.qa_notes || {};
      notes[host] = notes[host] || [];
      notes[host].push({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), text, ts: Date.now() });
      chrome.storage.local.set({ qa_notes: notes }, () => {
        input.value = '';
        renderNotesList(host);
        refreshNotesCount();
        toast('Note saved');
      });
    });
  });
});

/* Blocking confirmation (not a timed toast) for pages where Chrome
   forbids any extension UI, guarantees the user actually sees it
   before we proceed, rather than risking a missed/cut-off toast. */
function showRestrictedPageConfirm() {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(5,8,16,.95);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:28px;text-align:center;';
    overlay.innerHTML = `
      <p style="font-size:14px;font-weight:700;color:white;margin:0;">Control bar won't appear on this page</p>
      <p style="font-size:12px;color:rgba(248,250,252,.62);line-height:1.6;margin:0;max-width:260px;">Chrome blocks every extension from showing UI here (browser restriction, e.g. the New Tab Page or another extension's page). Recording will still capture your screen, you just won't see the countdown or control bar on this tab.</p>
      <div style="display:flex;gap:10px;margin-top:4px;">
        <button id="restricted-cancel" style="padding:10px 18px;border-radius:10px;border:1.5px solid rgba(148,163,253,.28);background:none;color:rgba(248,250,252,.7);font-size:12.5px;cursor:pointer;font-family:inherit;">Go Back</button>
        <button id="restricted-continue" style="padding:10px 18px;border-radius:10px;border:none;background:linear-gradient(135deg,#2563EB,#7C3AED);color:white;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;">Continue Anyway</button>
      </div>
    `;
    document.body.appendChild(overlay);
    document.getElementById('restricted-cancel').addEventListener('click', () => { overlay.remove(); resolve(false); });
    document.getElementById('restricted-continue').addEventListener('click', () => { overlay.remove(); resolve(true); });
  });
}

/* ── Priority ── */
document.querySelectorAll('.priority-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.priority-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    state.priority = btn.dataset.priority;
  });
});

/* ── Context fields ── */
document.getElementById('ctx-layer').addEventListener('change',  e => { state.layer       = e.target.value; });
document.getElementById('ctx-env').addEventListener('change',    e => { state.environment  = e.target.value; });
document.getElementById('ctx-type').addEventListener('change',   e => { state.testType     = e.target.value; });
document.getElementById('ctx-sprint').addEventListener('input',  e => { state.sprint       = e.target.value.trim(); });

/* ── Tags ── */
function renderTags() {
  const list = document.getElementById('tags-list');
  list.innerHTML = '';
  state.tags.forEach((tag, i) => {
    const chip = document.createElement('div');
    chip.className = 'tag-chip';
    chip.innerHTML = `<span>${tag}</span><button class="tag-chip-del" title="Remove">×</button>`;
    chip.querySelector('.tag-chip-del').addEventListener('click', () => {
      state.tags.splice(i, 1); renderTags();
    });
    list.appendChild(chip);
  });
}
function addTag() {
  const input = document.getElementById('tag-input');
  const val   = input.value.trim().toLowerCase().replace(/\s+/g, '-');
  if (!val || state.tags.includes(val)) { input.value = ''; return; }
  state.tags.push(val);
  input.value = '';
  renderTags();
}
document.getElementById('btn-add-tag').addEventListener('click', addTag);
document.getElementById('tag-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } });

/* ── Rules ── */
function renderRules() {
  const list = document.getElementById('rules-list');
  list.innerHTML = '';
  state.rules.forEach((rule, i) => {
    const item = document.createElement('div');
    item.className = 'rule-item';
    item.innerHTML = `
      <span class="rule-item-text"></span>
      <button class="rule-item-del" title="Remove">
        <svg viewBox="0 0 20 20" fill="none"><path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>`;
    item.querySelector('.rule-item-text').textContent = rule;
    item.querySelector('.rule-item-del').addEventListener('click', () => {
      state.rules.splice(i, 1); renderRules();
    });
    list.appendChild(item);
  });
}
function addRule() {
  const input = document.getElementById('rule-input');
  const val   = input.value.trim();
  if (!val) { input.focus(); return; }
  state.rules.push(val);
  input.value = '';
  renderRules();
}
document.getElementById('btn-add-rule').addEventListener('click', addRule);
document.getElementById('rule-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addRule(); } });

/* ── Settings: Jira + ClickUp ── */
function loadConnectorSettings() {
  chrome.storage.local.get(['qa_jira', 'qa_clickup'], (r) => {
    const jira    = r.qa_jira    || {};
    const clickup = r.qa_clickup || {};
    if (jira.url)     { document.getElementById('jira-url').value     = jira.url;     }
    if (jira.email)   { document.getElementById('jira-email').value   = jira.email;   }
    if (jira.token)   { document.getElementById('jira-token').value   = jira.token;   }
    if (jira.project) { document.getElementById('jira-project').value = jira.project; }
    if (clickup.token){ document.getElementById('clickup-token').value= clickup.token;}
    if (clickup.list) { document.getElementById('clickup-list').value = clickup.list; }
    updateConnectorBadges(jira, clickup);
  });
}

function updateConnectorBadges(jira, clickup) {
  const jBadge = document.getElementById('jira-status-badge');
  const cBadge = document.getElementById('clickup-status-badge');
  if (jira && jira.url && jira.token) {
    jBadge.textContent = '✓ Configured'; jBadge.classList.add('configured');
  } else {
    jBadge.textContent = 'Not configured'; jBadge.classList.remove('configured');
  }
  if (clickup && clickup.token) {
    cBadge.textContent = '✓ Configured'; cBadge.classList.add('configured');
  } else {
    cBadge.textContent = 'Not configured'; cBadge.classList.remove('configured');
  }
}

document.getElementById('btn-save-jira').addEventListener('click', () => {
  const jira = {
    url:     document.getElementById('jira-url').value.trim().replace(/\/$/, ''),
    email:   document.getElementById('jira-email').value.trim(),
    token:   document.getElementById('jira-token').value.trim(),
    project: document.getElementById('jira-project').value.trim().toUpperCase(),
  };
  chrome.storage.local.set({ qa_jira: jira }, () => {
    updateConnectorBadges(jira, null);
    toast('Jira settings saved');
  });
});

document.getElementById('btn-save-clickup').addEventListener('click', () => {
  const clickup = {
    token: document.getElementById('clickup-token').value.trim(),
    list:  document.getElementById('clickup-list').value.trim(),
  };
  chrome.storage.local.set({ qa_clickup: clickup }, () => {
    updateConnectorBadges(null, clickup);
    toast('ClickUp settings saved');
  });
});

loadConnectorSettings();

/* ══════════════════════════════════════════════════════════════
   LAUNCH
══════════════════════════════════════════════════════════════ */
document.getElementById('btn-launch').addEventListener('click', async () => {
  if (!validated().ok) { showScreen('idle'); toast('Please fill in your name and session title'); shakeEmpty(); return; }

  const needMic = state.micOn;
  const needCam = state.camOn;

  // Capture the tab the user is actually looking at RIGHT NOW, before the
  // permissions/recorder tab we're about to open steals "active" status
  // from it. This is the only point in the flow where "active tab" is
  // unambiguous.
  const targetTab = await getCurrentTab();
  const targetTabId = targetTab ? targetTab.id : null;

  // Chrome blocks ALL extensions from injecting into chrome:// pages,
  // including the New Tab Page, and other extensions' pages. Recording
  // still captures the screen fine there, but the countdown/control bar
  // can never appear, with no workaround.
  const url = targetTab && targetTab.url || '';
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('edge://') || url.startsWith('about:')) {
    const proceed = await showRestrictedPageConfirm();
    if (!proceed) { showScreen('record-setup'); return; }
  }

  if (needMic || needCam) {
    // Save recorder config in background worker BEFORE opening permissions tab.
    // The popup closes when the new tab opens, so we can't poll from here.
    // Background worker receives PERMISSIONS_DONE and opens the recorder tab.
    const { name, title } = validated();
    const config = {
      mode:         state.mode,
      quality:      state.quality,
      micOn:        state.micOn,
      camOn:        state.camOn,
      ctrlBarOn:    state.ctrlBarOn,
      countdownSec: state.countdownSec,
      title,
      tester:       name,
      targetTabId,
      priority:     state.priority,
      layer:        state.layer,
      environment:  state.environment,
      testType:     state.testType,
      sprint:       state.sprint,
      tags:         state.tags,
      rules:        state.rules,
    };
    chrome.runtime.sendMessage({ type: 'SAVE_RECORDER_CONFIG', config }, () => {
      const url = chrome.runtime.getURL('permissions/permissions.html')
        + `?mic=${needMic ? 1 : 0}&cam=${needCam ? 1 : 0}`;
      chrome.tabs.create({ url });
      showScreen('waiting-perms');
    });
  } else {
    // No mic/cam needed, open recorder directly from popup
    openRecorder(false, false, targetTabId);
  }
});

/* ══════════════════════════════════════════════════════════════
   OPEN RECORDER TAB
══════════════════════════════════════════════════════════════ */
function openRecorder(micGranted, camGranted, targetTabId) {
  const { name, title } = validated();
  const params = new URLSearchParams({
    mode:        state.mode,
    quality:     state.quality,
    mic:         state.micOn ? '1' : '0',
    cam:         state.camOn ? '1' : '0',
    ctrlbar:     state.ctrlBarOn ? '1' : '0',
    countdown:   String(state.countdownSec),
    title:       title,
    tester:      name,
    micg:        micGranted ? '1' : '0',
    camg:        camGranted ? '1' : '0',
    target:      targetTabId != null ? String(targetTabId) : '',
    priority:    state.priority,
    layer:       state.layer,
    environment: state.environment,
    testType:    state.testType,
    sprint:      state.sprint,
    tags:        JSON.stringify(state.tags),
    rules:       JSON.stringify(state.rules),
  });
  const url = chrome.runtime.getURL('recorder/recorder.html') + '?' + params.toString();
  chrome.tabs.create({ url });
  showScreen('recording-active');
}

document.getElementById('cancel-perms').addEventListener('click', () => showScreen('record-setup'));

document.getElementById('btn-stop-from-popup').addEventListener('click', (e) => {
  e.currentTarget.disabled = true;
  chrome.runtime.sendMessage({ type: 'CONTROLBAR_STOP' });
  toast('Stopping recording…');
});

/* ══════════════════════════════════════════════════════════════
   RESULTS: every saved session, read from IndexedDB (shared/db.js).
   Each record includes the actual video blob, written by recorder.js
   when a recording finishes, so video and transcript can be downloaded
   again later, not just right after recording.
══════════════════════════════════════════════════════════════ */
function fmtDuration(s) {
  s = Math.round(s || 0);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}
function fmtBytes(b) {
  b = b || 0;
  return b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
}

function buildTranscriptText(s) {
  const priorityLabels = { critical:'P1 Critical', high:'P2 High', medium:'P3 Medium', low:'P4 Low' };
  const lines = [];

  lines.push('===========================================');
  lines.push('   QA Smart Assistant - Session Report');
  lines.push('===========================================');
  lines.push('');
  lines.push(`Session     : ${s.title     || 'QA Session'}`);
  lines.push(`Tester      : ${s.tester    || 'Tester'}`);
  lines.push(`Date        : ${new Date(s.timestamp).toLocaleString()}`);
  lines.push(`Duration    : ${fmtDuration(s.duration)}`);
  if (s.priority)    lines.push(`Priority    : ${priorityLabels[s.priority] || s.priority}`);
  if (s.layer)       lines.push(`Layer       : ${s.layer}`);
  if (s.environment) lines.push(`Environment : ${s.environment}`);
  if (s.testType)    lines.push(`Test Type   : ${s.testType}`);
  if (s.sprint)      lines.push(`Sprint      : ${s.sprint}`);
  if (s.tags && s.tags.length > 0) lines.push(`Tags        : ${s.tags.join(', ')}`);
  lines.push('');

  // Notes from the page
  if (s.pageNotes && s.pageNotes.length > 0) {
    lines.push('-------------------------------------------');
    lines.push('  PAGE NOTES');
    lines.push('-------------------------------------------');
    s.pageNotes.forEach(n => {
      lines.push(`  [${new Date(n.ts).toLocaleTimeString()}] ${n.text}`);
    });
    lines.push('');
  }

  // Rules checklist
  if (s.rules && s.rules.length > 0) {
    lines.push('-------------------------------------------');
    lines.push('  TEST RULES');
    lines.push('-------------------------------------------');
    s.rules.forEach(r => lines.push(`  ${r.checked ? '[x]' : '[ ]'} ${r.text}`));
    const done = s.rules.filter(r => r.checked).length;
    lines.push(`  Completed: ${done}/${s.rules.length}`);
    lines.push('');
  }

  // Voice transcript
  var annotations = s.annotations || [];
  if (annotations.length > 0) {
    lines.push('-------------------------------------------');
    lines.push('  BUG ANNOTATIONS');
    lines.push('-------------------------------------------');
    annotations.forEach(function(a) {
      lines.push('  [' + fmtDuration(a.ts) + '] [' + a.severity.toUpperCase() + '] ' + a.text);
    });
    lines.push('');
  }

  lines.push('-------------------------------------------');
  lines.push('  VOICE TRANSCRIPT');
  lines.push('-------------------------------------------');
  lines.push('');
  if (s.transcript && s.transcript.length > 0) {
    s.transcript.forEach((entry, i) => {
      const text = entry.text.charAt(0).toUpperCase() + entry.text.slice(1);
      lines.push(`[${fmtDuration(entry.ts)}]  ${text}`);
      if (i < s.transcript.length - 1) lines.push('');
    });
    lines.push('');
    lines.push(`Total entries: ${s.transcript.length}`);
  } else {
    lines.push('(No voice notes were recorded for this session)');
  }

  lines.push('');
  lines.push('Generated by QA Smart Assistant');
  lines.push('===========================================');
  return lines.join('\n');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function downloadSessionVideo(id, btn) {
  const s = await qaGetSession(id);
  if (!s || !s.videoBlob) { toast('Video not available for this session'); return; }
  downloadBlob(s.videoBlob, `${s.title || 'QA_Session'}.${s.extension || 'webm'}`);
}

async function downloadSessionTranscript(id) {
  const s = await qaGetSession(id);
  if (!s) { toast('Session not available'); return; }

  // Include page notes at top of report
  await new Promise(resolve => {
    chrome.storage.local.get(['qa_notes'], (r) => {
      const allNotes = r.qa_notes || {};
      const flat = Object.values(allNotes).flat().sort((a, b) => a.ts - b.ts);
      s.pageNotes = flat;
      resolve();
    });
  });

  const blob = new Blob([buildTranscriptText(s)], { type: 'text/plain;charset=utf-8' });
  downloadBlob(blob, (s.title || 'QA_Session') + '_report.txt');
}

function renderSessionCard(s) {
  const card = document.createElement('div');
  card.className = 'session-card';
  card.innerHTML = `
    <div class="session-card-head">
      <p class="session-card-title"></p>
      <span class="session-card-date"></span>
    </div>
    <div class="session-card-stats">
      <span>${fmtDuration(s.duration)}</span>
      <span>${fmtBytes(s.size)}</span>
      <span class="accent">${(s.extension || 'webm').toUpperCase()}</span>
    </div>
    <div class="session-card-actions">
      <button class="btn-session-dl" data-action="video">
        <svg viewBox="0 0 20 20" fill="none"><rect x="2" y="4" width="11" height="9" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M13 8l4-2.5v6L13 9" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
        Video
      </button>
      <button class="btn-session-dl" data-action="text">
        <svg viewBox="0 0 20 20" fill="none"><path d="M4 3h9l3 3v11a1 1 0 01-1 1H4a1 1 0 01-1-1V4a1 1 0 011-1z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M7 9h6M7 12h6M7 15h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        Transcript
      </button>
    </div>
  `;
  card.querySelector('.session-card-title').textContent = s.title || 'QA Session';
  card.querySelector('.session-card-date').textContent  = `${s.tester || 'Tester'} · ${new Date(s.timestamp).toLocaleDateString()}`;
  card.querySelector('[data-action="video"]').addEventListener('click', () => downloadSessionVideo(s.id));
  card.querySelector('[data-action="text"]').addEventListener('click', () => downloadSessionTranscript(s.id));
  return card;
}

async function loadResults() {
  const empty = document.getElementById('results-empty');
  const data  = document.getElementById('results-data');
  const list  = document.getElementById('results-list');
  let sessions = [];
  try { sessions = await qaGetAllSessions(); } catch (e) { console.warn('[QA] loadResults:', e.message); }

  if (!sessions || sessions.length === 0) {
    empty.style.display = '';
    data.style.display  = 'none';
    return;
  }
  empty.style.display = 'none';
  data.style.display  = '';
  list.innerHTML = '';
  sessions.forEach(s => list.appendChild(renderSessionCard(s)));
}

/* ─── Init: notes count on Home ─── */
refreshNotesCount();
