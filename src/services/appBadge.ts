/**
 * The number of moves due on the installed app's icon (Badging API). It's set whenever the app is open
 * and the count changes, so it can be behind while the app is closed. iPhone, iPad and Mac web apps
 * only show a badge once the app may send notifications — Chess Prep never sends any.
 */
export const badgeSupported = (): boolean => typeof navigator !== 'undefined' && 'setAppBadge' in navigator;

export function setDueBadge(n: number) {
  if (!badgeSupported()) return;
  (n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {
    /* not allowed (yet): nothing to show */
  });
}

export type BadgePermission = 'unsupported' | 'ask' | 'granted' | 'denied';

/** Whether the badge can show, or still needs the notification permission (Apple's web apps). */
export function badgePermission(): BadgePermission {
  if (!badgeSupported()) return 'unsupported';
  if (typeof Notification === 'undefined') return 'granted';
  return Notification.permission === 'default' ? 'ask' : Notification.permission;
}

/** Ask for the permission the badge needs (call from a tap). */
export async function allowBadge(): Promise<BadgePermission> {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') await Notification.requestPermission();
  return badgePermission();
}

/** Opened from the home screen (an installed app) rather than in a browser tab. */
export const isInstalled = (): boolean =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);
