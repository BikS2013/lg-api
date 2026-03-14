# OAuth2 Authentication/Authorization for REST APIs - Comprehensive Research

**Research Date:** March 14, 2026
**Purpose:** Create a reusable implementation skill for OAuth2 API protection
**Target Platform:** Node.js/TypeScript REST APIs (Fastify, Express)

---

## Table of Contents

1. [OAuth2 Core Concepts](#oauth2-core-concepts)
2. [OAuth2 for API Protection (Resource Server)](#oauth2-for-api-protection-resource-server)
3. [Identity Providers](#identity-providers)
4. [Best Practices (OWASP, RFC, IETF)](#best-practices-owasp-rfc-ietf)
5. [Implementation Patterns for Node.js/TypeScript](#implementation-patterns-for-nodejstypescript)
6. [Common Pitfalls and Debugging](#common-pitfalls-and-debugging)
7. [Testing OAuth2 Protected APIs](#testing-oauth2-protected-apis)
8. [Assumptions & Scope](#assumptions--scope)
9. [References](#references)

---

## OAuth2 Core Concepts

### The 4 OAuth2 Grant Types

#### 1. Authorization Code Grant (Recommended for User Authentication)
**Use Case:** Web applications, mobile apps, SPAs with backend
**Security:** Most secure flow for user-facing applications
**Requirements:** PKCE is now mandatory (OAuth 2.1)

**Flow:**
1. User redirected to authorization server
2. User authenticates and grants consent
3. Authorization server redirects back with authorization code
4. Client exchanges code for access token (backend-to-backend)
5. Client uses access token to call APIs

**Key Points:**
- PKCE (Proof Key for Code Exchange) is required for all clients in OAuth 2.1
- Protects against authorization code injection attacks
- Short-lived authorization codes (typically 60 seconds)

#### 2. Client Credentials Grant (Machine-to-Machine)
**Use Case:** Service-to-service authentication, background jobs, daemon processes
**Security:** No user context, client authenticates with its own credentials
**Requirements:** Client ID + Client Secret

**Flow:**
1. Client sends client_id + client_secret to token endpoint
2. Authorization server validates credentials
3. Authorization server returns access token
4. Client uses access token to call APIs

**Key Points:**
- No user involvement
- Suitable for trusted server-side applications
- Access token represents the client, not a user
- Common in microservices architectures

**curl Example:**
```bash
curl --location --request POST 'https://auth.example.com/oauth/token' \
  --header 'Authorization: Basic base64(client_id:client_secret)' \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode 'scope=api.read api.write'
```

#### 3. Implicit Grant (DEPRECATED in OAuth 2.1)
**Status:** Removed from OAuth 2.1
**Reason:** Insecure - access tokens exposed in browser history, referrer headers
**Alternative:** Use Authorization Code + PKCE instead

#### 4. Resource Owner Password Credentials (DEPRECATED in OAuth 2.1)
**Status:** Removed from OAuth 2.1
**Reason:** Client handles user credentials directly, violating OAuth security principles
**Alternative:** Use Authorization Code + PKCE or federated identity

### Access Tokens vs Refresh Tokens

#### Access Tokens
- **Purpose:** Grant access to protected resources
- **Lifetime:** Short-lived (15 minutes to 1 hour recommended)
- **Format:** JWT (signed, optionally encrypted) or opaque tokens
- **Storage:** Memory preferred, secure HTTP-only cookies acceptable
- **Transmission:** Bearer token in Authorization header

#### Refresh Tokens
- **Purpose:** Obtain new access tokens without re-authentication
- **Lifetime:** Long-lived (days to weeks, or until revoked)
- **Security Requirements (OAuth 2.1):**
  - **Public clients:** Must be sender-constrained (DPoP) OR one-time use (rotation)
  - **Confidential clients:** Rotation recommended
- **Storage:** Secure server-side storage only, never in browser localStorage
- **Rotation:** New refresh token issued with each use, old one invalidated

**Refresh Token Rotation Benefits:**
- Limits window of opportunity for compromised tokens
- Enables reuse detection (security breach indicator)
- Forces regular token renewal

### Token Formats

#### JWT (JSON Web Token) - Structured Tokens
**Advantages:**
- Self-contained: includes claims (user ID, scopes, expiration)
- Verifiable locally using public keys (JWKS)
- No authorization server call needed for validation
- Ideal for distributed systems

**Structure:**
```
header.payload.signature
```

**Header Example:**
```json
{
  "alg": "RS256",
  "typ": "JWT",
  "kid": "key-id-2024"
}
```

**Payload Example:**
```json
{
  "iss": "https://auth.example.com",
  "sub": "user-123",
  "aud": "https://api.example.com",
  "exp": 1710420000,
  "iat": 1710416400,
  "scope": "read:messages write:messages"
}
```

**Critical Claims to Validate:**
- `iss` (issuer): Trusted authorization server
- `aud` (audience): Your API identifier
- `exp` (expiration): Token not expired
- `nbf` (not before): Token is valid now
- `scope` or `scp`: Authorized permissions
- `sub` (subject): User identifier

#### Opaque Tokens - Reference Tokens
**Advantages:**
- Can be revoked immediately
- No sensitive data exposed in token
- Centralized control

**Disadvantages:**
- Requires introspection endpoint call for every validation
- Higher latency
- Authorization server becomes bottleneck

**When to Use:**
- Real-time revocation is critical
- Zero-trust architectures
- External clients you don't fully trust

### Scopes and Permissions

**Scope Definition:**
- OAuth scopes limit access token privileges
- Represent "what" the client can do, not "who" can do it
- Coarse-grained authorization (entry-point control)

**Best Practices:**
1. **Principle of Least Privilege:** Request minimal scopes needed
2. **Incremental Authorization:** Request scopes when functionality is needed
3. **Clear Naming:** Use verb:resource pattern (e.g., `read:messages`, `write:orders`)
4. **Avoid Scope Explosion:** Start simple, add scopes as needed
5. **Document Scopes:** Clear descriptions for developers and users
6. **Fine-Grained Authorization:** Use claims/roles for object-level access control

**Example Scope Design:**
```yaml
# API: Order Management System
scopes:
  orders:read: "View orders"
  orders:write: "Create and update orders"
  orders:delete: "Delete orders"
  orders:admin: "Full order management including sensitive data"

  customers:read: "View customer information"
  customers:write: "Update customer information"
```

### PKCE (Proof Key for Code Exchange)

**Required for:** All clients using Authorization Code flow (OAuth 2.1)

**Purpose:** Prevents authorization code injection and interception attacks

**Flow:**
1. Client generates random `code_verifier` (43-128 characters)
2. Client creates `code_challenge` = BASE64URL(SHA256(code_verifier))
3. Client includes `code_challenge` and `code_challenge_method=S256` in authorization request
4. Authorization server stores `code_challenge` with the authorization code
5. Client includes `code_verifier` in token exchange request
6. Authorization server validates: BASE64URL(SHA256(code_verifier)) == stored code_challenge

**Node.js Implementation:**
```javascript
import crypto from 'crypto';

// Generate code verifier
function generateCodeVerifier() {
  return crypto.randomBytes(43).toString('hex');
}

// Generate code challenge
function generateCodeChallenge(verifier) {
  return crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64url');
}

const verifier = generateCodeVerifier();
const challenge = generateCodeChallenge(verifier);
```

**Security Benefits:**
- Protects public clients (SPAs, mobile apps) without client secrets
- Prevents authorization code interception on compromised devices
- Mitigates cross-site request forgery attacks

---

## OAuth2 for API Protection (Resource Server)

### How an API Validates Incoming Bearer Tokens

APIs acting as **resource servers** must validate access tokens on every request:

**Validation Steps:**
1. **Extract token** from Authorization header: `Bearer <token>`
2. **Decode token** (if JWT) or introspect (if opaque)
3. **Verify signature** (JWT) or validate with authorization server (opaque)
4. **Validate claims:**
   - Expiration (`exp`)
   - Not before (`nbf`)
   - Issuer (`iss`)
   - Audience (`aud`)
   - Scopes (`scope` or `scp`)
5. **Extract user context** from `sub` claim
6. **Authorize request** based on scopes and business rules

### Token Introspection vs Local JWT Validation

#### Local JWT Validation (Recommended for Performance)

**Advantages:**
- No network call after JWKS cache
- Fast and scalable
- Reduces dependency on authorization server
- Ideal for high-throughput APIs

**Disadvantages:**
- Cannot detect token revocation immediately
- Requires key rotation strategy
- Tokens valid until expiration even if revoked

**When to Use:**
- JWTs issued by trusted authorization server
- Short-lived access tokens (< 1 hour)
- High-performance requirements
- Distributed systems

**Process:**
1. Fetch JWKS (JSON Web Key Set) from authorization server's `/.well-known/jwks.json`
2. Cache public keys (with TTL and refresh on kid mismatch)
3. Verify JWT signature using public key matching `kid` header
4. Validate claims
5. Periodically refresh JWKS cache

#### Token Introspection (RFC 7662)

**Advantages:**
- Real-time revocation support
- Works with opaque tokens
- Centralized token validation logic
- Authoritative validation from issuer

**Disadvantages:**
- Network call on every request
- Higher latency
- Authorization server becomes bottleneck
- Requires client credentials for introspection endpoint

**When to Use:**
- Opaque tokens
- Real-time revocation required
- External/untrusted clients
- Zero-trust architectures

**Introspection Request:**
```bash
curl -X POST https://auth.example.com/oauth/introspect \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -u 'client_id:client_secret' \
  -d 'token=ACCESS_TOKEN'
```

**Response:**
```json
{
  "active": true,
  "scope": "read write",
  "client_id": "my-app",
  "username": "user@example.com",
  "token_type": "Bearer",
  "exp": 1710420000,
  "iat": 1710416400,
  "sub": "user-123",
  "aud": "https://api.example.com",
  "iss": "https://auth.example.com"
}
```

#### Hybrid Approach

**Best of Both Worlds:**
- Validate JWT signature locally (fast path)
- Periodically check introspection endpoint for revocation
- Use shorter cache for high-security endpoints

**Implementation Pattern:**
```javascript
async function validateToken(token) {
  // Fast path: local JWT validation
  const payload = await verifyJwtLocally(token);

  // For high-risk operations, check revocation
  if (isHighRiskOperation()) {
    const introspection = await introspectToken(token);
    if (!introspection.active) {
      throw new Error('Token revoked');
    }
  }

  return payload;
}
```

### JWKS (JSON Web Key Set) Endpoint and Key Rotation

**JWKS Endpoint:**
- Well-known URL: `https://auth.example.com/.well-known/jwks.json`
- Contains public keys for JWT signature verification
- Supports multiple keys (for rotation)

**JWKS Example:**
```json
{
  "keys": [
    {
      "kty": "RSA",
      "use": "sig",
      "kid": "key-2024-03",
      "n": "0vx7agoebGcQ...",
      "e": "AQAB",
      "alg": "RS256"
    },
    {
      "kty": "RSA",
      "use": "sig",
      "kid": "key-2024-02",
      "n": "xjlJw9sF3b...",
      "e": "AQAB",
      "alg": "RS256"
    }
  ]
}
```

**Key Rotation Best Practices:**
1. **Regular Rotation:** Every few months or on suspected compromise
2. **Grace Period:** Keep old keys in JWKS for token validity period
3. **Use `kid` Header:** Identify correct key for verification
4. **Cache JWKS:** Refresh on miss (unknown `kid`) or periodically
5. **Fallback Logic:** Handle JWKS endpoint downtime gracefully

**Key Rotation Flow:**
1. Generate new key pair
2. Add new public key to JWKS (keep old key)
3. Start signing new tokens with new key
4. After old tokens expire (access token TTL), remove old key from JWKS

**Caching Strategy:**
```javascript
class JwksCache {
  constructor(jwksUri, cacheTtl = 600000) { // 10 min default
    this.jwksUri = jwksUri;
    this.cacheTtl = cacheTtl;
    this.cache = new Map();
  }

  async getKey(kid) {
    const cached = this.cache.get(kid);
    if (cached && Date.now() - cached.timestamp < this.cacheTtl) {
      return cached.key;
    }

    // Fetch JWKS and update cache
    const jwks = await fetch(this.jwksUri).then(r => r.json());
    jwks.keys.forEach(key => {
      this.cache.set(key.kid, { key, timestamp: Date.now() });
    });

    return this.cache.get(kid)?.key;
  }
}
```

### Token Claims Validation

**Mandatory Validations:**

1. **Signature Verification:**
   - JWT: Verify using public key from JWKS
   - Opaque: Introspect with authorization server

2. **Expiration (`exp`):**
   ```javascript
   if (payload.exp * 1000 < Date.now()) {
     throw new Error('Token expired');
   }
   ```

3. **Not Before (`nbf`):**
   ```javascript
   if (payload.nbf && payload.nbf * 1000 > Date.now()) {
     throw new Error('Token not yet valid');
   }
   ```

4. **Issuer (`iss`):**
   ```javascript
   const TRUSTED_ISSUERS = ['https://auth.example.com'];
   if (!TRUSTED_ISSUERS.includes(payload.iss)) {
     throw new Error('Invalid issuer');
   }
   ```

5. **Audience (`aud`):**
   ```javascript
   const EXPECTED_AUDIENCE = 'https://api.example.com';
   if (payload.aud !== EXPECTED_AUDIENCE && !payload.aud.includes(EXPECTED_AUDIENCE)) {
     throw new Error('Invalid audience');
   }
   ```

   **Best Practice:** Single audience per token minimizes blast radius

6. **Clock Tolerance:**
   ```javascript
   const CLOCK_TOLERANCE = 60; // seconds
   const now = Math.floor(Date.now() / 1000);
   if (payload.exp < now - CLOCK_TOLERANCE) {
     throw new Error('Token expired');
   }
   ```

7. **Algorithm Restriction:**
   ```javascript
   const ALLOWED_ALGORITHMS = ['RS256', 'RS384', 'RS512'];
   if (!ALLOWED_ALGORITHMS.includes(header.alg)) {
     throw new Error('Unsupported algorithm');
   }
   ```

**Optional Validations:**
- **Subject (`sub`):** Extract user identifier
- **Scopes (`scope` or `scp`):** Verify authorized actions
- **Custom Claims:** Application-specific data (roles, tenant ID)

### Middleware/Plugin Patterns

**Key Patterns for Node.js APIs:**
1. **Global Authentication:** Validate all requests
2. **Route-Specific:** Protect specific routes
3. **Scope-Based Authorization:** Check permissions per endpoint
4. **Custom Claims Extraction:** Populate `request.user` or `request.auth`

**See Implementation Patterns section for code examples.**

---

## Identity Providers

### Microsoft Entra ID (Azure AD)

**Use Case:** Enterprise SSO, Microsoft 365 integration, B2B/B2C scenarios

**Key Features:**
- OAuth 2.0 + OpenID Connect
- Multi-tenant support
- Conditional Access policies
- API Management integration
- JWKS endpoint: `https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys`

**Registering an API as Resource:**
1. Navigate to Azure Portal → Entra ID → App Registrations
2. Create new registration for your API
3. Configure **Expose an API:**
   - Set Application ID URI: `api://your-api-domain`
   - Add scopes: `api://your-api-domain/scope.read`
4. Grant API permissions to client apps
5. Configure token settings (access token version, optional claims)

**Client Registration:**
1. Create app registration for client application
2. Configure redirect URIs
3. Generate client secret (confidential clients)
4. Grant API permissions (scopes)
5. Admin consent (if required by tenant policies)

**Token Validation:**
```javascript
const ISSUER = 'https://login.microsoftonline.com/{tenant-id}/v2.0';
const JWKS_URI = 'https://login.microsoftonline.com/{tenant-id}/discovery/v2.0/keys';
const AUDIENCE = 'api://{client-id}';

// Validate with jose library
const JWKS = createRemoteJWKSet(new URL(JWKS_URI));
const { payload } = await jwtVerify(token, JWKS, {
  issuer: ISSUER,
  audience: AUDIENCE
});
```

**2026 Security Enhancements:**
- Content Security Policy (CSP) enforcement (October 2026)
- Script injection hardening
- Enhanced API connector security

**Configuration:**
- **Endpoint:** `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`
- **Scopes:** `api://{client-id}/.default` or specific scopes
- **Token Claims:** `oid` (user object ID), `tid` (tenant ID), `roles`, `scp` (scopes)

### Auth0

**Use Case:** Developer-friendly, multi-provider federation, customizable

**Key Features:**
- Universal login (hosted login page)
- Social identity providers (Google, GitHub, etc.)
- Rules and Actions (extensibility)
- RBAC (Role-Based Access Control)
- Extensive SDKs and libraries
- JWKS endpoint: `https://{domain}/.well-known/jwks.json`

**Registering an API:**
1. Auth0 Dashboard → Applications → APIs → Create API
2. Set unique identifier (audience): `https://api.example.com`
3. Configure signing algorithm: RS256 recommended
4. Enable RBAC if needed
5. Define permissions (scopes)

**Client Registration:**
1. Applications → Create Application
2. Choose application type (SPA, Regular Web App, M2M)
3. Configure Allowed Callback URLs, Logout URLs
4. Copy Domain, Client ID, Client Secret
5. Grant API permissions

**Token Validation with Auth0 SDK:**
```javascript
import { auth } from 'express-oauth2-jwt-bearer';

app.use(
  auth({
    issuerBaseURL: 'https://{domain}',
    audience: 'https://api.example.com'
  })
);
```

**Pricing Consideration:**
- Subscription-based, escalates with user count
- Free tier: 7,000 active users
- Teams often migrate due to cost at scale

**Strengths:**
- Best developer experience
- Extensive documentation
- Quick to implement
- Managed service (no infrastructure)

### Okta

**Use Case:** Enterprise SSO, workforce identity, Okta-Auth0 integration

**Key Features:**
- Enterprise-grade identity platform
- Adaptive MFA
- Lifecycle management
- API Access Management
- B2B/B2C support
- JWKS endpoint: `https://{domain}/oauth2/default/v1/keys`

**Registering an API:**
1. Security → API → Add Authorization Server (or use default)
2. Define scopes, claims, access policies
3. Set audience claim
4. Configure token lifetime

**Client Registration:**
1. Applications → Add Application
2. Choose application type
3. Configure Grant Types
4. Assign users/groups
5. Note Client ID and Client Secret

**DPoP Support:**
- Configure OAuth 2.0 Demonstrating Proof-of-Possession
- Enhanced token security for public clients

**Okta vs Auth0:**
- Auth0 (owned by Okta) positioned as "developer tool"
- Okta marketed as "enterprise SSO"
- Subtle differences, converging roadmap

### Keycloak (Open Source)

**Use Case:** Self-hosted, cost-sensitive, full customization control

**Key Features:**
- Open-source (Red Hat)
- On-premises or cloud deployment
- OAuth 2.0, SAML, OpenID Connect
- User Federation (LDAP, Active Directory)
- Identity Brokering
- Fine-grained authorization
- JWKS endpoint: `https://{server}/realms/{realm}/protocol/openid-connect/certs`

**Registering an API:**
1. Create Realm (tenant equivalent)
2. Create Client for your API
3. Set Client Protocol: openid-connect
4. Access Type: bearer-only (for APIs)
5. Define Client Scopes

**Client Registration:**
1. Clients → Create
2. Set Client ID
3. Access Type: confidential (for server apps), public (for SPAs)
4. Configure redirect URIs
5. Assign Client Scopes and Roles

**Deployment Models:**
- Kubernetes, Docker, bare metal
- High availability clustering
- Database backend (PostgreSQL, MySQL)

**Strengths:**
- No licensing fees
- Full control and customization
- Enterprise features (no paywall)
- Active community

**Considerations:**
- Self-hosting overhead (maintenance, updates, scaling)
- Security responsibility (patching, monitoring)
- Learning curve for configuration

### Comparison Summary

| Feature | Microsoft Entra ID | Auth0 | Okta | Keycloak |
|---------|-------------------|-------|------|----------|
| **Deployment** | Cloud (SaaS) | Cloud (SaaS) | Cloud (SaaS) | Self-hosted or Cloud |
| **Pricing** | Per user (enterprise) | Subscription tiers | Subscription tiers | Free (open source) |
| **Best For** | Microsoft ecosystems | Developer-friendly apps | Enterprise workforce | Cost control, customization |
| **Protocols** | OAuth2, OIDC, SAML | OAuth2, OIDC, SAML | OAuth2, OIDC, SAML | OAuth2, OIDC, SAML |
| **Multi-Tenant** | Yes | Yes | Yes | Yes |
| **Social Login** | Limited | Extensive | Yes | Yes (via identity brokering) |
| **RBAC** | Yes | Yes | Yes | Yes |
| **Customization** | Moderate | High (Rules/Actions) | Moderate | Very High |
| **2026 Features** | CSP enforcement, passkeys | Passkey expansion | Adaptive MFA | Passkeys, FIDO2 native |
| **Scalability** | Massive | High | High | DIY (Kubernetes, clustering) |

**Decision Criteria:**
- **Enterprise + Microsoft:** Entra ID
- **Fast development:** Auth0
- **Enterprise SSO:** Okta
- **Budget/Control:** Keycloak

---

## Best Practices (OWASP, RFC, IETF)

### OAuth 2.1 Changes from OAuth 2.0

**OAuth 2.1 Status:** Draft specification consolidating security best practices

**Major Changes:**

1. **PKCE Required for All Clients**
   - Authorization Code flow MUST use PKCE
   - No longer optional for confidential clients

2. **Grant Types Removed:**
   - Implicit Grant (deprecated)
   - Resource Owner Password Credentials (deprecated)

3. **Stricter Redirect URI Matching:**
   - Exact string matching required (except localhost ports)
   - No wildcard or partial matching

4. **Refresh Token Security:**
   - Public clients: sender-constrained OR one-time use
   - Rotation encouraged for confidential clients

5. **Bearer Token in Query String Forbidden:**
   - Tokens must be in Authorization header or POST body
   - Prevents leakage via browser history, server logs

6. **Purpose:**
   - Simplify core specification
   - Incorporate security best practices from RFC 6819, RFC 7636, RFC 8252, etc.
   - Remove insecure patterns

**Migration Path:**
- Enable PKCE for all clients
- Deprecate Implicit and Password flows
- Implement refresh token rotation
- Review redirect URI configurations

### RFC 9700: OAuth 2.0 Security Best Current Practice

**Published:** January 2025
**Status:** Best Current Practice (BCP)

**Key Recommendations:**

1. **PKCE for All OAuth Clients:**
   - Protects against authorization code injection
   - Required for public clients, recommended for confidential

2. **Sender-Constrained Tokens:**
   - Use DPoP (Demonstrating Proof-of-Possession) or mTLS
   - Prevents token replay attacks
   - Critical for high-security environments

3. **CSRF Protection:**
   - Clients using PKCE can rely on it for CSRF protection
   - Alternative: state parameter validation

4. **Exact String Matching for Redirect URIs:**
   - Authorization servers MUST use exact matching
   - Exception: port numbers in localhost URIs (native apps)

5. **Short-Lived Access Tokens:**
   - Recommended: 15 minutes to 1 hour
   - Limits impact of token leakage

6. **Refresh Token Rotation:**
   - Issue new refresh token with each use
   - Invalidate old refresh token
   - Detect reuse (security breach indicator)

7. **Strong Authentication Methods:**
   - OAuth 2.0, signed JWTs, certificates
   - Avoid basic auth, static API keys

8. **Incremental Authorization:**
   - Request scopes when needed, not upfront
   - Improves user experience and security

9. **Rate Limiting:**
   - Prevent unrestricted resource consumption
   - Stricter limits for sensitive operations

10. **Monitoring and Logging:**
    - Log auth failures, authorization failures, rate-limit hits
    - Monitor for abuse patterns
    - Automate alerts

**Attacker Model Updates:**
- Network attackers (Wi-Fi, compromised routers)
- Malicious apps on user devices
- Browser-based attacks (XSS, clickjacking)
- Authorization server compromise scenarios

### OWASP OAuth2 Security Recommendations

**Key Threats:**

1. **Broken Object Level Authorization (BOLA):**
   - Top API security risk
   - OAuth scopes provide entry-point authorization only
   - Fine-grained checks required for object access

2. **Token Theft and Replay:**
   - Sender-constrained tokens (DPoP, mTLS)
   - Short-lived access tokens
   - Secure storage

3. **Insufficient Redirect URI Validation:**
   - Open redirect vulnerabilities
   - Authorization code interception

4. **CSRF Attacks:**
   - Use PKCE or state parameter
   - Validate state on callback

5. **Clickjacking:**
   - X-Frame-Options or CSP frame-ancestors
   - Prevent authorization UI embedding

**Mitigation Strategies:**

1. **PKCE Implementation:**
   - Mandatory for public clients
   - Recommended for all clients

2. **Token Management:**
   - JWT validation: verify signature, expiration, issuer, audience
   - Restrict algorithms (e.g., RS256, RS384, RS512)
   - Implement clock tolerance (60 seconds)

3. **Authorization Logic:**
   - Validate scopes on every request
   - Implement object-level access control
   - Use claims for fine-grained permissions

4. **Secure Communication:**
   - HTTPS only (TLS 1.2+)
   - HSTS headers
   - Certificate pinning (mobile apps)

5. **Credential Protection:**
   - Never log tokens
   - Encrypt tokens at rest
   - Use secure secret storage (Azure Key Vault, AWS Secrets Manager)

6. **Rate Limiting:**
   - Token endpoint: prevent brute force
   - API endpoints: prevent abuse
   - Stricter limits for state-changing operations

### Additional Best Practices

#### Token Storage

**Client-Side:**
- **SPAs:** Memory only (session storage acceptable for refresh tokens with rotation)
- **Mobile Apps:** Secure platform storage (Keychain, Keystore)
- **Avoid:** localStorage (XSS risk), cookies without httpOnly/secure flags

**Server-Side:**
- **Databases:** Encrypt at rest
- **Caching:** Redis with TTL matching token expiration
- **Secrets:** Never hardcode, use environment variables or secret managers

#### Scope Design

1. **Granularity:** Balance between too broad and scope explosion
2. **Naming:** Consistent pattern (verb:resource)
3. **Documentation:** Clear descriptions for developers and end-users
4. **Versioning:** Plan for scope evolution

#### Audience Restriction

- **Single Audience:** One resource server per token (preferred)
- **Multiple Audiences:** Only when truly necessary, increases risk
- **Validation:** Always validate `aud` claim matches your API

#### Token Binding

**DPoP (Demonstrating Proof-of-Possession):**
- Client proves key possession with each request
- DPoP header contains signed JWT
- Prevents stolen token replay
- RFC 9449

**mTLS (Mutual TLS):**
- Client certificate authentication
- Token bound to certificate thumbprint
- Strong but complex to deploy

#### CORS Configuration

**For OAuth Flows:**
- Allow authorization server origin
- Restrict methods: GET, POST, OPTIONS
- Allow Authorization header
- Handle preflight requests

**Example:**
```javascript
app.use(cors({
  origin: ['https://auth.example.com'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  credentials: true
}));
```

#### SSL/TLS Requirements

- **Minimum:** TLS 1.2
- **Recommended:** TLS 1.3
- **Certificate Validation:** Always validate server certificates
- **HSTS:** Enforce HTTPS

---

## Implementation Patterns for Node.js/TypeScript

### jose Library (Recommended)

**Library:** `panva/jose`
**Why Recommended:** Modern, standards-compliant, supports all runtimes (Node.js, Deno, Cloudflare Workers)

**Installation:**
```bash
npm install jose
```

#### JWT Verification with Remote JWKS

```typescript
import { createRemoteJWKSet, jwtVerify } from 'jose';

const JWKS_URI = 'https://auth.example.com/.well-known/jwks.json';
const ISSUER = 'https://auth.example.com';
const AUDIENCE = 'https://api.example.com';

// Create JWKS resolver (caches keys automatically)
const JWKS = createRemoteJWKSet(new URL(JWKS_URI));

async function validateToken(token: string) {
  try {
    const { payload, protectedHeader } = await jwtVerify(token, JWKS, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['RS256', 'RS384', 'RS512']
    });

    return {
      userId: payload.sub,
      scopes: (payload.scope as string)?.split(' ') || [],
      claims: payload
    };
  } catch (error) {
    if (error.code === 'ERR_JWT_EXPIRED') {
      throw new Error('Token expired');
    }
    if (error.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
      throw new Error('Invalid token claims');
    }
    throw new Error('Token validation failed');
  }
}
```

#### Handling Multiple Matching JWKS Keys

```typescript
const options = {
  issuer: ISSUER,
  audience: AUDIENCE,
};

const { payload, protectedHeader } = await jwtVerify(token, JWKS, options)
  .catch(async (error) => {
    if (error?.code === 'ERR_JWKS_MULTIPLE_MATCHING_KEYS') {
      // Iterate through matching keys
      for await (const publicKey of error) {
        try {
          return await jwtVerify(token, publicKey, options);
        } catch (innerError) {
          if (innerError?.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') {
            continue; // Try next key
          }
          throw innerError;
        }
      }
      throw new Error('No valid key found');
    }
    throw error;
  });
```

### jsonwebtoken Library

**Library:** `auth0/node-jsonwebtoken`
**Use Case:** Mature, widely used, comprehensive features

**Installation:**
```bash
npm install jsonwebtoken jwks-rsa
```

#### JWT Verification with JWKS (using jwks-rsa)

```typescript
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

const client = jwksClient({
  jwksUri: 'https://auth.example.com/.well-known/jwks.json',
  cache: true,
  cacheMaxAge: 600000, // 10 minutes
  rateLimit: true,
  jwksRequestsPerMinute: 10
});

function getKey(header: any, callback: any) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      return callback(err);
    }
    const signingKey = key.publicKey || key.rsaPublicKey;
    callback(null, signingKey);
  });
}

function validateToken(token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      getKey,
      {
        audience: 'https://api.example.com',
        issuer: 'https://auth.example.com',
        algorithms: ['RS256', 'RS384', 'RS512'],
        clockTolerance: 60 // 60 seconds tolerance
      },
      (err, decoded) => {
        if (err) {
          return reject(err);
        }
        resolve(decoded);
      }
    );
  });
}
```

### Fastify Integration

#### @fastify/jwt with JWKS

```typescript
import Fastify from 'fastify';
import fjwt from '@fastify/jwt';
import buildGetJwks from 'get-jwks';

const fastify = Fastify();
const getJwks = buildGetJwks();

fastify.register(fjwt, {
  decode: { complete: true },
  secret: async (request, token) => {
    const { header: { kid, alg }, payload: { iss } } = token;
    return getJwks.getPublicKey({ kid, domain: iss, alg });
  }
});

// Global authentication hook
fastify.addHook('onRequest', async (request, reply) => {
  try {
    await request.jwtVerify();
  } catch (err) {
    reply.code(401).send({ error: 'Unauthorized', message: err.message });
  }
});

// Access user info in routes
fastify.get('/protected', async (request, reply) => {
  return {
    message: 'Access granted',
    user: request.user
  };
});
```

#### RSA Keys (Public/Private Key Pairs)

```typescript
import Fastify from 'fastify';
import fjwt from '@fastify/jwt';
import fs from 'fs';

const fastify = Fastify();

fastify.register(fjwt, {
  secret: {
    private: fs.readFileSync('private.pem'),
    public: fs.readFileSync('public.pem')
  },
  sign: { algorithm: 'RS256' }
});

// Sign token
fastify.post('/login', async (request, reply) => {
  const token = await reply.jwtSign({
    userId: 123,
    email: 'user@example.com'
  }, {
    expiresIn: '1h'
  });

  return { token };
});

// Verify token
fastify.addHook('onRequest', async (request, reply) => {
  try {
    await request.jwtVerify();
  } catch (err) {
    reply.send(err);
  }
});
```

#### Scope-Based Authorization

```typescript
import { FastifyRequest, FastifyReply } from 'fastify';

function requireScopes(...requiredScopes: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const userScopes = (request.user as any).scope?.split(' ') || [];

    const hasAllScopes = requiredScopes.every(scope =>
      userScopes.includes(scope)
    );

    if (!hasAllScopes) {
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'Insufficient permissions',
        required: requiredScopes
      });
    }
  };
}

// Usage
fastify.get('/admin/users',
  {
    onRequest: [
      fastify.authenticate,
      requireScopes('admin:read', 'users:manage')
    ]
  },
  async (request, reply) => {
    // Handler code
  }
);
```

### Express Integration

#### express-oauth2-jwt-bearer (Auth0)

```typescript
import express from 'express';
import { auth, requiredScopes } from 'express-oauth2-jwt-bearer';

const app = express();

// Global JWT validation
app.use(
  auth({
    issuerBaseURL: 'https://auth.example.com',
    audience: 'https://api.example.com',
    tokenSigningAlg: 'RS256'
  })
);

// Access token data
app.get('/profile', (req, res) => {
  res.json({
    user: req.auth.payload.sub,
    claims: req.auth.payload
  });
});

// Scope-based authorization
app.get('/admin',
  requiredScopes('admin:access'),
  (req, res) => {
    res.json({ message: 'Admin access granted' });
  }
);
```

#### Manual JWT Middleware with jose

```typescript
import express from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const JWKS = createRemoteJWKSet(new URL('https://auth.example.com/.well-known/jwks.json'));

async function authenticateJWT(req: any, res: any, next: any) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.substring(7);

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: 'https://auth.example.com',
      audience: 'https://api.example.com'
    });

    req.auth = {
      userId: payload.sub,
      scopes: (payload.scope as string)?.split(' ') || [],
      claims: payload
    };

    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token', details: error.message });
  }
}

app.use(authenticateJWT);
```

### passport.js with OAuth2 Strategy

```typescript
import passport from 'passport';
import { Strategy as OAuth2Strategy } from 'passport-oauth2';

passport.use('oauth2', new OAuth2Strategy({
    authorizationURL: 'https://auth.example.com/oauth/authorize',
    tokenURL: 'https://auth.example.com/oauth/token',
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: 'https://myapp.com/auth/callback'
  },
  async (accessToken, refreshToken, profile, done) => {
    // Verify token, fetch user profile
    try {
      const user = await findOrCreateUser(profile);
      return done(null, user);
    } catch (error) {
      return done(error);
    }
  }
));

// Routes
app.get('/auth/login',
  passport.authenticate('oauth2')
);

app.get('/auth/callback',
  passport.authenticate('oauth2', { failureRedirect: '/login' }),
  (req, res) => {
    res.redirect('/dashboard');
  }
);
```

### Multi-Tenant Support (Multiple IdPs)

```typescript
import { createRemoteJWKSet, jwtVerify } from 'jose';

interface IdPConfig {
  issuer: string;
  jwksUri: string;
  audience: string;
}

const idpConfigs: Record<string, IdPConfig> = {
  'azure': {
    issuer: 'https://login.microsoftonline.com/{tenant}/v2.0',
    jwksUri: 'https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys',
    audience: 'api://{client-id}'
  },
  'auth0': {
    issuer: 'https://{domain}.auth0.com/',
    jwksUri: 'https://{domain}.auth0.com/.well-known/jwks.json',
    audience: 'https://api.example.com'
  },
  'okta': {
    issuer: 'https://{domain}.okta.com/oauth2/default',
    jwksUri: 'https://{domain}.okta.com/oauth2/default/v1/keys',
    audience: 'api://default'
  }
};

async function validateMultiTenantToken(token: string) {
  // Decode without verification to get issuer
  const decoded = JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString()
  );

  // Identify IdP by issuer claim
  const idpConfig = Object.values(idpConfigs).find(
    config => decoded.iss.startsWith(config.issuer.split('{')[0])
  );

  if (!idpConfig) {
    throw new Error('Unknown issuer');
  }

  // Verify with correct JWKS
  const JWKS = createRemoteJWKSet(new URL(idpConfig.jwksUri));
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: idpConfig.issuer,
    audience: idpConfig.audience
  });

  return { payload, idp: idpConfig };
}
```

### DPoP (Demonstrating Proof-of-Possession) Implementation

**Client-Side (Generate DPoP Proof):**

```typescript
import { SignJWT, generateKeyPair } from 'jose';

// Generate key pair (once, store private key securely)
const { publicKey, privateKey } = await generateKeyPair('ES256');

async function createDPoPProof(
  httpMethod: string,
  httpUrl: string,
  accessToken?: string
) {
  const proof = await new SignJWT({
    htm: httpMethod,
    htu: httpUrl,
    ...(accessToken && { ath: await calculateTokenHash(accessToken) })
  })
    .setProtectedHeader({
      alg: 'ES256',
      typ: 'dpop+jwt',
      jwk: await exportPublicKeyJWK(publicKey)
    })
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .sign(privateKey);

  return proof;
}

// Make request with DPoP
const dpopProof = await createDPoPProof('GET', 'https://api.example.com/data', accessToken);

fetch('https://api.example.com/data', {
  headers: {
    'Authorization': `DPoP ${accessToken}`,
    'DPoP': dpopProof
  }
});
```

**Server-Side (Validate DPoP Proof):**

```typescript
import { jwtVerify, importJWK } from 'jose';

async function validateDPoPProof(
  dpopHeader: string,
  httpMethod: string,
  httpUrl: string,
  accessToken: string
) {
  // Decode DPoP proof
  const decoded = JSON.parse(
    Buffer.from(dpopHeader.split('.')[0], 'base64url').toString()
  );

  if (decoded.typ !== 'dpop+jwt') {
    throw new Error('Invalid DPoP type');
  }

  // Import public key from JWK in header
  const publicKey = await importJWK(decoded.jwk, decoded.alg);

  // Verify DPoP proof
  const { payload } = await jwtVerify(dpopHeader, publicKey);

  // Validate claims
  if (payload.htm !== httpMethod || payload.htu !== httpUrl) {
    throw new Error('DPoP proof mismatch');
  }

  // Validate access token binding
  const tokenHash = await calculateTokenHash(accessToken);
  if (payload.ath !== tokenHash) {
    throw new Error('Access token binding mismatch');
  }

  return payload;
}
```

---

## Common Pitfalls and Debugging

### Token Expired Errors

**Symptom:** `Token expired` or `ERR_JWT_EXPIRED`

**Causes:**
1. Token lifetime too short
2. Clock skew between client and server
3. Token not refreshed before expiration

**Solutions:**
```typescript
// Implement clock tolerance
jwt.verify(token, publicKey, {
  clockTolerance: 60 // 60 seconds
});

// Refresh token before expiration
const REFRESH_BUFFER = 300; // 5 minutes
if (tokenExp - now < REFRESH_BUFFER) {
  await refreshAccessToken();
}

// Check token expiration on client
const payload = JSON.parse(atob(token.split('.')[1]));
const isExpired = payload.exp * 1000 < Date.now();
```

**Debugging:**
```bash
# Decode JWT to inspect claims
echo "eyJhbGc..." | cut -d'.' -f2 | base64 -d | jq

# Check current time vs exp claim
date +%s  # Current Unix timestamp
```

### Invalid Audience/Issuer

**Symptom:** `Invalid audience` or `Invalid issuer`

**Causes:**
1. Misconfigured audience in API
2. Token requested for wrong audience
3. Issuer URL mismatch (trailing slash, http vs https)

**Solutions:**
```typescript
// Accept multiple audiences
jwt.verify(token, publicKey, {
  audience: ['https://api.example.com', 'https://api.example.com/v1']
});

// Accept array of issuers (multi-tenant)
jwt.verify(token, publicKey, {
  issuer: [
    'https://login.microsoftonline.com/tenant1/v2.0',
    'https://login.microsoftonline.com/tenant2/v2.0'
  ]
});

// Normalize issuer (remove trailing slash)
const normalizeIssuer = (iss: string) => iss.replace(/\/$/, '');
```

**Debugging:**
```javascript
// Log expected vs actual
const payload = jwt.decode(token);
console.log('Expected audience:', EXPECTED_AUD);
console.log('Actual audience:', payload.aud);
console.log('Expected issuer:', EXPECTED_ISS);
console.log('Actual issuer:', payload.iss);
```

### JWKS Key Rotation Issues

**Symptom:** `No key found for kid: xyz`, `JWKSNoMatchingKey`

**Causes:**
1. Authorization server rotated keys
2. JWKS cache not refreshed
3. Incorrect `kid` in JWT header

**Solutions:**
```typescript
// Implement cache refresh on kid mismatch
class JwksResolver {
  private cache = new Map();

  async getKey(kid: string) {
    if (this.cache.has(kid)) {
      return this.cache.get(kid);
    }

    // Refresh JWKS
    await this.refreshKeys();

    if (!this.cache.has(kid)) {
      throw new Error(`Key not found: ${kid}`);
    }

    return this.cache.get(kid);
  }

  async refreshKeys() {
    const jwks = await fetch(this.jwksUri).then(r => r.json());
    this.cache.clear();
    jwks.keys.forEach(key => this.cache.set(key.kid, key));
  }
}

// Fallback to refresh on verification failure
try {
  await verifyJwt(token);
} catch (error) {
  if (error.code === 'ERR_JWKS_NO_MATCHING_KEY') {
    await jwksCache.refresh();
    return verifyJwt(token); // Retry
  }
  throw error;
}
```

### Clock Skew Problems

**Symptom:** Token rejected as expired or not yet valid

**Causes:**
1. Server time drift
2. Client time incorrect
3. Time zone mismatches

**Solutions:**
```typescript
// Use clock tolerance
const CLOCK_TOLERANCE = 60; // seconds

jwt.verify(token, publicKey, {
  clockTolerance: CLOCK_TOLERANCE
});

// Server-side time sync
// Ensure NTP service running
sudo systemctl status systemd-timesyncd

// Check time skew
const serverTime = Date.now();
const tokenIat = payload.iat * 1000;
const skew = Math.abs(serverTime - tokenIat);
if (skew > 300000) { // 5 minutes
  console.warn('Significant clock skew detected:', skew / 1000, 'seconds');
}
```

### CORS Preflight Failures with Authorization Header

**Symptom:** CORS error on OPTIONS request, Authorization header blocked

**Causes:**
1. Authorization not in allowed headers
2. OPTIONS request expects no auth header
3. Wildcard origin with credentials

**Solutions:**
```typescript
// Fastify CORS config
import cors from '@fastify/cors';

fastify.register(cors, {
  origin: ['https://app.example.com'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  exposedHeaders: ['Authorization'],
  credentials: true,
  preflight: true
});

// Bypass auth on OPTIONS
fastify.addHook('onRequest', async (request, reply) => {
  if (request.method === 'OPTIONS') {
    return; // Skip auth
  }
  await request.jwtVerify();
});
```

**Debugging:**
```bash
# Test preflight request
curl -X OPTIONS https://api.example.com/resource \
  -H "Origin: https://app.example.com" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: Authorization" \
  -v
```

### Token Not Being Sent (Missing Bearer Prefix)

**Symptom:** `Missing Authorization header`, `Unauthorized`

**Causes:**
1. Client not sending Authorization header
2. Missing "Bearer " prefix
3. Header name typo

**Solutions:**
```typescript
// Flexible header parsing
function extractToken(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null;
  }

  // Handle "Bearer <token>" or just "<token>"
  const parts = authHeader.split(' ');
  if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
    return parts[1];
  }

  // Assume entire header is token
  return authHeader;
}

// Client-side validation
const token = getAccessToken();
if (!token) {
  throw new Error('No access token available');
}

fetch('/api/resource', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

**Debugging:**
```javascript
// Server-side logging
console.log('Auth header:', request.headers.authorization);

// Client-side logging
console.log('Sending token:', headers.Authorization);
```

### Refresh Token Flow Failures

**Symptom:** Refresh token rejected, user logged out

**Causes:**
1. Refresh token expired
2. Refresh token revoked
3. Refresh token rotation not handled
4. Invalid grant type

**Solutions:**
```typescript
async function refreshAccessToken(refreshToken: string) {
  try {
    const response = await fetch('https://auth.example.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET
      })
    });

    if (!response.ok) {
      const error = await response.json();

      if (error.error === 'invalid_grant') {
        // Refresh token expired or revoked, re-authenticate
        await logout();
        throw new Error('Re-authentication required');
      }

      throw new Error(error.error_description);
    }

    const tokens = await response.json();

    // Handle rotation: save new refresh token
    await saveTokens({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || refreshToken, // Use new if provided
      expiresAt: Date.now() + tokens.expires_in * 1000
    });

    return tokens.access_token;
  } catch (error) {
    console.error('Token refresh failed:', error);
    throw error;
  }
}
```

### SSL/TLS Certificate Issues with IdP Endpoints

**Symptom:** `unable to verify the first certificate`, `CERT_HAS_EXPIRED`

**Causes:**
1. Self-signed certificates (dev/test environments)
2. Expired certificates
3. Missing intermediate certificates
4. Certificate name mismatch

**Solutions:**
```typescript
// Development only: disable certificate validation (NOT for production)
import https from 'https';

const agent = new https.Agent({
  rejectUnauthorized: false // DANGER: Only for local dev
});

fetch(jwksUri, { agent });

// Production: ensure CA certificates installed
// Ubuntu/Debian
sudo apt-get install ca-certificates
sudo update-ca-certificates

// Check certificate
openssl s_client -connect auth.example.com:443 -showcerts
```

---

## Testing OAuth2 Protected APIs

### Generating Test Tokens

#### Method 1: Use Real IdP Token Endpoint (Integration Tests)

```typescript
import { test, beforeAll } from 'vitest';

let accessToken: string;

beforeAll(async () => {
  const response = await fetch('https://auth.example.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.TEST_CLIENT_ID,
      client_secret: process.env.TEST_CLIENT_SECRET,
      scope: 'api:read api:write'
    })
  });

  const data = await response.json();
  accessToken = data.access_token;
});

test('GET /protected-resource', async () => {
  const response = await fetch('https://api.example.com/resource', {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });

  expect(response.status).toBe(200);
});
```

#### Method 2: Generate JWT with Private Key (Unit Tests)

```typescript
import { SignJWT, generateKeyPair, exportJWK } from 'jose';

// Generate key pair for testing
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = await exportJWK(publicKey);

// Sign test token
async function createTestToken(payload: any) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer('https://auth.test.com')
    .setAudience('https://api.test.com')
    .setSubject('test-user-123')
    .setExpirationTime('1h')
    .setIssuedAt()
    .sign(privateKey);
}

// Mock JWKS endpoint
import nock from 'nock';

nock('https://auth.test.com')
  .get('/.well-known/jwks.json')
  .reply(200, {
    keys: [{ ...jwk, kid: 'test-key', use: 'sig', alg: 'RS256' }]
  });

const token = await createTestToken({
  scope: 'read:messages'
});
```

### Mocking the IdP in Unit Tests

#### Using mock-jwks Library

```bash
npm install --save-dev mock-jwks
```

```typescript
import { test, beforeAll, afterAll } from 'vitest';
import createJWKSMock from 'mock-jwks';

const jwksMock = createJWKSMock('https://auth.test.com');

beforeAll(() => {
  jwksMock.start();
});

afterAll(() => {
  jwksMock.stop();
});

test('protected endpoint with mocked JWT', async () => {
  const token = jwksMock.token({
    sub: 'user-123',
    scope: 'read write'
  });

  const response = await request(app)
    .get('/protected')
    .set('Authorization', `Bearer ${token}`);

  expect(response.status).toBe(200);
});
```

#### Manual Mock with nock

```typescript
import nock from 'nock';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = await exportJWK(publicKey);

// Mock JWKS endpoint
nock('https://auth.example.com')
  .persist()
  .get('/.well-known/jwks.json')
  .reply(200, {
    keys: [{ ...jwk, kid: 'test-key-1', use: 'sig', alg: 'RS256' }]
  });

// Generate valid token
const token = await new SignJWT({ scope: 'admin' })
  .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
  .setIssuer('https://auth.example.com')
  .setAudience('https://api.example.com')
  .setSubject('admin-user')
  .setExpirationTime('1h')
  .setIssuedAt()
  .sign(privateKey);
```

### Integration Testing with Real IdP

```typescript
import { describe, test, beforeAll } from 'vitest';

describe('OAuth2 Integration Tests', () => {
  let tokens: any;

  beforeAll(async () => {
    // Authenticate with real IdP
    tokens = await authenticateTestUser();
  });

  test('access protected resource', async () => {
    const response = await fetch('https://api.example.com/resource', {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` }
    });

    expect(response.status).toBe(200);
  });

  test('refresh token flow', async () => {
    const newTokens = await refreshToken(tokens.refresh_token);
    expect(newTokens.access_token).toBeDefined();
    expect(newTokens.refresh_token).toBeDefined();
  });

  test('revoke token', async () => {
    await revokeToken(tokens.access_token);

    const response = await fetch('https://api.example.com/resource', {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` }
    });

    expect(response.status).toBe(401);
  });
});
```

### Using Postman/Insomnia with OAuth2 Flows

#### Postman Authorization Code Flow

1. Open Postman → Collection → Authorization
2. Select Type: OAuth 2.0
3. Configure:
   - **Grant Type:** Authorization Code (with PKCE)
   - **Auth URL:** `https://auth.example.com/oauth/authorize`
   - **Access Token URL:** `https://auth.example.com/oauth/token`
   - **Client ID:** `your-client-id`
   - **Client Secret:** `your-client-secret` (if confidential)
   - **Scope:** `api:read api:write`
   - **Callback URL:** `https://oauth.pstmn.io/v1/callback`
4. Click "Get New Access Token"
5. Login and grant consent
6. Use token for requests

#### curl Examples for Each Grant Type

**Authorization Code (after obtaining code):**
```bash
curl -X POST https://auth.example.com/oauth/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=authorization_code' \
  -d 'code=AUTHORIZATION_CODE' \
  -d 'redirect_uri=https://myapp.com/callback' \
  -d 'client_id=CLIENT_ID' \
  -d 'client_secret=CLIENT_SECRET' \
  -d 'code_verifier=CODE_VERIFIER'
```

**Client Credentials:**
```bash
curl -X POST https://auth.example.com/oauth/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -u 'CLIENT_ID:CLIENT_SECRET' \
  -d 'grant_type=client_credentials' \
  -d 'scope=api:read api:write'
```

**Refresh Token:**
```bash
curl -X POST https://auth.example.com/oauth/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -u 'CLIENT_ID:CLIENT_SECRET' \
  -d 'grant_type=refresh_token' \
  -d 'refresh_token=REFRESH_TOKEN'
```

**Using Access Token:**
```bash
curl https://api.example.com/resource \
  -H 'Authorization: Bearer ACCESS_TOKEN'
```

### Testing Token Validation Logic

```typescript
import { describe, test, expect } from 'vitest';

describe('Token Validation', () => {
  test('accepts valid token', async () => {
    const token = await createValidToken();
    const result = await validateToken(token);
    expect(result.userId).toBe('test-user-123');
  });

  test('rejects expired token', async () => {
    const token = await createExpiredToken();
    await expect(validateToken(token)).rejects.toThrow('Token expired');
  });

  test('rejects token with invalid signature', async () => {
    const token = await createTokenWithInvalidSignature();
    await expect(validateToken(token)).rejects.toThrow('Invalid signature');
  });

  test('rejects token with wrong audience', async () => {
    const token = await createToken({ aud: 'https://wrong-api.com' });
    await expect(validateToken(token)).rejects.toThrow('Invalid audience');
  });

  test('rejects token with wrong issuer', async () => {
    const token = await createToken({ iss: 'https://untrusted.com' });
    await expect(validateToken(token)).rejects.toThrow('Invalid issuer');
  });

  test('handles clock skew', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await createToken({ exp: now + 30 }); // 30 seconds in future

    // Should succeed with clock tolerance
    const result = await validateToken(token);
    expect(result).toBeDefined();
  });
});
```

---

## Assumptions & Scope

### Assumptions Made

| Assumption | Confidence | Impact if Wrong |
|------------|------------|-----------------|
| Target platform is Node.js 18+ with TypeScript | HIGH | Minor - patterns adaptable to other runtimes |
| APIs are primarily REST with JSON payloads | HIGH | Minor - OAuth2 concepts apply to GraphQL, gRPC |
| JWTs are preferred over opaque tokens | MEDIUM | Moderate - would emphasize introspection more |
| Short-lived access tokens (< 1 hour) are acceptable | HIGH | Low - best practice widely adopted |
| HTTPS/TLS is enforced in production | HIGH | Critical - security model assumes encrypted transport |
| Authorization server supports JWKS endpoint | HIGH | Moderate - fallback to token introspection |
| OAuth 2.1 adoption is progressing in 2026 | MEDIUM | Low - OAuth 2.0 still valid, 2.1 is best practice |
| PKCE is mandatory for authorization code flow | HIGH | Critical - security requirement in OAuth 2.1 |
| Fastify and Express are primary frameworks | MEDIUM | Low - patterns transferable to Koa, Hapi, etc. |

### Scope Coverage

**Included:**
- OAuth2 grant types and flows
- JWT validation with JWKS
- Token introspection
- Scope-based authorization
- Identity provider integration (Entra ID, Auth0, Okta, Keycloak)
- Node.js/TypeScript implementation patterns
- Common debugging scenarios
- Testing strategies

**Excluded (Out of Scope):**
- OAuth 1.0 (deprecated)
- SAML 2.0 (different protocol)
- OpenID Connect specifics (ID tokens, UserInfo endpoint, discovery)
- Authorization server implementation (focus is on resource server)
- Frontend OAuth flows (SPAs, mobile apps)
- Session management and cookie-based auth
- Advanced authorization (ABAC, ReBAC, policy engines)
- OAuth2 for Internet of Things (IoT) or device flows
- Detailed cryptography (key generation, algorithm selection)

### Uncertainties & Gaps

**Uncertainties:**

1. **PKCE for Confidential Clients:**
   - OAuth 2.1 mandates PKCE for all clients
   - Some IdPs still treat it as optional for confidential clients
   - **Recommendation:** Implement PKCE regardless of client type

2. **Token Binding Adoption:**
   - DPoP (RFC 9449) is standardized but adoption varies
   - mTLS token binding is complex to deploy
   - **Recommendation:** Evaluate based on security requirements

3. **Multi-Audience Tokens:**
   - Some IdPs support, others discourage
   - Security implications debated
   - **Recommendation:** Prefer single audience per token

4. **Refresh Token Rotation Grace Period:**
   - Implementation varies by IdP
   - Network issues can cause token loss
   - **Recommendation:** Test IdP-specific behavior

**Gaps Identified:**

1. **Performance Benchmarking:**
   - No specific performance data for JWKS caching vs introspection
   - **Follow-up:** Benchmark in target environment

2. **IdP-Specific Quirks:**
   - Each IdP has unique behaviors (claims format, error codes)
   - **Follow-up:** Test with actual IdP during implementation

3. **Rate Limiting Strategies:**
   - Limited detail on rate limit algorithms (token bucket, sliding window)
   - **Follow-up:** Consult rate limiting best practices separately

4. **Logging and Monitoring:**
   - High-level recommendations only
   - **Follow-up:** Design comprehensive observability strategy

5. **Revocation Strategies:**
   - Token blacklisting vs short-lived tokens trade-offs
   - **Follow-up:** Evaluate based on revocation latency requirements

### Clarifying Questions for Follow-up

1. **Target Identity Provider:**
   - Which IdP will be used (Entra ID, Auth0, Okta, Keycloak)?
   - Multiple IdPs (multi-tenant)?

2. **Security Requirements:**
   - Is real-time token revocation required?
   - Are sender-constrained tokens (DPoP, mTLS) needed?
   - Compliance requirements (FAPI, PSD2, HIPAA)?

3. **API Characteristics:**
   - Public API or internal microservices?
   - Expected request volume?
   - Stateless or stateful (session management)?

4. **Client Types:**
   - SPAs, mobile apps, server-to-server, or all?
   - Public clients (no client secret) or confidential?

5. **Authorization Model:**
   - Scope-based authorization sufficient?
   - Need for fine-grained permissions (RBAC, ABAC)?

6. **Token Storage:**
   - Server-side token storage required?
   - Redis/database for token blacklisting?

7. **Testing Strategy:**
   - Unit tests with mocked IdP sufficient?
   - Integration tests with real IdP required?

8. **Observability:**
   - Logging requirements (PII concerns)?
   - Metrics and alerting needs?

---

## References

### Official Specifications

1. **RFC 6749 - The OAuth 2.0 Authorization Framework**
   https://datatracker.ietf.org/doc/html/rfc6749

2. **RFC 6750 - The OAuth 2.0 Authorization Framework: Bearer Token Usage**
   https://datatracker.ietf.org/doc/html/rfc6750

3. **RFC 7636 - Proof Key for Code Exchange (PKCE)**
   https://datatracker.ietf.org/doc/html/rfc7636

4. **RFC 7662 - OAuth 2.0 Token Introspection**
   https://datatracker.ietf.org/doc/html/rfc7662

5. **RFC 9068 - JSON Web Token (JWT) Profile for OAuth 2.0 Access Tokens**
   https://datatracker.ietf.org/doc/html/rfc9068

6. **RFC 9449 - OAuth 2.0 Demonstrating Proof of Possession (DPoP)**
   https://datatracker.ietf.org/doc/html/rfc9449

7. **RFC 9700 - OAuth 2.0 Security Best Current Practice**
   https://datatracker.ietf.org/doc/html/rfc9700
   **Published:** January 2025

8. **OAuth 2.1 (Draft) - The OAuth 2.1 Authorization Framework**
   https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/
   https://oauth.net/2.1/

### OWASP Resources

9. **OAuth2 - OWASP Cheat Sheet Series**
   https://cheatsheetseries.owasp.org/cheatsheets/OAuth2_Cheat_Sheet.html

10. **Authentication - OWASP Cheat Sheet Series**
    https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html

### OAuth2 Best Practices

11. **OAuth 2.0 Security Best Current Practice**
    https://oauth.net/2/oauth-best-practice/

12. **Best Practices | Google Identity Platform**
    https://developers.google.com/identity/protocols/oauth2/resources/best-practices

13. **Professional API Security Best Practices in 2026**
    https://www.trustedaccounts.org/blog/post/professional-api-security-best-practices

14. **The complete guide to protecting your APIs with OAuth2 - Stack Overflow**
    https://stackoverflow.blog/2022/12/22/the-complete-guide-to-protecting-your-apis-with-oauth2/

### OAuth 2.1 and Evolution

15. **OAuth 2.1: Key Updates and Differences from OAuth 2.0 | FusionAuth**
    https://fusionauth.io/articles/oauth/differences-between-oauth-2-oauth-2-1

16. **OAuth 2.0 vs OAuth 2.1: What Changed? | LoginRadius**
    https://www.loginradius.com/blog/engineering/oauth-2-0-vs-oauth-2-1

17. **OAuth 2.1 vs 2.0: What developers need to know | Stytch**
    https://stytch.com/blog/oauth-2-1-vs-2-0/

### JWT and JWKS

18. **JWT validation with JWKs in Node.js | MojoAuth**
    https://mojoauth.com/blog/jwt-validation-with-jwks-nodejs/

19. **Navigating RS256 and JWKS | Auth0**
    https://auth0.com/blog/navigating-rs256-and-jwks/

20. **How to handle JWT in JavaScript | WorkOS**
    https://workos.com/blog/how-to-handle-jwt-in-javascript

21. **JWTs in Microservices: Key Rotation and Session Invalidation | Medium**
    https://techblogsbypallavi.medium.com/jwts-in-microservices-how-to-rotate-keys-and-invalidate-sessions-cleanly-db30c1110fd7

### Token Introspection vs Local Validation

22. **Choosing Between JWKS and Token Introspection - DEV Community**
    https://dev.to/mechcloud_academy/choosing-between-jwks-and-token-introspection-for-oauth-20-token-validation-1h9d

23. **OAuth 2.0 Token Introspection**
    https://oauth.net/2/token-introspection/

24. **OAuth 2.0 Token Introspection (RFC 7662) Explained**
    https://www.scalekit.com/blog/oauth-2-0-token-introspection-rfc-7662

### Identity Providers

25. **Microsoft Entra ID API permissions**
    https://www.azadvertizer.net/azEntraIdAPIpermissionsAdvertizer.html

26. **Expose scopes in a protected web API - Microsoft Entra**
    https://learn.microsoft.com/en-us/entra/identity-platform/scenario-protected-web-api-expose-scopes

27. **Protect API with OAuth 2.0 and Microsoft Entra ID - Azure API Management**
    https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-protect-backend-with-aad

28. **Auth0 vs Keycloak vs Okta Comparison**
    https://sourceforge.net/software/compare/Auth0-vs-Keycloak-vs-Okta/

29. **Keycloak vs Okta - Open Source Alternative | Phase Two**
    https://phasetwo.io/blog/keycloak-vs-okta-open-source-alternative/

30. **Top 7 Keycloak Alternatives In 2026 | Zluri**
    https://www.zluri.com/blog/keycloak-alternatives

### Scopes and Permissions

31. **OAuth Scopes Best Practices | Curity**
    https://curity.io/resources/learn/scope-best-practices/

32. **OAuth 2.0 Access Tokens and The Principle of Least Privilege | Auth0**
    https://auth0.com/blog/oauth2-access-tokens-and-principle-of-least-privilege/

33. **Protecting Resource APIs with API Scopes | Medium**
    https://medium.com/api-center/protecting-resource-apis-with-api-scopes-4f0e819763d7

34. **OAuth Scopes: A Guide to Secure Third-Party Access | FusionAuth**
    https://fusionauth.io/blog/how-to-design-oauth-scopes

35. **OAuth2 Audience Explained**
    https://sergiodxa.com/articles/oauth2-audience-explained

36. **OAuth 2.0 resource indicators (RFC 8707) explained**
    https://www.scalekit.com/blog/resource-indicators-for-oauth-2-0

### Refresh Token Security

37. **Refresh Token Rotation - Auth0 Docs**
    https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation

38. **OAuth 2 Refresh Tokens: A Practical Guide | Frontegg**
    https://frontegg.com/blog/oauth-2-refresh-tokens

39. **Refresh access tokens and rotate refresh tokens | Okta**
    https://developer.okta.com/docs/guides/refresh-tokens/main/

40. **What Are Refresh Tokens and How to Use Them Securely | Auth0**
    https://auth0.com/blog/refresh-tokens-what-are-they-and-when-to-use-them/

41. **Refresh Token Rotation Best Practices**
    https://www.serverion.com/uncategorized/refresh-token-rotation-best-practices-for-developers/

### DPoP (Demonstrating Proof of Possession)

42. **Demonstrating Proof-of-Possession (DPoP) - Auth0**
    https://auth0.com/docs/secure/sender-constraining/demonstrating-proof-of-possession-dpop

43. **Demonstrating Proof of Possession Overview | Curity**
    https://curity.io/resources/learn/dpop-overview/

44. **Protect Your Access Tokens with DPoP | Auth0**
    https://auth0.com/blog/protect-your-access-tokens-with-dpop/

45. **DPoP: Preventing Illegal Access of APIs | Kong**
    https://konghq.com/blog/engineering/demonstrating-proof-of-possession-dpop-preventing-illegal-access-of-apis

### Node.js Implementation Libraries

46. **panva/jose - GitHub**
    https://github.com/panva/jose

47. **auth0/node-jsonwebtoken - GitHub**
    https://github.com/auth0/node-jsonwebtoken

48. **fastify/fastify-jwt - GitHub**
    https://github.com/fastify/fastify-jwt

49. **fastify/fastify-oauth2 - GitHub**
    https://github.com/fastify/fastify-oauth2

50. **auth0/express-oauth2-jwt-bearer - GitHub**
    https://github.com/auth0/express-oauth2-bearer

51. **express-oauth2-jwt-bearer - npm**
    https://www.npmjs.com/package/express-oauth2-jwt-bearer

52. **Introducing OAuth 2.0 Express SDK | Auth0**
    https://auth0.com/blog/introducing-oauth2-express-sdk-protecting-api-with-jwt/

### Testing and Debugging

53. **Testing secure APIs by mocking JWT and JWKS**
    https://mestrak.com/blog/testing-secure-apis-by-mocking-jwt-and-jwks-3g8e

54. **mock-jwks - npm**
    https://www.npmjs.com/package/mock-jwks

55. **Mocking JSON Web Tokens with Express and Auth0**
    https://carterbancroft.com/mocking-json-web-tokens-and-auth0/

56. **Express+TypeScript: Properly mocking jwt.verify | Medium**
    https://zhifei-dev.medium.com/express-typescript-properly-mocking-jwt-verify-in-unit-test-b2dfd2e337a8

57. **Authenticate with OAuth 2.0 in Postman | Postman Docs**
    https://learning.postman.com/docs/sending-requests/authorization/oauth-20

58. **OAuth examples - Postman**
    https://documenter.getpostman.com/view/788154/RztrLSj6

### Common Issues and Debugging

59. **How to Fix 'Invalid Token' OAuth2 Errors**
    https://oneuptime.com/blog/post/2026-01-24-oauth2-invalid-token-errors/view

60. **Essential Tips for Debugging OAuth2 and JWT Issues in ASP.NET Core**
    https://moldstud.com/articles/p-essential-tips-and-tricks-for-debugging-oauth2-and-jwt-issues-in-aspnet-core

61. **Troubleshoot OAuth/OIDC Issues | Confluent**
    https://docs.confluent.io/cloud/current/security/authenticate/workload-identities/identity-providers/oauth/troubleshooting.html

### Multi-Tenant OAuth2

62. **Complete Guide to Multi-Provider OAuth 2 Authorization in Node.js**
    https://rrawat.com/blog/multi-provider-oauth2-nodejs

63. **passport-oauth2-multitenant - npm**
    https://www.npmjs.com/package/passport-oauth2-multitenant

64. **Multi-Provider OAuth2 Authentication in NestJS | Medium**
    https://medium.com/@camillefauchier/multi-provider-oauth2-authentication-in-nestjs-beyond-basic-jwt-7945ece51bb3

### Grant Types

65. **Client Credentials Flow - Auth0**
    https://auth0.com/docs/get-started/authentication-and-authorization-flow/client-credentials-flow

66. **OAuth 2.0 client credentials flow - Microsoft Entra**
    https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow

67. **Using Machine to Machine (M2M) Authorization | Auth0**
    https://auth0.com/blog/using-m2m-authorization/

68. **Call Your API Using Authorization Code Flow with PKCE - Auth0**
    https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow-with-pkce/call-your-api-using-the-authorization-code-flow-with-pkce

69. **oauth2-pkce - npm**
    https://www.npmjs.com/package/oauth2-pkce

### Additional Resources

70. **National Cyber Security Centre - API Authentication**
    https://www.ncsc.gov.uk/collection/securing-http-based-apis/2-api-authentication-and-authorisation

71. **API Authentication Best Practices in 2026 - DEV Community**
    https://dev.to/apiverve/api-authentication-best-practices-in-2026-3k4a

72. **OAuth 2.0 Security Best Current Practice (oauth.net)**
    https://oauth.net/2/oauth-best-practice/

---

**Document Version:** 1.0
**Last Updated:** March 14, 2026
**Confidence Level:** HIGH for core concepts, MEDIUM for implementation patterns (IdP-specific testing needed)
