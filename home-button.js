/**
 * Floating Home Button
 * Add this to any HTML: <script src="home-button.js"></script>
 */
(function() {
  // Don't show on index/home page
  const currentPage = window.location.pathname.split('/').pop() || 'index.html';
  if (currentPage === 'index.html' || currentPage === '' || currentPage === 'MTB' || currentPage === 'MTB/') {
    return;
  }

  // Create button
  const btn = document.createElement('a');
  btn.href = './index.html';
  btn.id = 'homeFloatingBtn';
  btn.title = 'Home';
  btn.innerHTML = '🏠';
  
  // Styles
  btn.style.cssText = `
    position: fixed;
    top: 20px;
    left: 20px;
    width: 50px;
    height: 50px;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 24px;
    text-decoration: none;
    box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
    z-index: 99999;
    transition: all 0.3s ease;
    cursor: pointer;
  `;

  // Hover effect
  btn.onmouseenter = () => {
    btn.style.transform = 'scale(1.1)';
    btn.style.boxShadow = '0 6px 20px rgba(102, 126, 234, 0.6)';
  };
  btn.onmouseleave = () => {
    btn.style.transform = 'scale(1)';
    btn.style.boxShadow = '0 4px 15px rgba(102, 126, 234, 0.4)';
  };

  // Add to page when DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => document.body.appendChild(btn));
  } else {
    document.body.appendChild(btn);
  }
})();
