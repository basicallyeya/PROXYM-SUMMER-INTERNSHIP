'use strict';

const p = new URLSearchParams(location.search);
const cfg = {
  mode:       p.get('mode')      || 'desktop',
  quality:    p.get('quality')   || '720',
  micOn:      p.get('mic')       === '1',
  camOn:      p.get('cam')       === '1',
  ctrlBarOn:  p.get('ctrlbar')   === '1',
  countdown:  parseInt(p.get('countdown') || '3', 10),
  title:      decodeURIComponent(p.get('title')  || 'QA Session'),
  tester:     decodeURIComponent(p.get('tester') || 'Tester'),
  micGranted: p.get('micg')      === '1',
  camGranted: p.get('camg')      === '1',
  targetTabId: (p.get('target') !== null && p.get('target') !== '') ? parseInt(p.get('target'), 10) : null,
  priority:    p.get('priority')    || 'medium',
  layer:       p.get('layer')       || '',
  environment: p.get('environment') || '',
  testType:    p.get('testType')    || '',
  sprint:      p.get('sprint')      || '',
  tags:   (() => { try { return JSON.parse(p.get('tags')  || '[]'); } catch(_) { return []; } })(),
  rules:  (() => { try { return JSON.parse(p.get('rules') || '[]'); } catch(_) { return []; } })(),
};

let mediaRecorder = null;
let screenStream  = null;
let micStream     = null;
let camStream     = null;
let chunks        = [];
let seconds       = 0;
let paused        = false;
let timerInterval = null;
let srRunning     = false;
let srInstance    = null;
let transcript    = [];
let userTabId     = null;
let userTabTitle  = '';
let recorderTabId = null;
let localSkip     = false;

