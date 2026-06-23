'use strict';
(function () {
  if (document.getElementById('qa-controlbar-host')) return;

  /* ── State ── */
  let micMuted   = false;
  let drawMode   = false;    // 'pen' | 'rect' | false
  let collapsed  = false;
  let isDragging = false;
  let dragOffsetX = 0, dragOffsetY = 0;
  let posLeft = 50, posTop = 92;

  /* ── Canvas state ── */
  let canvas  = null;
  let ctx     = null;
  let drawing = false;
  let lastX = 0, lastY = 0;
  let rectStartX = 0, rectStartY = 0;
  let snapData   = null; // snapshot before rect preview
  let drawColor  = '#FB3A5D';

  /* ── Colors available ── */
  const COLORS = [
    { hex: '#FB3A5D', label: 'Red'    },
    { hex: '#3B82F6', label: 'Blue'   },
    { hex: '#22C55E', label: 'Green'  },
    { hex: '#F59E0B', label: 'Yellow' },
    { hex: '#FFFFFF', label: 'White'  },
  ];

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
    <!-- Pen Draw -->
    <button class="qa-btn" id="qa-draw" title="Freehand Draw">
      <svg viewBox="0 0 20 20" fill="none"><path d="M14 3l3 3-9.5 9.5L4 17l1.5-3.5L14 3z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <!-- Rectangle Draw -->
    <button class="qa-btn" id="qa-rect" title="Draw Rectangle">
      <svg viewBox="0 0 20 20" fill="none"><rect x="3" y="5" width="14" height="10" rx="1.5" stroke="currentColor" stroke-width="1.8" fill="none"/></svg>
    </button>
    <!-- Color Picker -->
    <button class="qa-btn qa-color-btn" id="qa-color" title="Pick annotation color">
      <span class="qa-color-dot" id="qa-color-dot" style="background:#FB3A5D;"></span>
    </button>
    <!-- Color popup -->
    <div class="qa-color-popup hidden" id="qa-color-popup">
      ${COLORS.map(c => `<button class="qa-color-opt" data-color="${c.hex}" title="${c.label}" style="background:${c.hex};"></button>`).join('')}
    </div>
    <!-- Erase -->
    <button class="qa-btn" id="qa-erase" title="Clear all drawings">
      <svg viewBox="0 0 20 20" fill="none"><path d="M3 17l4-4 7-7-3-3-7 7-1.5 7.5L6 17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 17H9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
    </button>
    <div class="qa-divider"></div>
    <!-- Screenshot -->
    <button class="qa-btn" id="qa-screenshot" title="Take Screenshot (saved to review page)">
      <svg viewBox="0 0 20 20" fill="none">
        <rect x="2" y="4" width="16" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/>
        <circle cx="10" cy="10" r="2.5" stroke="currentColor" stroke-width="1.5"/>
        <path d="M7 4l1-2h4l1 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <!-- Screenshot flash feedback -->
    <span class="qa-screenshot-flash hidden" id="qa-ss-flash">📸 Saved</span>
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

  const timerEl      = document.getElementById('qa-timer');
  const dotEl        = document.getElementById('qa-dot');
  const pauseBtn     = document.getElementById('qa-pause');
  const stopBtn      = document.getElementById('qa-stop');
  const micBtn       = document.getElementById('qa-mic');
  const drawBtn      = document.getElementById('qa-draw');
  const rectBtn      = document.getElementById('qa-rect');
  const colorBtn     = document.getElementById('qa-color');
  const colorDot     = document.getElementById('qa-color-dot');
  const colorPopup   = document.getElementById('qa-color-popup');
  const eraseBtn     = document.getElementById('qa-erase');
  const screenshotBtn= document.getElementById('qa-screenshot');
  const ssFlash      = document.getElementById('qa-ss-flash');
  const collapseBtn  = document.getElementById('qa-collapse');
  const centerEl     = document.getElementById('qa-center');
  const barEl        = document.getElementById('qa-bar');
  const gripEl       = document.getElementById('qa-grip');

  function fmtTime(s) {
    return `${Math.floor(s/60)}:${(s%60).toString().padStart(2,'0')}`;
  }

  /* ── Position ── */
  function applyPosition() {
    host.style.left = posLeft + '%';
    host.style.top  = posTop  + '%';
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
  } catch (_) { applyPosition(); host.style.visibility = 'visible'; }

  /* ── Messages ── */
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'TIMER_TICK' && timerEl)     timerEl.textContent = fmtTime(msg.seconds);
    if (msg.type === 'RECORDING_PAUSED') {
      dotEl.style.animationPlayState = 'paused'; dotEl.style.opacity = '0.35';
      pauseBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="none"><path d="M7 5l7 5-7 5V5z" fill="currentColor"/></svg>`;
      pauseBtn.style.background = '#374151';
    }
    if (msg.type === 'RECORDING_RESUMED') {
      dotEl.style.animationPlayState = ''; dotEl.style.opacity = '';
      pauseBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="none"><rect x="5" y="4" width="3" height="12" rx="1.5" fill="currentColor"/><rect x="12" y="4" width="3" height="12" rx="1.5" fill="currentColor"/></svg>`;
      pauseBtn.style.background = '';
    }
    if (msg.type === 'MIC_MUTED_STATE') { micMuted = msg.muted; updateMicIcon(); }
  });

  /* ── Pause / Stop ── */
  pauseBtn.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'CONTROLBAR_PAUSE' }));
  stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CONTROLBAR_STOP' });
    if (canvas) canvas.remove();
    host.remove();
  });

  /* ── Mic ── */
  function updateMicIcon() {
    const svg = document.getElementById('qa-mic-svg');
    if (!svg) return;
    if (micMuted) {
      micBtn.style.opacity = '0.5';
      svg.innerHTML = `<rect x="7" y="2" width="6" height="10" rx="3" fill="currentColor" opacity="0.3"/><path d="M4 10a6 6 0 0012 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none" opacity="0.3"/><line x1="3" y1="3" x2="17" y2="17" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>`;
    } else {
      micBtn.style.opacity = '';
      svg.innerHTML = `<rect x="7" y="2" width="6" height="10" rx="3" fill="currentColor"/><path d="M4 10a6 6 0 0012 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/><line x1="10" y1="16" x2="10" y2="18.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`;
    }
  }
  micBtn.addEventListener('click', () => {
    micMuted = !micMuted; updateMicIcon();
    chrome.runtime.sendMessage({ type: 'MIC_MUTE_TOGGLE', muted: micMuted });
  });

  /* ── Canvas creation ── */
  function createCanvas() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.id = '__qa_draw_canvas__';
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.cssText = 'position:fixed;inset:0;z-index:2147483645;pointer-events:none;cursor:crosshair;';
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    applyCtxStyle();
    window.addEventListener('resize', () => {
      const img = canvas.toDataURL();
      canvas.width = window.innerWidth; canvas.height = window.innerHeight;
      applyCtxStyle();
      const image = new Image();
      image.onload = () => ctx.drawImage(image, 0, 0);
      image.src = img;
    });
  }

  function applyCtxStyle() {
    ctx.strokeStyle = drawColor;
    ctx.lineWidth   = 3;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
  }

  /* ── Pen draw ── */
  function enablePen() {
    createCanvas(); canvas.style.pointerEvents = 'all';
    canvas.addEventListener('mousedown', penStart);
    canvas.addEventListener('mousemove', penMove);
    canvas.addEventListener('mouseup',   penEnd);
    canvas.addEventListener('mouseleave', penEnd);
  }
  function disablePen() {
    if (!canvas) return; canvas.style.pointerEvents = 'none';
    canvas.removeEventListener('mousedown', penStart);
    canvas.removeEventListener('mousemove', penMove);
    canvas.removeEventListener('mouseup',   penEnd);
    canvas.removeEventListener('mouseleave', penEnd);
  }
  function penStart(e) { drawing=true; lastX=e.clientX; lastY=e.clientY; ctx.beginPath(); ctx.moveTo(lastX,lastY); }
  function penMove(e)  { if(!drawing) return; ctx.lineTo(e.clientX,e.clientY); ctx.stroke(); lastX=e.clientX; lastY=e.clientY; }
  function penEnd()    { drawing=false; ctx&&ctx.closePath(); }

  /* ── Rect draw ── */
  function enableRect() {
    createCanvas(); canvas.style.pointerEvents = 'all';
    canvas.addEventListener('mousedown', rectStart);
    canvas.addEventListener('mousemove', rectMove);
    canvas.addEventListener('mouseup',   rectEnd);
    canvas.addEventListener('mouseleave', rectEnd);
  }
  function disableRect() {
    if (!canvas) return; canvas.style.pointerEvents = 'none';
    canvas.removeEventListener('mousedown', rectStart);
    canvas.removeEventListener('mousemove', rectMove);
    canvas.removeEventListener('mouseup',   rectEnd);
    canvas.removeEventListener('mouseleave', rectEnd);
  }
  function rectStart(e) {
    drawing = true;
    rectStartX = e.clientX; rectStartY = e.clientY;
    snapData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  }
  function rectMove(e) {
    if (!drawing || !snapData) return;
    ctx.putImageData(snapData, 0, 0);
    applyCtxStyle();
    const w = e.clientX - rectStartX;
    const h = e.clientY - rectStartY;
    ctx.strokeRect(rectStartX, rectStartY, w, h);
  }
  function rectEnd(e) {
    if (!drawing) return;
    drawing = false;
    if (snapData) {
      ctx.putImageData(snapData, 0, 0);
      snapData = null;
      applyCtxStyle();
      const w = e.clientX - rectStartX;
      const h = e.clientY - rectStartY;
      ctx.strokeRect(rectStartX, rectStartY, w, h);
    }
  }

  function deactivateAllDrawTools() {
    disablePen(); disableRect();
    drawBtn.classList.remove('qa-btn-active');
    rectBtn.classList.remove('qa-btn-active');
  }

  /* ── Pen button ── */
  drawBtn.addEventListener('click', () => {
    if (drawMode === 'pen') {
      drawMode = false; deactivateAllDrawTools(); return;
    }
    deactivateAllDrawTools();
    drawMode = 'pen';
    drawBtn.classList.add('qa-btn-active');
    enablePen();
  });

  /* ── Rect button ── */
  rectBtn.addEventListener('click', () => {
    if (drawMode === 'rect') {
      drawMode = false; deactivateAllDrawTools(); return;
    }
    deactivateAllDrawTools();
    drawMode = 'rect';
    rectBtn.classList.add('qa-btn-active');
    enableRect();
  });

  /* ── Color picker ── */
  colorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    colorPopup.classList.toggle('hidden');
  });
  colorPopup.querySelectorAll('.qa-color-opt').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      drawColor = btn.dataset.color;
      colorDot.style.background = drawColor;
      applyCtxStyle();
      colorPopup.classList.add('hidden');
      // Mark active
      colorPopup.querySelectorAll('.qa-color-opt').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  document.addEventListener('click', () => colorPopup.classList.add('hidden'));

  /* ── Erase ── */
  eraseBtn.addEventListener('click', () => {
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawMode = false; deactivateAllDrawTools();
  });

  /* ── Screenshot ── */
  screenshotBtn.addEventListener('click', () => {
    // Hide the control bar briefly, capture, restore
    host.style.visibility = 'hidden';
    if (canvas) canvas.style.visibility = 'hidden';
    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'TAKE_SCREENSHOT',
        timestamp: Math.round(Date.now()),
      }, (resp) => {
        host.style.visibility = 'visible';
        if (canvas) canvas.style.visibility = 'visible';
        if (resp && resp.ok) {
          ssFlash.classList.remove('hidden');
          setTimeout(() => ssFlash.classList.add('hidden'), 1800);
        }
      });
    }, 80);
  });

  /* ── Collapse ── */
  collapseBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    centerEl.style.display = collapsed ? 'none' : '';
    document.getElementById('qa-collapse-icon').innerHTML = collapsed
      ? `<path d="M7 12l3-4 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`
      : `<path d="M13 8l-3 4-4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  });

  /* ── Drag ── */
  function startDrag(e) {
    if (e.target.closest('button')) return;
    isDragging = true; barEl.classList.add('qa-dragging');
    const rect = host.getBoundingClientRect();
    dragOffsetX = e.clientX - (rect.left + rect.width / 2);
    dragOffsetY = e.clientY - (rect.top  + rect.height / 2);
    e.preventDefault();
  }
  barEl.addEventListener('mousedown', startDrag);
  gripEl.addEventListener('mousedown', startDrag);
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    posLeft = ((e.clientX - dragOffsetX) / window.innerWidth)  * 100;
    posTop  = ((e.clientY - dragOffsetY) / window.innerHeight) * 100;
    clampToViewport(); applyPosition();
  });
  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false; barEl.classList.remove('qa-dragging');
    try { chrome.storage.local.set({ qa_controlbar_pos: { left: posLeft, top: posTop } }); } catch (_) {}
  });

})();
