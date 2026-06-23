'use strict';

let recordingData    = null;
let blobURL          = null;
let whisperDone      = false; // true after Whisper transcription completes

/* Persist rules + annotations back to IndexedDB so Results page sees latest state */
async function persistSession() {
  if (!recordingData || !recordingData.sessionId) return;
  try {
    await qaUpdateSessionFields(recordingData.sessionId, {
      rules:       recordingData.rules       || [],
      annotations: window.__qa_annotations__ || [],
      transcript:  recordingData.transcript  || [],
    });
  } catch(e) { console.warn('[QA] persistSession:', e.message); }
}

function fmt(s) {
  s = Math.round(s || 0);
  return `${Math.floor(s/60)}:${(s%60).toString().padStart(2,'0')}`;
}
function fmtSize(b) {
  b = b || 0;
  return b < 1048576 ? (b/1024).toFixed(0)+' KB' : (b/1048576).toFixed(1)+' MB';
}



function showError(msg) {
  const lo = document.getElementById('overlay-loading');
  const oe = document.getElementById('overlay-error');
  const em = document.getElementById('error-msg');
  if (lo) lo.style.display = 'none';
  if (oe) oe.style.display = 'flex';
  if (em && msg) em.textContent = msg;
}

function fillMeta(data) {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('video-title',  `${data.title || 'QA_Session'}.${data.extension || 'webm'}`);
  set('video-meta',   `Tester: ${data.tester || 'Unknown'} · ${fmt(data.duration)} · ${fmtSize(data.size)}`);
  set('panel-title',  data.title  || 'Recording Complete');
  set('panel-sub',    `By ${data.tester || 'Tester'} · ${fmt(data.duration)}`);
  set('stat-dur',     fmt(data.duration));
  set('stat-size',    fmtSize(data.size));
  set('stat-fmt',     (data.extension || 'webm').toUpperCase());
  document.title = `Review: ${data.title || 'QA Session'}`;

  // ── Metadata Panel ──
  const panel = document.getElementById('meta-panel');
  if (panel) {
    panel.style.display = 'flex';
    // Priority badge
    const pb = document.getElementById('meta-priority');
    if (pb) {
      const p = data.priority || 'medium';
      const labels = { critical:'🔴 Critical', high:'🟠 High', medium:'🟡 Medium', low:'🟢 Low' };
      pb.textContent = labels[p] || p;
      pb.className = `meta-priority-badge ${p}`;
    }
    // Context fields
    function setMeta(rowId, valId, val) {
      const row = document.getElementById(rowId);
      const el  = document.getElementById(valId);
      if (val && row && el) { el.textContent = val; row.style.display = 'flex'; }
    }
    setMeta('meta-row-layer',  'meta-layer',  data.layer);
    setMeta('meta-row-env',    'meta-env',    data.environment);
    setMeta('meta-row-type',   'meta-type',   data.testType);
    setMeta('meta-row-sprint', 'meta-sprint', data.sprint);
    // Tags
    if (data.tags && data.tags.length > 0) {
      const tagsRow  = document.getElementById('meta-row-tags');
      const tagsCont = document.getElementById('meta-tags');
      if (tagsRow && tagsCont) {
        tagsRow.style.display = 'flex';
        tagsCont.innerHTML = data.tags.map(t => `<span class="meta-tag">${t}</span>`).join('');
      }
    }
  }

  // ── Rules Checklist ──
  if (data.rules && data.rules.length > 0) {
    const rulesPanel     = document.getElementById('rules-panel');
    const rulesChecklist = document.getElementById('rules-checklist');
    if (rulesPanel && rulesChecklist) {
      rulesPanel.style.display = 'flex';
      rulesChecklist.innerHTML = '';
      data.rules.forEach((rule, i) => {
        const item = document.createElement('div');
        item.className = `rule-check-item${rule.checked ? ' checked' : ''}`;
        item.innerHTML = `
          <div class="rule-check-box">${rule.checked ? '<svg viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}</div>
          <span class="rule-check-text"></span>`;
        item.querySelector('.rule-check-text').textContent = rule.text;
        item.addEventListener('click', () => {
          rule.checked = !rule.checked;
          item.classList.toggle('checked', rule.checked);
          const box = item.querySelector('.rule-check-box');
          box.innerHTML = rule.checked ? '<svg viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '';
          item.querySelector('.rule-check-text').style.textDecoration = rule.checked ? 'line-through' : '';
          persistSession();
        });
        rulesChecklist.appendChild(item);
      });
    }
  }

  // Always show Voice Notes section
  const box  = document.getElementById('transcript-box');
  const list = document.getElementById('t-list');
  if (box) box.style.display = 'flex';

  if (data.transcript && data.transcript.length > 0) {
    renderTranscriptList(data.transcript, whisperDone ? 'whisper' : 'sr');
  } else {
    if (list) {
      list.innerHTML = `<p class="t-empty">No voice notes recorded.<br>Enable microphone and speak during recording.</p>`;
    }
  }
}

