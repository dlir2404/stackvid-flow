/**
 * @file flow-bridge.js
 * @description StackVid Page-Context RPC Executor & Event Bridge.
 * Runs in MAIN world to access WIZ_global_data (CSRF token, session ID) and window.fetch with native cookies.
 *
 * (c) 2026 StackVid Automation. Clean-Room Implementation.
 */
(() => {
  'use strict';

  if (window.__stackvid_bridge) return;

  const DEFAULT_SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
  const BATCH_EXECUTE_PATH = '/_/AiSandboxAngularFrontend/data/batchexecute';

  class StackVidFlowBridge {
    #mintQueue = Promise.resolve();

    constructor() {
      this.#initListeners();
    }

    #resolveSiteKey() {
      try {
        const clients = window.___grecaptcha_cfg?.clients || {};
        for (const key of Object.keys(clients)) {
          if (clients[key]?.sitekey) return clients[key].sitekey;
        }
      } catch {
        /* fall through to default */
      }
      return DEFAULT_SITE_KEY;
    }

    async #waitForReady(timeoutMs = 6000) {
      if (window.__stackvid_guard?.status?.hasPristine) return;

      return new Promise((resolve) => {
        let isDone = false;
        const complete = () => {
          if (!isDone) {
            isDone = true;
            resolve();
          }
        };
        try {
          window.grecaptcha?.enterprise?.ready?.(complete);
        } catch {
          /* ignore ready registration errors */
        }
        setTimeout(complete, timeoutMs);
      });
    }

    async #mintCaptcha(action) {
      const prior = this.#mintQueue.catch(() => {});
      let releaseLock;
      this.#mintQueue = new Promise((resolve) => {
        releaseLock = resolve;
      });

      await prior;
      try {
        await this.#waitForReady();
        const siteKey = this.#resolveSiteKey();
        if (!window.__stackvid_guard) {
          throw new Error('CAPTCHA_GUARD_NOT_INITIALIZED');
        }
        return await window.__stackvid_guard.acquireToken(siteKey, action);
      } finally {
        releaseLock();
      }
    }

    async #executeBatchRpc({ rpcId, freq, match, maxTextLength = 32000000 }) {
      const wiz = globalThis.WIZ_global_data || {};
      const atToken = wiz.SNlM0e;
      const sessionId = wiz.FdrFJe;
      const buildLabel = wiz.cfb2h;

      if (!atToken) {
        throw new Error('NO_AT_CSRF_TOKEN_FOUND');
      }

      const randomReqId = Math.floor(Math.random() * 900000) + 100000;
      const sourcePath = location.pathname || '/';
      const userLang = (document.documentElement.lang || navigator.language || 'en').split('-')[0];

      const url =
        `${BATCH_EXECUTE_PATH}?rpcids=${encodeURIComponent(rpcId)}` +
        `&source-path=${encodeURIComponent(sourcePath)}` +
        `&bl=${encodeURIComponent(buildLabel || '')}` +
        `&f.sid=${encodeURIComponent(sessionId || '')}` +
        `&hl=${encodeURIComponent(userLang)}` +
        `&_reqid=${randomReqId}&rt=c`;

      const response = await window.fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'x-same-domain': '1',
        },
        body: new URLSearchParams({ 'f.req': freq, at: atToken }),
      });

      const responseText = await response.text();

      // Payload slicing optimization for large media listings
      if (match) {
        const matchIndex = responseText.indexOf(match);
        return {
          status: response.status,
          matched: matchIndex !== -1,
          text: matchIndex === -1 ? '' : responseText.slice(matchIndex, matchIndex + 1200),
        };
      }

      return {
        status: response.status,
        text: responseText.slice(0, maxTextLength),
      };
    }

    #discoverAccountIdentity() {
      try {
        // Attempt 1: Read from Google account button or avatar tooltip
        const accountEl =
          document.querySelector('a[aria-label*="@"]') ||
          document.querySelector('button[aria-label*="@"]') ||
          document.querySelector('[data-identifier]');

        if (accountEl) {
          const label = accountEl.getAttribute('aria-label') || accountEl.getAttribute('data-identifier') || '';
          const emailMatch = label.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
          if (emailMatch) return { email: emailMatch[0] };
        }

        // Attempt 2: Check WIZ global user identifier if available
        const wiz = globalThis.WIZ_global_data || {};
        if (wiz.oPEP7c) {
          return { email: String(wiz.oPEP7c) };
        }
      } catch {
        /* best-effort identity detection */
      }
      return { email: null };
    }

    #initListeners() {
      // 1. Listen for Captcha Mint Requests
      window.addEventListener('STACKVID_MINT_CAPTCHA', async (event) => {
        const { requestId, action } = event.detail || {};
        try {
          const result = await this.#mintCaptcha(action || 'VIDEO_GENERATION');
          window.dispatchEvent(
            new CustomEvent('STACKVID_MINT_CAPTCHA_RESULT', {
              detail: {
                requestId,
                token: result.token,
                method: result.method,
                error: null,
              },
            })
          );
        } catch (err) {
          window.dispatchEvent(
            new CustomEvent('STACKVID_MINT_CAPTCHA_RESULT', {
              detail: {
                requestId,
                token: null,
                error: err.message || 'MINT_UNKNOWN_ERROR',
              },
            })
          );
        }
      });

      // 2. Listen for Direct RPC Execution Requests
      window.addEventListener('STACKVID_RUN_RPC', async (event) => {
        const { requestId, rpcId, freq, match } = event.detail || {};
        try {
          const result = await this.#executeBatchRpc({ rpcId, freq, match });
          window.dispatchEvent(
            new CustomEvent('STACKVID_RUN_RPC_RESULT', {
              detail: {
                requestId,
                status: result.status,
                text: result.text,
                matched: result.matched,
                error: null,
              },
            })
          );
        } catch (err) {
          window.dispatchEvent(
            new CustomEvent('STACKVID_RUN_RPC_RESULT', {
              detail: {
                requestId,
                status: 502,
                text: null,
                error: err.message || 'RPC_EXECUTE_ERROR',
              },
            })
          );
        }
      });

      // 3. Listen for Identity Probing Requests
      window.addEventListener('STACKVID_PROBE_IDENTITY', (event) => {
        const { requestId } = event.detail || {};
        const identity = this.#discoverAccountIdentity();
        window.dispatchEvent(
          new CustomEvent('STACKVID_PROBE_IDENTITY_RESULT', {
            detail: { requestId, email: identity.email },
          })
        );
      });
    }
  }

  // Mount bridge globally
  window.__stackvid_bridge = new StackVidFlowBridge();
})();
