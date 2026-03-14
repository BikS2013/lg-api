# OAuth2 API Protection -- Implementation Guide

**Version:** 1.0
**Date:** March 14, 2026
**Target:** Node.js 18+ / TypeScript REST APIs (Fastify v5, Express)
**Based on:** [OAuth2 Research Document](investigation-oauth2-api-protection.md)

---

## 1. Prerequisites Checklist

### Identity Provider Account

You need an account with at least one of the following Identity Providers (IdP):

| IdP | Account Type | Sign-up URL |
|-----|-------------|-------------|
| Microsoft Entra ID (Azure AD) | Azure subscription | https://portal.azure.com |
| Auth0 | Free tier (up to 7,000 users) | https://auth0.com/signup |
| Keycloak | Self-hosted (open source) | https://www.keycloak.org/downloads |

### Required Environment Variables

Every variable listed below is **mandatory** when OAuth2 is enabled. The application must throw an exception if any required variable is missing. **No fallback values are permitted.**

```
OAUTH2_ENABLED=true
OAUTH2_ISSUER=https://login.microsoftonline.com/{tenant-id}/v2.0
OAUTH2_AUDIENCE=api://{client-id}
OAUTH2_JWKS_URI=https://login.microsoftonline.com/{tenant-id}/discovery/v2.0/keys
OAUTH2_ALGORITHMS=RS256
OAUTH2_CLOCK_TOLERANCE=60
```

### Required npm Packages

```bash
# Option A: Fastify plugin approach
npm install @fastify/jwt@9.0.1 get-jwks@9.0.2

# Option B: Generic middleware approach (jose library)
npm install jose@6.0.8

# For testing
npm install --save-dev mock-jwks@3.3.0 nock@14.0.1
```

> **Note:** Package versions are pinned as of March 2026. Verify latest compatible versions before installing.

### Required Configuration Files

No additional configuration files are required. All OAuth2 configuration is managed through environment variables exclusively.

---

## 2. IdP Setup (per provider)

### 2.1 Microsoft Entra ID (Azure AD)

#### Step 1: Register the API Application

1. Navigate to **Azure Portal** -> **Microsoft Entra ID** -> **App registrations**
2. Click **New registration**
3. Configure:
   - **Name:** `your-api-name` (e.g., `lg-api`)
   - **Supported account types:** Select based on your needs:
     - "Accounts in this organizational directory only" (single tenant)
     - "Accounts in any organizational directory" (multi-tenant)
   - **Redirect URI:** Leave blank (this is a resource server, not a client)
4. Click **Register**
5. Record the following values from the **Overview** page:
   - **Application (client) ID** -- this becomes your `OAUTH2_AUDIENCE` (as `api://{client-id}`)
   - **Directory (tenant) ID** -- this is used in the `OAUTH2_ISSUER` and `OAUTH2_JWKS_URI` URLs

#### Step 2: Expose the API (Define Scopes)

1. In the app registration, go to **Expose an API**
2. Click **Set** next to "Application ID URI"
   - Accept the default `api://{client-id}` or set a custom URI
3. Click **Add a scope** for each permission your API requires:

   | Scope Name | Display Name | Description | Who Can Consent |
   |-----------|-------------|-------------|-----------------|
   | `api.read` | Read API data | Allows reading data from the API | Admins and users |
   | `api.write` | Write API data | Allows creating and updating data | Admins and users |
   | `api.admin` | Admin access | Full administrative access | Admins only |

4. For each scope, set:
   - **State:** Enabled
   - **Admin consent display name** and **description**
   - **User consent display name** and **description**

#### Step 3: Configure App Roles (Optional, for RBAC)

1. Go to **App roles** in the app registration
2. Click **Create app role**
3. Configure:
   - **Display name:** e.g., `API Administrator`
   - **Allowed member types:** Both (Users/Groups + Applications)
   - **Value:** `api.admin` (this appears in the `roles` claim)
   - **Description:** Clear description of the role
4. Repeat for each role needed

#### Step 4: Grant API Permissions to Client Applications

1. In the **client** app registration (not the API), go to **API permissions**
2. Click **Add a permission** -> **My APIs** -> select your API
3. Select the scopes the client needs
4. If required, click **Grant admin consent for {tenant}**

#### Step 5: Collect Configuration Values

| Value | Where to Find | Environment Variable |
|-------|--------------|---------------------|
| Tenant ID | App registration -> Overview | Used in `OAUTH2_ISSUER` and `OAUTH2_JWKS_URI` |
| Client ID | App registration -> Overview | `OAUTH2_AUDIENCE` (as `api://{client-id}`) |
| Issuer URL | `https://login.microsoftonline.com/{tenant-id}/v2.0` | `OAUTH2_ISSUER` |
| JWKS URI | `https://login.microsoftonline.com/{tenant-id}/discovery/v2.0/keys` | `OAUTH2_JWKS_URI` |

#### Step 6: Verification

```bash
# Verify the JWKS endpoint is accessible
curl -s https://login.microsoftonline.com/{tenant-id}/discovery/v2.0/keys | jq '.keys | length'
# Expected: a number > 0 (typically 2-4 keys)

# Verify the OpenID Connect discovery endpoint
curl -s https://login.microsoftonline.com/{tenant-id}/v2.0/.well-known/openid-configuration | jq '.issuer'
# Expected: "https://login.microsoftonline.com/{tenant-id}/v2.0"

# Obtain a test token using client_credentials
curl -X POST "https://login.microsoftonline.com/{tenant-id}/oauth2/v2.0/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id={client-app-client-id}" \
  -d "client_secret={client-app-secret}" \
  -d "scope=api://{api-client-id}/.default" | jq '.access_token'
```

**Entra ID Token Claims Reference:**

| Claim | Description | Example |
|-------|-------------|---------|
| `iss` | Issuer | `https://login.microsoftonline.com/{tenant}/v2.0` |
| `aud` | Audience | `api://{client-id}` |
| `sub` | Subject (user or app object ID) | `abc123-...` |
| `oid` | User object ID | `abc123-...` |
| `tid` | Tenant ID | `def456-...` |
| `scp` | Scopes (delegated permissions) | `api.read api.write` |
| `roles` | App roles | `["api.admin"]` |
| `azp` | Authorized party (client ID) | `{client-app-id}` |

---

### 2.2 Auth0

#### Step 1: Create an API

