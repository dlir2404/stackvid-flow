/**
 * @file background.js
 * @description StackVid Flow Background Service Worker (MV3).
 * Manages Flow tab in the current profile, connects to Flow Service (ws://127.0.0.1:9222),
 * and coordinates pristine token minting & batchexecute RPC relays.
 *
 * (c) 2026 StackVid Automation. Clean-Room Implementation.
 */

const DEFAULT_FLOW_SERVICE_WS = 'wss://api.stackvid.dev/fleet-ws';
const FLOW_TAB_URL = 'https://flow.google.com/';
const FLOW_URL_MATCHERS = [
  'https://flow.google.com/*',
  'https://labs.google/*',
];
const CAPTCHA_SLOT = '__CAPTCHA__';

let ws = null;
let workerId = null;
let accountEmail = null;
let connectionState = 'DISCONNECTED'; // DISCONNECTED | CONNECTING | CONNECTED
let activeJobs = 0;
let tabExecutionQueue = Promise.resolve();
let lastTabExecutionTime = 0;
const MIN_TAB_EXECUTION_GAP_MS = 3000;

async function executeWithGap(fn) {
  const previous = tabExecutionQueue;
  tabExecutionQueue = (async () => {
    await previous.catch(() => {});
    const elapsed = Date.now() - lastTabExecutionTime;
    if (elapsed < MIN_TAB_EXECUTION_GAP_MS) {
      await new Promise((r) => setTimeout(r, MIN_TAB_EXECUTION_GAP_MS - elapsed));
    }
    lastTabExecutionTime = Date.now();
    return await fn();
  })();
  return tabExecutionQueue;
}
let metrics = {
  totalCount: 0,
  successCount: 0,
  failCount: 0,
  lastError: null,
};
let executionLogs = [];

// ─── Startup & Alarms ──────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => void bootstrap());
chrome.runtime.onStartup.addListener(() => void bootstrap());

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'ws_reconnect') connectFlowService();
  if (alarm.name === 'ws_ping') sendPing();
  if (alarm.name === 'tab_sync') syncFlowTabIdentity();
});

async function bootstrap() {
  const stored = await chrome.storage.local.get(['workerId', 'accountEmail', 'metrics']);
  workerId = stored.workerId || `worker-${crypto.randomUUID().slice(0, 8)}`;
  accountEmail = stored.accountEmail || null;
  if (stored.metrics) Object.assign(metrics, stored.metrics);

  await chrome.storage.local.set({ workerId });

  chrome.alarms.create('ws_ping', { periodInMinutes: 0.4 });
  chrome.alarms.create('tab_sync', { periodInMinutes: 1.0 });

  connectFlowService();
  void syncFlowTabIdentity();
}

// ─── WebSocket Client ──────────────────────────────────────

function setConnectionState(state) {
  connectionState = state;
  broadcastState();
}

async function getFlowWsUrl() {
  try {
    const stored = await chrome.storage.local.get(['flowServerWsUrl']);
    return stored?.flowServerWsUrl || DEFAULT_FLOW_SERVICE_WS;
  } catch {
    return DEFAULT_FLOW_SERVICE_WS;
  }
}