function getDuration(video, fallback) {
  if (video.seekable && video.seekable.length > 0) {
    const d = video.seekable.end(video.seekable.length - 1);
    if (isFinite(d) && d > 0) return d;
  }
  if (isFinite(video.duration) && video.duration > 0) return video.duration;
  return fallback || 0;
}

function initVideo(url, data) {
  const video = document.getElementById('rv');
  if (!video) return;
  video.src = url;

  video.addEventListener('loadedmetadata', () => {
    const lo = document.getElementById('overlay-loading');
    const vw = document.getElementById('video-wrap');
    const vi = document.getElementById('video-info');
    if (lo) lo.style.display = 'none';
    if (vw) vw.style.display = 'block';
    if (vi) vi.style.display = 'flex';
    setupControls(video, data);
  }, { once: true });

  video.addEventListener('error', () => {
    showError('Video could not be played in the browser. Click "Download Recording" and open the file in VLC.');
  }, { once: true });
}

function setupControls(video, data) {
  const playBtn  = document.getElementById('vc-play');
  const playIcon = document.getElementById('play-icon');
  const timeEl   = document.getElementById('vc-time');
  const fillEl   = document.getElementById('vc-fill');
  const barEl    = document.getElementById('vc-bar');
  const muteBtn  = document.getElementById('vc-mute');
  const fsBtn    = document.getElementById('vc-fs');
  if (!playBtn) return;

  function updateTime() {
    const c   = isNaN(video.currentTime) ? 0 : video.currentTime;
    const dur = getDuration(video, data.duration);
    if (timeEl) timeEl.textContent = `${fmt(c)} / ${fmt(dur)}`;
    if (fillEl && dur > 0) fillEl.style.width = ((c / dur) * 100) + '%';
  }

  playBtn.addEventListener('click', () => {
    if (video.paused) {
      video.play().catch(e => console.warn('[QA] play:', e));
      if (playIcon) playIcon.innerHTML = `<rect x="5" y="4" width="3" height="12" rx="1.5" fill="currentColor"/><rect x="12" y="4" width="3" height="12" rx="1.5" fill="currentColor"/>`;
    } else {
      video.pause();
      if (playIcon) playIcon.innerHTML = `<path d="M7 5l9 5-9 5V5z" fill="currentColor"/>`;
    }
  });

  video.addEventListener('ended', () => {
    if (playIcon) playIcon.innerHTML = `<path d="M7 5l9 5-9 5V5z" fill="currentColor"/>`;
  });
  video.addEventListener('timeupdate',     updateTime);
  video.addEventListener('loadedmetadata', updateTime);
  video.addEventListener('durationchange', updateTime);
  video.addEventListener('progress',       updateTime);

  if (barEl) {
    barEl.addEventListener('click', e => {
      const dur = getDuration(video, data.duration);
      if (!dur) return;
      const r = barEl.getBoundingClientRect();
      const t = ((e.clientX - r.left) / r.width) * dur;
      if (isFinite(t)) { try { video.currentTime = t; } catch(_) {} }
    });
  }

  let muted = false;
  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      muted = !muted; video.muted = muted;
      const vi = document.getElementById('vol-icon');
      if (vi) vi.innerHTML = muted
        ? `<path d="M5 7H2v6h3l5 4V3L5 7z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" opacity=".3"/><line x1="13" y1="8" x2="18" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="18" y1="8" x2="13" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`
        : `<path d="M5 7H2v6h3l5 4V3L5 7z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M14.5 6.5a5 5 0 010 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>`;
    });
  }

  if (fsBtn) {
    fsBtn.addEventListener('click', () => {
      const wrap = document.getElementById('video-wrap');
      if (!document.fullscreenElement) wrap.requestFullscreen().catch(() => {});
      else document.exitFullscreen().catch(() => {});
    });
  }
}

/* ════════════════════════════════
   LOAD RECORDING
   Receives blobURL from recorder tab via chrome.runtime.onMessage.
   The container duration is already fixed by recorder.js before sending,
   so seeking and correct duration work out of the box.
════════════════════════════════ */
function loadRecording() {
  // Waits for RECORDING_DATA message from recorder tab
}

