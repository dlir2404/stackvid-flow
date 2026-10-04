/**
 * @file content.js
 * @description StackVid Content Script Message Relay.
 * Bridges messages between background service worker (ISOLATED world) and flow-bridge (MAIN world).
 *
 * (c) 2026 StackVid Automation. Clean-Room Implementation.
 */
(() => {
  'use strict';

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { action, requestId, payload } = message || {};

    // 1. Relay Captcha Minting
    if (action === 'MINT_CAPTCHA') {
      const timeoutTimer = setTimeout(() => {
        window.removeEventListener('STACKVID_MINT_CAPTCHA_RESULT', responseHandler);
        sendResponse({ error: 'CAPTCHA_BRIDGE_TIMEOUT' });
      }, 25000);

      const responseHandler = (event) => {
        if (event.detail?.requestId === requestId) {
          clearTimeout(timeoutTimer);
          window.removeEventListener('STACKVID_MINT_CAPTCHA_RESULT', responseHandler);
          sendResponse({
            token: event.detail.token,
            method: event.detail.method,
            error: event.detail.error,
          });
        }
      };

      window.addEventListener('STACKVID_MINT_CAPTCHA_RESULT', responseHandler);
      window.dispatchEvent(
        new CustomEvent('STACKVID_MINT_CAPTCHA', {
          detail: { requestId, action: payload?.captchaAction },
        })
      );
      return true; // Keep channel open for async response
    }

    // 2. Relay Batch RPC Execution
    if (action === 'EXECUTE_BATCH_RPC') {
      const timeoutTimer = setTimeout(() => {
        window.removeEventListener('STACKVID_RUN_RPC_RESULT', responseHandler);
        sendResponse({ error: 'RPC_BRIDGE_TIMEOUT', status: 504 });
      }, 60000);

      const responseHandler = (event) => {
        if (event.detail?.requestId === requestId) {
          clearTimeout(timeoutTimer);
          window.removeEventListener('STACKVID_RUN_RPC_RESULT', responseHandler);
          sendResponse({
            status: event.detail.status,
            text: event.detail.text,
            matched: event.detail.matched,
            error: event.detail.error,
          });
        }
      };

      window.addEventListener('STACKVID_RUN_RPC_RESULT', responseHandler);
      window.dispatchEvent(
        new CustomEvent('STACKVID_RUN_RPC', {
          detail: {
            requestId,
            rpcId: payload?.rpcid,
            freq: payload?.freq,
            match: payload?.match,
          },
        })
      );
      return true;
    }

    // 3. Relay Identity Discovery
    if (action === 'PROBE_IDENTITY') {
      const timeoutTimer = setTimeout(() => {
        window.removeEventListener('STACKVID_PROBE_IDENTITY_RESULT', responseHandler);
        sendResponse({ email: null, error: 'IDENTITY_PROBE_TIMEOUT' });
      }, 5000);

      const responseHandler = (event) => {
        if (event.detail?.requestId === requestId) {
          clearTimeout(timeoutTimer);
          window.removeEventListener('STACKVID_PROBE_IDENTITY_RESULT', responseHandler);
          sendResponse({ email: event.detail.email });
        }
      };

      window.addEventListener('STACKVID_PROBE_IDENTITY_RESULT', responseHandler);
      window.dispatchEvent(
        new CustomEvent('STACKVID_PROBE_IDENTITY', {
          detail: { requestId },
        })
      );
      return true;
    }

    return false;
  });
})();
