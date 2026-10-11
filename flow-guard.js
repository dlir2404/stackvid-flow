/**
 * @file flow-guard.js
 * @description StackVid Proprietary reCAPTCHA Enterprise Guard & Anti-Tamper Shield.
 * Runs in MAIN world at document_start to preserve pristine token execution against frontend wrappers.
 *
 * (c) 2026 StackVid Automation. Clean-Room Implementation.
 */
(() => {
  'use strict';

  if (window.__stackvid_guard) return;

  const POISON_SIGNATURE = 'extension_hijack_detected';

  class StackVidCaptchaGuard {
    #pristineMethod = null;
    #isTrapped = false;
    #captureLayer = null;
    #isCleaned = false;
    #pollTimer = null;

    constructor() {
      this.#initWatchers();
      this.#initPollers();
    }

    get status() {
      return {
        active: true,
        hasPristine: typeof this.#pristineMethod === 'function',
        captureLayer: this.#captureLayer,
        isTrapped: this.#isTrapped,
      };
    }

    #isPristine(fn) {
      if (typeof fn !== 'function') return false;
      try {
        const src = Function.prototype.toString.call(fn);
        if (src.includes(POISON_SIGNATURE)) {
          this.#isTrapped = true;
          return false;
        }
      } catch {
        // Native code or restricted toString: assume safe candidate
      }
      return true;
    }

    #commitPristine(fn, context, layerName) {
      if (this.#pristineMethod || !this.#isPristine(fn)) return false;

      this.#pristineMethod = fn.bind(context);
      this.#captureLayer = layerName;
      this.#stopPolling();

      // Schedule cleanup on next microtask so current setter call finishes cleanly
      Promise.resolve().then(() => this.#cleanTraps());
      return true;
    }

    #restoreProperty(obj, prop) {
      try {
        const desc = Object.getOwnPropertyDescriptor(obj, prop);
        if (!desc || (!desc.get && !desc.set)) return;
        Object.defineProperty(obj, prop, {
          value: desc.get ? desc.get() : undefined,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      } catch {
        /* property is sealed or non-configurable */
      }
    }

    #cleanTraps() {
      if (this.#isCleaned) return;
      this.#isCleaned = true;
      try {
        const gc = window.grecaptcha;
        if (gc) {
          const ent = gc.enterprise;
          if (ent) this.#restoreProperty(ent, 'execute');
          this.#restoreProperty(gc, 'enterprise');
        }
        this.#restoreProperty(window, 'grecaptcha');
      } catch {
        /* best-effort cleanup */
      }
    }

    #watchExecute(enterprise) {
      const current = enterprise.execute;
      if (typeof current === 'function' && this.#commitPristine(current, enterprise, 'execute-immediate')) {
        return;
      }

      try {
        let internalFn = current;
        Object.defineProperty(enterprise, 'execute', {
          get: () => internalFn,
          set: (nextFn) => {
            internalFn = nextFn;
            this.#commitPristine(nextFn, enterprise, 'execute-setter');
          },
          configurable: true,
          enumerable: true,
        });
      } catch {
        /* property already sealed */
      }
    }

    #watchEnterprise(grecaptcha) {
      const current = grecaptcha.enterprise;
      if (current && typeof current === 'object') {
        this.#watchExecute(current);
      }

      try {
        let internalEnt = current;
        Object.defineProperty(grecaptcha, 'enterprise', {
          get: () => internalEnt,
          set: (nextEnt) => {
            internalEnt = nextEnt;
            if (nextEnt && typeof nextEnt === 'object') {
              this.#watchExecute(nextEnt);
            }
          },
          configurable: true,
          enumerable: true,
        });
      } catch {
        /* property already sealed */
      }
    }

    #initWatchers() {
      const currentGc = window.grecaptcha;
      if (currentGc && typeof currentGc === 'object') {
        this.#watchEnterprise(currentGc);
      }

      try {
        let internalGc = currentGc;
        Object.defineProperty(window, 'grecaptcha', {
          get: () => internalGc,
          set: (nextGc) => {
            internalGc = nextGc;
            if (nextGc && typeof nextGc === 'object') {
              this.#watchEnterprise(nextGc);
            }
          },
          configurable: true,
          enumerable: true,
        });
      } catch {
        /* window property already defined */
      }
    }

    #initPollers() {
      const startTime = Date.now();
      const MAX_POLL_MS = 2500;

      this.#pollTimer = setInterval(() => {
        if (this.#pristineMethod || Date.now() - startTime > MAX_POLL_MS) {
          this.#stopPolling();
          return;
        }

        const execute = window.grecaptcha?.enterprise?.execute;
        if (typeof execute === 'function' && this.#isPristine(execute)) {
          this.#commitPristine(execute, window.grecaptcha.enterprise, 'poll-interval');
        }
      }, 3);
    }

    #stopPolling() {
      if (this.#pollTimer) {
        clearInterval(this.#pollTimer);
        this.#pollTimer = null;
      }
    }

    async acquireToken(siteKey, action, timeoutMs = 8000) {
      // Strategy 1: Use pristine function captured before page trap overwritten it
      if (typeof this.#pristineMethod === 'function') {
        try {
          const executionPromise = this.#pristineMethod(siteKey, { action });
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('PRISTINE_EXECUTE_TIMEOUT')), timeoutMs)
          );
          const token = await Promise.race([executionPromise, timeoutPromise]);
          if (token) return { token: String(token), method: 'PRISTINE_CAPTURE' };
        } catch (err) {
          console.warn('[StackVid Guard] Pristine execution failed, attempting fallback...', err);
        }
      }

      // Strategy 2: Dynamic Object.assign Neuter Fallback
      // When page-level trap overwrites execute, it injects "extension_hijack_detected" via Object.assign.
      // We temporarily neuter Object.assign during execution to neutralize the poison action.
      const nativeAssign = Object.assign;
      try {
        Object.assign = function (target, ...sources) {
          const applied = nativeAssign.call(this, target, ...sources);
          if (applied && typeof applied === 'object' && applied.action === POISON_SIGNATURE) {
            applied.action = action; // Force restore desired action!
          }
          return applied;
        };

        const executeFn = window.grecaptcha?.enterprise?.execute;
        if (typeof executeFn !== 'function') {
          throw new Error('GRECAPTCHA_NOT_AVAILABLE');
        }

        const executionPromise = executeFn(siteKey, { action });
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('NEUTER_EXECUTE_TIMEOUT')), timeoutMs)
        );
        const token = await Promise.race([executionPromise, timeoutPromise]);
        if (token) return { token: String(token), method: 'ASSIGN_NEUTER_FALLBACK' };

        throw new Error('TOKEN_MINT_RETURNED_EMPTY');
      } catch (err) {
        console.warn('[StackVid Guard] Neuter execution failed, attempting invisible widget fallback...', err);

        // Strategy 3: Invisible Widget Render Fallback
        try {
          let host = document.getElementById('stackvid-recaptcha-host');
          if (!host) {
            host = document.createElement('div');
            host.id = 'stackvid-recaptcha-host';
            host.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;';
            document.documentElement.appendChild(host);
          }

          const widgetId = await new Promise((resolve, reject) => {
            try {
              const id = window.grecaptcha?.enterprise?.render(host, {
                sitekey: siteKey,
                size: 'invisible',
                callback: () => {},
                'error-callback': (m) => reject(new Error('render_error: ' + m)),
              });
              resolve(id);
            } catch (e) {
              reject(e);
            }
          });

          const execFn = typeof this.#pristineMethod === 'function' ? this.#pristineMethod : window.grecaptcha?.enterprise?.execute;
          if (typeof execFn !== 'function') throw new Error('EXECUTE_NOT_AVAILABLE');
          const widgetPromise = execFn(widgetId, { action });
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('WIDGET_EXECUTE_TIMEOUT')), timeoutMs)
          );
          const token = await Promise.race([widgetPromise, timeoutPromise]);
          if (token) return { token: String(token), method: 'WIDGET_RENDER_FALLBACK' };
        } catch (widgetErr) {
          throw new Error(err.message || 'TOKEN_MINT_FAILED');
        }
        throw err;
      } finally {
        Object.assign = nativeAssign;
      }
    }
  }

  // Initialize and mount globally in MAIN world
  window.__stackvid_guard = new StackVidCaptchaGuard();
})();
