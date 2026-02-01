/**
 * Simple Authentication for Admin Dashboard
 * Uses password-based authentication with session storage
 */

const AUTH_SESSION_KEY = 'admin_auth_session';
const SESSION_DURATION = 24 * 60 * 60 * 1000; // 24 hours

export interface AuthSession {
  authenticated: boolean;
  expiresAt: number;
}

/**
 * Verify admin password
 */
export function verifyAdminPassword(password: string): boolean {
  const adminPassword = process.env.NEXT_PUBLIC_ADMIN_PASSWORD;

  if (!adminPassword) {
    console.error('NEXT_PUBLIC_ADMIN_PASSWORD not set in environment');
    return false;
  }

  return password === adminPassword;
}

/**
 * Create authentication session
 */
export function createAuthSession(): void {
  if (typeof window === 'undefined') return;

  const session: AuthSession = {
    authenticated: true,
    expiresAt: Date.now() + SESSION_DURATION,
  };

  localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
}

/**
 * Check if user is authenticated
 */
export function isAuthenticated(): boolean {
  if (typeof window === 'undefined') return false;

  try {
    const sessionData = localStorage.getItem(AUTH_SESSION_KEY);
    if (!sessionData) return false;

    const session: AuthSession = JSON.parse(sessionData);

    // Check if session is expired
    if (Date.now() > session.expiresAt) {
      clearAuthSession();
      return false;
    }

    return session.authenticated;
  } catch (error) {
    console.error('Error checking authentication:', error);
    return false;
  }
}

/**
 * Clear authentication session (logout)
 */
export function clearAuthSession(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(AUTH_SESSION_KEY);
}

/**
 * Get session expiry time
 */
export function getSessionExpiry(): Date | null {
  if (typeof window === 'undefined') return null;

  try {
    const sessionData = localStorage.getItem(AUTH_SESSION_KEY);
    if (!sessionData) return null;

    const session: AuthSession = JSON.parse(sessionData);
    return new Date(session.expiresAt);
  } catch (error) {
    return null;
  }
}