function fmt(s) { return `${Math.floor(s/60)}:${(s%60).toString().padStart(2,'0')}`; }
function fmtSize(b) { return b < 1048576 ? (b/1024).toFixed(0)+' KB' : (b/1048576).toFixed(1)+' MB'; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* Brief on-screen toast in the user's tab. */
function notifyUserTab(msg, ms = 5000) {
  if (!userTabId) return;
  chrome.scripting.executeScript({
    target: { tabId: userTabId },
    func: (m, dur) => {
      const t = document.createElement('div');
      t.style.cssText = 'position:fixed;bottom:140px;left:50%;transform:translateX(-50%);background:#16223A;border:1px solid rgba(148,163,253,.3);color:white;padding:9px 16px;border-radius:10px;font-size:12px;z-index:2147483648;font-family:sans-serif;max-width:80vw;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.45);';
      t.textContent = m;
      document.body.appendChild(t);
      setTimeout(() => t.remove(), dur);
    },
    args: [msg, ms]
  }).catch(() => {});
}

/* ── Get tab IDs ──
   userTabId comes from cfg.targetTabId, captured by popup.js at the one
   moment this was unambiguous (the tab active when the user clicked
   Launch), and threaded through permissions.html/background.js as a URL
   param, instead of re-guessing it here by scanning every open tab. */
async function getTabIds() {
  return new Promise(resolve => {
    chrome.tabs.getCurrent(myTab => {
      recorderTabId = myTab ? myTab.id : null;

      if (cfg.targetTabId == null) {
        console.warn('[QA] No target tab was passed to the recorder, countdown/control bar will be skipped.');
        userTabId = null;
        resolve();
        return;
      }

      chrome.tabs.get(cfg.targetTabId, tab => {
        if (chrome.runtime.lastError || !tab) {
          console.warn('[QA] Target tab no longer exists (closed before recording started), countdown/control bar will be skipped.');
          userTabId = null;
        } else {
          userTabId = tab.id;
          userTabTitle = tab.title || '';
        }
        resolve();
      });
    });
  });
}

/* ════════════════════════════════
   SHARED UI SHELL
════════════════════════════════ */
const LOGO_SVG = `<svg viewBox="0 0 20 20" fill="none"><rect x="5" y="3" width="5" height="9" rx="2.5" fill="white"/><path d="M3 9a7 7 0 0014 0" stroke="white" stroke-width="1.5" stroke-linecap="round" fill="none"/><line x1="10" y1="16" x2="10" y2="18.5" stroke="white" stroke-width="1.5" stroke-linecap="round"/></svg>`;

function renderShell(inner) {
  document.body.innerHTML = `<div class="rc-shell"><div class="rc-card">${inner}</div></div>`;
}

function showPreparingUI() {
  document.title = 'QA Smart Assistant: Recording';
  renderShell(`
    <div class="rc-logo">${LOGO_SVG}</div>
    <div class="rc-spinner"></div>
    <p class="rc-title">Getting ready</p>
    <p class="rc-sub">Preparing your recording session.</p>
  `);
}

function showCountdownUI() {
  document.title = 'QA Smart Assistant: Starting';
  renderShell(`
    <div class="rc-logo">${LOGO_SVG}</div>
    <p class="rc-status-text">Recording starts in</p>
    <p class="rc-timer" id="rc-cd-num">${cfg.countdown}</p>
    <p class="rc-sub" id="rc-cd-hint">Get ready</p>
    <button class="rc-btn rc-btn-ghost" id="rc-cd-skip" style="width:100%;">Skip</button>
  `);
  const skipBtn = document.getElementById('rc-cd-skip');
  if (skipBtn) skipBtn.addEventListener('click', () => { localSkip = true; });
}

function updateCountdownUI(remaining, hint) {
  const n = document.getElementById('rc-cd-num');
  const h = document.getElementById('rc-cd-hint');
  if (n) n.textContent = Math.ceil(remaining) || '';
  if (h) h.textContent = hint;
}

function showRecordingUI() {
  document.title = 'QA Smart Assistant: Recording';
  const micIcon  = `<svg viewBox="0 0 20 20" fill="none"><rect x="7" y="2" width="6" height="10" rx="3" fill="currentColor"/><path d="M4 10a6 6 0 0012 0" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/></svg>`;
  const camIcon  = `<svg viewBox="0 0 20 20" fill="none"><path d="M3 6h9a2 2 0 012 2v4a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2z" stroke="currentColor" stroke-width="1.4"/><path d="M14 8.5l4-2v5l-4-2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const barIcon  = `<svg viewBox="0 0 20 20" fill="none"><rect x="2" y="7" width="16" height="6" rx="3" stroke="currentColor" stroke-width="1.4"/><circle cx="6" cy="10" r="1.3" fill="currentColor"/><circle cx="10" cy="10" r="1.3" fill="currentColor"/></svg>`;
  const pauseIcon = `<svg viewBox="0 0 20 20" fill="none"><rect x="6" y="4" width="3" height="12" rx="1.5" fill="currentColor"/><rect x="11" y="4" width="3" height="12" rx="1.5" fill="currentColor"/></svg>`;
  const stopIcon  = `<svg viewBox="0 0 20 20" fill="none"><rect x="5" y="5" width="10" height="10" rx="2" fill="white"/></svg>`;

  renderShell(`
    <div class="rc-status-row"><span class="rc-dot" id="rc-dot"></span><span class="rc-status-text" id="rc-status-text">Recording</span></div>
    <p class="rc-timer" id="rc-timer">0:00</p>
    <p class="rc-session">${escapeHtml(cfg.title)}</p>
    <div class="rc-meta-row">
      <span class="rc-meta-pill ${cfg.micOn ? 'active' : ''}">${micIcon} Mic</span>
      <span class="rc-meta-pill ${cfg.camOn ? 'active' : ''}">${camIcon} Camera</span>
      <span class="rc-meta-pill ${cfg.ctrlBarOn ? 'active' : ''}">${barIcon} Control Bar</span>
    </div>
    <div class="rc-actions">
      <button class="rc-btn rc-btn-pause" id="rc-btn-pause">${pauseIcon}Pause</button>
      <button class="rc-btn rc-btn-stop" id="rc-btn-stop">${stopIcon}Stop</button>
    </div>
    <p class="rc-hint">Switch back to your test tab, recording continues in the background. The floating control bar there also lets you pause or stop.</p>
  `);
  document.getElementById('rc-btn-pause').addEventListener('click', () => { paused ? doResume() : doPause(); });
  document.getElementById('rc-btn-stop').addEventListener('click', doStop);
}

function updatePauseUI() {
  const btn  = document.getElementById('rc-btn-pause');
  const dot  = document.getElementById('rc-dot');
  const text = document.getElementById('rc-status-text');
  if (btn) {
    btn.innerHTML = paused
      ? `<svg viewBox="0 0 20 20" fill="none"><path d="M7 5l9 5-9 5V5z" fill="currentColor"/></svg>Resume`
      : `<svg viewBox="0 0 20 20" fill="none"><rect x="6" y="4" width="3" height="12" rx="1.5" fill="currentColor"/><rect x="11" y="4" width="3" height="12" rx="1.5" fill="currentColor"/></svg>Pause`;
  }
  if (dot)  dot.style.animationPlayState = paused ? 'paused' : '';
  if (text) text.textContent = paused ? 'Paused' : 'Recording';
}

function updateOverlayTimer() {
  const el = document.getElementById('rc-timer');
  if (el) el.textContent = fmt(seconds);
}

/* ════════════════════════════════
   COUNTDOWN
   Shown locally in this tab AND injected into the target tab. Chrome
   focuses this newly-created recorder tab by default, so the user is
   actually looking at THIS page during the countdown, not the target
   tab, even though the overlay there is also kept for anyone who
   switches over early.
════════════════════════════════ */
async function runCountdown() {
  if (cfg.countdown <= 0) return;

  showCountdownUI();
  localSkip = false;

  if (userTabId) {
    await chrome.scripting.executeScript({
      target: { tabId: userTabId },
      func: (sec) => {
        document.getElementById('__qa_overlay__') && document.getElementById('__qa_overlay__').remove();
        const ov = document.createElement('div');
        ov.id = '__qa_overlay__';
        ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(7,11,20,0.86);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;font-family:-apple-system,BlinkMacSystemFont,Inter,sans-serif;';
        ov.innerHTML = `
          <p style="font-size:15px;font-weight:500;color:rgba(248,250,252,.55);margin:0;">Recording starts in</p>
          <div style="position:relative;width:156px;height:156px;display:flex;align-items:center;justify-content:center;">
            <svg style="position:absolute;inset:0;width:100%;height:100%;" viewBox="0 0 120 120">
              <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(59,130,246,.2)" stroke-width="7"/>
              <circle id="__qa_arc__" cx="60" cy="60" r="52" fill="none" stroke="#3B82F6" stroke-width="7"
                stroke-linecap="round" stroke-dasharray="327" stroke-dashoffset="0" transform="rotate(-90 60 60)"
                style="transition:stroke-dashoffset .18s linear;"/>
            </svg>
            <span id="__qa_num__" style="font-size:78px;font-weight:800;color:white;line-height:1;position:relative;">${sec}</span>
          </div>
          <p id="__qa_hint__" style="font-size:13px;color:rgba(248,250,252,.4);margin:0;">Get ready</p>
          <button id="__qa_skip__" style="padding:10px 32px;border:1.5px solid rgba(148,163,253,.3);border-radius:100px;color:rgba(248,250,252,.7);font-size:13px;font-weight:500;cursor:pointer;background:none;font-family:inherit;">Skip</button>
        `;
        document.body.appendChild(ov);
        window.__qa_skip__ = false;
        document.getElementById('__qa_skip__').onclick = () => { window.__qa_skip__ = true; };
      },
      args: [cfg.countdown]
    }).catch(() => {});
  }

  const CIRC = 327;
  const start = Date.now();
  // Chrome's native picker can never auto-select a specific tab for us,
  // it always requires an explicit, manual click, by design. Naming the
  // exact tab here is the best mitigation available: it tells you
  // precisely which thumbnail to look for instead of guessing.
  const pickerHint = userTabTitle
    ? `Pick "${userTabTitle.length > 40 ? userTabTitle.slice(0, 40) + '...' : userTabTitle}" in the picker that opens next`
    : 'Screen picker will open next';
  const hints = ['Get ready', pickerHint, 'Starting'];

  return new Promise(resolve => {
    const iv = setInterval(async () => {
      const elapsed   = (Date.now() - start) / 1000;
      const remaining = Math.max(0, cfg.countdown - elapsed);
      const offset    = Math.min(CIRC, (elapsed / cfg.countdown) * CIRC);
      const hintIdx   = Math.min(Math.floor(elapsed / (cfg.countdown / hints.length)), hints.length - 1);

      updateCountdownUI(remaining, hints[hintIdx]);

      let remoteSkipped = false;
      if (userTabId) {
        try {
          const r = await chrome.scripting.executeScript({
            target: { tabId: userTabId },
            func: () => !!window.__qa_skip__
          });
          remoteSkipped = r && r[0] && r[0].result;
        } catch (_) {}
      }

      if (elapsed >= cfg.countdown || localSkip || remoteSkipped) {
        clearInterval(iv);
        if (userTabId) {
          chrome.scripting.executeScript({
            target: { tabId: userTabId },
            func: () => { document.getElementById('__qa_overlay__') && document.getElementById('__qa_overlay__').remove(); }
          }).catch(() => {});
        }
        resolve();
        return;
      }

      if (userTabId) {
        chrome.scripting.executeScript({
          target: { tabId: userTabId },
          func: (num, arc, hint) => {
            const n = document.getElementById('__qa_num__');
            const a = document.getElementById('__qa_arc__');
            const h = document.getElementById('__qa_hint__');
            if (n) n.textContent = Math.ceil(num) || '';
            if (a) a.style.strokeDashoffset = String(arc);
            if (h) h.textContent = hint;
          },
          args: [remaining, offset, hints[hintIdx]]
        }).catch(() => { clearInterval(iv); resolve(); });
      }
    }, 200);
  });
}

/* ════════════════════════════════
   START RECORDING
════════════════════════════════ */
async function startRecording() {
  try {
    const vc = cfg.quality === '1080'
      ? { width:{ideal:1920}, height:{ideal:1080}, frameRate:{ideal:30} }
      : cfg.quality === '4k'
      ? { width:{ideal:3840}, height:{ideal:2160}, frameRate:{ideal:30} }
      : { width:{ideal:1280}, height:{ideal:720},  frameRate:{ideal:30} };

    // "This Tab" mode hint: opens the native picker straight on its
    // "Chrome Tab" panel instead of defaulting to "Entire Screen".
    if (cfg.mode === 'tab') vc.displaySurface = 'browser';

    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: vc, audio: true });

    /* ── MICROPHONE ── */
    if (cfg.micOn) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 },
          video: false,
        });
      } catch (e) {
        console.warn('[QA] Mic getUserMedia failed:', e.name, e.message);
        notifyUserTab(`Microphone not available (${e.name}), recording screen only`, 4000);
      }
    }

    /* ── CAMERA ──
       Background.js manages the camera overlay across all tabs.
       It listens for tab switches and injects/removes automatically. */
    if (cfg.camOn) {
      chrome.runtime.sendMessage({ type: 'CAM_INJECT' });
    }

    /* ── BUILD STREAM ── */
    const tracks = [...screenStream.getVideoTracks()];
    if (micStream) micStream.getAudioTracks().forEach(t => tracks.push(t));
    screenStream.getAudioTracks().forEach(t => { if (!tracks.includes(t)) tracks.push(t); });
    const combined = new MediaStream(tracks);

    /* ── MEDIARECORDER: try MP4 first, fall back to WebM ── */
    const mp4Mime  = ['video/mp4;codecs=h264,aac','video/mp4;codecs=avc1,mp4a.40.2','video/mp4']
      .find(t => MediaRecorder.isTypeSupported(t));
    const webmMime = ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm']
      .find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';
    const mime = mp4Mime || webmMime;
    console.log('[QA] Recording MIME:', mime);
    const bps = cfg.quality === '4k' ? 8000000 : cfg.quality === '1080' ? 4000000 : 2500000;

    chunks = []; transcript = [];
    mediaRecorder = new MediaRecorder(combined, { mimeType: mime, videoBitsPerSecond: bps });
    mediaRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    mediaRecorder.onstop = onRecordingStop;
    mediaRecorder.start(1000);

    screenStream.getVideoTracks()[0].addEventListener('ended', () => {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') doStop();
    });

    showRecordingUI();

    if (cfg.ctrlBarOn && userTabId) {
      chrome.runtime.sendMessage({ type: 'RECORDING_STARTED', targetTabId: userTabId });
    }

    seconds = 0; paused = false;
    timerInterval = setInterval(() => {
      if (!paused) {
        seconds++;
        updateOverlayTimer();
        chrome.runtime.sendMessage({ type: 'TIMER_TICK', seconds }).catch(() => {});
      }
    }, 1000);

    startSR();
    if (userTabId) chrome.tabs.update(userTabId, { active: true });

  } catch (err) {
    console.error('[QA recorder]', err.name, err.message);
    if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
      chrome.runtime.sendMessage({ type: 'RECORDER_CANCELLED' });
    }
    window.close();
  }
}

/* ════════════════════════════════
   PAUSE / RESUME / STOP
   Shared by both this tab's own buttons and the control bar's
   CONTROLBAR_PAUSE/RESUME/STOP messages.
════════════════════════════════ */
function doPause() {
  if (!mediaRecorder || mediaRecorder.state !== 'recording') return;
  paused = true;
  mediaRecorder.pause();
  chrome.runtime.sendMessage({ type: 'RECORDING_PAUSED' }).catch(() => {});
  updatePauseUI();
}
function doResume() {
  if (!mediaRecorder || mediaRecorder.state !== 'paused') return;
  paused = false;
  mediaRecorder.resume();
  chrome.runtime.sendMessage({ type: 'RECORDING_RESUMED' }).catch(() => {});
  updatePauseUI();
}
function doStop() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
  clearInterval(timerInterval);
  stopSR();
  chrome.runtime.sendMessage({ type: 'RECORDING_STOPPED' }).catch(() => {});
  mediaRecorder.requestData();
  mediaRecorder.stop();
  // Tracks stopped inside onRecordingStop after blob is built
}

/* ════════════════════════════════
   AFTER STOP
   1. Build blob, create blobURL (valid while THIS tab is open)
   2. Open review tab
   3. Send blobURL via chrome.tabs.sendMessage while we're still alive
   4. Review page confirms receipt, show "safe to download" UI
   5. Recorder tab stays open until user clicks download in review page
════════════════════════════════ */
async function onRecordingStop() {
  [screenStream, micStream, camStream].forEach(s => { if (s) s.getTracks().forEach(t => t.stop()); });

  const mime      = (mediaRecorder && mediaRecorder.mimeType) || 'video/webm';
  const extension = mime.includes('mp4') ? 'mp4' : 'webm';
  let   blob      = new Blob(chunks, { type: mime });

  if (blob.size === 0) {
    showRecorderError('Recording was empty, no data was captured. Try selecting "Entire Screen" in the screen picker.');
    return;
  }

  showSavingUI(blob.size);

  // Fix the container's duration metadata so seeking works correctly,
  // MediaRecorder writes it as ~0 in both WebM and MP4 since it can't
  // know the final length until the recording stops.
  try {
    const durationMs = seconds * 1000;
    const fixed = mime.includes('mp4')
      ? await fixMp4Duration(blob, durationMs)
      : await fixWebmDuration(blob, durationMs);
    if (fixed) blob = fixed;
  } catch(e) {
    console.warn('[QA] Duration fix failed, using original:', e.message);
  }

  const blobURL = URL.createObjectURL(blob);

  const data = {
    blobURL,
    extension,
    duration:    seconds,
    title:       cfg.title,
    tester:      cfg.tester,
    size:        blob.size,
    timestamp:   Date.now(),
    transcript,
    priority:    cfg.priority,
    layer:       cfg.layer,
    environment: cfg.environment,
    testType:    cfg.testType,
    sprint:      cfg.sprint,
    tags:        cfg.tags,
    rules:       cfg.rules.map(r => ({ text: r, checked: false })),
  };

  // Persist the full session, including the video blob itself, to
  // IndexedDB for the popup's Results history. The blobURL above can't be
  // reused there (it only lives as long as this tab stays open), so this
  // is a separate, real copy of the recording that survives independently.
  const sessionId = data.timestamp + '-' + Math.random().toString(36).slice(2, 7);
  data.sessionId  = sessionId; // pass to review page so it can update rules/annotations
  try {
    await qaSaveSession({
      id: sessionId,
      title: data.title, tester: data.tester, duration: data.duration,
      size: data.size, extension: data.extension, timestamp: data.timestamp,
      transcript, videoBlob: blob,
      priority: cfg.priority, layer: cfg.layer, environment: cfg.environment,
      testType: cfg.testType, sprint: cfg.sprint, tags: cfg.tags,
      rules: data.rules,
      annotations: [],
    });
  } catch (e) {
    console.warn('[QA] Could not save session to history:', e.message);
  }

  showSavingUI(blob.size);

  chrome.tabs.create({ url: chrome.runtime.getURL('review/review.html') }, (reviewTab) => {
    let sent = false;

    function trySend(attemptsLeft) {
      if (sent) return;
      chrome.tabs.sendMessage(reviewTab.id, { type: 'RECORDING_DATA', data }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          if (attemptsLeft > 0) {
            setTimeout(() => trySend(attemptsLeft - 1), 400);
          } else {
            showRecorderError('Could not send the recording to the review page. Please do not close this tab and try refreshing the review page.');
          }
          return;
        }
        sent = true;
        showKeepOpenUI(blob.size, blobURL, data);
      });
    }

    setTimeout(() => trySend(15), 500);
  });
}

function showSavingUI(size) {
  renderShell(`
    <div class="rc-spinner"></div>
    <p class="rc-title">Opening review page</p>
    <p class="rc-sub">File size: ${fmtSize(size)}. Do not close this tab yet.</p>
  `);
}

function showKeepOpenUI(size, blobURL, data) {
  renderShell(`
    <div class="rc-success-icon"><svg viewBox="0 0 48 48" fill="none"><circle cx="24" cy="24" r="20" stroke="currentColor" stroke-width="2.5"/><path d="M14 24l8 8 12-14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
    <p class="rc-title">Review page is ready</p>
    <p class="rc-sub"><strong>Keep this tab open</strong> until you download the video. File size: ${fmtSize(size)}</p>
    <button class="rc-btn rc-btn-primary" id="direct-download" style="width:100%;">
      <svg viewBox="0 0 20 20" fill="none"><path d="M10 3v10M6 9l4 4 4-4" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 15v1a2 2 0 002 2h10a2 2 0 002-2v-1" stroke="white" stroke-width="1.6" stroke-linecap="round"/></svg>
      Download Here Too
    </button>
    <p class="rc-hint">This tab closes automatically after download.</p>
  `);
  document.getElementById('direct-download').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href     = blobURL;
    a.download = `${data.title || 'QA_Session'}.${data.extension || 'webm'}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => window.close(), 1500);
  });
}

