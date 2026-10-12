export function isNapCatAlreadyLoggedError(value) {
  const message = String(value?.message ?? value ?? '');
  return /QQ\s+Is\s+Logined|already\s+logged|已经登录/i.test(message);
}
