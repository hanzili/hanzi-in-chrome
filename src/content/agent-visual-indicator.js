/**
 * Agent Visual Indicator
 *
 * Shows visual feedback on the page when the agent is working:
 * - Pulsing teal glow border around the viewport
 * - "Stop" button at the bottom of the page
 * - Static indicator when agent is active in tab group
 */

(function() {
  // State
  let glowBorder = null;
  let stopContainer = null;
  let staticIndicator = null;
  let isShowingGlow = false;
  let isShowingStatic = false;
  let wasShowingGlow = false;
  let wasShowingStatic = false;

  // Inject animation styles
  function injectStyles() {
    if (document.getElementById('agent-animation-styles')) return;

    const style = document.createElement('style');
    style.id = 'agent-animation-styles';
    style.textContent = `
      @keyframes agent-pulse {
        0% {
          box-shadow:
            inset 0 0 10px rgba(93, 154, 154, 0.5),
            inset 0 0 20px rgba(93, 154, 154, 0.3),
            inset 0 0 30px rgba(93, 154, 154, 0.1);
        }
        50% {
          box-shadow:
            inset 0 0 15px rgba(93, 154, 154, 0.7),
            inset 0 0 25px rgba(93, 154, 154, 0.5),
            inset 0 0 35px rgba(93, 154, 154, 0.2);
        }
        100% {
          box-shadow:
            inset 0 0 10px rgba(93, 154, 154, 0.5),
            inset 0 0 20px rgba(93, 154, 154, 0.3),
            inset 0 0 30px rgba(93, 154, 154, 0.1);
        }
      }
    `;
    document.head.appendChild(style);
  }

  // Create the pulsing glow border
  function createGlowBorder() {
    const el = document.createElement('div');
    el.id = 'agent-glow-border';
    el.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      pointer-events: none;
      z-index: 2147483646;
      opacity: 0;
      transition: opacity 0.3s ease-in-out;
      animation: agent-pulse 2s ease-in-out infinite;
      box-shadow:
        inset 0 0 10px rgba(93, 154, 154, 0.5),
        inset 0 0 20px rgba(93, 154, 154, 0.3),
        inset 0 0 30px rgba(93, 154, 154, 0.1);
    `;
    return el;
  }

  // Create the stop button
  function createStopButton() {
    const container = document.createElement('div');
    container.id = 'agent-stop-container';
    container.style.cssText = `
      position: fixed;
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      justify-content: center;
      align-items: center;
      pointer-events: none;
      z-index: 2147483647;
    `;

    const button = document.createElement('button');
    button.id = 'agent-stop-button';
    button.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 256 256" fill="currentColor" style="margin-right: 12px; vertical-align: middle;">
        <path d="M128,20A108,108,0,1,0,236,128,108.12,108.12,0,0,0,128,20Zm0,192a84,84,0,1,1,84-84A84.09,84.09,0,0,1,128,212Zm40-112v56a12,12,0,0,1-12,12H100a12,12,0,0,1-12-12V100a12,12,0,0,1,12-12h56A12,12,0,0,1,168,100Z"></path>
      </svg>
      <span style="vertical-align: middle;">Stop Agent</span>
    `;
    button.style.cssText = `
      position: relative;
      transform: translateY(100px);
      padding: 12px 16px;
      background: #FAF9F5;
      color: #141413;
      border: 0.5px solid rgba(31, 30, 29, 0.4);
      border-radius: 12px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-shadow:
        0 40px 80px rgba(93, 154, 154, 0.24),
        0 4px 14px rgba(93, 154, 154, 0.24);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      opacity: 0;
      user-select: none;
      pointer-events: auto;
      white-space: nowrap;
      margin: 0 auto;
    `;

    button.addEventListener('mouseenter', () => {
      if (isShowingGlow) {
        button.style.background = '#F5F4F0';
      }
    });

    button.addEventListener('mouseleave', () => {
      if (isShowingGlow) {
        button.style.background = '#FAF9F5';
      }
    });

    button.addEventListener('click', async () => {
      try {
        await chrome.runtime.sendMessage({ type: 'STOP_TASK' });
      } catch (e) {
        console.error('[AgentIndicator] Failed to send stop message:', e);
      }
    });

    container.appendChild(button);
    return container;
  }

  // Create static indicator (shown when agent is active but not executing)
  function createStaticIndicator() {
    const el = document.createElement('div');
    el.id = 'agent-static-indicator';
    el.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="width: 16px; height: 16px; margin-right: 8px; vertical-align: middle;">
        <circle cx="8" cy="8" r="6" fill="#5D9A9A"/>
      </svg>
      <span style="vertical-align: middle; color: #141413; font-size: 14px;">Agent is active</span>
      <button id="agent-static-close" style="
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 6px;
        background: transparent;
        border: none;
        cursor: pointer;
        pointer-events: auto;
        margin-left: 8px;
        border-radius: 8px;
        transition: background 0.2s;
      ">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="#141413">
          <path d="M15.1464 4.14642C15.3417 3.95121 15.6582 3.95118 15.8534 4.14642C16.0486 4.34168 16.0486 4.65822 15.8534 4.85346L10.7069 9.99997L15.8534 15.1465C16.0486 15.3417 16.0486 15.6583 15.8534 15.8535C15.6826 16.0244 15.4186 16.0461 15.2245 15.918L15.1464 15.8535L9.99989 10.707L4.85338 15.8535C4.65813 16.0486 4.34155 16.0486 4.14634 15.8535C3.95115 15.6583 3.95129 15.3418 4.14634 15.1465L9.29286 9.99997L4.14634 4.85346C3.95129 4.65818 3.95115 4.34162 4.14634 4.14642C4.34154 3.95128 4.65812 3.95138 4.85338 4.14642L9.99989 9.29294L15.1464 4.14642Z"/>
        </svg>
      </button>
    `;
    el.style.cssText = `
      position: fixed;
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%);
      display: inline-flex;
      align-items: center;
      padding: 8px 12px;
      background: #FAF9F5;
      border: 0.5px solid rgba(31, 30, 29, 0.30);
      border-radius: 14px;
      box-shadow: 0 40px 80px 0 rgba(0, 0, 0, 0.15);
      z-index: 2147483647;
      pointer-events: none;
      white-space: nowrap;
      user-select: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    `;

    const closeBtn = el.querySelector('#agent-static-close');
    if (closeBtn) {
      closeBtn.addEventListener('mouseenter', () => {
        closeBtn.style.background = '#F0EEE6';
      });
      closeBtn.addEventListener('mouseleave', () => {
        closeBtn.style.background = 'transparent';
      });
      closeBtn.addEventListener('click', () => {
        hideStaticIndicator();
      });
    }

    return el;
  }

  // Show the pulsing glow indicator
  function showGlowIndicator() {
    isShowingGlow = true;
    injectStyles();

    if (!glowBorder) {
      glowBorder = createGlowBorder();
      document.body.appendChild(glowBorder);
    } else {
      glowBorder.style.display = '';
    }

    if (!stopContainer) {
      stopContainer = createStopButton();
      document.body.appendChild(stopContainer);
    } else {
      stopContainer.style.display = '';
    }

    // Animate in
    requestAnimationFrame(() => {
      if (glowBorder) glowBorder.style.opacity = '1';
      if (stopContainer) {
        const btn = stopContainer.querySelector('#agent-stop-button');
        if (btn) {
          btn.style.transform = 'translateY(0)';
          btn.style.opacity = '1';
        }
      }
    });
  }

  // Hide the pulsing glow indicator
  function hideGlowIndicator() {
    if (!isShowingGlow) return;
    isShowingGlow = false;

    if (glowBorder) glowBorder.style.opacity = '0';
    if (stopContainer) {
      const btn = stopContainer.querySelector('#agent-stop-button');
      if (btn) {
        btn.style.transform = 'translateY(100px)';
        btn.style.opacity = '0';
      }
    }

    // Remove after animation
    setTimeout(() => {
      if (!isShowingGlow) {
        if (glowBorder && glowBorder.parentNode) {
          glowBorder.parentNode.removeChild(glowBorder);
          glowBorder = null;
        }
        if (stopContainer && stopContainer.parentNode) {
          stopContainer.parentNode.removeChild(stopContainer);
          stopContainer = null;
        }
      }
    }, 300);
  }

  // Show static indicator
  function showStaticIndicator() {
    isShowingStatic = true;

    if (!staticIndicator) {
      staticIndicator = createStaticIndicator();
      document.body.appendChild(staticIndicator);
    } else {
      staticIndicator.style.display = '';
    }
  }

  // Hide static indicator
  function hideStaticIndicator() {
    if (!isShowingStatic) return;
    isShowingStatic = false;

    if (staticIndicator && staticIndicator.parentNode) {
      staticIndicator.parentNode.removeChild(staticIndicator);
      staticIndicator = null;
    }
  }

  // Temporarily hide for tool use (screenshots, etc.)
  function hideForToolUse() {
    wasShowingGlow = isShowingGlow;
    wasShowingStatic = isShowingStatic;

    if (glowBorder) glowBorder.style.display = 'none';
    if (stopContainer) stopContainer.style.display = 'none';
    if (staticIndicator && isShowingStatic) staticIndicator.style.display = 'none';
  }

  // Show again after tool use
  function showAfterToolUse() {
    if (wasShowingGlow) {
      if (glowBorder) glowBorder.style.display = '';
      if (stopContainer) stopContainer.style.display = '';
    }
    if (wasShowingStatic && staticIndicator) {
      staticIndicator.style.display = '';
    }
    wasShowingGlow = false;
    wasShowingStatic = false;
  }

  // Listen for messages from background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'SHOW_AGENT_INDICATORS':
        showGlowIndicator();
        sendResponse({ success: true });
        break;

      case 'HIDE_AGENT_INDICATORS':
        hideGlowIndicator();
        sendResponse({ success: true });
        break;

      case 'HIDE_FOR_TOOL_USE':
        hideForToolUse();
        sendResponse({ success: true });
        break;

      case 'SHOW_AFTER_TOOL_USE':
        showAfterToolUse();
        sendResponse({ success: true });
        break;

      case 'SHOW_STATIC_INDICATOR':
        showStaticIndicator();
        sendResponse({ success: true });
        break;

      case 'HIDE_STATIC_INDICATOR':
        hideStaticIndicator();
        sendResponse({ success: true });
        break;
    }
  });

  // Cleanup on page unload
  window.addEventListener('beforeunload', () => {
    hideGlowIndicator();
    hideStaticIndicator();
  });

  console.log('[Hanzi in Chrome] Visual indicator script loaded');
})();
