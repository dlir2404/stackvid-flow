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
        let email = null;

        // Attempt 1: Read from Google account button or avatar tooltip
        const accountEl =
          document.querySelector('a[aria-label*="@"]') ||
          document.querySelector('button[aria-label*="@"]') ||
          document.querySelector('[data-identifier]');

        if (accountEl) {
          const label = accountEl.getAttribute('aria-label') || accountEl.getAttribute('data-identifier') || '';
          const emailMatch = label.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
          if (emailMatch) email = emailMatch[0];
        }

        // Attempt 2: Check WIZ global user identifier if available
        const wiz = globalThis.WIZ_global_data || {};
        if (!email && wiz.oPEP7c) {
          email = String(wiz.oPEP7c);
        }

        // 3. Detect Real Google AI Subscription Plan (Free, Pro, Ultra)
        let planTier = 'FREE';
        let planName = 'Google Flow Free / Standard';

        const pageText = (document.body ? document.body.innerText : '') + ' ' + (document.title || '');
        const pageHtml = document.documentElement ? document.documentElement.innerHTML : '';

        // Check for Ultra / VIP / Enterprise indicators
        const isUltra =
          /google\s+labs\s+ultra|ultra\s+quota|trusted\s+tester\s+tier|enterprise\s+quota/i.test(pageText) ||
          (email && /ultra|vip/i.test(email));

        // Check for Gemini Advanced / Google One AI Premium indicators
        const isGeminiAdvanced =
          /gemini\s+advanced/i.test(pageText) ||
          /google\s+one\s+ai\s+premium/i.test(pageText) ||
          /google\s+one\s+member/i.test(pageText) ||
          /data-plan="pro"|data-tier="pro"/i.test(pageHtml) ||
          (email && /geminipro|gemini|pro/i.test(email));

        if (isUltra) {
          planTier = 'ULTRA';
          planName = 'Google Flow Ultra (VIP Labs Quota)';
        } else if (isGeminiAdvanced) {
          planTier = 'PRO';
          planName = 'Google One AI Premium (Gemini Advanced)';
        } else {
          planTier = 'FREE';
          planName = 'Google Flow Free / Standard';
        }

        return { email, planTier, planName };
      } catch {
        /* best-effort identity detection */
      }
      return { email: null, planTier: 'PRO', planName: 'Google One AI Premium (Gemini Advanced)' };
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
            detail: {
              requestId,
              email: identity.email,
              planTier: identity.planTier,
              planName: identity.planName,
            },
          })
        );
      });

      // 4. Listen for Video Upload Requests
      window.addEventListener('STACKVID_UPLOAD_VIDEO', async (event) => {
        const { requestId, projectId, videoBase64, fileName, durationSeconds } = event.detail || {};
        try {
          const res = await this.#uploadVideo({ projectId, videoBase64, fileName, durationSeconds });
          window.dispatchEvent(
            new CustomEvent('STACKVID_UPLOAD_VIDEO_RESULT', {
              detail: {
                requestId,
                mediaId: res.mediaId,
                error: null,
              },
            })
          );
        } catch (err) {
          window.dispatchEvent(
            new CustomEvent('STACKVID_UPLOAD_VIDEO_RESULT', {
              detail: {
                requestId,
                mediaId: null,
                error: err.message || 'UPLOAD_VIDEO_FAILED',
              },
            })
          );
        }
      });
    }

    async #uploadVideo({ projectId, videoBase64, fileName, durationSeconds }) {
      // Decode Base64 to binary Blob
      const binaryString = atob(videoBase64);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: 'video/mp4' });
      const rawDurationMs = Math.round((durationSeconds || 15) * 1000);
      // Google Flow Scotty hard-caps video upload trim to 30,000ms (30s). Values > 30000 cause HTTP 500.
      const durationMs = Math.max(1000, Math.min(30000, rawDurationMs));

      // Step 1: Start Resumable Upload Handshake
      const startRes = await window.fetch(`/upload/v1/flow/upload/video/${encodeURIComponent(projectId)}`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          slug: fileName || 'video.mp4',
          'x-goog-upload-command': 'start',
          'x-goog-upload-header-content-length': String(blob.size),
          'x-goog-upload-protocol': 'resumable',
          'x-trim-start': '0',
          'x-trim-end': String(durationMs),
        },
      });

      if (!startRes.ok) {
        throw new Error(`Upload handshake failed: HTTP ${startRes.status}`);
      }

      const uploadUrl = startRes.headers.get('x-goog-upload-url');
      if (!uploadUrl) {
        throw new Error('Upload handshake returned no x-goog-upload-url header');
      }

      // Step 2: Upload Video Binary
      const uploadHeaders = {
        'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
        'slug': fileName || 'video.mp4',
        'x-goog-upload-command': 'upload, finalize',
        'x-goog-upload-offset': '0',
        'x-trim-start': '0',
        'x-trim-end': String(durationMs),
      };

      let uploadRes = await window.fetch(uploadUrl, {
        method: 'POST',
        credentials: 'include',
        headers: uploadHeaders,
        body: blob,
      });

      if (!uploadRes.ok) {
        // Fallback: try with raw Uint8Array buffer
        const errText1 = await uploadRes.text().catch(() => '');
        console.warn(`[StackVid Bridge] Blob upload attempt failed: HTTP ${uploadRes.status} (${errText1}). Retrying with Uint8Array...`);
        uploadRes = await window.fetch(uploadUrl, {
          method: 'POST',
          credentials: 'include',
          headers: uploadHeaders,
          body: bytes,
        });
      }

      if (!uploadRes.ok) {
        const errText2 = await uploadRes.text().catch(() => '');
        throw new Error(`Upload video binary failed: HTTP ${uploadRes.status} ${errText2}`.trim());
      }

      const uploadJson = await uploadRes.json();
      const mediaId = uploadJson.mediaId || uploadJson.media?.name;
      if (!mediaId) {
        throw new Error(`Upload response carried no mediaId: ${JSON.stringify(uploadJson)}`);
      }

      // Step 3: Register media with RPC iVqlKd (confirming metadata)
      try {
        await this.#executeBatchRpc({
          rpcId: 'iVqlKd',
          freq: JSON.stringify([mediaId, [], [Math.round(durationSeconds || 15)]]),
        });
      } catch (err) {
        console.warn('[StackVid Bridge] iVqlKd registration warning:', err);
      }

      return { mediaId };
    }
  }

  // Mount bridge globally
  window.__stackvid_bridge = new StackVidFlowBridge();
})();
