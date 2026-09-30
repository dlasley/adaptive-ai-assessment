/**
 * Client-side admin authentication helpers
 * Calls server-side API routes — auth state lives in HttpOnly cookies
 */

/**
 * Login with admin password
 * Server verifies password and sets HttpOnly session cookie
 */
export async function loginAdmin(password: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    if (res.ok) {
      return { success: true };
    }

    if (res.status === 429) {
      return { success: false, error: 'Too many attempts. Please wait before trying again.' };
    }

    const data = await res.json();
    return { success: false, error: data.error || 'Login failed' };
  } catch {
    return { success: false, error: 'Network error. Please try again.' };
  }
}

/**
 * Verify current session via server cookie
 */
export async function verifySession(): Promise<boolean> {
  try {
    const res = await fetch('/api/admin/verify');
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Logout — expires the server cookie
 */
export async function logoutAdmin(): Promise<void> {
  try {
    await fetch('/api/admin/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    // Best effort
  }
}