async function connectFlowService(force = false) {
  if (!force && ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  if (force && ws) {
    try {
      ws.close();
    } catch {}
    ws = null;
  }

  setConnectionState('CONNECTING');

  try {
    const targetWsUrl = await getFlowWsUrl();
    ws = new WebSocket(targetWsUrl);

    ws.onopen = () => {
      setConnectionState('CONNECTED');
      appendLog('SYS', `Connected to StackVid Flow Service (${targetWsUrl})`);
      chrome.storage.local.get(['accountEmail', 'planTier', 'planName', 'runnerType', 'runnerToken'], (cached) => {
        const token = cached?.runnerToken?.trim() || null;
        ws.send(
          JSON.stringify({
            type: 'REGISTER_WORKER',
            workerId,
            accountEmail: cached?.accountEmail || accountEmail,
            planTier: cached?.planTier || 'PRO',
            planName: cached?.planName || 'Google One AI Premium (Gemini Advanced)',
            runnerType: cached?.runnerType || 'USER',
            token,
            verifiedFromGoogle: true,
            status: activeJobs > 0 ? 'BUSY' : 'IDLE',
            activeJobs,
            timestamp: Date.now(),
          })
        );
      });
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.method === 'batch_rpc') {
          executeWithGap(() => handleBatchRpc(msg));
        } else if (msg.method === 'upload_video') {
          executeWithGap(() => handleUploadVideo(msg));
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        } else if (msg.type === 'reload') {
          chrome.runtime.reload();
        }
      } catch (err) {
        console.error('[StackVid Worker] Message processing error:', err);
      }
    };

    ws.onclose = () => {
      setConnectionState('DISCONNECTED');
      chrome.alarms.create('ws_reconnect', { delayInMinutes: 0.1 }); // ~6s reconnect
    };

    ws.onerror = (err) => {
      setConnectionState('DISCONNECTED');
      metrics.lastError = 'WS_CONNECTION_ERROR';
    };
  } catch (err) {
    setConnectionState('DISCONNECTED');
    chrome.alarms.create('ws_reconnect', { delayInMinutes: 0.1 });
  }
}

function sendPing() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
  } else {
    connectFlowService();
  }
}

function sendResponse(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

// ─── Tab Management & Identity ─────────────────────────────

async function ensureFlowTab() {
  const tabs = await chrome.tabs.query({ url: FLOW_URL_MATCHERS });
  let candidate =
    tabs.find((t) => t.url && t.url.includes('/project/') && !t.discarded) ||
    tabs.find((t) => t.active && !t.discarded) ||
    tabs.find((t) => !t.discarded) ||
    tabs[0];

  if (!candidate) {
    // Open a background Flow tab if not open
    candidate = await chrome.tabs.create({ url: FLOW_TAB_URL, active: false });
    await new Promise((r) => setTimeout(r, 4500));
  } else if (candidate.discarded) {
    // Wake up discarded tab
    await chrome.tabs.reload(candidate.id);
    await new Promise((r) => setTimeout(r, 2500));
    candidate = await chrome.tabs.get(candidate.id);
  }

  return candidate;
}

async function syncFlowTabIdentity() {
  try {
    const tabs = await chrome.tabs.query({ url: FLOW_URL_MATCHERS });
    if (!tabs.length) return;

    const targetTab = tabs[0];
    const requestId = crypto.randomUUID();
    const result = await chrome.tabs.sendMessage(targetTab.id, {
      action: 'PROBE_IDENTITY',
      requestId,
    });

    if (result?.email) {
      const emailChanged = result.email !== accountEmail;
      accountEmail = result.email;
      const detectedPlanTier = result.planTier || 'PRO';
      const detectedPlanName = result.planName || 'Google One AI Premium (Gemini Advanced)';

      await chrome.storage.local.set({
        accountEmail,
        planTier: detectedPlanTier,
        planName: detectedPlanName,
      });

      if (emailChanged) {
        appendLog('IDENT', `Identified profile account: ${accountEmail} [${detectedPlanName}]`);
      }

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'UPDATE_IDENTITY',
            workerId,
            accountEmail,
            planTier: detectedPlanTier,
            planName: detectedPlanName,
            verifiedFromGoogle: true,
          })
        );
      }
    }
  } catch {
    /* Tab still booting or content script not ready */
  }
}

// ─── Batch RPC Execution ───────────────────────────────────

async function sendMessageToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    if (err.message && err.message.includes('Receiving end does not exist')) {
      console.warn(`[StackVid Worker] Content script missing on tab ${tabId}. Re-injecting...`);
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          files: ['flow-guard.js', 'recaptcha_enterprise.js', 'recaptcha__en.js', 'flow-bridge.js'],
        });
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content.js'],
        });
        await new Promise((r) => setTimeout(r, 500));
        return await chrome.tabs.sendMessage(tabId, message);
      } catch (injectErr) {
        console.error('[StackVid Worker] Failed to re-inject content script:', injectErr);
      }
    }
    throw err;
  }
}

