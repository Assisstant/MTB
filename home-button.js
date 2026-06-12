/**
 * Floating Home Button Dock — v2 (touch-optimized)
 * Features: drag (mouse + touch), edge snap, lock, hide/show, opacity slider — persists via localStorage
 * Usage:  <script src="home-button.js"></script>
 *         <script src="home-button.js" data-home="./Index.html"></script>   (optional custom home link)
 *
 * v2 fixes for touch:
 *  - touch-action:none on the handle → drag no longer fights page scrolling
 *  - tap vs drag decided by movement distance (6px), not a timer → slow taps work
 *  - position re-clamped on load/resize/rotation → dock never restores off-screen
 *  - snaps to the nearest screen edge after dragging
 *  - panel collapses to zero width when hidden → handle can hug the screen edge
 *  - bigger hit targets on coarse pointers (44px buttons)
 */
(function () {
  const here = (window.location.pathname.split("/").pop() || "index.html").toLowerCase();
  if (here === "index.html" || here === "" || here === "mtb") return;

  const STORAGE_KEY = "homeDockSettings_v1";
  const EDGE = 10;                          // snap margin from screen edge
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const coarse = window.matchMedia("(pointer: coarse)").matches;

  // optional custom home target: <script src="home-button.js" data-home="...">
  const homeHref =
    (document.currentScript && document.currentScript.dataset.home) || "./index.html";

  const defaultState = { x: 18, y: 18, locked: false, hidden: false, opacity: 0.55 };
  let state;
  try {
    state = { ...defaultState, ...(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")) };
  } catch {
    state = { ...defaultState };
  }
  const save = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

  // sizes scale up on touch devices
  const TAB_W = coarse ? 30 : 26;
  const TAB_H = coarse ? 60 : 54;
  const BTN = coarse ? 44 : 38;
  const HOME = coarse ? 50 : 44;

  /* ── root (draggable container) ── */
  const dock = document.createElement("div");
  dock.id = "homeDock";
  dock.style.cssText = `
    position: fixed;
    left: ${state.x}px;
    top: ${state.y}px;
    z-index: 99999;
    display: flex;
    align-items: center;
    gap: ${state.hidden ? "0" : "10px"};
    font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
    user-select: none;
    -webkit-user-select: none;
  `;

  /* ── handle (always visible) ── */
  const tab = document.createElement("div");
  tab.id = "homeDockTab";
  tab.title = "Home dock";
  tab.setAttribute("role", "button");
  tab.setAttribute("aria-label", "Home dock — повлечи или тапни");
  tab.innerHTML = "☰";
  tab.style.cssText = `
    width: ${TAB_W}px;
    height: ${TAB_H}px;
    border-radius: 14px;
    background: linear-gradient(180deg, rgba(62,62,80,0.62), rgba(24,24,34,0.55));
    border: 1px solid rgba(255,255,255,0.14);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    color: rgba(255,255,255,0.9);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: ${state.locked ? "default" : "grab"};
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.2), 0 4px 14px rgba(0,0,0,0.18);
    opacity: ${state.opacity};
    transition: opacity 180ms ease;
    touch-action: none;                       /* v2: дозволи drag без скрол */
    -webkit-tap-highlight-color: transparent;
    flex-shrink: 0;
  `;

  /* ── panel (collapses to width 0 when hidden) ── */
  const panel = document.createElement("div");
  panel.id = "homeDockPanel";
  panel.style.cssText = `
    display: flex;
    align-items: center;
    gap: 8px;
    padding: ${state.hidden ? "8px 0" : "8px 10px"};
    border-radius: 16px;
    background: linear-gradient(180deg, rgba(38,38,50,0.6), rgba(16,16,24,0.55));
    border: 1px solid rgba(255,255,255,0.12);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.16), 0 8px 22px rgba(0,0,0,0.22);
    max-width: ${state.hidden ? "0" : "420px"};
    opacity: ${state.hidden ? "0" : "1"};
    pointer-events: ${state.hidden ? "none" : "auto"};
    overflow: hidden;
    white-space: nowrap;
    transition: max-width 240ms ease, opacity 200ms ease, padding 240ms ease;
  `;

  /* ── home link ── */
  const home = document.createElement("a");
  home.href = homeHref;
  home.title = "Home";
  home.setAttribute("aria-label", "Назад кон почетната");
  home.innerHTML = "🏠";
  home.style.cssText = `
    width: ${HOME}px;
    height: ${HOME}px;
    border-radius: 50%;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: ${coarse ? 24 : 22}px;
    text-decoration: none;
    border: 1px solid rgba(255,255,255,0.28);
    box-shadow: inset 0 2px 3px rgba(255,255,255,0.45), inset 0 -8px 14px rgba(0,0,0,0.25), 0 4px 14px rgba(102, 126, 234, 0.35);
    transition: transform 180ms ease, box-shadow 180ms ease;
    -webkit-tap-highlight-color: transparent;
    flex-shrink: 0;
  `;
  home.addEventListener("pointerdown", () => { home.style.transform = "scale(0.92)"; });
  home.addEventListener("pointerup", () => { home.style.transform = "scale(1)"; });
  home.addEventListener("pointercancel", () => { home.style.transform = "scale(1)"; });

  /* ── small buttons ── */
  const smallBtnCss = `
    width: ${BTN}px;
    height: ${BTN}px;
    border-radius: 12px;
    border: 1px solid rgba(255,255,255,0.16);
    background: linear-gradient(180deg, rgba(255,255,255,0.22), rgba(255,255,255,0.07));
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.25);
    color: white;
    cursor: pointer;
    font-size: 16px;
    -webkit-tap-highlight-color: transparent;
    flex-shrink: 0;
  `;

  const lockBtn = document.createElement("button");
  lockBtn.type = "button";
  lockBtn.title = "Заклучи/отклучи позиција";
  lockBtn.textContent = state.locked ? "🔒" : "🔓";
  lockBtn.style.cssText = smallBtnCss;

  const hideBtn = document.createElement("button");
  hideBtn.type = "button";
  hideBtn.title = "Сокриј/прикажи панел";
  hideBtn.textContent = state.hidden ? "👁️" : "🙈";
  hideBtn.style.cssText = smallBtnCss;

  /* ── opacity slider ── */
  const sliderWrap = document.createElement("div");
  sliderWrap.style.cssText = `display:flex; align-items:center; gap:6px; padding-left:4px;`;

  const sliderLabel = document.createElement("span");
  sliderLabel.textContent = "👻";
  sliderLabel.title = "Видливост кога не е активен";
  sliderLabel.style.cssText = `font-size:14px; color:rgba(255,255,255,0.85);`;

  const opacityInput = document.createElement("input");
  opacityInput.type = "range";
  opacityInput.min = "0.15";
  opacityInput.max = "1";
  opacityInput.step = "0.05";
  opacityInput.value = String(state.opacity);
  opacityInput.title = "Видливост кога не е активен";
  opacityInput.style.cssText = `
    width: ${coarse ? 130 : 110}px;
    height: ${coarse ? 28 : 18}px;
    cursor: pointer;
    accent-color: #667eea;
    touch-action: none;
  `;

  sliderWrap.appendChild(sliderLabel);
  sliderWrap.appendChild(opacityInput);
  panel.appendChild(home);
  panel.appendChild(lockBtn);
  panel.appendChild(hideBtn);
  panel.appendChild(sliderWrap);
  dock.appendChild(tab);
  dock.appendChild(panel);

  /* ── helpers ── */
  const setIdleOpacity = () => {
    tab.style.opacity = String(state.opacity);
  };

  const applyHidden = () => {
    hideBtn.textContent = state.hidden ? "👁️" : "🙈";
    panel.style.maxWidth = state.hidden ? "0" : "420px";
    panel.style.opacity = state.hidden ? "0" : "1";
    panel.style.pointerEvents = state.hidden ? "none" : "auto";
    panel.style.padding = state.hidden ? "8px 0" : "8px 10px";
    dock.style.gap = state.hidden ? "0" : "10px";
    // по транзицијата провери дали отворениот панел излегува надвор од екранот
    setTimeout(() => ensureInViewport(true), 260);
  };

  // v2: гарантира дека докот е целосно во екранот (по rotate/resize/restore)
  const ensureInViewport = (animate) => {
    const w = dock.offsetWidth, h = dock.offsetHeight;
    const nx = clamp(state.x, EDGE, Math.max(EDGE, window.innerWidth - w - EDGE));
    const ny = clamp(state.y, EDGE, Math.max(EDGE, window.innerHeight - h - EDGE));
    if (nx !== state.x || ny !== state.y) {
      if (animate) dock.style.transition = "left 220ms ease, top 220ms ease";
      dock.style.left = nx + "px";
      dock.style.top = ny + "px";
      state.x = nx; state.y = ny;
      save();
      if (animate) setTimeout(() => { dock.style.transition = ""; }, 240);
    }
  };

  // v2: лепење на најблискиот раб (лево/десно) по влечење
  const snapToEdge = () => {
    const w = dock.offsetWidth;
    const centerX = state.x + w / 2;
    const targetX = centerX < window.innerWidth / 2 ? EDGE : window.innerWidth - w - EDGE;
    dock.style.transition = "left 220ms cubic-bezier(0.22, 1, 0.36, 1)";
    dock.style.left = targetX + "px";
    state.x = targetX;
    setTimeout(() => { dock.style.transition = ""; }, 240);
    save();
  };

  /* ── visibility feedback: hover (десктоп) + допир (телефон) ── */
  dock.addEventListener("mouseenter", () => {
    tab.style.opacity = "1";
    if (!state.hidden) {
      home.style.transform = "scale(1.03)";
      home.style.boxShadow = "inset 0 2px 3px rgba(255,255,255,0.45), inset 0 -8px 14px rgba(0,0,0,0.25), 0 8px 20px rgba(0, 0, 0, 0.3), 0 4px 14px rgba(102, 126, 234, 0.4)";
    }
  });
  dock.addEventListener("mouseleave", () => {
    setIdleOpacity();
    home.style.transform = "scale(1)";
    home.style.boxShadow = "inset 0 2px 3px rgba(255,255,255,0.45), inset 0 -8px 14px rgba(0,0,0,0.25), 0 4px 14px rgba(102, 126, 234, 0.35)";
  });

  let touchFadeTimer = null;
  dock.addEventListener("pointerdown", () => {
    tab.style.opacity = "1";
    clearTimeout(touchFadeTimer);
  });
  window.addEventListener("pointerup", () => {
    clearTimeout(touchFadeTimer);
    touchFadeTimer = setTimeout(() => {
      if (!dock.matches(":hover")) setIdleOpacity();
    }, 1800);
  });

  /* ── controls ── */
  const toggleHidden = () => {
    state.hidden = !state.hidden;
    applyHidden();
    save();
  };

  tab.addEventListener("click", () => {
    if (suppressClick) return;     // штотуку завршивме drag
    toggleHidden();
  });

  lockBtn.addEventListener("click", () => {
    state.locked = !state.locked;
    lockBtn.textContent = state.locked ? "🔒" : "🔓";
    tab.style.cursor = state.locked ? "default" : "grab";
    save();
  });

  hideBtn.addEventListener("click", toggleHidden);

  opacityInput.addEventListener("input", () => {
    state.opacity = parseFloat(opacityInput.value);
    setIdleOpacity();
    save();
  });

  /* ── drag (pointer events: mouse + touch + pen) ── */
  let dragging = false;
  let suppressClick = false;
  let startX = 0, startY = 0, origLeft = 0, origTop = 0;

  tab.addEventListener("pointerdown", (ev) => {
    if (state.locked) return;
    dragging = true;
    suppressClick = false;
    tab.setPointerCapture?.(ev.pointerId);
    const rect = dock.getBoundingClientRect();
    origLeft = rect.left;
    origTop = rect.top;
    startX = ev.clientX;
    startY = ev.clientY;
    tab.style.cursor = "grabbing";
  });

  tab.addEventListener("pointermove", (ev) => {
    if (!dragging || state.locked) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;

    // v2: tap vs drag по растојание, не по тајмер — спорите тапови работат
    if (!suppressClick && Math.hypot(dx, dy) > 6) suppressClick = true;
    if (!suppressClick) return;

    const newLeft = clamp(origLeft + dx, EDGE, Math.max(EDGE, window.innerWidth - dock.offsetWidth - EDGE));
    const newTop = clamp(origTop + dy, EDGE, Math.max(EDGE, window.innerHeight - dock.offsetHeight - EDGE));
    dock.style.left = newLeft + "px";
    dock.style.top = newTop + "px";
    state.x = Math.round(newLeft);
    state.y = Math.round(newTop);
  });

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    tab.style.cursor = state.locked ? "default" : "grab";
    if (suppressClick) snapToEdge();   // залепи само ако навистина влечевме
    save();
    // дозволи го следниот клик
    setTimeout(() => { suppressClick = false; }, 0);
  };
  tab.addEventListener("pointerup", endDrag);
  tab.addEventListener("pointercancel", endDrag);

  /* ── lifecycle ── */
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => ensureInViewport(false), 120);
  });
  window.addEventListener("orientationchange", () => {
    setTimeout(() => ensureInViewport(true), 250);
  });

  const mount = () => {
    document.body.appendChild(dock);
    ensureInViewport(false);   // v2: стари координати од друг екран не остануваат надвор
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
