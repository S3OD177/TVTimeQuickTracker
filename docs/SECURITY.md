# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.1.x   | :white_check_mark: |
| < 1.1   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in TV Time Quick Tracker, please report it by emailing:

**salbinzaid@gmail.com**

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fixes (optional)

**Response Time**: We aim to respond within 48 hours and provide a fix within 7 days for critical issues.

## Security Measures

### 1. Authentication & Authorization

- **Token Storage**: User authentication tokens are stored securely in `chrome.storage.local`, which is encrypted by Chrome
- **No Password Persistence**: User passwords are never stored; only authentication tokens
- **Automatic Session Cleanup**: Sessions are cleared on authentication failure (401/403 responses)
- **Bearer Token Preferred**: Bearer tokens are used instead of Basic Auth when available

### 2. Data Protection

- **HTTPS Only**: All network communications use HTTPS
- **Minimal Permissions**: Extension requests only necessary Chrome permissions
- **No Third-Party Tracking**: No analytics, advertising, or tracking SDKs
- **Local Storage Only**: No backend server; all data stored locally on user's device

### 3. Code Security

- **XSS Prevention**: All user input is properly escaped before DOM insertion
- **No Dynamic Code Execution**: No use of `eval()`, `new Function()`, or similar
- **Content Security Policy**: CSP configured to restrict script sources
- **Input Validation**: All API responses are validated before use

### 4. API Security

- **Read-Only Public API**: Search functionality uses a read-only public API key
- **Authenticated Endpoints**: All write operations require user authentication
- **Rate Limiting**: Server-side rate limiting protects against abuse
- **No Sensitive Data Exposure**: Public API key only grants access to search, not user data

## Known Security Considerations

### Search API Key

The extension includes a search API key (`SEARCH_API_KEY`) in the source code. This is a known limitation of browser extensions:

**Why it's acceptable:**
- The key is for **read-only search functionality only**
- The TV Time API has **server-side rate limiting**
- **No sensitive user data** is accessible with this key
- User **authentication is required** for all write operations (marking watched, following shows, etc.)

**Mitigation:**
- The key is documented as public and read-only
- TV Time's server enforces rate limits
- User operations require separate authentication
- Extension is open source, allowing community security review

**Alternative considered:**
- Proxy server: Would add complexity and hosting costs without significant security benefit for read-only search

## Security Best Practices for Users

1. **Keep Extension Updated**: Always use the latest version from Chrome Web Store
2. **Use Strong Password**: Use a strong, unique password for your TV Time account
3. **Review Permissions**: Before installing, review the extension's requested permissions
4. **Logout When Done**: Logout if using a shared computer
5. **Report Issues**: Report any suspicious behavior immediately

## Security Audit History

| Date | Auditor | Findings | Status |
|------|---------|----------|--------|
| 2026-02-11 | Internal | API key documentation, CSP added, email updated | ✅ Resolved |
| 2026-02-11 | Internal | Auth hardening, HTML escaping | ✅ Resolved |

## Dependency Security

This extension has **zero external dependencies** (no npm packages, no third-party libraries), which significantly reduces the attack surface.

## Vulnerability Disclosure Timeline

1. **Day 0**: Vulnerability reported via email
2. **Day 0-2**: Initial response and confirmation
3. **Day 2-7**: Investigation and fix development
4. **Day 7-14**: Testing and deployment
5. **Day 14+**: Public disclosure (if applicable) after users have time to update

## Security Contacts

- **Email**: salbinzaid@gmail.com
- **GitHub Issues**: For non-sensitive security improvements
- **Private Email**: For sensitive vulnerability reports

## License Considerations

This project is shared for contribution only. Unauthorized duplication or deployment may introduce security risks. See LICENSE for details.

---

Last Updated: February 11, 2026
