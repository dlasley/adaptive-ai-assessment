/**
 * Superuser Override Utility
 *
 * Manages superuser status override via sessionStorage.
 *
 * Usage:
 * - Keyboard shortcut: Ctrl+Shift+S (or Cmd+Shift+S on Mac) to toggle
 * - Console: window.setSuperuser(true/false)
 * - Override persists in sessionStorage until tab is closed
 */

const STORAGE_KEY = 'superuser_override';
export const SUPERUSER_CHANGE_EVENT = 'superuser-override-changed';

type SuperuserOverride = boolean | null;

/**
 * Get the current superuser override value
 * Returns null if no override is set
 */
export function getSuperuserOverride(): SuperuserOverride {
  if (typeof window === 'undefined') {
    console.log('🔍 getSuperuserOverride: window undefined (SSR), returning null');
    return null;
  }

  const stored = sessionStorage.getItem(STORAGE_KEY);
  const result = stored === 'true' ? true : stored === 'false' ? false : null;
  console.log(`🔍 getSuperuserOverride: stored="${stored}", returning ${result}`);
  return result;
}

/**
 * Set the superuser override value
 */
export function setSuperuserOverride(value: boolean): void {
  if (typeof window === 'undefined') return;
  const stringValue = value ? 'true' : 'false';
  console.log(`🔧 setSuperuserOverride: setting to "${stringValue}"`);
  sessionStorage.setItem(STORAGE_KEY, stringValue);
  // Verify it was written
  const verify = sessionStorage.getItem(STORAGE_KEY);
  console.log(`🔧 setSuperuserOverride: verified storage contains "${verify}"`);
}

/**
 * Clear the superuser override (revert to DB-based status)
 */
export function clearSuperuserOverride(): void {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem(STORAGE_KEY);
}

/**
 * Toggle superuser override on/off
 * Returns the new state and dispatches a custom event for React components to listen to
 */
export function toggleSuperuserOverride(): boolean {
  const current = getSuperuserOverride();
  const newValue = current !== true; // If null or false, enable; if true, disable
  setSuperuserOverride(newValue);
  console.log(`🔬 Superuser mode ${newValue ? 'ENABLED' : 'DISABLED'} (toggle)`);

  // Dispatch custom event so React components can update their state
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SUPERUSER_CHANGE_EVENT, { detail: { enabled: newValue } }));
  }

  return newValue;
}

/**
 * Initialize global console helper: window.setSuperuser(true/false)
 * Call this once on app initialization
 */
export function initGlobalSuperuserHelper(): void {
  if (typeof window === 'undefined') return;

  // Expose setSuperuser globally for console access
  (window as Window & { setSuperuser?: (value: boolean) => void }).setSuperuser = (value: boolean) => {
    setSuperuserOverride(value);
    console.log(`🔬 Superuser mode ${value ? 'ENABLED' : 'DISABLED'} via console`);

    // Dispatch custom event so React components can update their state
    window.dispatchEvent(new CustomEvent(SUPERUSER_CHANGE_EVENT, { detail: { enabled: value } }));
  };

  console.log('💡 Superuser helper available: window.setSuperuser(true/false)');
}

/**
 * Initialize keyboard shortcut for toggling superuser mode
 * Ctrl+Shift+S to toggle
 */
export function initSuperuserKeyboardShortcut(): () => void {
  if (typeof window === 'undefined') return () => {};

  const handleKeydown = (event: KeyboardEvent) => {
    // Ctrl+Shift+S (or Cmd+Shift+S on Mac)
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      const newState = toggleSuperuserOverride();

      // Show a brief visual notification
      showSuperuserNotification(newState);
    }
  };

  window.addEventListener('keydown', handleKeydown);

  // Return cleanup function
  return () => window.removeEventListener('keydown', handleKeydown);
}

/**
 * Show a brief notification when superuser mode is toggled
 */
function showSuperuserNotification(enabled: boolean): void {
  // Remove any existing notification
  const existing = document.getElementById('superuser-notification');
  if (existing) existing.remove();

  // Create notification element
  const notification = document.createElement('div');
  notification.id = 'superuser-notification';
  notification.innerHTML = `🔬 Superuser: ${enabled ? 'ON' : 'OFF'}`;
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    padding: 12px 20px;
    background: ${enabled ? '#7c3aed' : '#6b7280'};
    color: white;
    border-radius: 8px;
    font-weight: 600;
    font-size: 14px;
    z-index: 9999;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    transition: opacity 0.3s ease;
  `;

  document.body.appendChild(notification);

  // Fade out and remove after 2 seconds
  setTimeout(() => {
    notification.style.opacity = '0';
    setTimeout(() => notification.remove(), 300);
  }, 4000);
}