1. Log in to the **Auth0 Dashboard** (https://manage.auth0.com)
2. Navigate to **Applications** -> **APIs**
3. Click **Create API**
4. Configure:
   - **Name:** `your-api-name` (e.g., `lg-api`)
   - **Identifier (Audience):** `https://api.yourdomain.com` (a logical URI, does not need to resolve)
   - **Signing Algorithm:** RS256
5. Click **Create**
6. In the API settings, go to the **Permissions** tab
7. Add scopes:

   | Permission | Description |
   |-----------|-------------|
   | `api:read` | Read access to the API |
   | `api:write` | Write access to the API |
   | `api:admin` | Administrative access |

8. (Optional) Enable **RBAC** and **Add Permissions in the Access Token** under the API **Settings** tab

#### Step 2: Create a Client Application (for testing)

1. Navigate to **Applications** -> **Applications**
2. Click **Create Application**
3. Choose **Machine to Machine Applications** (for server-to-server testing)
4. Select the API you created and authorize the desired scopes
5. Record:
   - **Domain** (e.g., `your-tenant.auth0.com`)
   - **Client ID**
   - **Client Secret**

#### Step 3: Collect Configuration Values

| Value | Where to Find | Environment Variable |
|-------|--------------|---------------------|
| Domain | Application -> Settings | Used in `OAUTH2_ISSUER` and `OAUTH2_JWKS_URI` |
| API Identifier | APIs -> your API -> Settings | `OAUTH2_AUDIENCE` |
| Issuer URL | `https://{domain}/` | `OAUTH2_ISSUER` |
| JWKS URI | `https://{domain}/.well-known/jwks.json` | `OAUTH2_JWKS_URI` |

**Important:** Auth0 issuer URLs include a trailing slash. Your validation must account for this.

#### Step 4: Verification

```bash
# Verify the JWKS endpoint
curl -s https://{domain}/.well-known/jwks.json | jq '.keys | length'
# Expected: a number > 0

# Verify OpenID Connect discovery
curl -s https://{domain}/.well-known/openid-configuration | jq '.issuer'
# Expected: "https://{domain}/"

# Obtain a test token
curl -X POST "https://{domain}/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id={client-id}" \
  -d "client_secret={client-secret}" \
  -d "audience=https://api.yourdomain.com" | jq '.access_token'
```

**Auth0 Token Claims Reference:**

| Claim | Description | Example |
|-------|-------------|---------|
| `iss` | Issuer | `https://{domain}/` |
| `aud` | Audience | `https://api.yourdomain.com` |
| `sub` | Subject | `auth0|user-id` or `{client-id}@clients` |
| `scope` | Scopes | `api:read api:write` |
| `permissions` | RBAC permissions (if enabled) | `["api:read", "api:write"]` |
| `azp` | Authorized party | `{client-id}` |

---

### 2.3 Keycloak

#### Step 1: Create a Realm

1. Log in to the **Keycloak Admin Console** (e.g., `https://keycloak.yourdomain.com/admin`)
2. Click the realm dropdown in the top-left -> **Create realm**
3. Configure:
   - **Realm name:** `your-realm` (e.g., `lg-api-realm`)
4. Click **Create**

#### Step 2: Create a Client for the API

1. In your realm, go to **Clients** -> **Create client**
2. Configure:
   - **Client type:** OpenID Connect
   - **Client ID:** `your-api` (e.g., `lg-api`)
3. Click **Next**
4. Configure:
   - **Client authentication:** Off (bearer-only APIs do not authenticate themselves)
   - **Authorization:** Off (unless using Keycloak's built-in authorization services)
5. Click **Save**
6. In the client settings, set **Access Type** to `bearer-only` (if available in your version)

#### Step 3: Create Client Scopes

1. Go to **Client scopes** -> **Create client scope**
2. Configure:
   - **Name:** `api.read`
   - **Protocol:** OpenID Connect
   - **Include in token scope:** On
3. Repeat for `api.write`, `api.admin`, etc.
4. Assign the scopes to your API client under **Clients** -> your client -> **Client scopes** -> **Add client scope**

#### Step 4: Create a Test Client (for obtaining tokens)

1. Go to **Clients** -> **Create client**
2. Configure:
   - **Client type:** OpenID Connect
   - **Client ID:** `test-client`
3. Click **Next**
4. Configure:
   - **Client authentication:** On (confidential client)
   - **Service accounts roles:** On (enables client_credentials grant)
5. Click **Save**
6. Go to the **Credentials** tab and record the **Client secret**
7. Go to **Client scopes** -> add the API scopes

#### Step 5: Collect Configuration Values

| Value | Where to Find | Environment Variable |
|-------|--------------|---------------------|
| Realm name | Realm settings | Used in all URLs |
| Server URL | Keycloak base URL | Used in all URLs |
| Issuer URL | `https://{server}/realms/{realm}` | `OAUTH2_ISSUER` |
| JWKS URI | `https://{server}/realms/{realm}/protocol/openid-connect/certs` | `OAUTH2_JWKS_URI` |
| Audience | Client ID of the API client | `OAUTH2_AUDIENCE` |

#### Step 6: Verification

```bash
# Verify the JWKS endpoint
curl -s https://{server}/realms/{realm}/protocol/openid-connect/certs | jq '.keys | length'
# Expected: a number > 0

# Verify OpenID Connect discovery
curl -s https://{server}/realms/{realm}/.well-known/openid-configuration | jq '.issuer'
# Expected: "https://{server}/realms/{realm}"

# Obtain a test token
curl -X POST "https://{server}/realms/{realm}/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=test-client" \
  -d "client_secret={client-secret}" \
  -d "scope=api.read api.write" | jq '.access_token'
```

**Keycloak Token Claims Reference:**

| Claim | Description | Example |
|-------|-------------|---------|
| `iss` | Issuer | `https://{server}/realms/{realm}` |
| `aud` | Audience | `your-api` or `account` |
| `sub` | Subject (user ID) | `uuid` |
| `scope` | Scopes | `api.read api.write` |
| `realm_access.roles` | Realm-level roles | `["admin"]` |
| `resource_access.{client}.roles` | Client-level roles | `["api.admin"]` |
| `azp` | Authorized party | `test-client` |

---

## 3. API Implementation (Node.js/TypeScript)

### 3.1 Package Installation

```bash
# Fastify plugin approach (recommended for Fastify projects)
npm install @fastify/jwt@9.0.1 get-jwks@9.0.2

# OR: Generic approach using jose (works with any framework)
npm install jose@6.0.8

# Both approaches benefit from:
npm install fast-jwt@5.0.5   # Optional: high-performance JWT decode for claim inspection
```

### 3.2 Configuration

#### Environment Variables

Add these to your environment configuration loader. All variables are **required** when `OAUTH2_ENABLED` is `true`. The application must throw an exception on startup if any required variable is missing.

```typescript
// src/config/oauth2.config.ts

export interface OAuth2Config {
  enabled: boolean;
  issuer: string;
  audience: string;
  jwksUri: string;
  algorithms: string[];
  clockToleranceSeconds: number;
}

export function loadOAuth2Config(): OAuth2Config {
  const enabled = process.env.OAUTH2_ENABLED;
  if (enabled === undefined || enabled === '') {
    throw new Error('Missing required environment variable: OAUTH2_ENABLED');
  }

  const isEnabled = enabled === 'true';

  if (!isEnabled) {
    // Return a minimal config when disabled; no other vars are checked
    return {
      enabled: false,
      issuer: '',
      audience: '',
      jwksUri: '',
      algorithms: [],
      clockToleranceSeconds: 0,
    };
  }

  const issuer = process.env.OAUTH2_ISSUER;
  if (!issuer) {
    throw new Error('Missing required environment variable: OAUTH2_ISSUER');
  }

  const audience = process.env.OAUTH2_AUDIENCE;
  if (!audience) {
    throw new Error('Missing required environment variable: OAUTH2_AUDIENCE');
  }

  const jwksUri = process.env.OAUTH2_JWKS_URI;
  if (!jwksUri) {
    throw new Error('Missing required environment variable: OAUTH2_JWKS_URI');
  }

  const algorithms = process.env.OAUTH2_ALGORITHMS;
  if (!algorithms) {
    throw new Error('Missing required environment variable: OAUTH2_ALGORITHMS');
  }

  const clockTolerance = process.env.OAUTH2_CLOCK_TOLERANCE;
  if (!clockTolerance) {
    throw new Error('Missing required environment variable: OAUTH2_CLOCK_TOLERANCE');
  }

  const parsed = parseInt(clockTolerance, 10);
  if (isNaN(parsed)) {
    throw new Error('OAUTH2_CLOCK_TOLERANCE must be a valid integer (seconds)');
  }

  return {
    enabled: true,
    issuer,
    audience,
    jwksUri,
    algorithms: algorithms.split(',').map((a) => a.trim()),
    clockToleranceSeconds: parsed,
  };
}
```

#### .env File Example

```bash
# OAuth2 Configuration
OAUTH2_ENABLED=true
OAUTH2_ISSUER=https://login.microsoftonline.com/{tenant-id}/v2.0
OAUTH2_AUDIENCE=api://{client-id}
OAUTH2_JWKS_URI=https://login.microsoftonline.com/{tenant-id}/discovery/v2.0/keys
OAUTH2_ALGORITHMS=RS256
OAUTH2_CLOCK_TOLERANCE=60
```

---

### 3.3 JWT Validation Middleware

#### Implementation A: Fastify Plugin (@fastify/jwt + get-jwks)

This is the recommended approach for Fastify-based projects. It integrates natively with the Fastify request lifecycle.

```typescript
// src/plugins/oauth2.plugin.ts

import fp from 'fastify-plugin';
import fjwt from '@fastify/jwt';
import buildGetJwks from 'get-jwks';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { OAuth2Config } from '../config/oauth2.config.js';

/**
 * Paths that never require authentication.
 * Health checks and documentation must always be accessible.
 */
const PUBLIC_PATHS = ['/ok', '/docs', '/info'];

function isPublicPath(url: string): boolean {
  return PUBLIC_PATHS.some(
    (path) => url === path || url.startsWith(path + '/')
  );
}

/**
 * Decoded JWT user claims attached to each authenticated request.
 */
export interface JwtUser {
  /** Subject identifier (user ID or client ID) */
  sub: string;
  /** Issuer URL */
  iss: string;
  /** Audience */
  aud: string | string[];
  /** OAuth2 scopes (space-delimited string or array) */
  scope?: string;
  scp?: string[];
  /** App roles (Entra ID, Keycloak) */
  roles?: string[];
  /** RBAC permissions (Auth0) */
  permissions?: string[];
  /** Email claim (if present) */
  email?: string;
  /** Name claim (if present) */
  name?: string;
  /** All other claims */
  [key: string]: unknown;
}

// Augment Fastify types so request.user is typed
declare module '@fastify/jwt' {
  interface FastifyJWT {
    user: JwtUser;
  }
}

export default fp(
  async function oauth2Plugin(fastify: FastifyInstance) {
    const config: OAuth2Config = fastify.oauth2Config;

    if (!config.enabled) {
      fastify.log.info('[oauth2] OAuth2 authentication is DISABLED');
      return;
    }

    fastify.log.info(
      `[oauth2] OAuth2 authentication ENABLED — issuer=${config.issuer}, audience=${config.audience}`
    );

    // Build the JWKS key resolver with automatic caching
    const getJwks = buildGetJwks({
      jwksPath: config.jwksUri,
      max: 100,           // max cached keys
      ttl: 60_000,        // cache TTL in ms (1 minute)
    });

    // Register @fastify/jwt with remote JWKS key resolution
    await fastify.register(fjwt, {
      decode: { complete: true },
      secret: async (_request: FastifyRequest, token: { header: { kid: string; alg: string }; payload: { iss: string } }) => {
        const { header: { kid, alg }, payload: { iss } } = token;

        // Validate algorithm before key lookup
        if (!config.algorithms.includes(alg)) {
          throw new Error(`Unsupported signing algorithm: ${alg}`);
        }

        return getJwks.getPublicKey({ kid, domain: iss, alg });
      },
      verify: {
        allowedIss: config.issuer,
        allowedAud: config.audience,
        clockTolerance: config.clockToleranceSeconds,
      },
    });

    // Decorate fastify with an authenticate function for per-route use
    fastify.decorate(
      'authenticate',
      async function (request: FastifyRequest, reply: FastifyReply) {
        try {
          await request.jwtVerify();
        } catch (err: unknown) {
          const message =
            err instanceof Error ? err.message : 'Authentication failed';
          reply.code(401).send({
            error: 'Unauthorized',
            message,
          });
        }
      }
    );

    // Global preHandler hook: enforce authentication on all non-public routes
    fastify.addHook(
      'preHandler',
      async (request: FastifyRequest, reply: FastifyReply) => {
        // Skip public paths
        if (isPublicPath(request.url)) {
          return;
        }

        // Skip CORS preflight requests
        if (request.method === 'OPTIONS') {
          return;
        }

        // Extract token from Authorization header
        const authHeader = request.headers.authorization;
        if (!authHeader) {
          reply.code(401).send({
            error: 'Unauthorized',
            message: 'Missing Authorization header',
          });
          return;
        }

        if (!authHeader.startsWith('Bearer ')) {
          reply.code(401).send({
            error: 'Unauthorized',
            message:
              'Authorization header must use Bearer scheme: Bearer <token>',
          });
          return;
        }

        try {
          await request.jwtVerify();
        } catch (err: unknown) {
          const message =
            err instanceof Error ? err.message : 'Token validation failed';

          // Distinguish between expired tokens and other failures
          const errorMessage =
            err instanceof Error && err.message.includes('expired')
              ? 'Token expired'
              : message;

          reply.code(401).send({
            error: 'Unauthorized',
            message: errorMessage,
          });
          return;
        }
      }
    );
  },
  {
    name: 'oauth2-plugin',
  }
);
```

#### Implementation B: Generic Middleware (jose Library)

This approach works with any Node.js framework. It uses the `jose` library directly for JWT verification against a remote JWKS endpoint.

```typescript
// src/middleware/oauth2-middleware.ts

import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import type { JWTPayload, JWTVerifyResult } from 'jose';
import type { OAuth2Config } from '../config/oauth2.config.js';

/**
 * Verified token result with parsed claims.
 */
export interface VerifiedToken {
  /** Raw JWT payload */
  payload: JWTPayload;
  /** Subject identifier */
  sub: string;
  /** Parsed scopes as an array */
  scopes: string[];
  /** App roles (Entra ID, Keycloak) */
  roles: string[];
  /** RBAC permissions (Auth0) */
  permissions: string[];
}

/**
 * OAuth2 token validator using jose + remote JWKS.
 *
 * Usage:
 *   const validator = new OAuth2TokenValidator(config);
 *   const result = await validator.validate(token);
 */
export class OAuth2TokenValidator {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly config: OAuth2Config;

  constructor(config: OAuth2Config) {
    if (!config.enabled) {
      throw new Error('Cannot create OAuth2TokenValidator when OAuth2 is disabled');
    }

    this.config = config;
    this.jwks = createRemoteJWKSet(new URL(config.jwksUri));
  }

  /**
   * Validate a Bearer token string.
   * Throws on any validation failure.
   */
  async validate(token: string): Promise<VerifiedToken> {
    let result: JWTVerifyResult;

    try {
      result = await jwtVerify(token, this.jwks, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: this.config.algorithms,
        clockTolerance: this.config.clockToleranceSeconds,
      });
    } catch (err: unknown) {
      if (err instanceof joseErrors.JWTExpired) {
        throw new OAuth2Error(401, 'Token expired');
      }
      if (err instanceof joseErrors.JWTClaimValidationFailed) {
        const detail = err.message || 'Claim validation failed';
        if (detail.includes('aud')) {
          throw new OAuth2Error(401, 'Invalid audience');
        }
        if (detail.includes('iss')) {
          throw new OAuth2Error(401, 'Invalid issuer');
        }
        throw new OAuth2Error(401, `Invalid token claims: ${detail}`);
      }
      if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
        throw new OAuth2Error(401, 'Invalid token signature');
      }
      if (err instanceof joseErrors.JWKSNoMatchingKey) {
        throw new OAuth2Error(401, 'Token signing key not found in JWKS');
      }
      if (err instanceof joseErrors.JWKSMultipleMatchingKeys) {
        throw new OAuth2Error(401, 'Ambiguous token signing key');
      }

      throw new OAuth2Error(
        401,
        err instanceof Error ? err.message : 'Token validation failed'
      );
    }

    const { payload } = result;

    // Parse scopes from either 'scope' (string) or 'scp' (array) claim
    const scopeString =
      typeof payload.scope === 'string' ? payload.scope : '';
    const scpArray = Array.isArray((payload as Record<string, unknown>).scp)
      ? ((payload as Record<string, unknown>).scp as string[])
      : [];
    const scopes =
      scpArray.length > 0
        ? scpArray
        : scopeString.split(' ').filter((s) => s.length > 0);

    // Parse roles from 'roles' claim (Entra ID, Keycloak)
    const roles = Array.isArray((payload as Record<string, unknown>).roles)
      ? ((payload as Record<string, unknown>).roles as string[])
      : [];

    // Parse permissions from 'permissions' claim (Auth0)
    const permissions = Array.isArray(
      (payload as Record<string, unknown>).permissions
    )
      ? ((payload as Record<string, unknown>).permissions as string[])
      : [];

    return {
      payload,
      sub: payload.sub ?? '',
      scopes,
      roles,
      permissions,
    };
  }
}

/**
 * OAuth2 authentication error.
 */
export class OAuth2Error extends Error {
  public readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'OAuth2Error';
  }
}

/**
 * Extract Bearer token from Authorization header.
 * Returns null if header is missing or malformed.
 */
export function extractBearerToken(
  authorizationHeader: string | undefined
): string | null {
  if (!authorizationHeader) {
    return null;
  }

  if (!authorizationHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authorizationHeader.substring(7).trim();
  if (token.length === 0) {
    return null;
  }

  return token;
}
```

**Fastify adapter using the generic middleware:**

```typescript
// src/plugins/oauth2-jose.plugin.ts

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  OAuth2TokenValidator,
  extractBearerToken,
} from '../middleware/oauth2-middleware.js';
import type { OAuth2Config } from '../config/oauth2.config.js';
import type { VerifiedToken } from '../middleware/oauth2-middleware.js';

const PUBLIC_PATHS = ['/ok', '/docs', '/info'];

function isPublicPath(url: string): boolean {
  return PUBLIC_PATHS.some(
    (path) => url === path || url.startsWith(path + '/')
  );
}

// Augment Fastify request with user property
declare module 'fastify' {
  interface FastifyRequest {
    user?: VerifiedToken;
  }
}

export default fp(
  async function oauth2JosePlugin(fastify: FastifyInstance) {
    const config: OAuth2Config = fastify.oauth2Config;

    if (!config.enabled) {
      fastify.log.info('[oauth2-jose] OAuth2 authentication is DISABLED');
      return;
    }

    const validator = new OAuth2TokenValidator(config);

    fastify.log.info(
      `[oauth2-jose] OAuth2 authentication ENABLED — issuer=${config.issuer}, audience=${config.audience}`
    );

    fastify.addHook(
      'preHandler',
      async (request: FastifyRequest, reply: FastifyReply) => {
        if (isPublicPath(request.url)) {
          return;
        }

        if (request.method === 'OPTIONS') {
          return;
        }

        const token = extractBearerToken(request.headers.authorization);

        if (!token) {
          reply.code(401).send({
            error: 'Unauthorized',
            message: 'Missing or malformed Authorization header. Expected: Bearer <token>',
          });
          return;
        }

        try {
          request.user = await validator.validate(token);
        } catch (err: unknown) {
          const statusCode =
            err instanceof Error && 'statusCode' in err
              ? (err as { statusCode: number }).statusCode
              : 401;
          const message =
            err instanceof Error ? err.message : 'Authentication failed';

          reply.code(statusCode).send({
            error: 'Unauthorized',
            message,
          });
          return;
        }
      }
    );
  },
  {
    name: 'oauth2-jose-plugin',
  }
);
```

---

### 3.4 Route Protection

#### Protect All Routes (Global Hook)

Both plugin implementations above install a global `preHandler` hook. All routes are protected by default except those in `PUBLIC_PATHS`.

#### Protect Specific Routes Only

If you prefer opt-in protection instead of global protection, remove the global hook and use per-route decoration:

```typescript
// Using the @fastify/jwt approach:
fastify.get(
  '/protected/resource',
  {
    preHandler: [fastify.authenticate],
  },
  async (request, reply) => {
    return { message: 'Protected content', user: request.user };
  }
);

// Using the jose approach:
import { OAuth2TokenValidator, extractBearerToken } from '../middleware/oauth2-middleware.js';

const validator = new OAuth2TokenValidator(config);

fastify.get(
  '/protected/resource',
  {
    preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
      const token = extractBearerToken(request.headers.authorization);
      if (!token) {
        reply.code(401).send({ error: 'Unauthorized', message: 'Missing token' });
        return;
      }
      try {
        request.user = await validator.validate(token);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Authentication failed';
        reply.code(401).send({ error: 'Unauthorized', message });
        return;
      }
    },
  },
  async (request, reply) => {
    return { message: 'Protected content', user: request.user };
  }
);
```

#### Allow Public Routes

Public routes are defined in the `PUBLIC_PATHS` array. Add any path that must be accessible without authentication:

```typescript
const PUBLIC_PATHS = [
  '/ok',           // Health check
  '/info',         // Server info
  '/docs',         // Swagger UI and OpenAPI spec
  '/metrics',      // Prometheus metrics (if applicable)
];
```

#### Scope-Based Authorization Per Endpoint

```typescript
// src/middleware/require-scopes.ts

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { VerifiedToken } from './oauth2-middleware.js';

/**
 * Factory function that creates a preHandler hook requiring specific scopes.
 * The user must have ALL the listed scopes to proceed.
 *
 * Scopes are checked against:
 *   - payload.scope (space-delimited string) -- standard OAuth2
 *   - payload.scp (array) -- Entra ID
 *   - payload.permissions (array) -- Auth0 RBAC
 */
export function requireScopes(...requiredScopes: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as VerifiedToken | undefined;

    if (!user) {
      reply.code(401).send({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
      return;
    }

    // Combine all permission sources
    const grantedPermissions = new Set([
      ...user.scopes,
      ...user.roles,
      ...user.permissions,
    ]);

    const missingScopes = requiredScopes.filter(
      (scope) => !grantedPermissions.has(scope)
    );

    if (missingScopes.length > 0) {
      reply.code(403).send({
        error: 'Forbidden',
        message: 'Insufficient permissions',
        required_scopes: requiredScopes,
        missing_scopes: missingScopes,
      });
      return;
    }
  };
}

/**
 * Require at least one of the specified scopes.
 */
export function requireAnyScope(...requiredScopes: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user as VerifiedToken | undefined;

    if (!user) {
      reply.code(401).send({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
      return;
    }

    const grantedPermissions = new Set([
      ...user.scopes,
      ...user.roles,
      ...user.permissions,
    ]);

    const hasAny = requiredScopes.some((scope) =>
      grantedPermissions.has(scope)
    );

    if (!hasAny) {
      reply.code(403).send({
        error: 'Forbidden',
        message: 'Insufficient permissions — at least one scope required',
        required_scopes: requiredScopes,
      });
      return;
    }
  };
}

// Usage examples:

// Require all scopes
fastify.post(
  '/assistants',
  { preHandler: [requireScopes('api:write')] },
  assistantCreateHandler
);

// Require any of these scopes
fastify.get(
  '/threads/:id',
  { preHandler: [requireAnyScope('api:read', 'api:admin')] },
  threadGetHandler
);

// Admin-only endpoint
fastify.delete(
  '/threads/:id',
  { preHandler: [requireScopes('api:admin')] },
  threadDeleteHandler
);
```

---

### 3.5 Token Claims Access

#### Accessing Claims in Route Handlers

```typescript
// With the @fastify/jwt plugin approach:
fastify.get('/me', async (request, reply) => {
  const user = request.user; // Type: JwtUser (from the declare module augmentation)

  return {
    subject: user.sub,
    email: user.email,
    name: user.name,
    scopes: user.scope?.split(' ') || user.scp || [],
    roles: user.roles || [],
  };
});

// With the jose plugin approach:
fastify.get('/me', async (request, reply) => {
  const user = request.user; // Type: VerifiedToken

  if (!user) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }

  return {
    subject: user.sub,
    scopes: user.scopes,
    roles: user.roles,
    permissions: user.permissions,
    raw_claims: user.payload,
  };
});
```

#### TypeScript Type Augmentation

If you use the jose-based approach, add the type augmentation to a declaration file:

```typescript
// src/types/fastify.d.ts

import type { VerifiedToken } from '../middleware/oauth2-middleware.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: VerifiedToken;
  }
}
```

If you use the @fastify/jwt approach, the augmentation is in the plugin file:

```typescript
declare module '@fastify/jwt' {
  interface FastifyJWT {
    user: JwtUser;
  }
}
```

#### Common Claims Across Providers

| Claim | Entra ID | Auth0 | Keycloak | Description |
|-------|---------|-------|----------|-------------|
| Subject | `sub` | `sub` | `sub` | Unique user/app identifier |
| Email | `email` or `preferred_username` | `email` (via OIDC) | `email` | User email |
| Name | `name` | `name` | `name` | Display name |
| Scopes | `scp` (array) | `scope` (string) | `scope` (string) | Granted permissions |
| Roles | `roles` (array) | `permissions` (array) | `realm_access.roles` | App roles |
| Tenant | `tid` | N/A | `azp` | Tenant identifier |
| Client ID | `azp` | `azp` | `azp` | Calling application |

---

## 4. Multi-Tenant Support

### Supporting Multiple Identity Providers

When your API must accept tokens from multiple IdPs, you need to dynamically resolve the correct JWKS endpoint and validation parameters based on the token's issuer.

```typescript
// src/middleware/multi-tenant-validator.ts

import { createRemoteJWKSet, jwtVerify, decodeJwt } from 'jose';
import type { JWTPayload } from 'jose';

export interface IdPConfig {
  /** Unique name for this IdP (for logging) */
  name: string;
  /** Expected issuer claim value */
  issuer: string;
  /** JWKS endpoint URL */
  jwksUri: string;
  /** Expected audience claim value */
  audience: string;
  /** Allowed signing algorithms */
  algorithms: string[];
  /** Clock tolerance in seconds */
  clockToleranceSeconds: number;
}

export class MultiTenantValidator {
  private readonly idps: IdPConfig[];
  private readonly jwksSets: Map<string, ReturnType<typeof createRemoteJWKSet>>;

  constructor(idps: IdPConfig[]) {
    if (idps.length === 0) {
      throw new Error('At least one IdP configuration is required');
    }

    this.idps = idps;
    this.jwksSets = new Map();

    // Pre-initialize JWKS resolvers for each IdP
    for (const idp of idps) {
      this.jwksSets.set(idp.issuer, createRemoteJWKSet(new URL(idp.jwksUri)));
    }
  }

  async validate(token: string): Promise<{ payload: JWTPayload; idp: IdPConfig }> {
    // Decode without verification to read the issuer
    let claims: JWTPayload;
    try {
      claims = decodeJwt(token);
    } catch {
      throw new Error('Malformed JWT: unable to decode token');
    }

    const issuer = claims.iss;
    if (!issuer) {
      throw new Error('Token missing issuer (iss) claim');
    }

    // Find matching IdP by issuer
    const idp = this.idps.find((config) => config.issuer === issuer);
    if (!idp) {
      throw new Error(`Unknown token issuer: ${issuer}`);
    }

    const jwks = this.jwksSets.get(idp.issuer);
    if (!jwks) {
      throw new Error(`No JWKS resolver for issuer: ${issuer}`);
    }

    const { payload } = await jwtVerify(token, jwks, {
      issuer: idp.issuer,
      audience: idp.audience,
      algorithms: idp.algorithms,
      clockTolerance: idp.clockToleranceSeconds,
    });

    return { payload, idp };
  }
}
```

**Configuration for multi-tenant (environment variables):**

```bash
# IdP 1: Entra ID
OAUTH2_IDP_1_NAME=entra-id
OAUTH2_IDP_1_ISSUER=https://login.microsoftonline.com/{tenant-id}/v2.0
OAUTH2_IDP_1_AUDIENCE=api://{client-id}
OAUTH2_IDP_1_JWKS_URI=https://login.microsoftonline.com/{tenant-id}/discovery/v2.0/keys
OAUTH2_IDP_1_ALGORITHMS=RS256
OAUTH2_IDP_1_CLOCK_TOLERANCE=60

# IdP 2: Auth0
OAUTH2_IDP_2_NAME=auth0
OAUTH2_IDP_2_ISSUER=https://{domain}.auth0.com/
OAUTH2_IDP_2_AUDIENCE=https://api.example.com
OAUTH2_IDP_2_JWKS_URI=https://{domain}.auth0.com/.well-known/jwks.json
OAUTH2_IDP_2_ALGORITHMS=RS256
OAUTH2_IDP_2_CLOCK_TOLERANCE=60
```

---

## 5. Refresh Token Handling

### Server-Side Token Refresh Flow

Refresh tokens are typically managed by **client applications**, not the API server (resource server). The API server validates access tokens only. However, if your server acts as a Backend-for-Frontend (BFF) proxy, you may need to handle refresh tokens.

```typescript
// src/services/token-refresh.service.ts

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp in ms
}

export interface TokenRefreshConfig {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
}

export class TokenRefreshService {
  private readonly config: TokenRefreshConfig;

  constructor(config: TokenRefreshConfig) {
    this.config = config;
  }

  /**
   * Refresh an access token using a refresh token.
   * Handles rotation: if a new refresh token is returned, it replaces the old one.
   */
  async refresh(refreshToken: string): Promise<TokenSet> {
    const response = await fetch(this.config.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      const errorCode = (errorBody as Record<string, unknown>).error;

      if (errorCode === 'invalid_grant') {
        throw new TokenRefreshError(
          'REVOKED',
          'Refresh token has been revoked or expired. Re-authentication required.'
        );
      }

      throw new TokenRefreshError(
        'FAILED',
        `Token refresh failed: ${(errorBody as Record<string, unknown>).error_description || response.statusText}`
      );
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    return {
      accessToken: data.access_token,
      // Use new refresh token if provided (rotation), otherwise keep the old one
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
  }
}

export class TokenRefreshError extends Error {
  public readonly code: 'REVOKED' | 'FAILED';

  constructor(code: 'REVOKED' | 'FAILED', message: string) {
    super(message);
    this.code = code;
    this.name = 'TokenRefreshError';
  }
}
```

### Rotation Detection

If a refresh token is used more than once (e.g., due to token theft), the IdP will revoke all tokens for that grant. Your application should handle the `invalid_grant` error by forcing re-authentication.

### Revocation

```typescript
/**
 * Revoke a refresh token at the IdP.
 * Uses the RFC 7009 token revocation endpoint.
 */
export async function revokeToken(
  revocationEndpoint: string,
  token: string,
  clientId: string,
  clientSecret: string
): Promise<void> {
  const response = await fetch(revocationEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      token,
      token_type_hint: 'refresh_token',
    }),
  });

  if (!response.ok) {
    throw new Error(`Token revocation failed: ${response.statusText}`);
  }
}
```

---

## 6. Testing

### 6.1 Unit Tests

Complete test suite using **vitest** with mocked JWKS.

```typescript
// test_scripts/oauth2.test.ts

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import type { KeyLike, JWK } from 'jose';
import nock from 'nock';
import {
  OAuth2TokenValidator,
  OAuth2Error,
  extractBearerToken,
} from '../src/middleware/oauth2-middleware.js';
import type { OAuth2Config } from '../src/config/oauth2.config.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const TEST_ISSUER = 'https://auth.test.example.com';
const TEST_AUDIENCE = 'https://api.test.example.com';
const TEST_JWKS_URI = `${TEST_ISSUER}/.well-known/jwks.json`;
const TEST_KID = 'test-key-001';

let privateKey: KeyLike;
let publicJwk: JWK;
let validator: OAuth2TokenValidator;

const baseConfig: OAuth2Config = {
  enabled: true,
  issuer: TEST_ISSUER,
  audience: TEST_AUDIENCE,
  jwksUri: TEST_JWKS_URI,
  algorithms: ['RS256'],
  clockToleranceSeconds: 60,
};

// Helper: create a signed JWT
async function createToken(overrides: Record<string, unknown> = {}): Promise<string> {
  const builder = new SignJWT({
    scope: 'api:read api:write',
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: TEST_KID })
    .setIssuer(TEST_ISSUER)
    .setAudience(TEST_AUDIENCE)
    .setSubject('test-user-123')
    .setIssuedAt()
    .setExpirationTime('1h');

  // Allow overrides of standard claims
  if (overrides.iss !== undefined) {
    // Re-create with custom issuer
    return new SignJWT({
      scope: 'api:read api:write',
      ...overrides,
    })
      .setProtectedHeader({ alg: 'RS256', kid: TEST_KID })
      .setIssuer(overrides.iss as string)
      .setAudience(
        (overrides.aud as string) ?? TEST_AUDIENCE
      )
      .setSubject((overrides.sub as string) ?? 'test-user-123')
      .setIssuedAt()
      .setExpirationTime(
        (overrides.exp as string) ?? '1h'
      )
      .sign(privateKey);
  }

  if (overrides.aud !== undefined) {
    return new SignJWT({
      scope: 'api:read api:write',
      ...overrides,
    })
      .setProtectedHeader({ alg: 'RS256', kid: TEST_KID })
      .setIssuer(TEST_ISSUER)
      .setAudience(overrides.aud as string)
      .setSubject('test-user-123')
      .setIssuedAt()
      .setExpirationTime(
        (overrides.exp as string) ?? '1h'
      )
      .sign(privateKey);
  }

  if (overrides.exp !== undefined && typeof overrides.exp === 'number') {
    return new SignJWT({
      scope: 'api:read api:write',
      ...overrides,
    })
      .setProtectedHeader({ alg: 'RS256', kid: TEST_KID })
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUDIENCE)
      .setSubject('test-user-123')
      .setIssuedAt()
      .setExpirationTime(overrides.exp as number)
      .sign(privateKey);
  }

  return builder.sign(privateKey);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const keyPair = await generateKeyPair('RS256');
  privateKey = keyPair.privateKey;
  publicJwk = await exportJWK(keyPair.publicKey);
});

beforeEach(() => {
  nock.cleanAll();

  // Mock the JWKS endpoint
  nock(TEST_ISSUER)
    .get('/.well-known/jwks.json')
    .reply(200, {
      keys: [
        {
          ...publicJwk,
          kid: TEST_KID,
          use: 'sig',
          alg: 'RS256',
        },
      ],
    })
    .persist();

  validator = new OAuth2TokenValidator(baseConfig);
});

afterAll(() => {
  nock.cleanAll();
  nock.restore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractBearerToken', () => {
  test('extracts token from valid Bearer header', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
  });

  test('returns null for missing header', () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  test('returns null for non-Bearer scheme', () => {
    expect(extractBearerToken('Basic abc123')).toBeNull();
  });

  test('returns null for empty token', () => {
    expect(extractBearerToken('Bearer ')).toBeNull();
  });

  test('returns null for Bearer without space', () => {
    expect(extractBearerToken('Bearerabc123')).toBeNull();
  });
});

describe('OAuth2TokenValidator', () => {
  test('validates a valid token successfully', async () => {
    const token = await createToken();
    const result = await validator.validate(token);

    expect(result.sub).toBe('test-user-123');
    expect(result.scopes).toContain('api:read');
    expect(result.scopes).toContain('api:write');
  });

  test('rejects an expired token', async () => {
    const token = await createToken({
      exp: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
    });

    await expect(validator.validate(token)).rejects.toThrow('Token expired');
  });

  test('rejects a token with wrong audience', async () => {
    const token = await createToken({ aud: 'https://wrong-api.example.com' });

    await expect(validator.validate(token)).rejects.toThrow(
      /audience|aud/i
    );
  });

  test('rejects a token with wrong issuer', async () => {
    const token = await createToken({ iss: 'https://evil.example.com' });

    await expect(validator.validate(token)).rejects.toThrow(
      /issuer|iss/i
    );
  });

  test('rejects a request with no token (empty string)', async () => {
    await expect(validator.validate('')).rejects.toThrow();
  });

  test('rejects a malformed token', async () => {
    await expect(
      validator.validate('not.a.valid.jwt.string')
    ).rejects.toThrow();
  });

  test('rejects a token signed with unknown key', async () => {
    // Generate a different key pair
    const { privateKey: otherKey } = await generateKeyPair('RS256');

    const token = await new SignJWT({ scope: 'api:read' })
      .setProtectedHeader({ alg: 'RS256', kid: 'unknown-key' })
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUDIENCE)
      .setSubject('test-user')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(otherKey);

    await expect(validator.validate(token)).rejects.toThrow();
  });

  test('parses scopes from space-delimited scope claim', async () => {
    const token = await createToken({ scope: 'read write admin' });
    const result = await validator.validate(token);

    expect(result.scopes).toEqual(['read', 'write', 'admin']);
  });

  test('parses roles from roles array claim', async () => {
    const token = await createToken({
      roles: ['api.admin', 'api.reader'],
    });
    const result = await validator.validate(token);

    expect(result.roles).toEqual(['api.admin', 'api.reader']);
  });

  test('parses permissions from Auth0 permissions claim', async () => {
    const token = await createToken({
      permissions: ['api:read', 'api:write'],
    });
    const result = await validator.validate(token);

    expect(result.permissions).toEqual(['api:read', 'api:write']);
  });

  test('respects clock tolerance for nearly-expired tokens', async () => {
    // Token expires 30 seconds from now; with 60s tolerance, this should pass
    const token = await createToken({
      exp: Math.floor(Date.now() / 1000) + 30,
    });

    const result = await validator.validate(token);
    expect(result.sub).toBe('test-user-123');
  });
});

describe('OAuth2TokenValidator — insufficient scope', () => {
  test('returns scopes for downstream checking', async () => {
    const token = await createToken({ scope: 'api:read' });
    const result = await validator.validate(token);

    expect(result.scopes).toEqual(['api:read']);
    expect(result.scopes).not.toContain('api:write');
  });
});
```

Run the tests:

```bash
npx vitest run test_scripts/oauth2.test.ts
```

---

### 6.2 Integration Tests

Integration tests use real IdP tokens obtained via the `client_credentials` grant.

```typescript
// test_scripts/oauth2-integration.test.ts

import { describe, test, expect, beforeAll } from 'vitest';

// These tests require real IdP credentials.
// Skip them if env vars are not set.
const SKIP = !process.env.OAUTH2_TEST_TOKEN_ENDPOINT;

describe.skipIf(SKIP)('OAuth2 Integration Tests', () => {
  let accessToken: string;
  const API_BASE = process.env.OAUTH2_TEST_API_BASE ?? 'http://localhost:8123';

  beforeAll(async () => {
    const tokenEndpoint = process.env.OAUTH2_TEST_TOKEN_ENDPOINT;
    if (!tokenEndpoint) {
      throw new Error('Missing OAUTH2_TEST_TOKEN_ENDPOINT');
    }
    const clientId = process.env.OAUTH2_TEST_CLIENT_ID;
    if (!clientId) {
      throw new Error('Missing OAUTH2_TEST_CLIENT_ID');
    }
    const clientSecret = process.env.OAUTH2_TEST_CLIENT_SECRET;
    if (!clientSecret) {
      throw new Error('Missing OAUTH2_TEST_CLIENT_SECRET');
    }
    const scope = process.env.OAUTH2_TEST_SCOPE;
    if (!scope) {
      throw new Error('Missing OAUTH2_TEST_SCOPE');
    }

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to obtain token: ${response.statusText}`);
    }

    const data = (await response.json()) as { access_token: string };
    accessToken = data.access_token;
  });

  test('health check is accessible without token', async () => {
    const res = await fetch(`${API_BASE}/ok`);
    expect(res.status).toBe(200);
  });

  test('protected endpoint returns 401 without token', async () => {
    const res = await fetch(`${API_BASE}/assistants/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  test('protected endpoint returns 200 with valid token', async () => {
    const res = await fetch(`${API_BASE}/assistants/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
  });

  test('protected endpoint returns 401 with invalid token', async () => {
    const res = await fetch(`${API_BASE}/assistants/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer invalid.token.here',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});
```

**Required environment variables for integration tests:**

```bash
OAUTH2_TEST_TOKEN_ENDPOINT=https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
OAUTH2_TEST_CLIENT_ID={client-id}
OAUTH2_TEST_CLIENT_SECRET={client-secret}
OAUTH2_TEST_SCOPE=api://{api-client-id}/.default
OAUTH2_TEST_API_BASE=http://localhost:8123
```

Run the integration tests:

```bash
npx vitest run test_scripts/oauth2-integration.test.ts
```

---

### 6.3 Manual Testing with curl

#### Step 1: Obtain a Token via client_credentials

**Entra ID:**

```bash
TOKEN=$(curl -s -X POST \
  "https://login.microsoftonline.com/{tenant-id}/oauth2/v2.0/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id={client-app-id}" \
  -d "client_secret={client-app-secret}" \
  -d "scope=api://{api-client-id}/.default" | jq -r '.access_token')

echo $TOKEN
```

**Auth0:**

```bash
TOKEN=$(curl -s -X POST \
  "https://{domain}/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id={client-id}" \
  -d "client_secret={client-secret}" \
  -d "audience=https://api.yourdomain.com" | jq -r '.access_token')

echo $TOKEN
```

**Keycloak:**

```bash
TOKEN=$(curl -s -X POST \
  "https://{server}/realms/{realm}/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=test-client" \
  -d "client_secret={client-secret}" \
  -d "scope=api.read api.write" | jq -r '.access_token')

echo $TOKEN
```

#### Step 2: Inspect the Token

```bash
# Decode the JWT payload (no verification, just inspection)
echo $TOKEN | cut -d'.' -f2 | base64 -d 2>/dev/null | jq .

# Check token expiration
echo $TOKEN | cut -d'.' -f2 | base64 -d 2>/dev/null | jq '.exp' | xargs -I{} date -r {}
```

#### Step 3: Call a Protected Endpoint

```bash
# Should return 200
curl -s -X POST http://localhost:8123/assistants/search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{}' | jq .
```

#### Step 4: Verify Public Endpoints Are Accessible Without Token

```bash
# Health check — should return 200
curl -s http://localhost:8123/ok | jq .
```

#### Step 5: Verify 401 Without Token

```bash
# Should return 401
curl -s -X POST http://localhost:8123/assistants/search \
  -H "Content-Type: application/json" \
  -d '{}' | jq .
```

#### Step 6: Verify 401 With Invalid Token

```bash
# Should return 401
curl -s -X POST http://localhost:8123/assistants/search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer invalid.token.here" \
  -d '{}' | jq .
```

#### Step 7: Verify 401 With Expired Token

```bash
# Use a previously captured token after its exp time has passed
curl -s -X POST http://localhost:8123/assistants/search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $EXPIRED_TOKEN" \
  -d '{}' | jq .
# Expected: {"error":"Unauthorized","message":"Token expired"}
```

---

## 7. Verification Checklist

After implementation, verify each of these items. Every item must pass before considering the implementation complete.

- [ ] **Server starts without errors** — `npm run dev` starts cleanly with all `OAUTH2_*` variables set
- [ ] **Server fails to start with missing config** — remove `OAUTH2_ISSUER` and confirm the app throws on startup
- [ ] **Health check accessible without token** — `curl -s http://localhost:8123/ok` returns 200
- [ ] **Swagger UI accessible without token** — `curl -s http://localhost:8123/docs` returns 200
- [ ] **Protected endpoint returns 401 without token** — `curl -s -X POST http://localhost:8123/assistants/search -H 'Content-Type: application/json' -d '{}'` returns 401
- [ ] **Protected endpoint returns 401 with expired token** — use an expired JWT, confirm 401 with "Token expired" message
- [ ] **Protected endpoint returns 401 with wrong audience** — obtain a token for a different audience, confirm 401
- [ ] **Protected endpoint returns 401 with wrong issuer** — craft or obtain a token from a different issuer, confirm 401
- [ ] **Protected endpoint returns 200 with valid token** — obtain a fresh token and confirm 200
- [ ] **Protected endpoint returns 403 with insufficient scope** — if scope checking is enabled, use a token lacking the required scope
- [ ] **JWKS keys are cached** — check server logs; after the first request, subsequent requests should not re-fetch JWKS
- [ ] **Token claims accessible in route handlers** — add a temporary debug endpoint that returns `request.user` and confirm claims are present
- [ ] **CORS preflight works** — `curl -X OPTIONS http://localhost:8123/assistants/search -H "Origin: https://app.example.com" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: Authorization" -v` returns CORS headers
- [ ] **Swagger UI shows security scheme** — open `/docs` and verify the "Authorize" button appears with Bearer token input
- [ ] **Unit tests pass** — `npx vitest run test_scripts/oauth2.test.ts` reports all green
- [ ] **TypeScript compilation clean** — `npx tsc --noEmit` reports no errors

---

## 8. Debugging Guide

### Error 1: "401 Unauthorized" on Every Request

**Symptom:** Every request to a protected endpoint returns 401, even with a valid token.

**Cause:** Configuration mismatch -- the issuer, audience, or JWKS URI is incorrect.

**Diagnosis:**

```bash
# 1. Decode the token to inspect claims
echo $TOKEN | cut -d'.' -f2 | base64 -d 2>/dev/null | jq '{ iss, aud, exp, scope }'

# 2. Compare with your environment variables
echo "OAUTH2_ISSUER=$OAUTH2_ISSUER"
echo "OAUTH2_AUDIENCE=$OAUTH2_AUDIENCE"

# 3. Check for trailing slash mismatch (common with Auth0)
# Auth0 issuer: "https://domain.auth0.com/" (trailing slash)
# Your config may have: "https://domain.auth0.com" (no trailing slash)

# 4. Verify JWKS is reachable
curl -s "$OAUTH2_JWKS_URI" | jq '.keys | length'
```

**Fix:** Ensure `OAUTH2_ISSUER` and `OAUTH2_AUDIENCE` exactly match the `iss` and `aud` claims in the token. Pay attention to trailing slashes, protocol (http vs https), and case sensitivity.

---

### Error 2: "invalid_token" Error

**Symptom:** IdP returns `invalid_token` or `invalid_grant` when requesting tokens.

**Cause:** Client credentials are incorrect, the client is not authorized for the API, or scopes are misconfigured.

**Diagnosis:**

```bash
# 1. Test token endpoint with verbose output
curl -v -X POST "$TOKEN_ENDPOINT" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET" \
  -d "scope=$SCOPE"

# 2. Check the error response body for details
# Common: "AADSTS700016: Application with identifier 'xxx' was not found"
# Meaning: Wrong client_id or wrong tenant
```

**Fix:** Verify client_id, client_secret, and scope. For Entra ID, ensure the client app has API permissions granted (and admin consent if required).

---

### Error 3: "Token expired" Despite Being Fresh (Clock Skew)

**Symptom:** A newly obtained token is rejected as expired.

**Cause:** The server clock is out of sync with the IdP clock.

**Diagnosis:**

```bash
# 1. Check server time
date -u +%s

# 2. Check token iat (issued at) time
echo $TOKEN | cut -d'.' -f2 | base64 -d 2>/dev/null | jq '.iat'

# 3. Compare -- difference should be < 60 seconds
# If the difference is large, your server clock is skewed

# 4. Check NTP status
timedatectl status   # Linux
sntp -S time.apple.com   # macOS
```

**Fix:** Increase `OAUTH2_CLOCK_TOLERANCE` to account for skew (e.g., 120 seconds). Also sync the server clock using NTP.

---

### Error 4: JWKS Fetch Fails (Network/Firewall)

**Symptom:** Server logs show errors fetching JWKS, all requests return 401.

**Cause:** The server cannot reach the JWKS endpoint due to network restrictions, proxy requirements, or DNS issues.

**Diagnosis:**

```bash
# 1. Test JWKS endpoint from the server
curl -v "$OAUTH2_JWKS_URI"

# 2. Check DNS resolution
nslookup login.microsoftonline.com  # or your IdP domain

# 3. Check if a proxy is required
echo $HTTP_PROXY
echo $HTTPS_PROXY

# 4. Check firewall rules
curl -s --connect-timeout 5 "$OAUTH2_JWKS_URI" || echo "FAILED: cannot reach JWKS"
```

**Fix:** Ensure the server has outbound HTTPS access to the IdP domain. Configure HTTP_PROXY/HTTPS_PROXY if behind a corporate proxy. Whitelist the IdP domain in firewall rules.

---

### Error 5: "Invalid audience" Error

**Symptom:** Token validation fails with audience mismatch.

**Cause:** The `aud` claim in the token does not match `OAUTH2_AUDIENCE`.

**Diagnosis:**

```bash
# 1. Inspect token audience
echo $TOKEN | cut -d'.' -f2 | base64 -d 2>/dev/null | jq '.aud'

# 2. Compare with configured audience
echo "Expected: $OAUTH2_AUDIENCE"
echo "Token has: $(echo $TOKEN | cut -d'.' -f2 | base64 -d 2>/dev/null | jq -r '.aud')"
```

**Fix:**

- **Entra ID:** The audience is typically `api://{client-id}`. Ensure the token was requested with `scope=api://{client-id}/.default`.
- **Auth0:** The audience must match the API Identifier. Ensure the `audience` parameter was passed in the token request.
- **Keycloak:** The audience may be the client ID or a configured audience mapper.

---

### Error 6: "Invalid issuer" Error

**Symptom:** Token validation fails with issuer mismatch.

**Cause:** The `iss` claim does not match `OAUTH2_ISSUER`.

**Diagnosis:**

```bash
# 1. Inspect token issuer
echo $TOKEN | cut -d'.' -f2 | base64 -d 2>/dev/null | jq '.iss'

# 2. Common mismatches:
# Entra ID v1 vs v2:
#   v1: https://sts.windows.net/{tenant-id}/
#   v2: https://login.microsoftonline.com/{tenant-id}/v2.0
# Auth0 trailing slash:
#   With: https://domain.auth0.com/
#   Without: https://domain.auth0.com
```

**Fix:** Copy the exact `iss` value from a decoded token and set it as `OAUTH2_ISSUER`. For Entra ID, ensure you are using the v2.0 endpoint consistently.

---

### Error 7: CORS Error When Sending Authorization Header

**Symptom:** Browser console shows CORS error. The preflight OPTIONS request fails.

**Cause:** The CORS configuration does not allow the `Authorization` header.

**Diagnosis:**

```bash
# Test preflight request
curl -v -X OPTIONS http://localhost:8123/assistants/search \
  -H "Origin: https://app.example.com" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: Authorization,Content-Type"

# Look for these response headers:
# Access-Control-Allow-Origin: https://app.example.com
# Access-Control-Allow-Headers: Authorization, Content-Type
# Access-Control-Allow-Methods: POST
```

**Fix:** Ensure CORS configuration includes `Authorization` in `allowedHeaders` and that OPTIONS requests bypass authentication (the plugin implementations above handle this).

```typescript
// Fastify CORS config
fastify.register(cors, {
  origin: ['https://app.example.com'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  credentials: true,
});
```

---

### Error 8: Token Works in Postman but Not from Frontend

**Symptom:** API calls work in Postman/curl but fail from a browser SPA.

**Cause:** Almost always a CORS issue. Browsers enforce CORS; Postman does not.

**Diagnosis:**

1. Open browser DevTools -> Network tab
2. Look for a failed OPTIONS preflight request
3. Check the response headers on the OPTIONS request
4. Verify `Access-Control-Allow-Origin` includes your frontend origin

**Fix:** See Error 7 above. Additionally, do not use `origin: '*'` (wildcard) with `credentials: true` -- browsers reject this combination.

---

### Error 9: Refresh Token Rejected

**Symptom:** `invalid_grant` error when attempting to refresh.

**Cause:** Refresh token has been revoked, expired, or was already used (rotation detected reuse).

**Diagnosis:**

```bash
# Attempt refresh and inspect the error
curl -v -X POST "$TOKEN_ENDPOINT" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token" \
  -d "refresh_token=$REFRESH_TOKEN" \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET"

# Look at the error_description field
```

**Fix:** If the refresh token was rotated and the old one was used, all tokens for that grant are revoked (security measure). Force the user to re-authenticate. Store the new refresh token immediately after each refresh.

---

### Error 10: "Key not found" After IdP Key Rotation

**Symptom:** `JWKSNoMatchingKey` or `No key found for kid: xyz`.

**Cause:** The IdP rotated signing keys. Cached JWKS does not contain the new `kid`.

**Diagnosis:**

```bash
# 1. Decode the token header to get the kid
echo $TOKEN | cut -d'.' -f1 | base64 -d 2>/dev/null | jq '.kid'

# 2. Fetch current JWKS and list all kids
curl -s "$OAUTH2_JWKS_URI" | jq '.keys[].kid'

# 3. Check if the token's kid is in the JWKS
# If not, the token was signed with an old key that has been removed
```

**Fix:** The `jose` library's `createRemoteJWKSet` and the `get-jwks` library both handle key rotation automatically by refetching JWKS when a `kid` mismatch occurs. If the issue persists, restart the server to clear any stale in-memory caches. Tokens signed with the old key that has been removed from JWKS cannot be validated -- they must expire naturally or clients must obtain new tokens.

---

## 9. Security Hardening

### Rate Limiting on Token Validation Failures

Protect against brute-force token guessing and denial-of-service attacks targeting the authentication layer.

```typescript
// src/middleware/auth-rate-limiter.ts

/**
 * Simple in-memory rate limiter for authentication failures.
 * Tracks failed attempts by client IP.
 */
export class AuthRateLimiter {
  private readonly failures: Map<string, { count: number; resetAt: number }> =
    new Map();
  private readonly maxFailures: number;
  private readonly windowMs: number;

  constructor(maxFailures: number, windowMs: number) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
  }

  /**
   * Record an authentication failure for the given IP.
   * Returns true if the IP should be blocked.
   */
  recordFailure(ip: string): boolean {
    const now = Date.now();
    const record = this.failures.get(ip);

    if (!record || record.resetAt < now) {
      this.failures.set(ip, { count: 1, resetAt: now + this.windowMs });
      return false;
    }

    record.count += 1;
    return record.count >= this.maxFailures;
  }

  /**
   * Check if the given IP is currently blocked.
   */
  isBlocked(ip: string): boolean {
    const record = this.failures.get(ip);
    if (!record) return false;
    if (record.resetAt < Date.now()) {
      this.failures.delete(ip);
      return false;
    }
    return record.count >= this.maxFailures;
  }

  /**
   * Reset failures for an IP (on successful authentication).
   */
  reset(ip: string): void {
    this.failures.delete(ip);
  }
}
```

**Recommended limits:**

| Context | Max Failures | Window |
|---------|-------------|--------|
| Authentication failures per IP | 10 | 5 minutes |
| Token refresh failures per client | 5 | 1 minute |
| Overall API rate limit | 1000 req/min | per IP |

### Token Size Limits

Reject tokens that exceed a reasonable size to prevent denial-of-service through oversized tokens.

```typescript
const MAX_TOKEN_SIZE = 8192; // 8 KB -- reasonable upper bound for JWT

function validateTokenSize(token: string): void {
  if (token.length > MAX_TOKEN_SIZE) {
    throw new OAuth2Error(401, 'Token exceeds maximum allowed size');
  }
}
```

### Logging -- What to Log and What NOT to Log

**DO log:**
- Authentication success/failure events (without the token)
- Client IP address
- Requested endpoint
- Token issuer and subject (not sensitive)
- Failure reason (expired, invalid signature, wrong audience, etc.)
- Timestamp

**DO NOT log:**
- The full access token (enables token replay attacks)
- Client secrets
- Refresh tokens
- Full Authorization header
- User passwords

```typescript
// Good logging practice
fastify.log.warn({
  event: 'auth_failure',
  reason: 'Token expired',
  ip: request.ip,
  path: request.url,
  issuer: decodedToken?.iss,
  subject: decodedToken?.sub,
});

// BAD -- never do this
// fastify.log.info({ token: request.headers.authorization });
```

### HTTPS Enforcement

In production, all OAuth2 communication must occur over HTTPS. Access tokens transmitted over HTTP are trivially interceptable.

```typescript
// Fastify hook to enforce HTTPS in production
fastify.addHook('onRequest', async (request, reply) => {
  if (
    process.env.NODE_ENV === 'production' &&
    request.headers['x-forwarded-proto'] !== 'https' &&
    !request.hostname.includes('localhost')
  ) {
    reply.code(421).send({
      error: 'HTTPS Required',
      message: 'This API requires HTTPS in production',
    });
  }
});
```

### Token Revocation Checking

For high-security operations, supplement local JWT validation with token introspection:

```typescript
async function introspectToken(
  introspectionEndpoint: string,
  token: string,
  clientId: string,
  clientSecret: string
): Promise<boolean> {
  const response = await fetch(introspectionEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ token }),
  });

  if (!response.ok) {
    return false;
  }

  const data = (await response.json()) as { active: boolean };
  return data.active === true;
}
```

### DPoP (Demonstrating Proof-of-Possession)

**When to use:** High-security environments where token theft/replay is a concern (financial APIs, healthcare, government).

**Overview:** DPoP binds an access token to a specific client key pair. Even if the token is stolen, it cannot be used without the private key.

**Client sends:**
1. `Authorization: DPoP <access_token>`
2. `DPoP: <signed-proof-jwt>` (contains HTTP method, URL, token hash)

**Server validates:**
1. Verify the DPoP proof JWT signature
2. Confirm `htm` (HTTP method) and `htu` (HTTP URL) match the request
3. Confirm `ath` (access token hash) matches the access token
4. Confirm the DPoP proof is fresh (not replayed)

DPoP is defined in RFC 9449. Implement it only when the threat model justifies the added complexity.

---

## 10. Configuration Reference

| Variable | Required | Description | How to Obtain | Example | Expiration |
|----------|---------|-------------|---------------|---------|------------|
| `OAUTH2_ENABLED` | Yes | Enable/disable OAuth2 authentication. Set to `"true"` to enable. | Developer decision | `true` | N/A |
| `OAUTH2_ISSUER` | When enabled | Expected `iss` claim value. Must exactly match the token issuer. | From IdP OpenID Connect discovery endpoint (`/.well-known/openid-configuration`) or IdP documentation | `https://login.microsoftonline.com/{tenant}/v2.0` | N/A |
| `OAUTH2_AUDIENCE` | When enabled | Expected `aud` claim value. Must match the API identifier registered in the IdP. | From IdP app registration (Entra ID: Application ID URI; Auth0: API Identifier; Keycloak: Client ID) | `api://{client-id}` | N/A |
| `OAUTH2_JWKS_URI` | When enabled | URL to the IdP's JWKS (JSON Web Key Set) endpoint. Used to fetch public keys for JWT signature verification. | From IdP OpenID Connect discovery endpoint, or construct from IdP docs | `https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys` | N/A |
| `OAUTH2_ALGORITHMS` | When enabled | Comma-separated list of allowed JWT signing algorithms. Restricts which algorithms are accepted to prevent algorithm confusion attacks. | Determined by IdP configuration; RS256 is the standard default | `RS256` | N/A |
| `OAUTH2_CLOCK_TOLERANCE` | When enabled | Clock skew tolerance in seconds for `exp` and `nbf` claim validation. Accounts for time differences between the IdP and the API server. | Recommended: 60 seconds. Increase if persistent clock-skew issues occur. | `60` | N/A |

**For integration testing, the following additional variables are needed:**

| Variable | Required | Description | How to Obtain | Example | Expiration |
|----------|---------|-------------|---------------|---------|------------|
| `OAUTH2_TEST_TOKEN_ENDPOINT` | For integration tests | The IdP's token endpoint URL | From IdP OpenID Connect discovery endpoint | `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` | N/A |
| `OAUTH2_TEST_CLIENT_ID` | For integration tests | Client ID of a test application registered in the IdP | Created during IdP setup (Section 2) | `abcdef-1234-...` | N/A |
| `OAUTH2_TEST_CLIENT_SECRET` | For integration tests | Client secret of the test application | Generated during IdP app registration | `secret-value` | **Yes** -- Entra ID: 24 months max; Auth0: no expiration; Keycloak: configurable. Track expiration and rotate proactively. |
| `OAUTH2_TEST_SCOPE` | For integration tests | Scopes to request when obtaining test tokens | Defined during API registration (Section 2) | `api://{client-id}/.default` | N/A |
| `OAUTH2_TEST_API_BASE` | For integration tests | Base URL of the running API server | Developer configuration | `http://localhost:8123` | N/A |

**Expiration Tracking Recommendation:**

For `OAUTH2_TEST_CLIENT_SECRET` (and any client secret used by the application), add an expiration-tracking environment variable:

```bash
OAUTH2_TEST_CLIENT_SECRET_EXPIRES=2028-03-14
```

Implement a startup warning:

```typescript
const secretExpires = process.env.OAUTH2_TEST_CLIENT_SECRET_EXPIRES;
if (secretExpires) {
  const expiresDate = new Date(secretExpires);
  const daysUntilExpiry = Math.floor(
    (expiresDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  );
  if (daysUntilExpiry <= 30) {
    console.warn(
      `[WARNING] OAuth2 test client secret expires in ${daysUntilExpiry} days (${secretExpires}). Renew it now.`
    );
  }
}
```

---

**Document Version:** 1.0
**Last Updated:** March 14, 2026
**Based on Research:** [investigation-oauth2-api-protection.md](investigation-oauth2-api-protection.md)
