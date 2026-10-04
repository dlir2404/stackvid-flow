/**
 * @file side_panel.js
 * @description StackVid Flow Side Panel Workbench Controller.
 *
 * (c) 2026 StackVid Automation. Clean-Room Implementation.
 */

document.addEventListener('DOMContentLoaded', () => {
  const elEmail = document.getElementById('side-account-email');
  const elConnDot = document.getElementById('side-conn-dot');
  const elConnStatus = document.getElementById('side-conn-status');
  const elLogsContainer = document.getElementById('side-logs-container');
  const elTestOutput = document.getElementById('test-output');

  const btnTestMint = document.getElementById('btn-test-mint');
  const btnReconnect = document.getElementById('btn-side-reconnect');
  const btnClear = document.getElementById('btn-side-clear');

  function renderState(state) {
    if (!state) return;
    if (elEmail) {
      elEmail.textContent = state.accountEmail || 'NO_FLOW_TAB_DETECTED';
      elEmail.style.color = state.accountEmail ? '#06b6d4' : '#a1a1aa';
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
      elLogsContainer.innerHTML = '<div class="log-empty">No events yet.</div>';
      return;
    }
    elLogsContainer.innerHTML = logs
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

  btnReconnect?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'RECONNECT' });
  });

  btnClear?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'CLEAR_LOGS' }, () => {
      renderLogs([]);
    });
  });

  btnTestMint?.addEventListener('click', async () => {
    btnTestMint.disabled = true;
    elTestOutput.textContent = 'Probing active Flow tab and minting token...';

    const tabs = await chrome.tabs.query({ url: ['https://flow.google.com/*', 'https://labs.google/fx/tools/flow*'] });
    if (!tabs.length) {
      elTestOutput.textContent = 'ERROR: No active flow.google.com tab found in this Chrome profile.';
      btnTestMint.disabled = false;
      return;
    }

    const testId = crypto.randomUUID();
    chrome.tabs.sendMessage(
      tabs[0].id,
      {
        action: 'MINT_CAPTCHA',
        requestId: testId,
        payload: { captchaAction: 'VIDEO_GENERATION' },
      },
      (response) => {
        btnTestMint.disabled = false;
        if (chrome.runtime.lastError) {
          elTestOutput.textContent = `ERROR: ${chrome.runtime.lastError.message}`;
          return;
        }
        if (response?.error) {
          elTestOutput.textContent = `MINT FAILED: ${response.error}`;
        } else if (response?.token) {
          elTestOutput.textContent = `SUCCESS! Minted token via: ${response.method}\nToken prefix: ${response.token.slice(0, 40)}... (length: ${response.token.length})`;
        } else {
          elTestOutput.textContent = 'Received empty response.';
        }
      }
    );
  });
});
