/**
 * @file background.js
 * @description StackVid Flow Background Service Worker (MV3).
 * Manages Flow tab in the current profile, connects to Flow Service (ws://127.0.0.1:9222),
 * and coordinates pristine token minting & batchexecute RPC relays.
 *
 * (c) 2026 StackVid Automation. Clean-Room Implementation.
 */

const FLOW_SERVICE_WS = 'ws://127.0.0.1:9222';
const FLOW_TAB_URL = 'https://flow.google.com/';
const FLOW_URL_MATCHERS = [
  'https://flow.google.com/*',
  'https://labs.google/fx/tools/flow*',
  'https://labs.google/fx/*/tools/flow*',
];
const CAPTCHA_SLOT = '__CAPTCHA__';

let ws = null;
let workerId = null;
let accountEmail = null;
let connectionState = 'DISCONNECTED'; // DISCONNECTED | CONNECTING | CONNECTED
let activeJobs = 0;
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

function connectFlowService() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  setConnectionState('CONNECTING');

  try {
    ws = new WebSocket(FLOW_SERVICE_WS);

    ws.onopen = () => {
      setConnectionState('CONNECTED');
      appendLog('SYS', 'Connected to StackVid Flow Service');
      ws.send(
        JSON.stringify({
          type: 'REGISTER_WORKER',
          workerId,
          accountEmail,
          status: activeJobs > 0 ? 'BUSY' : 'IDLE',
          activeJobs,
          timestamp: Date.now(),
        })
      );
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.method === 'batch_rpc') {
          await handleBatchRpc(msg);
        } else if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
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
  let candidate = tabs.find((t) => !t.discarded) || tabs[0];

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

    if (result?.email && result.email !== accountEmail) {
      accountEmail = result.email;
      await chrome.storage.local.set({ accountEmail });
      appendLog('IDENT', `Identified profile account: ${accountEmail}`);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'UPDATE_IDENTITY', workerId, accountEmail }));
      }
    }
  } catch {
    /* Tab still booting or content script not ready */
  }
}

// ─── Batch RPC Execution ───────────────────────────────────

async function handleBatchRpc(msg) {
  const { id, params } = msg;
  const { rpcid, captchaAction, match } = params || {};
  let freq = params?.freq;

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
      const mintResult = await chrome.tabs.sendMessage(tab.id, {
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
    const rpcResult = await chrome.tabs.sendMessage(tab.id, {
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
    connectFlowService();
    reply({ ok: true });
  }
  if (msg.action === 'CLEAR_LOGS') {
    executionLogs = [];
    broadcastLogs();
    reply({ ok: true });
  }
});
