/**
 * @file popup.js
 * @description StackVid Flow HUD Controller.
 * Queries background status and subscribes to state and log broadcasts.
 *
 * (c) 2026 StackVid Automation. Clean-Room Implementation.
 */

document.addEventListener('DOMContentLoaded', () => {
  const elEmail = document.getElementById('val-account-email');
  const elWorkerId = document.getElementById('val-worker-id');
  const elConnDot = document.getElementById('conn-dot');
  const elConnStatus = document.getElementById('conn-status');
  const elActiveJobs = document.getElementById('val-active-jobs');
  const elSuccessCount = document.getElementById('val-success-count');
  const elFailCount = document.getElementById('val-fail-count');
  const elLogsContainer = document.getElementById('terminal-logs-container');

  const btnReconnect = document.getElementById('btn-reconnect');
  const btnOpenFlow = document.getElementById('btn-open-flow');
  const btnClearLogs = document.getElementById('btn-clear-logs');
  const btnSidePanel = document.getElementById('btn-side-panel');
  const selRunnerType = document.getElementById('sel-runner-type');
  const inputRunnerToken = document.getElementById('input-runner-token');
  const btnSaveToken = document.getElementById('btn-save-token');
  const elTokenMsg = document.getElementById('token-status-msg');
  const selServerEnv = document.getElementById('sel-server-env');

  // Load stored runner credentials & server env
  chrome.storage.local.get(['runnerType', 'runnerToken', 'flowServerWsUrl'], (stored) => {
    if (selRunnerType) selRunnerType.value = stored.runnerType || 'USER';
    if (inputRunnerToken && stored.runnerToken) inputRunnerToken.value = stored.runnerToken;
    if (selServerEnv) selServerEnv.value = stored.flowServerWsUrl || 'wss://api.stackvid.dev/fleet-ws';
  });

  selServerEnv?.addEventListener('change', () => {
    const flowServerWsUrl = selServerEnv.value;
    chrome.storage.local.set({ flowServerWsUrl }, () => {
      chrome.runtime.sendMessage({ action: 'RECONNECT' });
    });
  });

  btnSaveToken?.addEventListener('click', () => {
    const runnerType = selRunnerType?.value || 'USER';
    const runnerToken = inputRunnerToken?.value?.trim() || '';

    chrome.storage.local.set({ runnerType, runnerToken }, () => {
      if (elTokenMsg) {
        elTokenMsg.textContent = '✅ Đã lưu cấu hình! Đang kết nối lại...';
        elTokenMsg.style.color = '#10b981';
        setTimeout(() => {
          elTokenMsg.textContent = runnerType === 'USER' ? 'Chế độ User: lấy token tại /flow/fleet' : 'Chế độ System: dùng Admin Cluster Secret';
          elTokenMsg.style.color = '#71717a';
        }, 3000);
      }
      chrome.runtime.sendMessage({ action: 'RECONNECT' });
    });
  });

  function renderState(state) {
    if (!state) return;

    if (elEmail) {
      elEmail.textContent = state.accountEmail || 'NO_FLOW_TAB_DETECTED';
      elEmail.style.color = state.accountEmail ? '#06b6d4' : '#a1a1aa';
    }

    if (elWorkerId) {
      elWorkerId.textContent = state.workerId || '—';
    }

    if (elActiveJobs) {
      elActiveJobs.textContent = state.activeJobs ?? 0;
    }

    if (elSuccessCount) {
      elSuccessCount.textContent = state.metrics?.successCount ?? 0;
    }

    if (elFailCount) {
      elFailCount.textContent = state.metrics?.failCount ?? 0;
    }

    if (elConnDot && elConnStatus) {
      const conn = state.connectionState || 'DISCONNECTED';
      elConnStatus.textContent = conn;
      elConnDot.className = 'dot';
      if (conn === 'CONNECTED') {
        elConnDot.classList.add('dot-online');
      } else if (conn === 'CONNECTING') {
        elConnDot.classList.add('dot-waiting');
      } else {
        elConnDot.classList.add('dot-offline');
      }
    }
  }

  function renderLogs(logs) {
    if (!elLogsContainer) return;
    if (!logs || !logs.length) {
      elLogsContainer.innerHTML =
        '<div class="log-empty">No RPC events captured yet. Waiting for jobs...</div>';
      return;
    }

    elLogsContainer.innerHTML = logs
      .slice(0, 30)
      .map(
        (log) => `
        <div class="log-entry">
          <span class="log-time">[${log.time}]</span>
          <span class="log-type">${log.type}</span>
          <span class="log-msg ${log.status || ''}">${escapeHtml(log.message)}</span>
        </div>
      `
      )
      .join('');
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Initial State Query
  chrome.runtime.sendMessage({ action: 'GET_WORKER_STATUS' }, (resp) => {
    if (resp) {
      renderState(resp);
      renderLogs(resp.logs);
    }
  });

  // Listen to live broadcast updates
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'STATE_UPDATE' && msg.state) {
      renderState(msg.state);
    }
    if (msg.type === 'LOGS_UPDATE' && msg.logs) {
      renderLogs(msg.logs);
    }
  });

  // Action Buttons
  btnReconnect?.addEventListener('click', () => {
    btnReconnect.disabled = true;
    chrome.runtime.sendMessage({ action: 'RECONNECT' }, () => {
      setTimeout(() => {
        btnReconnect.disabled = false;
      }, 1500);
    });
  });

  btnOpenFlow?.addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({ url: ['https://flow.google.com/*'] });
    if (tabs.length) {
      chrome.tabs.update(tabs[0].id, { active: true });
    } else {
      chrome.tabs.create({ url: 'https://flow.google.com/' });
    }
  });

  btnClearLogs?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'CLEAR_LOGS' }, () => {
      renderLogs([]);
    });
  });

  btnSidePanel?.addEventListener('click', async () => {
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (currentTab?.windowId && chrome.sidePanel?.open) {
      chrome.sidePanel.open({ windowId: currentTab.windowId });
    }
  });
});
