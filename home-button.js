/**
 * Floating Home Button (peek tab -> slide out)
 * <script src="home-button.js"></script>
 */
(function () {
  const currentPage = window.location.pathname.split("/").pop() || "index.html";
  if (currentPage === "index.html" || currentPage === "" || currentPage === "MTB" || currentPage === "MTB/") return;

  // Wrapper (fixed area)
  const wrap = document.createElement("div");
  wrap.id = "homePeekWrap";
  wrap.style.cssText = `
    position: fixed;
    top: 18px;
    left: 0;
    z-index: 99999;
    display: flex;
    align-items: center;
    gap: 10px;
    transform: translateX(-34px);
    transition: transform 220ms ease, opacity 220ms ease;
    opacity: 0.65;
  `;

  // The small tab that stays visible
  const tab = document.createElement("div");
  tab.id = "homePeekTab";
  tab.title = "Home";
  tab.innerHTML = "🏠";
  tab.style.cssText = `
    width: 34px;
    height: 44px;
    border-radius: 0 12px 12px 0;
    background: rgba(35, 35, 45, 0.45);
    backdrop-filter: blur(6px);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    cursor: pointer;
    user-select: none;
  `;

  // The actual home button (slides out)
  const btn = document.createElement("a");
  btn.href = "./index.html";
  btn.id = "homeFloatingBtn";
  btn.title = "Home";
  btn.innerHTML = "🏠";
  btn.style.cssText = `
    width: 45px;
    height: 45px;
    border-radius: 50%;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 22px;
    text-decoration: none;
    box-shadow: 0 4px 14px rgba(102, 126, 234, 0.35);
    transform: translateX(-10px);
    transition: transform 220ms ease, box-shadow 220ms ease;
  `;

  // Slide out on hover (wrap hover)
  const open = () => {
    wrap.style.transform = "translateX(8px)";
    wrap.style.opacity = "1";
    btn.style.transform = "translateX(0)";
    btn.style.boxShadow = "0 6px 20px rgba(102, 126, 234, 0.55)";
  };
  const close = () => {
    wrap.style.transform = "translateX(-34px)";
    wrap.style.opacity = "0.65";
    btn.style.transform = "translateX(-10px)";
    btn.style.boxShadow = "0 4px 14px rgba(102, 126, 234, 0.35)";
  };

  wrap.addEventListener("mouseenter", open);
  wrap.addEventListener("mouseleave", close);

  // Also allow click on tab to go home (optional)
  tab.addEventListener("click", () => (window.location.href = "./index.html"));

  wrap.appendChild(tab);
  wrap.appendChild(btn);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => document.body.appendChild(wrap));
  } else {
    document.body.appendChild(wrap);
  }
})();
