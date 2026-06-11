/**
 * Floating Home Button Dock
 * Features: drag, lock position, hide/show, opacity slider (persists via localStorage)
 * Usage: <script src="home-button.js"></script>
 */
(function () {
  const currentPage = window.location.pathname.split("/").pop() || "index.html";
  if (currentPage === "index.html" || currentPage === "" || currentPage === "MTB" || currentPage === "MTB/") return;

  const STORAGE_KEY = "homeDockSettings_v1";
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

  const defaultState = {
    x: 18,
    y: 18,
    locked: false,
    hidden: false,      // when true, only the tiny tab shows
    opacity: 0.55,      // idle opacity (not hovered)
  };

  let state;
  try {
    state = { ...defaultState, ...(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")) };
  } catch {
    state = { ...defaultState };
  }

  const save = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

  // Root wrapper (draggable container)
  const dock = document.createElement("div");
  dock.id = "homeDock";
  dock.style.cssText = `
    position: fixed;
    left: ${state.x}px;
    top: ${state.y}px;
    z-index: 99999;
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
    user-select: none;
  `;

  // Tiny tab (always visible)
  const tab = document.createElement("div");
  tab.id = "homeDockTab";
  tab.title = "Home dock";
  tab.innerHTML = "☰";
  tab.style.cssText = `
    width: 26px;
    height: 54px;
    border-radius: 14px;
    background: rgba(35, 35, 45, 0.55);
    backdrop-filter: blur(6px);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: grab;
    box-shadow: 0 4px 14px rgba(0,0,0,0.18);
    opacity: ${state.opacity};
    transition: opacity 180ms ease;
  `;

  // Panel (slides open/closed)
  const panel = document.createElement("div");
  panel.id = "homeDockPanel";
  panel.style.cssText = `
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 16px;
    background: rgba(20, 20, 26, 0.55);
    backdrop-filter: blur(8px);
    box-shadow: 0 8px 22px rgba(0,0,0,0.22);
    transform: translateX(${state.hidden ? "-16px" : "0"});
    opacity: ${state.hidden ? "0" : "1"};
    pointer-events: ${state.hidden ? "none" : "auto"};
    transition: transform 220ms ease, opacity 220ms ease;
  `;

  // Home button
  const home = document.createElement("a");
  home.href = "./index.html";
  home.title = "Home";
  home.innerHTML = "🏠";
  home.style.cssText = `
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 22px;
    text-decoration: none;
    box-shadow: 0 4px 14px rgba(102, 126, 234, 0.35);
    transition: transform 180ms ease, box-shadow 180ms ease;
  `;

  // Lock toggle button
  const lockBtn = document.createElement("button");
  lockBtn.type = "button";
  lockBtn.title = "Lock/unlock position";
  lockBtn.textContent = state.locked ? "🔒" : "🔓";
  lockBtn.style.cssText = `
    width: 38px;
    height: 38px;
    border-radius: 12px;
    border: 0;
    background: rgba(255,255,255,0.12);
    color: white;
    cursor: pointer;
    font-size: 16px;
  `;

  // Hide toggle button
  const hideBtn = document.createElement("button");
  hideBtn.type = "button";
  hideBtn.title = "Hide/show dock";
  hideBtn.textContent = state.hidden ? "👁️" : "🙈";
  hideBtn.style.cssText = lockBtn.style.cssText;

  // Opacity slider (controls idle opacity)
  const sliderWrap = document.createElement("div");
  sliderWrap.style.cssText = `
    display: flex;
    align-items: center;
    gap: 6px;
    padding-left: 4px;
  `;

  const sliderLabel = document.createElement("span");
  sliderLabel.textContent = "Opacity";
  sliderLabel.style.cssText = `font-size: 12px; color: rgba(255,255,255,0.85);`;

  const opacityInput = document.createElement("input");
  opacityInput.type = "range";
  opacityInput.min = "0.15";
  opacityInput.max = "1";
  opacityInput.step = "0.05";
  opacityInput.value = String(state.opacity);
  opacityInput.title = "Idle opacity";
  opacityInput.style.cssText = `width: 110px; cursor: pointer;`;

  sliderWrap.appendChild(sliderLabel);
  sliderWrap.appendChild(opacityInput);

  panel.appendChild(home);
  panel.appendChild(lockBtn);
  panel.appendChild(hideBtn);
  panel.appendChild(sliderWrap);

  dock.appendChild(tab);
  dock.appendChild(panel);

  // Hover behavior: make it more visible when hovered
  const setIdleOpacity = () => {
    tab.style.opacity = String(state.opacity);
    if (!state.hidden) panel.style.opacity = "1";
  };

  dock.addEventListener("mouseenter", () => {
    tab.style.opacity = "1";
    if (!state.hidden) home.style.transform = "scale(1.06)";
    if (!state.hidden) home.style.boxShadow = "0 6px 18px rgba(102, 126, 234, 0.55)";
  });

  dock.addEventListener("mouseleave", () => {
    setIdleOpacity();
    home.style.transform = "scale(1)";
    home.style.boxShadow = "0 4px 14px rgba(102, 126, 234, 0.35)";
  });

  // Toggle hidden state by clicking the tab (single click)
  tab.addEventListener("click", (e) => {
    // If dragging, ignore click (we set a flag below)
    if (dock._draggingClickSuppress) return;

    state.hidden = !state.hidden;
    hideBtn.textContent = state.hidden ? "👁️" : "🙈";

    panel.style.transform = `translateX(${state.hidden ? "-16px" : "0"})`;
    panel.style.opacity = state.hidden ? "0" : "1";
    panel.style.pointerEvents = state.hidden ? "none" : "auto";

    save();
  });

  // Lock/unlock
  lockBtn.addEventListener("click", () => {
    state.locked = !state.locked;
    lockBtn.textContent = state.locked ? "🔒" : "🔓";
    tab.style.cursor = state.locked ? "default" : "grab";
    save();
  });

  // Hide/show (explicit button)
  hideBtn.addEventListener("click", () => {
    state.hidden = !state.hidden;
    hideBtn.textContent = state.hidden ? "👁️" : "🙈";

    panel.style.transform = `translateX(${state.hidden ? "-16px" : "0"})`;
    panel.style.opacity = state.hidden ? "0" : "1";
    panel.style.pointerEvents = state.hidden ? "none" : "auto";

    save();
  });

  // Opacity slider
  opacityInput.addEventListener("input", () => {
    state.opacity = parseFloat(opacityInput.value);
    setIdleOpacity();
    save();
  });

  // Drag logic (drag by the tab). Works on mouse + touch/pointer.
  let dragging = false;
  let startX = 0, startY = 0;
  let origLeft = 0, origTop = 0;

  const onPointerDown = (ev) => {
    if (state.locked) return;
    dragging = true;
    dock._draggingClickSuppress = false;
    tab.setPointerCapture?.(ev.pointerId);

    const rect = dock.getBoundingClientRect();
    origLeft = rect.left;
    origTop = rect.top;
    startX = ev.clientX;
    startY = ev.clientY;

    tab.style.cursor = "grabbing";

    // If user moves even a bit, suppress the click toggle
    const suppress = () => (dock._draggingClickSuppress = true);
    dock._suppressTimer = setTimeout(suppress, 80);
  };

  const onPointerMove = (ev) => {
    if (!dragging || state.locked) return;

    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;

    const newLeft = origLeft + dx;
    const newTop = origTop + dy;

    const maxLeft = window.innerWidth - dock.offsetWidth;
    const maxTop = window.innerHeight - dock.offsetHeight;

    const clampedLeft = clamp(newLeft, 0, maxLeft);
    const clampedTop = clamp(newTop, 0, maxTop);

    dock.style.left = `${clampedLeft}px`;
    dock.style.top = `${clampedTop}px`;

    state.x = Math.round(clampedLeft);
    state.y = Math.round(clampedTop);
  };

  const onPointerUp = () => {
    if (!dragging) return;
    dragging = false;

    clearTimeout(dock._suppressTimer);
    tab.style.cursor = state.locked ? "default" : "grab";
    save();
  };

  tab.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);

  // Add to page
  const mount = () => document.body.appendChild(dock);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
