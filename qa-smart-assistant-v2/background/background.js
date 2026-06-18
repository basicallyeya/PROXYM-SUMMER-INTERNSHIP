'use strict';
/* background.js v10, speech recognition runs locally in recorder.js
   (extension origin), no longer relayed through content scripts */

let isRecording  = false;
let camEnabled   = false;
let pendingRecording = null;
let recorderTabId    = null;
let micMuted         = false;
let currentSeconds   = 0;

/* ══════════════════════════════════════
   CONTROL BAR helpers
══════════════════════════════════════ */
function injectControlBarIntoTab(tabId) {
  if (!tabId || !isRecording) return;
  chrome.tabs.get(tabId, tab => {
    if (!tab || !tab.url || isExtensionOrSystemPage(tab.url)) return;
    chrome.scripting.executeScript({
      target: { tabId },
      func: () => { const e = document.getElementById('qa-controlbar-host'); if (e) e.remove(); }
    }).catch(() => {}).finally(() => {
      Promise.all([
        chrome.scripting.insertCSS({ target: { tabId }, files: ['controlbar/controlbar.css'] }),
        chrome.scripting.executeScript({ target: { tabId }, files: ['controlbar/controlbar.js'] })
      ]).then(() => {
        setTimeout(() => {
          chrome.tabs.sendMessage(tabId, { type: 'TIMER_TICK', seconds: currentSeconds }).catch(() => {});
          if (micMuted) chrome.tabs.sendMessage(tabId, { type: 'MIC_MUTED_STATE', muted: true }).catch(() => {});
        }, 200);
      }).catch(() => {});
    });
  });
}

function removeControlBarFromTab(tabId) {
  if (!tabId) return;
  chrome.scripting.executeScript({
    target: { tabId },
    func: () => { const e = document.getElementById('qa-controlbar-host'); if (e) e.remove(); }
  }).catch(() => {});
}

function removeControlBarFromAllTabs() {
  chrome.tabs.query({}, tabs => {
    tabs.forEach(t => { if (t.url && !isExtensionOrSystemPage(t.url)) removeControlBarFromTab(t.id); });
  });
}

/* ══════════════════════════════════════
   CAMERA helpers
══════════════════════════════════════ */
function injectCamIntoTab(tabId) {
  if (!tabId || !camEnabled || !isRecording) return;
  chrome.tabs.get(tabId, tab => {
    if (!tab || !tab.url || isExtensionOrSystemPage(tab.url)) return;
    chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        if (document.getElementById('__qa_cam__')) return;
        const wrapper = document.createElement('div');
        wrapper.id = '__qa_cam__';
        wrapper.style.cssText = 'position:fixed;bottom:120px;right:20px;width:200px;height:150px;border-radius:12px;overflow:hidden;border:3px solid rgba(124,58,237,0.9);box-shadow:0 4px 20px rgba(0,0,0,0.6);z-index:2147483646;background:#000;';
        const video = document.createElement('video');
        video.autoplay = true; video.muted = true; video.playsInline = true;
        video.style.cssText = 'width:100%;height:100%;object-fit:cover;transform:scaleX(-1);';
        wrapper.appendChild(video);
        document.body.appendChild(wrapper);
        navigator.mediaDevices.getUserMedia({ video: { width:{ideal:320}, height:{ideal:240}, facingMode:'user' }, audio: false })
          .then(stream => { video.srcObject = stream; window.__qa_cam_stream__ = stream; })
          .catch(e => { console.warn('[QA cam]', e.message); wrapper.remove(); });
      }
    }).catch(() => {});
  });
}

function removeCamFromTab(tabId) {
  if (!tabId) return;
  chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      if (window.__qa_cam_stream__) { window.__qa_cam_stream__.getTracks().forEach(t => t.stop()); window.__qa_cam_stream__ = null; }
      document.getElementById('__qa_cam__') && document.getElementById('__qa_cam__').remove();
    }
  }).catch(() => {});
}

function removeCamFromAllTabs() {
  chrome.tabs.query({}, tabs => {
    tabs.forEach(t => { if (t.url && !isExtensionOrSystemPage(t.url)) removeCamFromTab(t.id); });
  });
}

