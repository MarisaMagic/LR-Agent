// 深链（lr-agent://reset-password?token=...）解析与 pending token 暂存。
// 后端在 send_password_reset_email 中按 email_deep_link_base(默认 "lr-agent://")
// 生成 "lr-agent://reset-password?token=..." 链接。

const DEEP_LINK_SCHEME = 'lr-agent://';
const RESET_PATH_PREFIX = 'reset-password';

let pendingResetToken: string | null = null;

export function parseResetDeepLink(url: string): string | null {
  if (!url.startsWith(DEEP_LINK_SCHEME)) return null;

  const rest = url.slice(DEEP_LINK_SCHEME.length);
  if (!rest.startsWith(RESET_PATH_PREFIX)) return null;

  const queryIndex = rest.indexOf('?');
  if (queryIndex < 0) return null;

  const params = new URLSearchParams(rest.slice(queryIndex + 1));
  return params.get('token');
}

export function setPendingResetToken(token: string): void {
  pendingResetToken = token;
}

export function takePendingResetToken(): string | null {
  const token = pendingResetToken;
  pendingResetToken = null;
  return token;
}
