'use strict';
(function () {
  if (document.getElementById('qa-controlbar-host')) return;

  /* ── State ── */
  let micMuted   = false;
  let drawMode   = false;
  let collapsed  = false;
  let isDragging = false;
  let dragOffsetX = 0, dragOffsetY = 0;
  let posLeft = 50, posTop = 92; // percentages of viewport, anchored to the bar's center

  /* ── Canvas for draw tool ── */
  let canvas = null;
  let ctx    = null;
  let drawing = false;
  let lastX = 0, lastY = 0;

  /* ── Build HTML ── */
  const host = document.createElement('div');
  host.id = 'qa-controlbar-host';
  host.innerHTML = `
<div class="qa-bar" id="qa-bar">
  <div class="qa-grip" id="qa-grip" title="Drag to move">
    <svg viewBox="0 0 10 16" fill="none"><circle cx="2" cy="2" r="1.4" fill="currentColor"/><circle cx="8" cy="2" r="1.4" fill="currentColor"/><circle cx="2" cy="8" r="1.4" fill="currentColor"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/><circle cx="2" cy="14" r="1.4" fill="currentColor"/><circle cx="8" cy="14" r="1.4" fill="currentColor"/></svg>
  </div>
  <div class="qa-bar-left">
    <span class="qa-rec-dot" id="qa-dot"></span>
    <span class="qa-timer" id="qa-timer">0:00</span>
  </div>
  <div class="qa-bar-center" id="qa-center">
    <!-- Pause -->
    <button class="qa-btn qa-btn-pause" id="qa-pause" title="Pause / Resume">
      <svg viewBox="0 0 20 20" fill="none">
        <rect x="5" y="4" width="3" height="12" rx="1.5" fill="currentColor"/>
        <rect x="12" y="4" width="3" height="12" rx="1.5" fill="currentColor"/>
      </svg>
    </button>
    <!-- Stop -->
    <button class="qa-btn qa-btn-stop" id="qa-stop" title="Stop Recording">
      <svg viewBox="0 0 20 20" fill="none">
        <rect x="5" y="5" width="10" height="10" rx="2" fill="currentColor"/>
      </svg>
    </button>
    <div class="qa-divider"></div>
    <!-- Mic -->
    <button class="qa-btn" id="qa-mic" title="Mute / Unmute Microphone">
      <svg id="qa-mic-svg" viewBox="0 0 20 20" fill="none">
        <rect x="7" y="2" width="6" height="10" rx="3" fill="currentColor"/>
        <path d="M4 10a6 6 0 0012 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>
        <line x1="10" y1="16" x2="10" y2="18.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </button>
    <div class="qa-divider"></div>
    <!-- Draw -->
    <button class="qa-btn" id="qa-draw" title="Draw / Annotate">
      <svg viewBox="0 0 20 20" fill="none"><path d="M14 3l3 3-9.5 9.5L4 17l1.5-3.5L14 3z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <!-- Erase -->
    <button class="qa-btn" id="qa-erase" title="Clear all drawings">
      <svg viewBox="0 0 20 20" fill="none"><path d="M3 17l4-4 7-7-3-3-7 7-1.5 7.5L6 17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 17H9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
    </button>
  </div>
  <!-- Collapse -->
  <button class="qa-btn qa-btn-collapse" id="qa-collapse" title="Collapse">
    <svg id="qa-collapse-icon" viewBox="0 0 20 20" fill="none">
      <path d="M13 8l-3 4-4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </button>
</div>
`;
  document.body.appendChild(host);

  const timerEl     = document.getElementById('qa-timer');
  const dotEl       = document.getElementById('qa-dot');
  const pauseBtn    = document.getElementById('qa-pause');
  const stopBtn     = document.getElementById('qa-stop');
  const micBtn      = document.getElementById('qa-mic');
  const drawBtn     = document.getElementById('qa-draw');
  const eraseBtn    = document.getElementById('qa-erase');
  const collapseBtn = document.getElementById('qa-collapse');
  const centerEl    = document.getElementById('qa-center');
  const barEl       = document.getElementById('qa-bar');
  const gripEl      = document.getElementById('qa-grip');

  function fmtTime(s) {
    return `${Math.floor(s/60)}:${(s%60).toString().padStart(2,'0')}`;
  }

  /* ── Position: placeable anywhere on screen, remembered across tabs ── */
  function applyPosition() {
    host.style.left = posLeft + '%';
    host.style.top  = posTop + '%';
  }

  function clampToViewport() {
    posLeft = Math.max(4, Math.min(96, posLeft));
    posTop  = Math.max(4, Math.min(96, posTop));
  }

  try {
    chrome.storage.local.get(['qa_controlbar_pos'], (r) => {
      if (r && r.qa_controlbar_pos) {
        posLeft = r.qa_controlbar_pos.left;
        posTop  = r.qa_controlbar_pos.top;
        clampToViewport();
      }
      applyPosition();
      host.style.visibility = 'visible';
    });
  } catch (_) {
    applyPosition();
    host.style.visibility = 'visible';
  }

  /* ── Timer / pause state from background ── */
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'TIMER_TICK' && timerEl) {
      timerEl.textContent = fmtTime(msg.seconds);
    }
    if (msg.type === 'RECORDING_PAUSED') {
      dotEl.style.animationPlayState = 'paused';
      dotEl.style.opacity = '0.35';
      pauseBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="none"><path d="M7 5l7 5-7 5V5z" fill="currentColor"/></svg>`;
      pauseBtn.style.background = '#374151';
    }
    if (msg.type === 'RECORDING_RESUMED') {
      dotEl.style.animationPlayState = '';
      dotEl.style.opacity = '';
      pauseBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="none"><rect x="5" y="4" width="3" height="12" rx="1.5" fill="currentColor"/><rect x="12" y="4" width="3" height="12" rx="1.5" fill="currentColor"/></svg>`;
      pauseBtn.style.background = '';
    }
    if (msg.type === 'MIC_MUTED_STATE') {
      // Sync mute state when re-injected into new tab
      micMuted = msg.muted;
      updateMicIcon();
    }
  });

  /* ── Pause ── */
  pauseBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CONTROLBAR_PAUSE' });
  });

  /* ── Stop ── */
  stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CONTROLBAR_STOP' });
    if (canvas) canvas.remove();
    host.remove();
  });

  /* ── Mic mute: sends message to background which relays to recorder ── */
  function updateMicIcon() {
    const svg = document.getElementById('qa-mic-svg');
    if (!svg) return;
    if (micMuted) {
      micBtn.style.opacity = '0.5';
      svg.innerHTML = `
        <rect x="7" y="2" width="6" height="10" rx="3" fill="currentColor" opacity="0.3"/>
        <path d="M4 10a6 6 0 0012 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none" opacity="0.3"/>
        <line x1="3" y1="3" x2="17" y2="17" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
      `;
    } else {
      micBtn.style.opacity = '';
      svg.innerHTML = `
        <rect x="7" y="2" width="6" height="10" rx="3" fill="currentColor"/>
        <path d="M4 10a6 6 0 0012 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>
        <line x1="10" y1="16" x2="10" y2="18.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      `;
    }
  }

  micBtn.addEventListener('click', () => {
    micMuted = !micMuted;
    updateMicIcon();
    // Tell background to relay MIC_MUTE to recorder tab
    chrome.runtime.sendMessage({ type: 'MIC_MUTE_TOGGLE', muted: micMuted });
  });

  /* ── Draw tool: creates a transparent canvas overlay ── */
  function createCanvas() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.id = '__qa_draw_canvas__';
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:2147483645',
      'pointer-events:none', 'cursor:crosshair',
    ].join(';');
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    ctx.strokeStyle = '#FB3A5D';
    ctx.lineWidth   = 3;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';

    // Resize canvas if window resizes
    window.addEventListener('resize', () => {
      const img = canvas.toDataURL();
      canvas.width  = window.innerWidth;
      canvas.height = window.innerHeight;
      ctx.strokeStyle = '#FB3A5D';
      ctx.lineWidth   = 3;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      const image = new Image();
      image.onload = () => ctx.drawImage(image, 0, 0);
      image.src = img;
    });
  }

  function enableDraw() {
    createCanvas();
    canvas.style.pointerEvents = 'all';

    canvas.addEventListener('mousedown', startDraw);
    canvas.addEventListener('mousemove', doDraw);
    canvas.addEventListener('mouseup',   endDraw);
    canvas.addEventListener('mouseleave', endDraw);
  }

  function disableDraw() {
    if (!canvas) return;
    canvas.style.pointerEvents = 'none';
    canvas.removeEventListener('mousedown', startDraw);
    canvas.removeEventListener('mousemove', doDraw);
    canvas.removeEventListener('mouseup',   endDraw);
    canvas.removeEventListener('mouseleave', endDraw);
  }

  function startDraw(e) {
    drawing = true;
    lastX = e.clientX;
    lastY = e.clientY;
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
  }

  function doDraw(e) {
    if (!drawing) return;
    ctx.lineTo(e.clientX, e.clientY);
    ctx.stroke();
    lastX = e.clientX;
    lastY = e.clientY;
  }

  function endDraw() {
    drawing = false;
    ctx && ctx.closePath();
  }

  drawBtn.addEventListener('click', () => {
    drawMode = !drawMode;
    drawBtn.classList.toggle('qa-btn-active', drawMode);
    drawBtn.title = drawMode ? 'Click again to stop drawing' : 'Draw / Annotate';
    if (drawMode) {
      enableDraw();
    } else {
      disableDraw();
    }
  });

  eraseBtn.addEventListener('click', () => {
    if (canvas && ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    drawMode = false;
    drawBtn.classList.remove('qa-btn-active');
    disableDraw();
  });

  /* ── Collapse ── */
  collapseBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    centerEl.style.display = collapsed ? 'none' : '';
    document.getElementById('qa-collapse-icon').innerHTML = collapsed
      ? `<path d="M7 12l3-4 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`
      : `<path d="M13 8l-3 4-4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  });

  /* ── Drag: anywhere on screen (left, right, top, bottom), remembered
     for next time via chrome.storage.local. Grab from the grip handle
     or anywhere on the bar background that isn't a button. ── */
  function startDrag(e) {
    if (e.target.closest('button')) return;
    isDragging = true;
    barEl.classList.add('qa-dragging');
    const rect = host.getBoundingClientRect();
    dragOffsetX = e.clientX - (rect.left + rect.width / 2);
    dragOffsetY = e.clientY - (rect.top + rect.height / 2);
    e.preventDefault();
  }

  barEl.addEventListener('mousedown', startDrag);
  gripEl.addEventListener('mousedown', startDrag);

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const cx = e.clientX - dragOffsetX;
    const cy = e.clientY - dragOffsetY;
    posLeft = (cx / window.innerWidth) * 100;
    posTop  = (cy / window.innerHeight) * 100;
    clampToViewport();
    applyPosition();
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    barEl.classList.remove('qa-dragging');
    try { chrome.storage.local.set({ qa_controlbar_pos: { left: posLeft, top: posTop } }); } catch (_) {}
  });

})();
