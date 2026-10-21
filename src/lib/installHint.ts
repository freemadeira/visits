// iOS Safari has no beforeinstallprompt API — there's no programmatic "Add to Home
// Screen" button possible, only a manual Share-sheet action. This detects "running in
// iOS Safari, not yet added to the home screen" so the UI can point the user at it.

const LS_DISMISSED = 'visit-tracker.install-hint-dismissed';

export function shouldShowIosInstallHint(): boolean {
  if (typeof navigator === 'undefined') return false;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (!isIos || isStandalone) return false;
  try {
    return localStorage.getItem(LS_DISMISSED) !== '1';
  } catch {
    return true;
  }
}

export function dismissIosInstallHint() {
  try {
    localStorage.setItem(LS_DISMISSED, '1');
  } catch {
    /* hint will just show again next time */
  }
}