function showRecorderError(msg) {
  renderShell(`
    <div class="rc-error-icon"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M12 8v4M12 16h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></div>
    <p class="rc-error-title">Something went wrong</p>
    <p class="rc-sub">${escapeHtml(msg)}</p>
    <button class="rc-btn rc-btn-ghost" id="rc-err-close" style="width:100%;">Close</button>
  `);
  document.getElementById('rc-err-close').addEventListener('click', () => window.close());
}

/* ════════════════════════════════
   FIX WEBM DURATION
   Safe approach: only overwrite existing Duration bytes.
   Never injects new bytes (that corrupts the file).
   Scans for the Duration element signature and overwrites value in-place.
════════════════════════════════ */
async function fixWebmDuration(blob, durationMs) {
  const buffer = await blob.arrayBuffer();
  const bytes  = new Uint8Array(buffer);
  const view   = new DataView(buffer);
  const durationSec = durationMs / 1000;

  // Duration element ID is 0x44 0x89
  // Followed by a VINT size byte then the float value
  // Chrome WebM always uses float64 (8 bytes), size VINT = 0x88
  // Search entire file header area (first 256KB)
  const limit = Math.min(bytes.length - 12, 262144);

  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0x44 && bytes[i + 1] === 0x89) {
      const sizeByte = bytes[i + 2];
      if (sizeByte === 0x88) {
        view.setFloat64(i + 3, durationSec, false);
        return new Blob([buffer], { type: blob.type });
      }
      if (sizeByte === 0x84) {
        view.setFloat32(i + 3, durationSec, false);
        return new Blob([buffer], { type: blob.type });
      }
    }
  }

  console.warn('[QA] WebM Duration element not found, file returned unchanged');
  return blob;
}

