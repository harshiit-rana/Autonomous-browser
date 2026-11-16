/**
 * Project Aegis - Visual Agent Cursor & Click Ripple Overlay
 * Injected into active WebContentsView to provide clear visual feedback
 * of physical mouse movements, Bezier kinematic arcs, and click actions.
 */

export const CURSOR_OVERLAY_SCRIPT = `
(() => {
  if (window.__aegisCursorLoaded) return;
  window.__aegisCursorLoaded = true;

  const style = document.createElement('style');
  style.id = '__aegis_cursor_styles__';
  style.textContent = \`
    #__aegis_agent_cursor__ {
      position: fixed;
      top: 0;
      left: 0;
      z-index: 2147483647;
      pointer-events: none;
      transform: translate(-10px, -10px);
      transition: transform 0.05s linear;
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    .__aegis_cursor_dot__ {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: radial-gradient(circle, #a855f7 0%, #3b82f6 100%);
      border: 2px solid #ffffff;
      box-shadow: 0 0 14px rgba(168, 85, 247, 0.9), 0 0 4px rgba(0,0,0,0.5);
      position: relative;
    }

    .__aegis_click_ripple__ {
      position: absolute;
      top: -10px;
      left: -10px;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      border: 3px solid #ec4899;
      opacity: 0;
      transform: scale(0.3);
      pointer-events: none;
    }

    .__aegis_click_ripple__.animate {
      animation: __aegis_ripple_anim__ 0.6s cubic-bezier(0.1, 0.8, 0.3, 1) forwards;
    }

    @keyframes __aegis_ripple_anim__ {
      0% {
        opacity: 1;
        transform: scale(0.4);
      }
      100% {
        opacity: 0;
        transform: scale(2.4);
      }
    }

    .__aegis_cursor_badge__ {
      margin-top: 6px;
      background: rgba(15, 23, 42, 0.95);
      color: #38bdf8;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 11px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 6px;
      border: 1px solid #38bdf8;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      white-space: nowrap;
      letter-spacing: 0.3px;
    }

    .__aegis_highlight_box__ {
      outline: 3px solid #ec4899 !important;
      outline-offset: 2px !important;
      background: rgba(236, 72, 153, 0.15) !important;
      transition: all 0.2s ease-in-out !important;
    }
  \`;
  document.head.appendChild(style);

  const cursorEl = document.createElement('div');
  cursorEl.id = '__aegis_agent_cursor__';
  cursorEl.innerHTML = \`
    <div class="__aegis_cursor_dot__">
      <div class="__aegis_click_ripple__"></div>
    </div>
    <div class="__aegis_cursor_badge__">Worker [Crawler]</div>
  \`;
  document.documentElement.appendChild(cursorEl);

  let currentX = 150;
  let currentY = 150;

  window.__updateAgentCursor = (x, y, label) => {
    currentX = x;
    currentY = y;
    cursorEl.style.transform = \`translate(\${x - 10}px, \${y - 10}px)\`;
    if (label) {
      const b = cursorEl.querySelector('.__aegis_cursor_badge__');
      if (b) b.textContent = label;
    }
  };

  window.__triggerAgentClick = (x, y) => {
    if (x !== undefined && y !== undefined) {
      window.__updateAgentCursor(x, y);
    }
    const ripple = cursorEl.querySelector('.__aegis_click_ripple__');
    if (ripple) {
      ripple.classList.remove('animate');
      void ripple.offsetWidth; // trigger reflow
      ripple.classList.add('animate');
    }
  };

  window.__highlightElement = (selector) => {
    document.querySelectorAll('.__aegis_highlight_box__').forEach(el => el.classList.remove('__aegis_highlight_box__'));
    const target = document.querySelector(selector);
    if (target) {
      target.classList.add('__aegis_highlight_box__');
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  window.__updateAgentCursor(150, 150, 'Agent Online');
})();
`;
