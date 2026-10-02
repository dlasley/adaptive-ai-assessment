# Security policy

To report a vulnerability, use GitHub's private vulnerability reporting: open this repository's
Security tab and choose "Report a vulnerability". Please do not open a public issue or pull request
for a suspected vulnerability.

Include what you found, how to reproduce it, and the version or commit you tested. This is a
personal project maintained by one person, so there is no guaranteed response time.

Do not include real student data, credentials, or API keys in a report.

## Scope

Student data is anonymous study codes and quiz history. A study code is the only student
credential, so anyone who learns a code can act as that student. The admin session is a shared
password and a stateless signed cookie: it lasts up to 24 hours and cannot be revoked before then
except by rotating `ADMIN_SESSION_SECRET`.