/* Receive recording data from recorder tab */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'RECORDING_DATA' && msg.data) {
    recordingData = msg.data;
    blobURL       = msg.data.blobURL;

    if (!blobURL) {
      showError('No blob URL received.');
      sendResponse({ ok: false });
      return true;
    }

    fillMeta(recordingData);
    initVideo(blobURL, recordingData);

    // Load screenshots — from data (recorder relay) or session storage fallback
    const initialShots = recordingData.screenshots || [];
    if (initialShots.length > 0) {
      renderScreenshots(initialShots);
    } else {
      // Try session storage fallback
      chrome.storage.session.get(['qa_screenshots'], (r) => {
        const shots = r.qa_screenshots || [];
        if (shots.length > 0) {
          // Attach to recordingData with index
          recordingData.screenshots = shots.map((s, i) => ({ ...s, index: i + 1 }));
          renderScreenshots(recordingData.screenshots);
        }
      });
    }
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

/* Timeout: if no data in 20s show error */
setTimeout(() => {
  const video = document.getElementById('rv');
  if (!video || !video.src) {
    showError('No recording received. The recorder tab may have been closed before the video was sent. Please try again and keep the recorder tab open until you download.');
  }
}, 20000);

/* ════════════════════════════════
   GROQ TRANSCRIPTION
   Calls Groq API directly from the browser — no local server needed.
   Uses whisper-large-v3 model. Free tier: 7200s/day.
════════════════════════════════ */
const GROQ_API_KEY = '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';
const GROQ_URL     = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL   = 'whisper-large-v3';
let selectedLang   = 'en'; // default English

function setWhisperStatus(msg, state) {
  // state: 'loading' | 'ok' | 'warn'
  const bar     = document.getElementById('whisper-status');
  const text    = document.getElementById('whisper-status-text');
  const spinner = document.getElementById('whisper-spinner');
  const iconOk  = document.getElementById('whisper-icon-ok');
  const iconWarn = document.getElementById('whisper-icon-warn');
  if (bar)  { bar.style.display = 'flex'; bar.className = 'whisper-status' + (state ? ' ' + state : ''); }
  if (text) text.textContent   = msg;
  if (spinner)  spinner.style.display  = state === 'loading' ? 'block' : 'none';
  if (iconOk)   iconOk.style.display   = state === 'ok'   ? 'block' : 'none';
  if (iconWarn) iconWarn.style.display = state === 'warn' ? 'block' : 'none';
}

function hideWhisperStatus() {
  const bar = document.getElementById('whisper-status');
  if (bar) bar.style.display = 'none';
}

function renderTranscriptList(segments, source, sourceLabel) {
  const list = document.getElementById('t-list');
  if (!list) return;

  // Update source badge
  const badge = document.getElementById('transcript-source-badge');
  if (badge) {
    if (source === 'whisper') {
      badge.className = 'source-badge sb-whisper';
      const label = sourceLabel || 'Whisper AI';
      badge.innerHTML = `<svg viewBox="0 0 20 20" fill="none"><path d="M5 10l4 4 6-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>${label}`;
    } else {
      badge.className = 'source-badge sb-sr';
      badge.innerHTML = `<svg viewBox="0 0 20 20" fill="none"><path d="M10 2l1.5 5.5L17 9l-5.5 1.5L10 16l-1.5-5.5L3 9l5.5-1.5L10 2z" fill="currentColor"/></svg>Live (Web Speech)`;
    }
    badge.style.display = 'block';
  }

  list.innerHTML = '';
  segments.forEach(e => {
    const row  = document.createElement('div');
    row.className = 't-row';
    const text = e.text.charAt(0).toUpperCase() + e.text.slice(1);
    row.innerHTML = `<span class="t-ts">${fmt(e.ts)}</span><span class="t-text"></span>`;
    row.querySelector('.t-text').textContent = text;
    list.appendChild(row);
  });
}

async function transcribeWithWhisper() {
  if (!blobURL) {
    alert('Recording not ready yet. Please wait for the video to load.');
    return;
  }

  const btn     = document.getElementById('btn-whisper');
  const btnText = document.getElementById('whisper-btn-text');
  if (btn) btn.disabled = true;
  if (btnText) btnText.textContent = 'Transcribing…';

  const langNames = { en: 'English', fr: 'French', ar: 'Arabic' };

  // Step 1: Fetch the blob from the blobURL
  setWhisperStatus('Preparing audio…', 'loading');
  let audioBlob;
  try {
    const resp = await fetch(blobURL);
    audioBlob  = await resp.blob();
  } catch(e) {
    setWhisperStatus('Could not read recording. Try downloading the file first.', 'warn');
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = 'Transcribe with Groq';
    return;
  }

  // Step 2: Convert to mp3/webm and send directly to Groq API
  // Groq accepts: mp3, mp4, mpeg, mpga, m4a, wav, webm (max 25MB)
  const ext      = (recordingData && recordingData.extension) || 'webm';
  const mimeType = ext === 'mp4' ? 'video/mp4' : 'video/webm';
  const filename = 'recording.' + ext;

  if (audioBlob.size > 24 * 1024 * 1024) {
    setWhisperStatus('Recording is too large for Groq (max 25MB). Try a shorter session.', 'warn');
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = 'Transcribe with Groq';
    return;
  }

  const formData = new FormData();
  formData.append('file', new File([audioBlob], filename, { type: mimeType }));
  formData.append('model', GROQ_MODEL);
  formData.append('language', selectedLang);
  formData.append('response_format', 'verbose_json');
  formData.append('timestamp_granularities[]', 'segment');

  setWhisperStatus('Sending to Groq AI (' + (langNames[selectedLang] || selectedLang) + ', ' + fmtSize(audioBlob.size) + ')…', 'loading');

  try {
    const resp = await fetch(GROQ_URL, {
      method:  'POST',
      headers: { 'Authorization': 'Bearer ' + GROQ_API_KEY },
      body:    formData,
      signal:  AbortSignal.timeout(120000), // 2 minute timeout
    });

    if (!resp.ok) {
      const errJson = await resp.json().catch(() => ({}));
      const errMsg  = (errJson.error && errJson.error.message) || ('Groq error ' + resp.status);
      throw new Error(errMsg);
    }

    const result = await resp.json();

    // Groq returns segments array with start/end/text
    const rawSegs = result.segments || [];
    const segments = rawSegs
      .filter(s => s.text && s.text.trim().length > 2)
      .map(s => ({
        ts:   Math.round(s.start || 0),
        end:  Math.round(s.end   || 0),
        text: s.text.trim(),
      }));

    if (segments.length === 0) {
      setWhisperStatus('Groq found no speech in the recording. Check that microphone was enabled.', 'warn');
      if (btn) btn.disabled = false;
      if (btnText) btnText.textContent = 'Try Again';
      return;
    }

    // Success — show results
    whisperDone = true;
    if (recordingData) recordingData.transcript = segments;
    persistSession(); // save transcript to IndexedDB

    const sourceLabel = '✓ Groq Cloud (' + GROQ_MODEL + ')';
    renderTranscriptList(segments, 'whisper', sourceLabel);
    hideWhisperStatus();
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = '✓ Transcribed';

    setWhisperStatus(sourceLabel + ' — ' + segments.length + ' segment' + (segments.length !== 1 ? 's' : ''), 'ok');
    setTimeout(hideWhisperStatus, 3000);

  } catch(e) {
    console.error('[QA Groq]', e);
    if (e.name === 'TimeoutError') {
      setWhisperStatus('Groq timed out. Recording may be too long. Try a shorter session.', 'warn');
    } else {
      setWhisperStatus('Groq error: ' + e.message, 'warn');
    }
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = 'Transcribe with Groq';
  }
}

// buttons wired below


/* ════════════════════════════════
   DOWNLOAD TRANSCRIPT / REPORT
════════════════════════════════ */
async function downloadTranscript() {
  const d      = recordingData;
  const tr     = d && d.transcript;
  const title  = (d && d.title)  || 'QA_Session';
  const tester = (d && d.tester) || 'Tester';
  const date   = new Date((d && d.timestamp) || Date.now()).toLocaleString();
  const dur    = fmt((d && d.duration) || 0);
  const priorityLabels = { critical:'P1 Critical', high:'P2 High', medium:'P3 Medium', low:'P4 Low' };

  // Fetch page notes from storage
  var pageNotes = [];
  try {
    var stored = await new Promise(function(resolve) {
      chrome.storage.local.get(['qa_notes'], function(r){ resolve(r.qa_notes || {}); });
    });
    pageNotes = Object.values(stored).flat().sort(function(a,b){return a.ts-b.ts;});
  } catch(e) {}

  const lines = [];
  lines.push('===========================================');
  lines.push('   QA Smart Assistant - Session Report');
  lines.push('===========================================');
  lines.push('');
  lines.push('Session     : ' + title);
  lines.push('Tester      : ' + tester);
  lines.push('Date        : ' + date);
  lines.push('Duration    : ' + dur);
  if (d && d.priority)    lines.push('Priority    : ' + (priorityLabels[d.priority] || d.priority));
  if (d && d.layer)       lines.push('Layer       : ' + d.layer);
  if (d && d.environment) lines.push('Environment : ' + d.environment);
  if (d && d.testType)    lines.push('Test Type   : ' + d.testType);
  if (d && d.sprint)      lines.push('Sprint      : ' + d.sprint);
  if (d && d.tags && d.tags.length > 0) lines.push('Tags        : ' + d.tags.join(', '));
  lines.push('');

  if (pageNotes.length > 0) {
    lines.push('-------------------------------------------');
    lines.push('  PAGE NOTES');
    lines.push('-------------------------------------------');
    pageNotes.forEach(function(n){ lines.push('  ' + n.text); });
    lines.push('');
  }

  if (d && d.rules && d.rules.length > 0) {
    lines.push('-------------------------------------------');
    lines.push('  TEST RULES');
    lines.push('-------------------------------------------');
    d.rules.forEach(function(r) { lines.push('  ' + (r.checked ? '[x]' : '[ ]') + ' ' + r.text); });
    var done = d.rules.filter(function(r){return r.checked;}).length;
    lines.push('  Completed: ' + done + '/' + d.rules.length);
    lines.push('');
  }

  var annotations = window.__qa_annotations__ || [];
  if (annotations.length > 0) {
    lines.push('-------------------------------------------');
    lines.push('  BUG ANNOTATIONS');
    lines.push('-------------------------------------------');
    annotations.forEach(function(a) {
      lines.push('  [' + fmt(a.ts) + '] [' + a.severity.toUpperCase() + '] ' + a.text);
    });
    lines.push('');
  }

  lines.push('-------------------------------------------');
  lines.push('  VOICE TRANSCRIPT');
  lines.push('-------------------------------------------');
  lines.push('');
  if (tr && tr.length > 0) {
    tr.forEach(function(entry, i) {
      var text = entry.text.charAt(0).toUpperCase() + entry.text.slice(1);
      lines.push('[' + fmt(entry.ts) + ']  ' + text);
      if (i < tr.length - 1) lines.push('');
    });
    lines.push('');
    lines.push('Total entries: ' + tr.length);
  } else {
    lines.push('(No voice notes were recorded for this session)');
  }

  lines.push('');
  lines.push('Generated by QA Smart Assistant');
  lines.push('===========================================');

  var blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href     = url;
  a.download = title + '_report.txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
}

/* ════════════════════════════════
   CONNECTORS — Jira & ClickUp
════════════════════════════════ */
function buildTicketDescription() {
  const d = recordingData;
  if (!d) return '';
  const p  = { critical:'P1 - Critical', high:'P2 - High', medium:'P3 - Medium', low:'P4 - Low' };
  const tr = d.transcript && d.transcript.length > 0
    ? d.transcript.map(e => `[${fmt(e.ts)}] ${e.text}`).join('\n')
    : '(No transcript available)';
  const rules = d.rules && d.rules.length > 0
    ? '\n\nTest Rules:\n' + d.rules.map(r => `${r.checked ? '[x]' : '[ ]'} ${r.text}`).join('\n')
    : '';
  return `QA Session: ${d.title || 'QA Session'}
Tester: ${d.tester || 'Tester'}
Date: ${new Date(d.timestamp || Date.now()).toLocaleString()}
Priority: ${p[d.priority] || d.priority || 'Medium'}
${d.layer ? 'Layer: ' + d.layer : ''}${d.environment ? '\nEnvironment: ' + d.environment : ''}${d.testType ? '\nTest Type: ' + d.testType : ''}${d.sprint ? '\nSprint: ' + d.sprint : ''}
Duration: ${fmt(d.duration)}
${d.tags && d.tags.length > 0 ? 'Tags: ' + d.tags.join(', ') : ''}${rules}

--- Transcript ---
${tr}`;
}

function showConnectorStatus(msg, type) {
  const el = document.getElementById('connector-status');
  if (!el) return;
  el.style.display = 'block';
  el.textContent   = msg;
  el.className     = `connector-status${type ? ' ' + type : ''}`;
  if (type === 'ok') setTimeout(() => { el.style.display = 'none'; }, 4000);
}

// ── Jira ──
document.getElementById('btn-jira').addEventListener('click', () => {
  chrome.storage.local.get(['qa_jira'], (r) => {
    const jira = r.qa_jira || {};
    if (!jira.url || !jira.token) {
      showConnectorStatus('Jira not configured. Go to the extension popup → Settings tab.', 'err');
      return;
    }
    // Pre-fill form
    document.getElementById('jira-summary').value = `[QA] ${recordingData?.title || 'QA Session'} - Bug Report`;
    document.getElementById('jira-desc').value     = buildTicketDescription();
    document.getElementById('jira-modal').style.display = 'block';
  });
});
document.getElementById('jira-modal-close').addEventListener('click', () => {
  document.getElementById('jira-modal').style.display = 'none';
});
document.getElementById('btn-jira-submit').addEventListener('click', async () => {
  const btn = document.getElementById('btn-jira-submit');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  showConnectorStatus('Creating Jira ticket…', '');

  chrome.storage.local.get(['qa_jira'], async (r) => {
    const jira = r.qa_jira || {};
    const summary   = document.getElementById('jira-summary').value.trim();
    const desc      = document.getElementById('jira-desc').value.trim();
    const issueType = document.getElementById('jira-issue-type').value;
    const priorityMap = { critical:'Highest', high:'High', medium:'Medium', low:'Low' };
    const priority  = priorityMap[recordingData?.priority] || 'Medium';

    try {
      const res = await fetch(`${jira.url}/rest/api/3/issue`, {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + btoa(`${jira.email}:${jira.token}`),
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          fields: {
            project:   { key: jira.project || 'QA' },
            summary,
            description: {
              type: 'doc', version: 1,
              content: [{ type: 'paragraph', content: [{ type: 'text', text: desc }] }]
            },
            issuetype: { name: issueType },
            priority:  { name: priority },
          }
        })
      });

      const json = await res.json();
      if (res.ok && json.key) {
        showConnectorStatus(`✓ Jira ticket created: ${json.key}`, 'ok');
        document.getElementById('jira-modal').style.display = 'none';
      } else {
        const errMsg = json.errors ? Object.values(json.errors).join(', ') : (json.message || 'Unknown error');
        showConnectorStatus(`Jira error: ${errMsg}`, 'err');
      }
    } catch(e) {
      showConnectorStatus(`Network error: ${e.message}`, 'err');
    }
    btn.disabled = false;
    btn.textContent = 'Create Ticket';
  });
});