/* ════════════════════════════════
   FIX MP4 DURATION
   Same problem as WebM, different container: MediaRecorder writes the
   'moov' box (which holds the overall duration, in 'mvhd') in the very
   first chunk it emits, before it can possibly know how long the
   recording will end up being, so it ships with duration ~0. Simply
   concatenating the later chunks never goes back to correct it, which
   is why every player shows the file as having ~0 duration: the seek
   bar reads that and disables itself, even though playback works fine.
   Safe approach: walk the box tree (ftyp/moov/mvhd are tiny and always
   in the first chunk) and overwrite only the existing duration field,
   same byte count in and out, nothing inserted, nothing else touched.
════════════════════════════════ */
async function fixMp4Duration(blob, durationMs) {
  const buffer = await blob.arrayBuffer();
  const view   = new DataView(buffer);
  const size   = buffer.byteLength;
  const durationSec = durationMs / 1000;

  function boxTypeAt(offset) {
    return String.fromCharCode(
      view.getUint8(offset + 4), view.getUint8(offset + 5),
      view.getUint8(offset + 6), view.getUint8(offset + 7)
    );
  }

  // Returns { start, end } of the first child box of `type` within [start,end), or null.
  function findBox(type, start, end) {
    let offset = start;
    while (offset + 8 <= end) {
      let boxSize = view.getUint32(offset);
      let headerSize = 8;
      if (boxSize === 1) {
        if (offset + 16 > end) break;
        boxSize = Number(view.getBigUint64(offset + 8));
        headerSize = 16;
      } else if (boxSize === 0) {
        boxSize = end - offset;
      }
      if (boxSize < headerSize || offset + boxSize > end) break;
      if (boxTypeAt(offset) === type) {
        return { start: offset + headerSize, end: offset + boxSize };
      }
      offset += boxSize;
    }
    return null;
  }

  const moov = findBox('moov', 0, size);
  const mvhd = moov && findBox('mvhd', moov.start, moov.end);
  if (!mvhd) {
    console.warn('[QA] MP4 mvhd box not found, file returned unchanged');
    return blob;
  }

  const version = view.getUint8(mvhd.start);
  // version(1) + flags(3) = 4 bytes, then creation_time/modification_time/timescale,
  // each 8 bytes (v1) or 4 bytes (v0), then duration in the same width.
  const fieldWidth      = version === 1 ? 8 : 4;
  const timescaleOffset = mvhd.start + 4 + fieldWidth + fieldWidth;
  const durationOffset  = timescaleOffset + 4;
  const timescale = view.getUint32(timescaleOffset);
  if (!timescale) {
    console.warn('[QA] MP4 mvhd timescale is 0, file returned unchanged');
    return blob;
  }

  const units = Math.round(durationSec * timescale);
  if (version === 1) view.setBigUint64(durationOffset, BigInt(units));
  else view.setUint32(durationOffset, units);

  return new Blob([buffer], { type: blob.type });
}

