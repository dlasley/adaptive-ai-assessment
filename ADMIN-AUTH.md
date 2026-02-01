# Admin Authentication Guide

## Overview

The admin dashboard is now protected with password authentication. Only authorized users with the admin password can access student data and progress reports.

## Security Features

- ✅ Password-protected login
- ✅ 24-hour session timeout
- ✅ Logout functionality
- ✅ Automatic redirect to login if unauthenticated
- ✅ Session stored in browser localStorage

## Setup Instructions

### 1. Set Your Admin Password

Edit your `.env.local` file and change the admin password:

```bash
# Change this to a strong password
NEXT_PUBLIC_ADMIN_PASSWORD=YourSecurePasswordHere
```

**Important Security Notes:**
- Use a strong, unique password (mix of letters, numbers, symbols)
- Never commit `.env.local` to git (it's already in `.gitignore`)
- Change the default password immediately
- Don't share the password in plain text

### 2. Restart the Development Server

After changing the password, restart the server:

```bash
npm run dev
```

## How to Use

### Login

1. Navigate to http://localhost:3000/admin
2. You'll be automatically redirected to the login page
3. Enter your admin password
4. Click "Login"

### Access Admin Dashboard

Once logged in, you can:
- View all student progress
- Search and filter students
- Add admin labels to identify students
- Export data to CSV
- View detailed analytics

### Logout

Click the "🔓 Logout" button in the top-right corner of the admin dashboard.

## Session Management

- Sessions last for **24 hours** from login
- After 24 hours, you'll need to log in again
- Logging out immediately clears your session
- Session is stored in browser localStorage

## Access URLs

- **Login:** http://localhost:3000/admin/login
- **Dashboard:** http://localhost:3000/admin (requires authentication)

## Security Recommendations

### For Development (Current Setup)
✅ Password stored in environment variable
✅ Session-based authentication
✅ Automatic session expiry

### For Production (Recommended Upgrades)
Consider implementing:
- Server-side session management with httpOnly cookies
- Password hashing (bcrypt)
- Rate limiting on login attempts
- HTTPS encryption
- Two-factor authentication (2FA)
- OAuth integration (Google, Microsoft)
- Role-based access control for multiple teachers

## Troubleshooting

### Can't Login?

1. **Check password:** Ensure you're using the exact password from `.env.local`
2. **Restart server:** Changes to `.env.local` require server restart
3. **Clear browser data:** Clear localStorage if experiencing issues
   - Open browser DevTools (F12)
   - Go to Application > Local Storage
   - Delete `admin_auth_session`

### Session Expired?

Simply login again at `/admin/login`. Sessions expire after 24 hours for security.

### Password Not Working?

1. Verify `NEXT_PUBLIC_ADMIN_PASSWORD` is set in `.env.local`
2. Make sure there are no extra spaces in the password
3. Restart the development server after changes

## Future Enhancements

Possible improvements for production use:

1. **Database-backed authentication** - Store user credentials in Supabase
2. **Supabase Auth integration** - Use Supabase's built-in authentication
3. **NextAuth.js** - Full OAuth provider support (Google, GitHub, etc.)
4. **Multi-user support** - Allow multiple teachers with different permissions
5. **Audit logging** - Track who accessed what and when
6. **Password reset** - Email-based password recovery

## Current Limitations

⚠️ **Client-side password verification** - Password is checked on the client side. For production, move verification to server-side API routes.

⚠️ **localStorage sessions** - Sessions stored in browser can be cleared. For production, use httpOnly cookies or server-side sessions.

⚠️ **Plain text password** - Password stored in environment variable. For production, use password hashing.

Despite these limitations, this setup provides reasonable security for:
- Local development
- Single-teacher usage
- Non-public deployments
- Internal school networks

---

**Remember:** Change the default password immediately and never share it!
