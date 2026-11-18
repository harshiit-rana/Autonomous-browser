/**
 * Project Aegis - Themed Accessible Error Page Generator (Issue #169 - [BRW-02])
 * 
 * Provides native, styled, accessible HTML error pages preventing blank views
 * on network failures, SSL errors, timeouts, crashes, or policy blocks.
 */

export interface ErrorPageContext {
  errorCode: string;
  errorDescription: string;
  failedUrl: string;
  policyReason?: string;
}

export class ErrorPageRenderer {
  public static renderErrorPage(context: ErrorPageContext): string {
    const { errorCode, errorDescription, failedUrl, policyReason } = context;

    let title = 'Unable to Load Page';
    let heading = 'Navigation Error';
    let suggestion = 'Please check your internet connection and try reloading the page.';
    let showReload = true;
    let iconSvg = `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

    switch (errorCode) {
      case 'ERR_NAME_NOT_RESOLVED':
        title = 'Server Not Found';
        heading = 'DNS Resolution Failed';
        suggestion = 'The server IP address could not be resolved. Check the URL spelling or your DNS settings.';
        break;

      case 'ERR_INTERNET_DISCONNECTED':
        title = 'You are Offline';
        heading = 'No Internet Connection';
        suggestion = 'Check your network cables, Wi-Fi connection, or router status.';
        break;

      case 'ERR_CONNECTION_REFUSED':
        title = 'Connection Refused';
        heading = 'Server Refused Connection';
        suggestion = 'The host refused the connection. If this is a local server, ensure the dev process is running.';
        break;

      case 'ERR_CONNECTION_TIMED_OUT':
        title = 'Connection Timed Out';
        heading = 'Host Took Too Long to Respond';
        suggestion = 'The server is unreachable or taking too long. Verify the server is online.';
        break;

      case 'ERR_CERT_COMMON_NAME_INVALID':
      case 'ERR_CERT_AUTHORITY_INVALID':
        title = 'Security Warning: Invalid Certificate';
        heading = 'Your Connection is Not Private';
        suggestion = 'The website certificate is invalid or untrusted. Attackers might be trying to steal your credentials.';
        iconSvg = `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`;
        break;

      case 'ERR_TOO_MANY_REDIRECTS':
        title = 'Redirect Loop';
        heading = 'Too Many Redirects';
        suggestion = 'The page redirected you too many times. Try clearing cookies for this site.';
        break;

      case 'ERR_BLOCKED_BY_POLICY':
        title = 'Blocked by Security Policy';
        heading = 'Action Denied by Aegis Policy Engine';
        suggestion = policyReason || 'This destination or action violates your enterprise security rules or origin scope.';
        showReload = false;
        iconSvg = `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
        break;

      case 'ERR_CRASHED':
        title = 'Tab Crashed';
        heading = 'Page Unresponsive or Crashed';
        suggestion = 'The renderer process encountered an unhandled exception or ran out of memory.';
        break;
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - Autonomous Browser</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --border: #334155;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
    }
    body {
      margin: 0;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      background-color: var(--bg);
      color: var(--text-main);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .error-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 36px;
      max-width: 540px;
      width: 90%;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
      text-align: center;
    }
    .icon { margin-bottom: 20px; }
    h1 { font-size: 22px; font-weight: 600; margin: 0 0 12px 0; }
    p { color: var(--text-muted); font-size: 14px; line-height: 1.6; margin: 0 0 20px 0; }
    .url-chip {
      background: rgba(0, 0, 0, 0.3);
      padding: 6px 12px;
      border-radius: 6px;
      font-family: monospace;
      font-size: 12px;
      word-break: break-all;
      margin-bottom: 24px;
      display: inline-block;
      border: 1px solid var(--border);
    }
    .actions { display: flex; gap: 12px; justify-content: center; }
    button {
      background: var(--primary);
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover { background: var(--primary-hover); }
    .btn-secondary {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-main);
    }
    .btn-secondary:hover { background: rgba(255, 255, 255, 0.05); }
    .details {
      margin-top: 24px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
      font-size: 11px;
      color: var(--text-muted);
      text-align: left;
    }
  </style>
</head>
<body>
  <div class="error-card" role="alert">
    <div class="icon">${iconSvg}</div>
    <h1>${escapeHtml(heading)}</h1>
    <div class="url-chip">${escapeHtml(failedUrl)}</div>
    <p>${escapeHtml(suggestion)}</p>
    <div class="actions">
      ${showReload ? '<button onclick="location.reload()">Reload Page</button>' : ''}
      <button class="btn-secondary" onclick="history.back()">Go Back</button>
    </div>
    <div class="details">
      <div><strong>Code:</strong> ${escapeHtml(errorCode)}</div>
      <div><strong>Reason:</strong> ${escapeHtml(errorDescription)}</div>
    </div>
  </div>
</body>
</html>`;
  }
}

function escapeHtml(str: string): string {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