/* ════════════════════════════════
   SPEECH RECOGNITION
   Runs directly in THIS tab (chrome-extension:// origin), not in the
   page being tested. Microphone permission is granted per-origin, and
   this origin already has it (via permissions.html / the getUserMedia
   call above), a content script injected into an arbitrary website
   would need its own separate mic grant for that site, which is never
   requested, so recognition silently fails there with "not-allowed".
════════════════════════════════ */
let srNetErrCount = 0;

function startSR() {
  if (!cfg.micOn) return;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    console.warn('[QA SR] Web Speech API not available in this browser');
    return;
  }

  srRunning     = true;
  srNetErrCount = 0;

  function launch() {
    if (!srRunning) return;

    const r = new SR();
    r.continuous      = true;
    r.interimResults  = false; // final only, cleaner results
    r.lang            = 'en-US';
    r.maxAlternatives = 1;

    r.onresult = (event) => {
      srNetErrCount = 0; // got a real result, connection to the recognition service is fine
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          const text = event.results[i][0].transcript.trim();
          if (text) {
            transcript.push({ ts: seconds, text });
            console.log('[QA SR] Got result:', text, 'at', seconds);
          }
        }
      }
    };

    r.onerror = (e) => {
      if (e.error === 'aborted' || e.error === 'no-speech') return;
      if (e.error === 'not-allowed') {
        console.warn('[QA SR] Microphone permission denied, voice transcript disabled');
        srRunning = false;
        return;
      }
      if (e.error === 'network') {
        // Chrome's speech engine couldn't reach Google's recognition servers
        // (VPN/proxy, firewall, antivirus SSL inspection, or no real connectivity).
        // Not something this code controls, back off instead of hammering it.
        // Logged only, no on-screen notice by design.
        srNetErrCount++;
        console.warn('[QA SR] network error (attempt ' + srNetErrCount + '), speech recognition service unreachable');
        return;
      }
      console.warn('[QA SR] error:', e.error);
    };

    r.onend = () => {
      srInstance = null;
      if (!srRunning) return;
      // Back off after repeated network errors instead of retrying instantly.
      const delay = srNetErrCount > 0 ? Math.min(1000 * srNetErrCount, 10000) : 100;
      setTimeout(launch, delay);
    };

    try {
      r.start();
      srInstance = r;
    } catch (e) {
      srInstance = null;
      if (srRunning) setTimeout(launch, 500);
    }
  }

  launch();
}

function stopSR() {
  srRunning = false;
  if (srInstance) {
    try { srInstance.abort(); } catch (_) {}
    srInstance = null;
  }
}

/* ════════════════════════════════
   MESSAGES
════════════════════════════════ */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CONTROLBAR_STOP')   { doStop();   sendResponse({ ok: true }); }
  if (msg.type === 'CONTROLBAR_PAUSE')  { doPause();  sendResponse({ ok: true }); }
  if (msg.type === 'CONTROLBAR_RESUME') { doResume(); sendResponse({ ok: true }); }
  // Mute/unmute the actual microphone audio track
  if (msg.type === 'MIC_MUTE_TOGGLE') {
    if (micStream) {
      micStream.getAudioTracks().forEach(track => {
        track.enabled = !msg.muted;
      });
    }
    sendResponse({ ok: true });
  }
  return true;
});

/* ════════════════════════════════
   ENTRY POINT
════════════════════════════════ */
async function main() {
  await getTabIds();
  showPreparingUI();
  await runCountdown();
  await startRecording();
}

main();