// ── ClickUp ──
document.getElementById('btn-clickup').addEventListener('click', () => {
  chrome.storage.local.get(['qa_clickup'], (r) => {
    const cu = r.qa_clickup || {};
    if (!cu.token) {
      showConnectorStatus('ClickUp not configured. Go to the extension popup → Settings tab.', 'err');
      return;
    }
    document.getElementById('clickup-name').value = `[QA] ${recordingData?.title || 'QA Session'}`;
    document.getElementById('clickup-desc').value = buildTicketDescription();
    document.getElementById('clickup-modal').style.display = 'block';
  });
});
document.getElementById('clickup-modal-close').addEventListener('click', () => {
  document.getElementById('clickup-modal').style.display = 'none';
});
document.getElementById('btn-clickup-submit').addEventListener('click', async () => {
  const btn = document.getElementById('btn-clickup-submit');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  showConnectorStatus('Creating ClickUp task…', '');

  chrome.storage.local.get(['qa_clickup'], async (r) => {
    const cu   = r.qa_clickup || {};
    const name = document.getElementById('clickup-name').value.trim();
    const desc = document.getElementById('clickup-desc').value.trim();
    const priorityMap = { critical:1, high:2, medium:3, low:4 };
    const priority    = priorityMap[recordingData?.priority] || 3;

    try {
      const res = await fetch(`https://api.clickup.com/api/v2/list/${cu.list}/task`, {
        method: 'POST',
        headers: { 'Authorization': cu.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: desc, priority })
      });
      const json = await res.json();
      if (res.ok && json.id) {
        showConnectorStatus(`✓ ClickUp task created: ${json.name}`, 'ok');
        document.getElementById('clickup-modal').style.display = 'none';
      } else {
        showConnectorStatus(`ClickUp error: ${json.err || 'Unknown error'}`, 'err');
      }
    } catch(e) {
      showConnectorStatus(`Network error: ${e.message}`, 'err');
    }
    btn.disabled = false;
    btn.textContent = 'Create Task';
  });
});