function isExtensionOrSystemPage(url) {
  return !url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') ||
    url.startsWith('about:') || url.includes('recorder.html') ||
    url.includes('review.html') || url.includes('permissions.html');
}

/* ══════════════════════════════════════
   TAB EVENTS: follow active tab
══════════════════════════════════════ */
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!isRecording) return;
  chrome.tabs.get(tabId, tab => {
    if (!tab || !tab.url || isExtensionOrSystemPage(tab.url)) return;
    injectControlBarIntoTab(tabId);
    if (camEnabled) injectCamIntoTab(tabId);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!isRecording || changeInfo.status !== 'complete') return;
  if (isExtensionOrSystemPage(tab.url)) return;
  chrome.tabs.query({ active: true, currentWindow: true }, activeTabs => {
    if (activeTabs[0] && activeTabs[0].id === tabId) {
      injectControlBarIntoTab(tabId);
      if (camEnabled) injectCamIntoTab(tabId);
    }
  });
});

/* ══════════════════════════════════════
   MESSAGES
══════════════════════════════════════ */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'SAVE_RECORDER_CONFIG') {
    pendingRecording = msg.config;
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'PERMISSIONS_DONE') {
    if (!pendingRecording) { sendResponse({ ok: false }); return false; }
    const cfg = pendingRecording;
    pendingRecording = null;
    camEnabled = cfg.camOn;
    micMuted   = false;
    const params = new URLSearchParams({
      mode: cfg.mode, quality: cfg.quality,
      mic: cfg.micOn ? '1' : '0', cam: cfg.camOn ? '1' : '0',
      ctrlbar: cfg.ctrlBarOn ? '1' : '0',
      countdown: String(cfg.countdownSec),
      title: cfg.title, tester: cfg.tester,
      micg: msg.mic === 'granted' ? '1' : '0',
      camg: msg.cam === 'granted' ? '1' : '0',
      target: cfg.targetTabId != null ? String(cfg.targetTabId) : '',
    });
    chrome.tabs.create({
      url: chrome.runtime.getURL('recorder/recorder.html') + '?' + params.toString()
    }, tab => { recorderTabId = tab.id; });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'RECORDING_STARTED') {
    isRecording    = true;
    currentSeconds = 0;
    micMuted       = false;
    const targetTabId = msg.targetTabId;
    if (targetTabId) {
      injectControlBarIntoTab(targetTabId);
      if (camEnabled) injectCamIntoTab(targetTabId);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'CAM_INJECT') {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0]) injectCamIntoTab(tabs[0].id);
    });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'TIMER_TICK') {
    currentSeconds = msg.seconds;
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0] && !isExtensionOrSystemPage(tabs[0].url)) {
        // Update control bar timer
        chrome.tabs.sendMessage(tabs[0].id, { type: 'TIMER_TICK', seconds: msg.seconds }).catch(() => {});
      }
    });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'RECORDING_PAUSED' || msg.type === 'RECORDING_RESUMED') {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, msg).catch(() => {});
    });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'MIC_MUTE_TOGGLE') {
    micMuted = msg.muted;
    chrome.tabs.query({}, tabs => {
      const rec = tabs.find(t => t.url && t.url.includes('recorder/recorder.html'));
      if (rec) chrome.tabs.sendMessage(rec.id, { type: 'MIC_MUTE_TOGGLE', muted: msg.muted }).catch(() => {});
    });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'RECORDING_STOPPED') {
    isRecording = false;
    camEnabled  = false;
    removeControlBarFromAllTabs();
    removeCamFromAllTabs();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'CONTROLBAR_STOP' || msg.type === 'CONTROLBAR_PAUSE' || msg.type === 'CONTROLBAR_RESUME') {
    if (msg.type === 'CONTROLBAR_STOP') {
      isRecording = false;
      camEnabled  = false;
      removeControlBarFromAllTabs();
      removeCamFromAllTabs();
    }
    chrome.tabs.query({}, tabs => {
      const rec = tabs.find(t => t.url && t.url.includes('recorder/recorder.html'));
      if (rec) chrome.tabs.sendMessage(rec.id, msg).catch(() => {});
    });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});