async function handleBatchRpc(msg) {
  const { id, params } = msg;
  const { rpcid, match } = params;
  let { freq, captchaAction } = params;

  if (!rpcid || !freq) {
    sendResponse({ id, status: 400, error: 'MISSING_RPC_OR_FREQ' });
    return;
  }

  activeJobs++;
  metrics.totalCount++;
  const logEntry = appendLog(rpcid, `Execute RPC [${rpcid}]...`, 'RUNNING');

  try {
    const tab = await ensureFlowTab();
    if (!tab) {
      throw new Error('UNABLE_TO_ACQUIRE_FLOW_TAB');
    }

    // Step 1: Mint Captcha Token if needed
    if (captchaAction) {
      const captchaReqId = crypto.randomUUID();
      const mintResult = await sendMessageToTab(tab.id, {
        action: 'MINT_CAPTCHA',
        requestId: captchaReqId,
        payload: { captchaAction },
      });

      if (!mintResult?.token) {
        throw new Error(mintResult?.error || 'CAPTCHA_MINT_FAILED');
      }

      freq = freq.split(CAPTCHA_SLOT).join(mintResult.token);
    }

    // Step 2: Execute Batch RPC in page context
    const rpcReqId = crypto.randomUUID();
    const rpcResult = await sendMessageToTab(tab.id, {
      action: 'EXECUTE_BATCH_RPC',
      requestId: rpcReqId,
      payload: { rpcid, freq, match },
    });

    if (rpcResult?.error) {
      throw new Error(rpcResult.error);
    }

    metrics.successCount++;
    updateLog(logEntry.id, 'SUCCESS', `200 OK (${rpcResult.matched ? 'Matched' : 'Full'})`);
    sendResponse({ id, status: rpcResult.status || 200, data: rpcResult.text });
  } catch (err) {
    metrics.failCount++;
    metrics.lastError = err.message || 'RPC_FAILED';
    updateLog(logEntry.id, 'FAILED', err.message || 'Execution error');
    sendResponse({ id, status: 502, error: err.message || 'RPC_FAILED' });
  } finally {
    activeJobs = Math.max(0, activeJobs - 1);
    await chrome.storage.local.set({ metrics });
    broadcastState();
  }
}