/* ════════════════════════════════
   BUG ANNOTATIONS
   Stored in window.__qa_annotations__ = [{ts, text, severity}]
   Timestamps link to video position — click to seek
════════════════════════════════ */
window.__qa_annotations__ = [];

function renderAnnotations() {
  const list  = document.getElementById('annotations-list');
  const count = document.getElementById('annotations-count');
  if (!list) return;
  const anns = window.__qa_annotations__;
  if (count) count.textContent = anns.length > 0 ? `${anns.length} annotation${anns.length > 1 ? 's' : ''}` : '';
  if (anns.length === 0) {
    list.innerHTML = '<p style="font-size:12px;color:var(--text-lo);font-style:italic;padding:4px 0;">No bug annotations yet. Play the video and click Mark to annotate a timestamp.</p>';
    return;
  }
  list.innerHTML = '';
  anns.forEach((ann, i) => {
    const item = document.createElement('div');
    item.className = 'annotation-item';
    const sevLabels = { critical:'Critical', high:'High', medium:'Medium', low:'Low' };
    item.innerHTML = `
      <span class="annotation-ts" title="Click to seek to this moment">[${fmt(ann.ts)}]</span>
      <span class="annotation-text"></span>
      <span class="annotation-sev ${ann.severity}">${sevLabels[ann.severity] || ann.severity}</span>
      <button class="annotation-del" title="Delete">
        <svg viewBox="0 0 16 16" fill="none" width="14" height="14"><path d="M3 4h10M6 4V2.5a.5.5 0 01.5-.5h3a.5.5 0 01.5.5V4m-6 0l.4 8.5a1 1 0 001 .95h3.2a1 1 0 001-.95L11 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>`;
    item.querySelector('.annotation-text').textContent = ann.text;
    item.querySelector('.annotation-ts').addEventListener('click', () => {
      const video = document.getElementById('rv');
      if (video && isFinite(ann.ts)) {
        video.currentTime = ann.ts;
        video.play().catch(() => {});
      }
    });
    item.querySelector('.annotation-del').addEventListener('click', () => {
      window.__qa_annotations__.splice(i, 1);
      renderAnnotations();
      persistSession();
    });
    list.appendChild(item);
  });
}

