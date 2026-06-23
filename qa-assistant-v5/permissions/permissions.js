'use strict';

const params  = new URLSearchParams(location.search);
const needMic = params.get('mic') === '1';
const needCam = params.get('cam') === '1';
const results = { mic: 'skipped', cam: 'skipped' };

function setState(id, state, text) {
  const item   = document.getElementById('item-' + id);
  const status = document.getElementById('status-' + id);
  const badge  = document.getElementById('badge-' + id);
  if (!item) return;
  item.className     = 'perm-item ' + state;
  status.textContent = text;
  if (state === 'granted') {
    badge.className = 'perm-badge ok';
    badge.innerHTML = `<svg viewBox="0 0 20 20" fill="none"><path d="M5 10l4 4 6-7" stroke="#6EE7B7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  } else if (state === 'denied') {
    badge.className = 'perm-badge err';
    badge.innerHTML = `<svg viewBox="0 0 20 20" fill="none"><path d="M6 6l8 8M14 6l-8 8" stroke="#FCA5A5" stroke-width="2" stroke-linecap="round"/></svg>`;
  } else if (state === 'skipped') {
    badge.className = 'perm-badge wait';
    badge.innerHTML = `<svg viewBox="0 0 20 20" fill="none"><path d="M8 6l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity=".4"/></svg>`;
  } else {
    badge.className = 'perm-badge wait';
    badge.innerHTML = `<div style="width:13px;height:13px;border-radius:50%;border:2px solid rgba(255,255,255,.2);border-top-color:white;animation:spin .7s linear infinite;"></div>`;
  }
}

function setBtn(loading, label) {
  const btn     = document.getElementById('btn-continue');
  const spinner = document.getElementById('btn-spinner');
  const lbl     = document.getElementById('btn-label');
  if (!btn) return;
  spinner.style.display = loading ? 'block' : 'none';
  lbl.textContent       = label;
  btn.disabled          = loading;
}

async function requestAll() {
  let allAlreadyGranted = true;

  if (needMic) {
    let alreadyGranted = false;
    try {
      const s = await navigator.permissions.query({ name: 'microphone' });
      if (s.state === 'granted') alreadyGranted = true;
    } catch(_) {}

    if (alreadyGranted) {
      results.mic = 'granted';
      setState('mic', 'granted', 'Microphone already allowed');
    } else {
      allAlreadyGranted = false;
      setState('mic', 'requesting', 'Check the top-left of your browser…');
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        s.getTracks().forEach(t => t.stop());
        results.mic = 'granted';
        setState('mic', 'granted', 'Microphone access granted');
      } catch(e) {
        results.mic = 'denied';
        setState('mic', 'denied', 'Denied, recording will have no audio');
      }
    }
  } else {
    setState('mic', 'skipped', 'Not requested');
  }

  if (needCam) {
    let alreadyGranted = false;
    try {
      const s = await navigator.permissions.query({ name: 'camera' });
      if (s.state === 'granted') alreadyGranted = true;
    } catch(_) {}

    if (alreadyGranted) {
      results.cam = 'granted';
      setState('cam', 'granted', 'Camera already allowed');
    } else {
      allAlreadyGranted = false;
      setState('cam', 'requesting', 'Check the top-left of your browser…');
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        s.getTracks().forEach(t => t.stop());
        results.cam = 'granted';
        setState('cam', 'granted', 'Camera access granted');
      } catch(e) {
        results.cam = 'denied';
        setState('cam', 'denied', 'Denied, no webcam overlay');
      }
    }
  } else {
    setState('cam', 'skipped', 'Not requested');
  }

  if (allAlreadyGranted && (needMic || needCam)) {
    // Already granted, auto-proceed after brief delay so user sees checkmarks
    setBtn(false, 'All allowed, opening recorder...');
    setTimeout(done, 900);
  } else {
    setBtn(false, 'Continue to Recording');
    document.getElementById('btn-continue').addEventListener('click', done, { once: true });
  }
}

function done() {
  setBtn(true, 'Opening recorder…');
  // Send to BACKGROUND (not popup, popup is closed)
  // Background will open the recorder tab using the config it saved earlier
  chrome.runtime.sendMessage(
    { type: 'PERMISSIONS_DONE', mic: results.mic, cam: results.cam },
    () => { window.close(); }
  );
}

document.addEventListener('DOMContentLoaded', requestAll);