async function handleUploadVideo(msg) {
  const { id, params } = msg;
  const logEntry = appendLog(
    'UPLOAD_VIDEO',
    `Uploading ${params.fileName || 'video.mp4'} (${Math.round(params.videoBase64?.length / 1024)} KB) to ${params.projectId}...`
  );
  activeJobs++;
  broadcastState();

  try {
    // 1. Decode Base64 to binary Uint8Array / Blob directly in Service Worker
    const binaryString = atob(params.videoBase64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: 'video/mp4' });
    const rawDurationMs = Math.round((params.durationSeconds || 15) * 1000);
    // Google Flow Scotty hard-caps video upload trim to 30,000ms (30s). Values > 30000 cause HTTP 500.
    const durationMs = Math.max(1000, Math.min(30000, rawDurationMs));

    const tab = await ensureFlowTab();
    let targetProjectId = params.projectId;
    const tabProjMatch = tab?.url?.match(/\/project\/([0-9a-fA-F-]{36})/);
    if (tabProjMatch && (!targetProjectId || targetProjectId.startsWith('v2v_') || !targetProjectId.includes('-'))) {
      targetProjectId = tabProjMatch[1];
    }

    // Step 1: Start Resumable Upload Handshake
    const startUrl = `https://flow.google.com/upload/v1/flow/upload/video/${encodeURIComponent(targetProjectId)}`;
    const startRes = await fetch(startUrl, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        slug: params.fileName || 'video.mp4',
        'x-goog-upload-command': 'start',
        'x-goog-upload-header-content-length': String(blob.size),
        'x-goog-upload-protocol': 'resumable',
        'x-trim-start': '0',
        'x-trim-end': String(durationMs),
      },
    });

    if (!startRes.ok) {
      const txt = await startRes.text().catch(() => '');
      throw new Error(`Upload handshake failed: HTTP ${startRes.status} ${txt}`);
    }

    const uploadUrl = startRes.headers.get('x-goog-upload-url');
    if (!uploadUrl) {
      throw new Error('Upload handshake returned no x-goog-upload-url header');
    }

    // Step 2: Upload Video Binary
    const uploadHeaders = {
      'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
      slug: params.fileName || 'video.mp4',
      'x-goog-upload-command': 'upload, finalize',
      'x-goog-upload-offset': '0',
      'x-trim-start': '0',
      'x-trim-end': String(durationMs),
    };

    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      credentials: 'include',
      headers: uploadHeaders,
      body: blob,
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text().catch(() => '');
      throw new Error(`Upload video binary failed: HTTP ${uploadRes.status} ${errText}`.trim());
    }

    const uploadJson = await uploadRes.json();
    const mediaId = uploadJson.mediaId || uploadJson.media?.name;
    if (!mediaId) {
      throw new Error(`Upload response carried no mediaId: ${JSON.stringify(uploadJson)}`);
    }

    // Step 3: Register media with RPC iVqlKd (using handleBatchRpc which runs in tab)
    try {
      const tab = await ensureFlowTab();
      const rpcReqId = crypto.randomUUID();
      await chrome.tabs.sendMessage(tab.id, {
        action: 'EXECUTE_BATCH_RPC',
        requestId: rpcReqId,
        payload: {
          rpcid: 'iVqlKd',
          freq: JSON.stringify([[["iVqlKd", JSON.stringify([mediaId, [], [Math.round(params.durationSeconds || 15)]]), null, "generic"]]]),
        },
      });
    } catch (e) {
      console.warn('[StackVid] iVqlKd registration warning:', e);
    }

    metrics.successCount++;
    updateLog(logEntry.id, 'SUCCESS', `Uploaded video mediaId: ${mediaId}`);
    sendResponse({ id, status: 200, mediaId });
  } catch (err) {
    metrics.failCount++;
    metrics.lastError = err.message || 'UPLOAD_FAILED';
    updateLog(logEntry.id, 'FAILED', err.message || 'Upload error');
    sendResponse({ id, status: 502, error: err.message || 'UPLOAD_FAILED' });
  } finally {
    activeJobs = Math.max(0, activeJobs - 1);
    await chrome.storage.local.set({ metrics });
    broadcastState();
  }
}

// ─── Logging & Telemetry ───────────────────────────────────

function appendLog(type, message, status = 'INFO') {
  const entry = {
    id: crypto.randomUUID(),
    time: new Date().toLocaleTimeString(),
    type,
    message,
    status,
  };
  executionLogs.unshift(entry);
  if (executionLogs.length > 50) executionLogs.pop();
  broadcastLogs();
  return entry;
}

function updateLog(id, status, message) {
  const item = executionLogs.find((l) => l.id === id);
  if (item) {
    item.status = status;
    if (message) item.message = message;
    broadcastLogs();
  }
}

function broadcastState() {
  chrome.runtime
    .sendMessage({
      type: 'STATE_UPDATE',
      state: {
        workerId,
        accountEmail,
        connectionState,
        activeJobs,
        metrics,
      },
    })
    .catch(() => {});
}

function broadcastLogs() {
  chrome.runtime
    .sendMessage({
      type: 'LOGS_UPDATE',
      logs: executionLogs,
    })
    .catch(() => {});
}

// Allow popup/side panel to query initial state
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.action === 'GET_WORKER_STATUS') {
    reply({
      workerId,
      accountEmail,
      connectionState,
      activeJobs,
      metrics,
      logs: executionLogs,
    });
  }
  if (msg.action === 'RECONNECT') {
    connectFlowService(true);
    reply({ ok: true });
  }
  if (msg.action === 'CLEAR_LOGS') {
    executionLogs = [];
    broadcastLogs();
    reply({ ok: true });
  }
});