document.addEventListener('DOMContentLoaded', () => {

  /* ── Download Recording ── */
  const dlBtn = document.getElementById('btn-dl');
  if (dlBtn) dlBtn.addEventListener('click', () => {
    if (!blobURL) { alert('Recording not ready yet.'); return; }
    const a = document.createElement('a');
    a.href     = blobURL;
    a.download = ((recordingData && recordingData.title) || 'QA_Session') + '.' + ((recordingData && recordingData.extension) || 'webm');
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  });

  /* ── Download Transcript ── */
  const txBtn = document.getElementById('btn-dl-transcript');
  if (txBtn) txBtn.addEventListener('click', downloadTranscript);

  /* ── New Session ── */
  const newBtn = document.getElementById('btn-new');
  if (newBtn) newBtn.addEventListener('click', () => window.close());

  /* ── Whisper / Groq button ── */
  const wBtn = document.getElementById('btn-whisper');
  if (wBtn) wBtn.addEventListener('click', transcribeWithWhisper);

  const zipBtn = document.getElementById('btn-zip');
  if (zipBtn) zipBtn.addEventListener('click', downloadZipBundle);

  /* ── Language selector ── */
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.lang-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedLang = btn.dataset.lang;
    });
  });

  /* ── Bug Annotations ── */
  const addBtn = document.getElementById('btn-add-annotation');
  const input  = document.getElementById('annotation-input');
  const sevSel = document.getElementById('annotation-sev');
  if (addBtn && input) {
    function addAnnotation() {
      const text = input.value.trim();
      if (!text) { input.focus(); return; }
      const video = document.getElementById('rv');
      const ts    = (video && !isNaN(video.currentTime)) ? Math.round(video.currentTime) : 0;
      window.__qa_annotations__.push({ ts, text, severity: sevSel.value });
      window.__qa_annotations__.sort((a, b) => a.ts - b.ts);
      input.value = '';
      renderAnnotations();
      persistSession();
    }
    addBtn.addEventListener('click', addAnnotation);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addAnnotation(); } });
  }

  loadRecording();
});

