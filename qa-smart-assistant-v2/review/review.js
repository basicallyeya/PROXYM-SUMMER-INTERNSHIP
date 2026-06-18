'use strict';

let recordingData    = null;
let blobURL          = null;
let whisperDone      = false; // true after Whisper transcription completes

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
   WHISPER TRANSCRIPTION
   Sends recording blob to local Whisper server at localhost:5000
   and displays timestamped results in the Voice Notes section.
════════════════════════════════ */
const WHISPER_URL = 'http://localhost:5000';
let selectedLang  = 'en'; // default English

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

function renderTranscriptList(segments, source) {
  const list = document.getElementById('t-list');
  if (!list) return;

  // Update source badge
  const badge = document.getElementById('transcript-source-badge');
  if (badge) {
    if (source === 'whisper') {
      badge.className = 'source-badge sb-whisper';
      badge.innerHTML = `<svg viewBox="0 0 20 20" fill="none"><path d="M5 10l4 4 6-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Whisper AI`;
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
  if (btnText) btnText.textContent = 'Transcribing';

  // Step 1: Check server is running
  setWhisperStatus('Checking Whisper server', 'loading');
  try {
    const health = await fetch(`${WHISPER_URL}/health`, { signal: AbortSignal.timeout(3000) });
    if (!health.ok) throw new Error('Server not OK');
  } catch(e) {
    setWhisperStatus('Whisper server not running. Open VS Code and run: python whisper_server.py', 'warn');
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = 'Transcribe with Whisper';
    return;
  }

  // Step 2: Fetch the blob from the blobURL
  setWhisperStatus('Preparing audio', 'loading');
  let audioBlob;
  try {
    const resp = await fetch(blobURL);
    audioBlob  = await resp.blob();
  } catch(e) {
    setWhisperStatus('Could not read recording. Try downloading the file first.', 'warn');
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = 'Transcribe with Whisper';
    return;
  }

  // Step 3: Send to Whisper server
  const ext      = (recordingData && recordingData.extension) || 'webm';
  const filename = `recording.${ext}`;
  const mimeType = ext === 'mp4' ? 'video/mp4' : 'video/webm';

  const formData = new FormData();
  formData.append('audio', new File([audioBlob], filename, { type: mimeType }));
  formData.append('language', selectedLang); // send user-selected language

  const langNames = { en: 'English', fr: 'French', ar: 'Arabic' };
  setWhisperStatus(`Transcribing in ${langNames[selectedLang] || selectedLang} (${fmtSize(audioBlob.size)}, may take a moment)`, 'loading');

  try {
    const resp = await fetch(`${WHISPER_URL}/transcribe`, {
      method: 'POST',
      body:   formData,
      signal: AbortSignal.timeout(300000), // 5 minute timeout for long recordings
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(err.error || `Server error ${resp.status}`);
    }

    const result = await resp.json();

    if (!result.segments || result.segments.length === 0) {
      setWhisperStatus('Whisper found no speech in the recording. Check microphone was on.', 'warn');
      if (btn) btn.disabled = false;
      if (btnText) btnText.textContent = 'Try Again';
      return;
    }

    // Step 4: Replace SR transcript with Whisper results
    whisperDone = true;
    if (recordingData) recordingData.transcript = result.segments;
    renderTranscriptList(result.segments, 'whisper');
    hideWhisperStatus();
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = 'Transcribed';

    setWhisperStatus('Transcription complete', 'ok');
    setTimeout(hideWhisperStatus, 2500);

  } catch(e) {
    console.error('[QA Whisper]', e);
    if (e.name === 'TimeoutError') {
      setWhisperStatus('Transcription timed out. Try a shorter recording or use the "small" model.', 'warn');
    } else {
      setWhisperStatus(`Error: ${e.message}`, 'warn');
    }
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = 'Transcribe with Whisper';
  }
}

/* ════════════════════════════════
   DOWNLOAD TRANSCRIPT AS .TXT
════════════════════════════════ */
function downloadTranscript() {
  const tr = recordingData && recordingData.transcript;
  const title  = (recordingData && recordingData.title)  || 'QA_Session';
  const tester = (recordingData && recordingData.tester) || 'Tester';
  const date   = new Date((recordingData && recordingData.timestamp) || Date.now()).toLocaleString();
  const dur    = fmt((recordingData && recordingData.duration) || 0);

  const lines = [];
  lines.push('===============================================');
  lines.push('   QA Smart Assistant: Voice Transcript');
  lines.push('===============================================');
  lines.push('');
  lines.push(`Session  : ${title}`);
  lines.push(`Tester   : ${tester}`);
  lines.push(`Date     : ${date}`);
  lines.push(`Duration : ${dur}`);
  lines.push('');
  lines.push('-----------------------------------------------');
  lines.push('  TRANSCRIPT');
  lines.push('-----------------------------------------------');
  lines.push('');

  if (tr && tr.length > 0) {
    tr.forEach((entry, i) => {
      const text = entry.text.charAt(0).toUpperCase() + entry.text.slice(1);
      lines.push(`[${fmt(entry.ts)}]  ${text}`);
      if (i < tr.length - 1) lines.push('');
    });
    lines.push('');
    lines.push('-----------------------------------------------');
    lines.push(`Total entries: ${tr.length}`);
  } else {
    lines.push('(No voice notes were recorded for this session)');
  }

  lines.push('Generated by QA Smart Assistant');
  lines.push('===============================================');

  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${title}_transcript.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ════════════════════════════════
   BUTTONS
════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  const dlBtn  = document.getElementById('btn-dl');
  const newBtn = document.getElementById('btn-new');

  if (dlBtn) {
    dlBtn.addEventListener('click', () => {
      if (!blobURL) { alert('Recording not ready yet.'); return; }
      const a = document.createElement('a');
      a.href     = blobURL;
      a.download = `${(recordingData && recordingData.title) || 'QA_Session'}.${(recordingData && recordingData.extension) || 'webm'}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
  }

  if (newBtn) newBtn.addEventListener('click', () => window.close());

  const gdBtn     = document.getElementById('btn-gdrive');
  const ntBtn     = document.getElementById('btn-notion');
  const txBtn     = document.getElementById('btn-dl-transcript');
  const wBtn      = document.getElementById('btn-whisper');
  if (gdBtn) gdBtn.addEventListener('click', () => alert('Google Drive integration coming soon.'));
  if (ntBtn) ntBtn.addEventListener('click', () => alert('Jira / Notion integration coming soon.'));
  if (txBtn) txBtn.addEventListener('click', downloadTranscript);
  if (wBtn)  wBtn.addEventListener('click',  transcribeWithWhisper);

  // Language selector buttons
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.lang-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedLang = btn.dataset.lang;
    });
  });

  loadRecording();
});