/* ════════════════════════════════
   SCREENSHOTS
════════════════════════════════ */
function renderScreenshots(shots) {
  const panel = document.getElementById('screenshots-panel');
  const grid  = document.getElementById('screenshots-grid');
  const count = document.getElementById('screenshots-count');
  if (!panel || !grid) return;
  if (!shots || shots.length === 0) { panel.style.display = 'none'; return; }

  panel.style.display = 'flex';
  if (count) count.textContent = `${shots.length} screenshot${shots.length !== 1 ? 's' : ''}`;
  grid.innerHTML = '';

  shots.forEach((shot, i) => {
    const item = document.createElement('div');
    item.className = 'screenshot-item';
    item.innerHTML = `
      <img src="${shot.dataUrl}" alt="Screenshot ${shot.index || i+1}" loading="lazy"/>
      <div class="screenshot-item-label">Screenshot ${shot.index || i+1}</div>
      <button class="screenshot-item-dl" title="Download screenshot">
        <svg viewBox="0 0 20 20" fill="none"><path d="M10 4v8M7 9l3 3 3-3" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 15v1a1 1 0 001 1h10a1 1 0 001-1v-1" stroke="white" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>`;

    // Click image to enlarge
    item.querySelector('img').addEventListener('click', () => {
      const w = window.open('', '_blank');
      w.document.write(`<html><body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh;"><img src="${shot.dataUrl}" style="max-width:100%;max-height:100vh;"/></body></html>`);
    });

    // Download individual screenshot
    item.querySelector('.screenshot-item-dl').addEventListener('click', (e) => {
      e.stopPropagation();
      const a = document.createElement('a');
      a.href     = shot.dataUrl;
      a.download = `${(recordingData && recordingData.title) || 'QA'}_screenshot_${shot.index || i+1}.png`;
      a.click();
    });

    grid.appendChild(item);
  });
}

/* ════════════════════════════════
   ZIP BUNDLE DOWNLOAD
   Contains: video, transcript.txt, screenshots/
════════════════════════════════ */
async function downloadZipBundle() {
  const btn     = document.getElementById('btn-zip');
  const btnText = document.getElementById('zip-btn-text');
  if (!blobURL || !recordingData) { alert('Recording not ready yet.'); return; }
  if (btn) btn.disabled = true;
  if (btnText) btnText.textContent = 'Building ZIP…';

  try {
    const JSZip = window.JSZip;
    if (!JSZip) { alert('JSZip library not loaded. Check your internet connection.'); return; }

    const zip   = new JSZip();
    const title = (recordingData.title || 'QA_Session').replace(/[^a-zA-Z0-9_\-]/g, '_');

    // 1. Video file
    if (btnText) btnText.textContent = 'Adding video…';
    const videoResp = await fetch(blobURL);
    const videoBlob = await videoResp.blob();
    const ext       = recordingData.extension || 'webm';
    zip.file(`${title}.${ext}`, videoBlob);

    // 2. Report .txt
    if (btnText) btnText.textContent = 'Adding report…';
    const reportText = await buildReportText();
    zip.file(`${title}_report.txt`, reportText);

    // 3. Screenshots folder
    const shots = recordingData.screenshots || [];
    if (shots.length > 0) {
      if (btnText) btnText.textContent = `Adding ${shots.length} screenshots…`;
      const ssFolder = zip.folder('screenshots');
      for (const shot of shots) {
        // Convert dataUrl to blob
        const res    = await fetch(shot.dataUrl);
        const sBlob  = await res.blob();
        ssFolder.file(`screenshot_${shot.index || (shots.indexOf(shot)+1)}.png`, sBlob);
      }
    }

    // 4. Generate and download
    if (btnText) btnText.textContent = 'Compressing…';
    const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const url = URL.createObjectURL(zipBlob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = `${title}_bundle.zip`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 3000);

    if (btnText) btnText.textContent = '✓ Downloaded!';
    setTimeout(() => { if (btnText) btnText.textContent = 'Download ZIP Bundle'; }, 3000);

  } catch(e) {
    console.error('[QA ZIP]', e);
    alert('ZIP creation failed: ' + e.message);
    if (btnText) btnText.textContent = 'Download ZIP Bundle';
  }
  if (btn) btn.disabled = false;
}

async function buildReportText() {
  /* Same as downloadTranscript but returns text instead of downloading */
  const d      = recordingData;
  const tr     = d && d.transcript;
  const title  = (d && d.title)  || 'QA_Session';
  const tester = (d && d.tester) || 'Tester';
  const date   = new Date((d && d.timestamp) || Date.now()).toLocaleString();
  const dur    = fmt((d && d.duration) || 0);
  const priorityLabels = { critical:'P1 Critical', high:'P2 High', medium:'P3 Medium', low:'P4 Low' };

  var pageNotes = [];
  try {
    var stored = await new Promise(function(resolve) {
      chrome.storage.local.get(['qa_notes'], function(r){ resolve(r.qa_notes || {}); });
    });
    pageNotes = Object.values(stored).flat().sort(function(a,b){return a.ts-b.ts;});
  } catch(e) {}

  const lines = [];
  lines.push('===========================================');
  lines.push('   QA Smart Assistant - Session Report');
  lines.push('===========================================');
  lines.push('');
  lines.push('Session     : ' + title);
  lines.push('Tester      : ' + tester);
  lines.push('Date        : ' + date);
  lines.push('Duration    : ' + dur);
  if (d && d.priority)    lines.push('Priority    : ' + (priorityLabels[d.priority] || d.priority));
  if (d && d.layer)       lines.push('Layer       : ' + d.layer);
  if (d && d.environment) lines.push('Environment : ' + d.environment);
  if (d && d.testType)    lines.push('Test Type   : ' + d.testType);
  if (d && d.sprint)      lines.push('Sprint      : ' + d.sprint);
  if (d && d.tags && d.tags.length > 0) lines.push('Tags        : ' + d.tags.join(', '));
  lines.push('');

  if (pageNotes.length > 0) {
    lines.push('-------------------------------------------');
    lines.push('  PAGE NOTES');
    lines.push('-------------------------------------------');
    pageNotes.forEach(function(n){ lines.push('  ' + n.text); });
    lines.push('');
  }

  if (d && d.rules && d.rules.length > 0) {
    lines.push('-------------------------------------------');
    lines.push('  TEST RULES');
    lines.push('-------------------------------------------');
    d.rules.forEach(function(r) { lines.push('  ' + (r.checked ? '[x]' : '[ ]') + ' ' + r.text); });
    const done = d.rules.filter(function(r){return r.checked;}).length;
    lines.push('  Completed: ' + done + '/' + d.rules.length);
    lines.push('');
  }

  var annotations = window.__qa_annotations__ || [];
  if (annotations.length > 0) {
    lines.push('-------------------------------------------');
    lines.push('  BUG ANNOTATIONS');
    lines.push('-------------------------------------------');
    annotations.forEach(function(a) {
      lines.push('  [' + fmt(a.ts) + '] [' + a.severity.toUpperCase() + '] ' + a.text);
    });
    lines.push('');
  }

  const shots = (d && d.screenshots) || [];
  if (shots.length > 0) {
    lines.push('-------------------------------------------');
    lines.push('  SCREENSHOTS (' + shots.length + ' captured)');
    lines.push('-------------------------------------------');
    lines.push('  See screenshots/ folder in the ZIP bundle.');
    lines.push('');
  }

  lines.push('-------------------------------------------');
  lines.push('  VOICE TRANSCRIPT');
  lines.push('-------------------------------------------');
  lines.push('');
  if (tr && tr.length > 0) {
    tr.forEach(function(entry, i) {
      var text = entry.text.charAt(0).toUpperCase() + entry.text.slice(1);
      lines.push('[' + fmt(entry.ts) + ']  ' + text);
      if (i < tr.length - 1) lines.push('');
    });
    lines.push('');
    lines.push('Total entries: ' + tr.length);
  } else {
    lines.push('(No voice notes were recorded for this session)');
  }

  lines.push('');
  lines.push('Generated by QA Smart Assistant');
  lines.push('===========================================');
  return lines.join('\n');
}
