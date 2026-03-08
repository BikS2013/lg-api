# Investigation: LangGraph Server API Replacement - TypeScript Implementation

**Document Version:** 1.0
**Date:** 2026-03-08
**Status:** Complete

---

## Executive Summary

This investigation analyzes the technical approaches for building a TypeScript API server that replicates the LangGraph Platform Server API. After comprehensive research of frameworks, libraries, and patterns, **Fastify with TypeBox** emerges as the recommended solution, offering superior OpenAPI generation, built-in TypeScript support, SSE streaming capabilities, and performance advantages over Express.js.

### Key Recommendation

**Primary Stack:**
- **Framework:** Fastify (v5.x)
- **Schema/Validation:** TypeBox with `@fastify/type-provider-typebox`
- **SSE Streaming:** `better-sse` library
- **OpenAPI Generation:** `@fastify/swagger` + `@fastify/swagger-ui`
- **Authentication:** Custom preHandler middleware for `X-Api-Key` validation
- **Data Layer:** Repository pattern with in-memory Map-based storage

**Why Fastify?**
1. Native TypeScript support and JSON Schema-first approach
2. Automatic OpenAPI 3.1 generation from route schemas
3. 3x performance advantage over Express (80k vs 25k req/s)
4. Built-in request/response validation with Ajv
5. Official TypeBox integration for type-safe schemas
6. Better compatibility with SSE streaming patterns

---

## 1. Framework Selection: Fastify vs Express 5.x

### Comparison Matrix

| Feature | Fastify | Express 5.x | Winner |
|---------|---------|-------------|--------|
| **TypeScript Support** | First-class, written in TypeScript | Official types available (new in v5) | Fastify |
| **OpenAPI Generation** | Automatic via `@fastify/swagger` | Manual (tsoa, swagger-jsdoc) | Fastify |
| **Schema Validation** | Built-in with Ajv, JSON Schema-first | Requires external libraries (Joi, Zod) | Fastify |
| **Performance** | 80,000 req/s | 25,000 req/s (3x slower) | Fastify |
| **SSE Streaming** | Compatible with better-sse, native support | Compatible with better-sse | Tie |
| **Middleware Ecosystem** | Growing, plugin-based | Massive, mature | Express |
| **Learning Curve** | Steeper (encapsulation model) | Gentle (familiar patterns) | Express |
| **API-First Development** | Excellent (schema-driven) | Good (decorator-driven with tsoa) | Fastify |
| **Community Maturity** | Mature, actively maintained | Very mature, widely adopted | Express |

### Detailed Analysis

#### Fastify Advantages

1. **Native JSON Schema & OpenAPI**: Fastify's route schemas automatically generate OpenAPI 3.1 specs via `@fastify/swagger`, eliminating documentation drift.

2. **TypeScript-First Design**: Written in TypeScript with excellent type inference from route schemas using TypeBox or json-schema-to-ts.

3. **Performance**: Consistently handles 3x more requests per second than Express in benchmarks (though absolute performance may not be critical for this use case).

4. **Validation Built-In**: Uses Ajv v8 for JSON Schema validation, providing both runtime safety and API documentation from a single source.

5. **Schema Reusability**: Schemas can be registered globally and referenced with `$ref`, matching LangGraph's pattern of shared types.

**Example Fastify Route with TypeBox:**

```typescript
import Fastify from 'fastify'
import { Type, TypeBoxTypeProvider } from '@fastify/type-provider-typebox'

const fastify = Fastify().withTypeProvider<TypeBoxTypeProvider>()

// Register shared schema
fastify.addSchema({
  $id: 'Assistant',
  type: 'object',
  properties: {
    assistant_id: Type.String({ format: 'uuid' }),
    graph_id: Type.String(),
    config: Type.Object({}),
    created_at: Type.String({ format: 'date-time' }),
    updated_at: Type.String({ format: 'date-time' }),
    metadata: Type.Object({})
  }
})

// Route with automatic OpenAPI generation
fastify.post('/assistants', {
  schema: {
    body: Type.Object({
      graph_id: Type.String(),
      assistant_id: Type.Optional(Type.String({ format: 'uuid' })),
      config: Type.Optional(Type.Object({})),
      metadata: Type.Optional(Type.Object({})),
      if_exists: Type.Optional(Type.Union([
        Type.Literal('raise'),
        Type.Literal('do_nothing')
      ]))
    }),
    response: {
      200: Type.Ref('Assistant')
    }
  }
}, async (request, reply) => {
  // Handler logic
  return {
    assistant_id: '...',
    // ...
  }
})
```

#### Express 5.x Considerations

1. **Ecosystem Maturity**: Express has the largest middleware ecosystem and most Stack Overflow answers.

2. **Team Familiarity**: If the team is more familiar with Express, this reduces risk.

3. **OpenAPI Tooling**: Requires additional tooling:
   - **tsoa**: Generates routes and OpenAPI from TypeScript decorators (recommended for new projects)
   - **swagger-jsdoc**: Generates OpenAPI from JSDoc comments (less type-safe)
   - **express-openapi-validator**: Validates requests against OpenAPI spec

**Example Express Route with tsoa:**

```typescript
import { Controller, Post, Body, Route, SuccessResponse } from 'tsoa'

interface CreateAssistantRequest {
  graph_id: string
  assistant_id?: string
  config?: Record<string, unknown>
  metadata?: Record<string, unknown>
  if_exists?: 'raise' | 'do_nothing'
}

@Route('assistants')
export class AssistantsController extends Controller {
  @Post()
  @SuccessResponse(200, 'Created')
  public async createAssistant(
    @Body() body: CreateAssistantRequest
  ): Promise<Assistant> {
    // Handler logic
  }
}
```

### Recommendation Rationale

**Choose Fastify** for this project because:

1. The project is API-first with 45+ endpoints requiring accurate OpenAPI documentation
2. Schema-driven development aligns with LangGraph's TypedDict/interface-based approach
3. No existing Express codebase to migrate
4. TypeScript is a hard requirement
5. Performance benefits are a bonus, not the primary driver

---

## 2. Schema Definition & Validation Approach

### Options Comparison

| Approach | TypeBox + Fastify | Zod + Fastify | Manual OpenAPI + Ajv |
|----------|-------------------|---------------|----------------------|
| **Type Safety** | Excellent (inferred) | Excellent (inferred) | Manual TypeScript types |
| **OpenAPI Generation** | Automatic | Via plugins (fastify-type-provider-zod) | Manual spec writing |
| **Runtime Validation** | Very fast (Ajv) | Slower than TypeBox | Fast (Ajv) |
| **JSON Schema Compatibility** | Native (generates JSON Schema) | Requires conversion | Native |
| **Learning Curve** | Moderate | Easy (fluent API) | Steep |
| **Community Support** | Official Fastify plugin | Third-party plugin | Standard |

### Recommendation: TypeBox with `@fastify/type-provider-typebox`

**Why TypeBox:**

1. **JSON Schema-First**: TypeBox generates JSON Schema objects that are 100% compatible with OpenAPI 3.1, which is required for the LangGraph API.

2. **Performance**: TypeBox uses Ajv under the hood, providing extremely fast validation (critical for high-throughput APIs).

3. **Official Fastify Support**: `@fastify/type-provider-typebox` is an official Fastify plugin (120k+ weekly downloads).

4. **OpenAPI Compatibility**: The project requirement explicitly mentions OpenAPI generation; TypeBox's JSON Schema output maps directly to OpenAPI schemas.

5. **Type Inference**: TypeBox provides excellent TypeScript type inference:

```typescript
import { Static, Type } from '@sinclair/typebox'

const AssistantSchema = Type.Object({
  assistant_id: Type.String({ format: 'uuid' }),
  graph_id: Type.String(),
  config: Type.Object({}),
  metadata: Type.Object({})
})

// Automatically inferred TypeScript type
type Assistant = Static<typeof AssistantSchema>
```

**When to Consider Zod:**

If the team is already familiar with Zod from frontend work (React Hook Form, tRPC), the `fastify-type-provider-zod` plugin provides compatibility. However, TypeBox's alignment with JSON Schema makes it the better choice for API-centric projects.

### Schema Organization Pattern

**Recommended structure:**

```
src/
├── schemas/
│   ├── common.schema.ts       # Shared types (Config, Metadata, etc.)
│   ├── assistant.schema.ts    # Assistant-related schemas
│   ├── thread.schema.ts       # Thread-related schemas
│   ├── run.schema.ts          # Run-related schemas
│   ├── cron.schema.ts         # Cron-related schemas
│   └── store.schema.ts        # Store-related schemas
```

**Example schema file:**

```typescript
// schemas/assistant.schema.ts
import { Type, Static } from '@sinclair/typebox'
import { ConfigSchema, MetadataSchema } from './common.schema'

export const CreateAssistantRequestSchema = Type.Object({
  graph_id: Type.String(),
  assistant_id: Type.Optional(Type.String({ format: 'uuid' })),
  config: Type.Optional(ConfigSchema),
  context: Type.Optional(Type.Object({})),
  metadata: Type.Optional(MetadataSchema),
  if_exists: Type.Optional(Type.Union([
    Type.Literal('raise'),
    Type.Literal('do_nothing')
  ], { default: 'raise' })),
  name: Type.Optional(Type.String()),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()]))
})

export const AssistantSchema = Type.Object({
  assistant_id: Type.String({ format: 'uuid' }),
  graph_id: Type.String(),
  config: ConfigSchema,
  context: Type.Optional(Type.Object({})),
  created_at: Type.String({ format: 'date-time' }),
  updated_at: Type.String({ format: 'date-time' }),
  metadata: MetadataSchema,
  version: Type.Integer(),
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()])
})

export type CreateAssistantRequest = Static<typeof CreateAssistantRequestSchema>
export type Assistant = Static<typeof AssistantSchema>
```

---

## 3. SSE Streaming Implementation

### Requirements Analysis

The LangGraph API requires SSE streaming with:
- Multiple stream modes (`values`, `updates`, `messages`, `events`, `debug`, `custom`, `tasks`, `checkpoints`, `messages-tuple`)
- Metadata event at stream start
- End event at stream completion
- Error events on failures
- Reconnection support via `Last-Event-ID` header
- Multiple concurrent stream modes in a single request

### Recommended Library: `better-sse`

**Why better-sse:**

1. **TypeScript-Native**: Written in TypeScript with built-in type definitions
2. **Spec-Compliant**: Fully implements the SSE specification
3. **Framework-Agnostic**: Works with any Node.js framework (Express, Fastify, etc.)
4. **Zero Dependencies**: No external dependencies
5. **Reconnection Support**: Built-in support for `Last-Event-ID` handling
6. **Channels**: Broadcast to multiple clients
7. **Keep-Alive**: Automatic ping/keep-alive mechanism
8. **Event Buffering**: Batch events for performance

**Installation:**

```bash
npm install better-sse
```

**Implementation Pattern:**

```typescript
import { createSession, Session } from 'better-sse'
import { FastifyRequest, FastifyReply } from 'fastify'

interface StreamOptions {
  stream_mode?: string[]
  last_event_id?: string
}

async function streamRunHandler(
  request: FastifyRequest<{ Params: { thread_id: string, run_id: string }, Querystring: StreamOptions }>,
  reply: FastifyReply
) {
  const { thread_id, run_id } = request.params
  const { stream_mode = ['values'], last_event_id } = request.query

  // Create SSE session
  const session: Session = await createSession(request, reply)

  try {
    // Send metadata event
    await session.push({
      event: 'metadata',
      data: JSON.stringify({
        run_id,
        thread_id,
        stream_mode
      }),
      id: '1'
    })

    // Simulate streaming events based on stream_mode
    let eventId = 2

    for (const mode of stream_mode) {
      if (mode === 'values') {
        await session.push({
          event: 'values',
          data: JSON.stringify({
            messages: [{ role: 'assistant', content: 'Response...' }]
          }),
          id: String(eventId++)
        })
      }

      if (mode === 'updates') {
        await session.push({
          event: 'updates',
          data: JSON.stringify({
            node: 'agent',
            output: { message: 'Processing...' }
          }),
          id: String(eventId++)
        })
      }

      // Handle other stream modes...
    }

    // Send end event
    await session.push({
      event: 'end',
      data: null,
      id: String(eventId++)
    })
  } catch (error) {
    // Send error event
    await session.push({
      event: 'error',
      data: JSON.stringify({
        message: error.message
      }),
      id: String(eventId++)
    })
  } finally {
    // Close session
    await session.close()
  }
}

// Fastify route registration
fastify.get('/threads/:thread_id/runs/:run_id/stream', {
  schema: {
    params: Type.Object({
      thread_id: Type.String({ format: 'uuid' }),
      run_id: Type.String({ format: 'uuid' })
    }),
    querystring: Type.Object({
      stream_mode: Type.Optional(Type.Array(Type.String())),
      last_event_id: Type.Optional(Type.String())
    })
  }
}, streamRunHandler)
```

### SSE Event Format

The LangGraph SDK expects events in this format:

```
event: metadata
data: {"run_id": "..."}
id: 1

event: values
data: {"messages": [...]}
id: 2

event: updates
data: {"node": "agent", "output": {...}}
id: 3

event: end
data: null
id: 4
```

### Reconnection Handling

```typescript
// Handle reconnection with Last-Event-ID
async function handleReconnection(session: Session, last_event_id?: string) {
  if (last_event_id) {
    // Retrieve events after last_event_id from buffer/storage
    const missedEvents = await getEventsAfter(last_event_id)

    for (const event of missedEvents) {
      await session.push(event)
    }
  }
}
```

### Alternative: Fastify SSE Plugin

Fastify also has an official SSE plugin (`@fastify/sse`), but `better-sse` is recommended because:
- More mature and feature-complete
- Better TypeScript support
- More flexible API for complex streaming scenarios
- Better reconnection handling

---

## 4. LangGraph SDK Source Analysis

### Key Findings from LangGraph Documentation

#### API Structure

The LangGraph Platform API (renamed to LangSmith Deployment as of October 2025) exposes 5 primary endpoint groups:

1. **Assistants** (11 endpoints) - Configured instances of a graph
2. **Threads** (12 endpoints) - Accumulated outputs of a group of runs
3. **Runs** (14 endpoints) - Invocations of a graph/assistant
4. **Crons** (6 endpoints) - Periodic runs on a schedule
5. **Store** (5 endpoints) - Persistent key-value store

#### Authentication

All endpoints require `X-Api-Key` header authentication:

```bash
curl --request POST \
  --url http://localhost:8124/assistants/search \
  --header 'Content-Type: application/json' \
  --header 'X-Api-Key: LANGSMITH_API_KEY' \
  --data '{"metadata": {}, "limit": 10, "offset": 0}'
```

#### Key Data Models

**Assistant:**
```typescript
interface Assistant {
  assistant_id: string       // UUID
  graph_id: string
  config: Config
  context?: Record<string, unknown>
  created_at: string         // ISO 8601 date-time
  updated_at: string         // ISO 8601 date-time
  metadata: Record<string, unknown>
  version: number
  name: string
  description: string | null
}
```

**Thread:**
```typescript
interface Thread {
  thread_id: string          // UUID
  created_at: string         // ISO 8601 date-time
  updated_at: string         // ISO 8601 date-time
  metadata: Record<string, unknown>
  status: 'idle' | 'busy' | 'interrupted' | 'error'
  state_updated_at?: string
  config?: Config
  values?: Record<string, unknown>
  interrupts?: Interrupt[]
  ttl?: TTLInfo
}
```

**Run:**
```typescript
interface Run {
  run_id: string             // UUID
  thread_id: string          // UUID
  assistant_id: string       // UUID
  created_at: string         // ISO 8601 date-time
  updated_at: string         // ISO 8601 date-time
  status: 'pending' | 'running' | 'error' | 'success' | 'timeout' | 'interrupted'
  metadata: Record<string, unknown>
  multitask_strategy: 'reject' | 'interrupt' | 'rollback' | 'enqueue'
  kwargs?: Record<string, unknown>
}
```

**Config:**
```typescript
interface Config {
  tags?: string[]
  recursion_limit?: number
  configurable?: Record<string, unknown>
}
```

#### Pagination Headers

Search/list endpoints return pagination headers:

```
X-Pagination-Total: 42
X-Pagination-Offset: 0
X-Pagination-Limit: 10
```

#### Error Response Format

The LangGraph server returns errors in this format (inferred from SDK error handling):

```typescript
interface ErrorResponse {
  detail?: string            // Error message
  message?: string           // Alternative message field
  status?: number           // HTTP status code
}
```

HTTP status codes used:
- `200` - Success
- `204` - No Content (DELETE operations)
- `404` - Not Found
- `409` - Conflict (duplicate resource)
- `422` - Validation Error
- `500` - Internal Server Error

#### Stream Event Types

The LangGraph SDK supports these stream modes:
- `values` - Complete state after each step
- `updates` - Only the updates from each step
- `messages` - Message-specific updates
- `messages-tuple` - Messages as tuples
- `events` - All events during execution
- `debug` - Debug information
- `custom` - Custom events
- `tasks` - Task-level events
- `checkpoints` - Checkpoint events

### JavaScript SDK Client Interface

The `@langchain/langgraph-sdk` provides these client methods:

```typescript
// Client initialization
const client = new Client({
  apiUrl: 'http://localhost:8124',
  apiKey: 'LANGSMITH_API_KEY'
})

// Assistants
await client.assistants.create({ graph_id: '...', config: {} })
await client.assistants.get(assistant_id)
await client.assistants.search({ metadata: {}, limit: 10 })
await client.assistants.delete(assistant_id)

// Threads
await client.threads.create({ metadata: {} })
await client.threads.get(thread_id)
await client.threads.search({ status: 'idle' })
await client.threads.getState(thread_id)
await client.threads.updateState(thread_id, { values: {} })

// Runs
await client.runs.create(thread_id, assistant_id, { input: {} })
const stream = client.runs.stream(thread_id, assistant_id, { stream_mode: ['values'] })
for await (const event of stream) {
  console.log(event)
}
await client.runs.wait(thread_id, run_id)
await client.runs.cancel(thread_id, run_id)

// Crons
await client.crons.create(assistant_id, { schedule: '0 0 * * *' })
await client.crons.delete(cron_id)
await client.crons.search({ assistant_id })

// Store
await client.store.putItem(['namespace'], 'key', { value: 'data' })
await client.store.getItem(['namespace'], 'key')
await client.store.searchItems({ namespace_prefix: ['namespace'] })
```

---

## 5. Project Structure & Organization

### Recommended Structure for 45+ Endpoints

```
lg-api/
├── src/
│   ├── server.ts              # Server entry point
│   ├── app.ts                 # Fastify app configuration
│   ├── config/
│   │   └── env.config.ts      # Environment variable validation
│   ├── schemas/
│   │   ├── index.ts           # Schema exports
│   │   ├── common.schema.ts   # Shared schemas (Config, Metadata, Pagination, etc.)
│   │   ├── assistant.schema.ts
│   │   ├── thread.schema.ts
│   │   ├── run.schema.ts
│   │   ├── cron.schema.ts
│   │   └── store.schema.ts
│   ├── types/
│   │   └── index.ts           # Type exports from schemas
│   ├── plugins/
│   │   ├── auth.plugin.ts     # Authentication middleware
│   │   ├── cors.plugin.ts     # CORS configuration
│   │   ├── swagger.plugin.ts  # OpenAPI/Swagger setup
│   │   └── error-handler.plugin.ts
│   ├── middleware/
│   │   └── api-key-auth.ts    # X-Api-Key validation
│   ├── modules/
│   │   ├── assistants/
│   │   │   ├── assistants.routes.ts
│   │   │   ├── assistants.controller.ts
│   │   │   ├── assistants.service.ts
│   │   │   └── assistants.repository.ts
│   │   ├── threads/
│   │   │   ├── threads.routes.ts
│   │   │   ├── threads.controller.ts
│   │   │   ├── threads.service.ts
│   │   │   └── threads.repository.ts
│   │   ├── runs/
│   │   │   ├── runs.routes.ts
│   │   │   ├── runs.controller.ts
│   │   │   ├── runs.service.ts
│   │   │   ├── runs.repository.ts
│   │   │   └── runs.streaming.ts    # SSE streaming logic
│   │   ├── crons/
│   │   │   ├── crons.routes.ts
│   │   │   ├── crons.controller.ts
│   │   │   ├── crons.service.ts
│   │   │   └── crons.repository.ts
│   │   ├── store/
│   │   │   ├── store.routes.ts
│   │   │   ├── store.controller.ts
│   │   │   ├── store.service.ts
│   │   │   └── store.repository.ts
│   │   └── system/
│   │       └── system.routes.ts     # /ok, /info endpoints
│   ├── repositories/
│   │   ├── base.repository.ts       # Abstract repository interface
│   │   └── in-memory.repository.ts  # In-memory Map implementation
│   ├── utils/
│   │   ├── uuid.util.ts
│   │   ├── date.util.ts
│   │   └── pagination.util.ts
│   └── errors/
│       ├── api-error.ts
│       └── error-codes.ts
├── test/
│   ├── integration/
│   │   ├── assistants.test.ts
│   │   ├── threads.test.ts
│   │   └── sdk-compatibility.test.ts
│   └── unit/
│       ├── services/
│       └── repositories/
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

### Module Pattern

Each module (assistants, threads, runs, crons, store) follows this pattern:

**routes.ts** - Route registration with schemas
```typescript
import { FastifyInstance } from 'fastify'
import { AssistantsController } from './assistants.controller'
import { CreateAssistantRequestSchema, AssistantSchema } from '../../schemas/assistant.schema'

export async function assistantsRoutes(fastify: FastifyInstance) {
  const controller = new AssistantsController(fastify)

  fastify.post('/assistants', {
    schema: {
      body: CreateAssistantRequestSchema,
      response: {
        200: AssistantSchema
      }
    },
    preHandler: fastify.authenticate  // Auth middleware
  }, controller.create)

  fastify.get('/assistants/:assistant_id', {
    schema: {
      params: Type.Object({
        assistant_id: Type.String({ format: 'uuid' })
      }),
      response: {
        200: AssistantSchema,
        404: ErrorResponseSchema
      }
    },
    preHandler: fastify.authenticate
  }, controller.get)

  // More routes...
}
```

**controller.ts** - Request/response handling
```typescript
import { FastifyRequest, FastifyReply } from 'fastify'
import { AssistantsService } from './assistants.service'
import { CreateAssistantRequest, Assistant } from '../../types'

export class AssistantsController {
  private service: AssistantsService

  constructor(fastify: FastifyInstance) {
    this.service = new AssistantsService(fastify)
  }

  create = async (
    request: FastifyRequest<{ Body: CreateAssistantRequest }>,
    reply: FastifyReply
  ): Promise<Assistant> => {
    const assistant = await this.service.create(request.body)
    return reply.code(200).send(assistant)
  }

  get = async (
    request: FastifyRequest<{ Params: { assistant_id: string } }>,
    reply: FastifyReply
  ): Promise<Assistant> => {
    const assistant = await this.service.get(request.params.assistant_id)
    if (!assistant) {
      return reply.code(404).send({ detail: 'Assistant not found' })
    }
    return reply.send(assistant)
  }

  // More handlers...
}
```

**service.ts** - Business logic
```typescript
import { AssistantsRepository } from './assistants.repository'
import { CreateAssistantRequest, Assistant } from '../../types'
import { v4 as uuidv4 } from 'uuid'

export class AssistantsService {
  private repository: AssistantsRepository

  constructor() {
    this.repository = new AssistantsRepository()
  }

  async create(request: CreateAssistantRequest): Promise<Assistant> {
    const assistant_id = request.assistant_id || uuidv4()

    // Check if_exists behavior
    if (request.if_exists === 'do_nothing') {
      const existing = await this.repository.findById(assistant_id)
      if (existing) return existing
    }

    const assistant: Assistant = {
      assistant_id,
      graph_id: request.graph_id,
      config: request.config || {},
      context: request.context,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: request.metadata || {},
      version: 1,
      name: request.name || 'Untitled',
      description: request.description || null
    }

    await this.repository.save(assistant)
    return assistant
  }

  async get(assistant_id: string): Promise<Assistant | null> {
    return this.repository.findById(assistant_id)
  }

  // More methods...
}
```

**repository.ts** - Data access
```typescript
import { BaseRepository } from '../../repositories/base.repository'
import { Assistant } from '../../types'

export class AssistantsRepository extends BaseRepository<Assistant> {
  constructor() {
    super('assistants')
  }

  async findByGraphId(graph_id: string): Promise<Assistant[]> {
    return this.findMany((assistant) => assistant.graph_id === graph_id)
  }

  // More data access methods...
}
```

### Key Design Principles

1. **Separation of Concerns**: Routes handle HTTP concerns, controllers orchestrate, services contain business logic, repositories manage data.

2. **Dependency Injection**: Controllers receive dependencies via constructor, making them testable.

3. **Schema Co-location**: Keep schemas in a central location for reuse and OpenAPI generation.

4. **Module Encapsulation**: Each module is self-contained with its own routes, controller, service, and repository.

5. **Type Safety**: TypeScript types are derived from schemas, ensuring runtime and compile-time alignment.

---

## 6. In-Memory Store Pattern

### Repository Pattern with Replaceable Persistence

The repository pattern provides an abstraction layer between business logic and data storage, making it easy to swap in-memory storage for a database later.

### Base Repository Interface

```typescript
// repositories/base.repository.ts
export interface IRepository<T> {
  findById(id: string): Promise<T | null>
  findMany(filter: (item: T) => boolean): Promise<T[]>
  save(item: T): Promise<T>
  update(id: string, updates: Partial<T>): Promise<T | null>
  delete(id: string): Promise<boolean>
  count(filter?: (item: T) => boolean): Promise<number>
  search(options: SearchOptions<T>): Promise<SearchResult<T>>
}

export interface SearchOptions<T> {
  filter?: (item: T) => boolean
  limit?: number
  offset?: number
  sort_by?: keyof T
  sort_order?: 'asc' | 'desc'
}

export interface SearchResult<T> {
  items: T[]
  total: number
  offset: number
  limit: number
}
```

### In-Memory Implementation

```typescript
// repositories/in-memory.repository.ts
export class InMemoryRepository<T extends { [key: string]: any }> implements IRepository<T> {
  protected store: Map<string, T>
  protected idField: string

  constructor(idField: string = 'id') {
    this.store = new Map()
    this.idField = idField
  }

  async findById(id: string): Promise<T | null> {
    return this.store.get(id) || null
  }

  async findMany(filter: (item: T) => boolean): Promise<T[]> {
    const items = Array.from(this.store.values())
    return items.filter(filter)
  }

  async save(item: T): Promise<T> {
    const id = item[this.idField]
    if (!id) {
      throw new Error(`Item missing ${this.idField} field`)
    }
    this.store.set(id, item)
    return item
  }

  async update(id: string, updates: Partial<T>): Promise<T | null> {
    const existing = this.store.get(id)
    if (!existing) return null

    const updated = { ...existing, ...updates }
    this.store.set(id, updated)
    return updated
  }

  async delete(id: string): Promise<boolean> {
    return this.store.delete(id)
  }

  async count(filter?: (item: T) => boolean): Promise<number> {
    if (!filter) return this.store.size

    const items = Array.from(this.store.values())
    return items.filter(filter).length
  }

  async search(options: SearchOptions<T>): Promise<SearchResult<T>> {
    let items = Array.from(this.store.values())

    // Apply filter
    if (options.filter) {
      items = items.filter(options.filter)
    }

    // Apply sorting
    if (options.sort_by) {
      items.sort((a, b) => {
        const aVal = a[options.sort_by!]
        const bVal = b[options.sort_by!]
        const compare = aVal > bVal ? 1 : aVal < bVal ? -1 : 0
        return options.sort_order === 'desc' ? -compare : compare
      })
    }

    const total = items.length
    const offset = options.offset || 0
    const limit = options.limit || 100

    // Apply pagination
    items = items.slice(offset, offset + limit)

    return { items, total, offset, limit }
  }
}

// Base repository with in-memory implementation
export abstract class BaseRepository<T extends { [key: string]: any }> {
  protected repo: InMemoryRepository<T>

  constructor(idField: string) {
    this.repo = new InMemoryRepository<T>(idField)
  }

  async findById(id: string): Promise<T | null> {
    return this.repo.findById(id)
  }

  async save(item: T): Promise<T> {
    return this.repo.save(item)
  }

  async update(id: string, updates: Partial<T>): Promise<T | null> {
    return this.repo.update(id, updates)
  }

  async delete(id: string): Promise<boolean> {
    return this.repo.delete(id)
  }

  async findMany(filter: (item: T) => boolean): Promise<T[]> {
    return this.repo.findMany(filter)
  }

  async count(filter?: (item: T) => boolean): Promise<number> {
    return this.repo.count(filter)
  }

  async search(options: SearchOptions<T>): Promise<SearchResult<T>> {
    return this.repo.search(options)
  }
}
```

### Usage Example

```typescript
// modules/assistants/assistants.repository.ts
export class AssistantsRepository extends BaseRepository<Assistant> {
  constructor() {
    super('assistant_id')  // ID field name
  }

  async findByGraphId(graph_id: string): Promise<Assistant[]> {
    return this.findMany((assistant) => assistant.graph_id === graph_id)
  }

  async searchWithMetadata(metadata: Record<string, unknown>): Promise<Assistant[]> {
    return this.findMany((assistant) => {
      return Object.entries(metadata).every(([key, value]) => {
        return assistant.metadata[key] === value
      })
    })
  }
}
```

### Database Migration Path

When ready to replace in-memory storage with PostgreSQL:

1. **Create database repository implementation:**

```typescript
// repositories/postgres.repository.ts
import { Pool } from 'pg'

export class PostgresRepository<T> implements IRepository<T> {
  constructor(
    private pool: Pool,
    private tableName: string,
    private idField: string
  ) {}

  async findById(id: string): Promise<T | null> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tableName} WHERE ${this.idField} = $1`,
      [id]
    )
    return result.rows[0] || null
  }

  // Implement other methods...
}
```

2. **Swap implementation via dependency injection:**

```typescript
// In service or controller initialization
const repository = process.env.USE_DATABASE === 'true'
  ? new PostgresAssistantsRepository(pool)
  : new InMemoryAssistantsRepository()
```

3. **No changes to business logic required** - services and controllers remain unchanged.

---

## 7. Authentication Middleware

### X-Api-Key Header Pattern

```typescript
// middleware/api-key-auth.ts
import { FastifyRequest, FastifyReply } from 'fastify'
import { config } from '../config/env.config'

export async function apiKeyAuthMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (!config.authEnabled) {
    return // Auth disabled
  }

  const apiKey = request.headers['x-api-key']

  if (!apiKey) {
    return reply.code(401).send({
      detail: 'Missing X-Api-Key header'
    })
  }

  if (apiKey !== config.apiKey) {
    return reply.code(401).send({
      detail: 'Invalid API key'
    })
  }

  // Auth successful
}

// Plugin registration
// plugins/auth.plugin.ts
import fp from 'fastify-plugin'
import { FastifyInstance } from 'fastify'
import { apiKeyAuthMiddleware } from '../middleware/api-key-auth'

export default fp(async (fastify: FastifyInstance) => {
  fastify.decorate('authenticate', apiKeyAuthMiddleware)
})

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: typeof apiKeyAuthMiddleware
  }
}
```

### Apply to Routes

```typescript
// Apply to all routes in a module
fastify.register(async (instance) => {
  instance.addHook('preHandler', instance.authenticate)

  instance.post('/assistants', assistantsController.create)
  instance.get('/assistants/:id', assistantsController.get)
  // ...
})

// Apply to specific routes
fastify.get('/assistants/:id', {
  preHandler: [fastify.authenticate]
}, assistantsController.get)
```

---

## 8. Configuration Management

### Environment Variable Validation

Per project requirements, all configuration must be provided via environment variables with NO fallback values.

```typescript
// config/env.config.ts
import { Type, Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

const ConfigSchema = Type.Object({
  LG_API_PORT: Type.Number({ minimum: 1, maximum: 65535 }),
  LG_API_HOST: Type.String(),
  LG_API_AUTH_ENABLED: Type.Boolean(),
  LG_API_KEY: Type.Optional(Type.String()),  // Required only when auth enabled
  NODE_ENV: Type.Union([
    Type.Literal('development'),
    Type.Literal('production'),
    Type.Literal('test')
  ])
})

type Config = Static<typeof ConfigSchema>

function loadConfig(): Config {
  const rawConfig = {
    LG_API_PORT: process.env.LG_API_PORT ? parseInt(process.env.LG_API_PORT, 10) : undefined,
    LG_API_HOST: process.env.LG_API_HOST,
    LG_API_AUTH_ENABLED: process.env.LG_API_AUTH_ENABLED === 'true',
    LG_API_KEY: process.env.LG_API_KEY,
    NODE_ENV: process.env.NODE_ENV || 'development'
  }

  // Validate required fields
  const requiredFields = ['LG_API_PORT', 'LG_API_HOST', 'LG_API_AUTH_ENABLED']
  const missing = requiredFields.filter(field => rawConfig[field as keyof typeof rawConfig] === undefined)

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
  }

  // Validate auth-specific requirements
  if (rawConfig.LG_API_AUTH_ENABLED && !rawConfig.LG_API_KEY) {
    throw new Error('LG_API_KEY is required when LG_API_AUTH_ENABLED is true')
  }

  // Validate against schema
  if (!Value.Check(ConfigSchema, rawConfig)) {
    const errors = [...Value.Errors(ConfigSchema, rawConfig)]
    throw new Error(`Invalid configuration: ${JSON.stringify(errors)}`)
  }

  return rawConfig as Config
}

export const config = loadConfig()
```

### .env.example

```bash
# Server Configuration
LG_API_PORT=8124
LG_API_HOST=0.0.0.0

# Authentication
LG_API_AUTH_ENABLED=true
LG_API_KEY=your-api-key-here

# Environment
NODE_ENV=development
```

---

## 9. OpenAPI/Swagger Documentation

### Fastify Swagger Setup

```typescript
// plugins/swagger.plugin.ts
import fp from 'fastify-plugin'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { FastifyInstance } from 'fastify'
import { config } from '../config/env.config'

export default fp(async (fastify: FastifyInstance) => {
  await fastify.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'LangGraph API Replacement',
        description: 'Drop-in replacement for LangGraph Platform Server API',
        version: '1.0.0'
      },
      servers: [
        {
          url: `http://${config.LG_API_HOST}:${config.LG_API_PORT}`,
          description: 'Development server'
        }
      ],
      tags: [
        { name: 'Assistants', description: 'Assistant management endpoints' },
        { name: 'Threads', description: 'Thread management endpoints' },
        { name: 'Runs', description: 'Run execution endpoints' },
        { name: 'Crons', description: 'Scheduled run endpoints' },
        { name: 'Store', description: 'Key-value store endpoints' },
        { name: 'System', description: 'System health and info endpoints' }
      ],
      components: {
        securitySchemes: {
          ApiKeyAuth: {
            type: 'apiKey',
            name: 'X-Api-Key',
            in: 'header'
          }
        }
      },
      security: [
        { ApiKeyAuth: [] }
      ]
    }
  })

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true
    },
    staticCSP: true,
    transformStaticCSP: (header) => header
  })
})
```

### Route Documentation

Schemas automatically generate OpenAPI documentation:

```typescript
fastify.post('/assistants', {
  schema: {
    description: 'Create a new assistant',
    tags: ['Assistants'],
    body: CreateAssistantRequestSchema,
    response: {
      200: {
        description: 'Assistant created successfully',
        ...AssistantSchema
      },
      409: {
        description: 'Assistant already exists',
        ...ErrorResponseSchema
      },
      422: {
        description: 'Validation error',
        ...ErrorResponseSchema
      }
    }
  }
}, handler)
```

This generates OpenAPI spec automatically accessible at `/docs`.

---

## 10. Options Analysis Summary

### Framework Decision Matrix

| Factor | Weight | Fastify Score | Express Score | Winner |
|--------|--------|---------------|---------------|--------|
| OpenAPI Auto-generation | 10 | 10 | 5 | Fastify |
| TypeScript Support | 9 | 10 | 7 | Fastify |
| Schema Validation | 8 | 10 | 6 | Fastify |
| SSE Streaming | 7 | 9 | 9 | Tie |
| Performance | 5 | 10 | 7 | Fastify |
| Learning Curve | 6 | 6 | 9 | Express |
| Ecosystem | 7 | 7 | 10 | Express |
| **Weighted Total** | | **8.7** | **7.5** | **Fastify** |

### Schema Approach Decision Matrix

| Factor | Weight | TypeBox Score | Zod Score | Manual Score | Winner |
|--------|--------|---------------|-----------|--------------|--------|
| OpenAPI Compatibility | 10 | 10 | 7 | 10 | TypeBox/Manual |
| Type Safety | 9 | 9 | 10 | 5 | Zod |
| Validation Performance | 8 | 10 | 6 | 10 | TypeBox/Manual |
| Developer Experience | 7 | 7 | 10 | 4 | Zod |
| Fastify Integration | 8 | 10 | 7 | 8 | TypeBox |
| **Weighted Total** | | **9.1** | **7.8** | **7.6** | **TypeBox** |

---

## 11. Implementation Roadmap

### Phase 1: Foundation (Week 1)

1. **Project Setup**
   - Initialize TypeScript project with Fastify
   - Configure tsconfig.json (strict mode)
   - Install dependencies: `@fastify/swagger`, `@fastify/swagger-ui`, `@fastify/type-provider-typebox`, `better-sse`
   - Set up environment configuration validation
   - Create project structure

2. **Core Infrastructure**
   - Implement base repository pattern
   - Create authentication middleware
   - Set up OpenAPI/Swagger documentation
   - Implement error handling

### Phase 2: Data Models (Week 2)

3. **Schema Definition**
   - Define TypeBox schemas for all data models (Assistant, Thread, Run, Cron, Store)
   - Create shared schemas (Config, Metadata, Pagination)
   - Export TypeScript types from schemas

### Phase 3: Assistants API (Week 2-3)

4. **Assistants Module**
   - Implement all 11 Assistant endpoints
   - Create routes, controller, service, repository
   - Add stub response generation
   - Write unit tests

### Phase 4: Threads API (Week 3-4)

5. **Threads Module**
   - Implement all 12 Thread endpoints
   - Handle thread state management (dummy)
   - Implement pagination
   - Write unit tests

### Phase 5: Runs API (Week 4-5)

6. **Runs Module**
   - Implement all 14 Run endpoints (including streaming)
   - Implement SSE streaming with `better-sse`
   - Support multiple stream modes
   - Handle reconnection with Last-Event-ID
   - Write unit tests

### Phase 6: Crons & Store APIs (Week 5-6)

7. **Crons Module**
   - Implement all 6 Cron endpoints
   - Write unit tests

8. **Store Module**
   - Implement all 5 Store endpoints
   - Write unit tests

### Phase 7: System & Testing (Week 6)

9. **System Endpoints**
   - Implement `/ok` health check
   - Implement `/info` endpoint

10. **Integration Testing**
    - Test with LangGraph Python SDK
    - Test with LangGraph JavaScript SDK
    - Verify OpenAPI spec accuracy
    - Performance testing

### Phase 8: Documentation (Week 7)

11. **Documentation**
    - Complete API documentation
    - Write deployment guide
    - Create configuration guide
    - Document SDK compatibility

---

## 12. Assumptions & Scope

### Assumptions Made

| Assumption | Confidence | Impact if Wrong |
|------------|------------|-----------------|
| Fastify's JSON Schema approach aligns with LangGraph's TypedDict schemas | HIGH | Minor - schemas would need restructuring |
| TypeBox provides sufficient type expressiveness for all LangGraph types | HIGH | Medium - may need custom transformers |
| better-sse handles all SSE requirements (multi-mode, reconnection) | MEDIUM | Medium - may need custom SSE implementation |
| LangGraph SDK error responses follow standard format | MEDIUM | Low - error format can be adjusted |
| In-memory Map storage is acceptable for initial stub implementation | HIGH | None - this is per requirements |
| Configuration via environment variables is sufficient | HIGH | None - this is per project convention |
| OpenAPI 3.1 is compatible with LangGraph SDK expectations | HIGH | Low - can generate 3.0 if needed |
| No WebSocket support required (SSE only) | MEDIUM | High - would require additional implementation |

### Uncertainties & Gaps

1. **Exact error response format**: LangGraph server error responses need reverse-engineering from SDK error handling. **Resolution:** Implement standard format, iterate based on SDK testing.

2. **Streaming event payload structures**: While event types are documented, exact payload structures for each stream mode need verification. **Resolution:** Test with SDK, adjust payloads accordingly.

3. **Multitask strategy enforcement**: Unclear if stub should maintain realistic state transitions. **Resolution:** Accept parameters, return appropriate status, skip execution logic.

4. **Thread status transitions**: Should stub maintain `idle` -> `busy` -> `idle` transitions? **Resolution:** Implement basic transitions for realism, document in stub engine.

5. **Webhook delivery**: Should stub acknowledge webhooks without delivery? **Resolution:** Accept webhook URLs, log them, don't deliver (document this behavior).

6. **Rate limiting**: Unknown if original LangGraph server implements rate limiting. **Resolution:** Exclude from initial implementation, add if SDK tests fail.

7. **Checkpoint format**: The exact structure of checkpoint objects needs clarification. **Resolution:** Use minimal valid structure, iterate based on SDK usage.

---

## 13. Clarifying Questions for Follow-up

1. **Error Response Format**: Should we reverse-engineer the exact error response format from the LangGraph SDK error handling code, or is a reasonable JSON structure (`{detail: string}`) sufficient?

2. **Stub Realism**: How realistic should dummy responses be? Should thread status transition through `busy` during run execution, or can they remain `idle`?

3. **Webhook Handling**: Should the stub implement mock webhook delivery (POST to webhook URL), or just accept and ignore webhook parameters?

4. **Multitask Strategy**: Should the stub actually enforce `reject`/`interrupt`/`rollback`/`enqueue` semantics against in-memory state, or just accept the parameter?

5. **SDK Version Target**: Which specific version of the LangGraph SDK should be the compatibility target? (e.g., `langgraph-sdk 0.3.9` as of March 2026?)

6. **Streaming Payload Details**: Are there sample SSE stream payloads available for each stream mode (`values`, `updates`, `messages`, etc.)? The event types are documented, but exact payload structures would ensure SDK compatibility.

7. **Database Migration Timeline**: When is the transition from in-memory to PostgreSQL planned? This affects repository interface design.

8. **A2A & MCP Endpoints**: Should Agent-to-Agent and Model Context Protocol endpoints be included in a future phase, or are they permanently out of scope?

9. **Testing Approach**: Should integration tests use the actual LangGraph SDK, or mock SDK requests? Using the real SDK would ensure compatibility but adds complexity.

10. **Deployment Target**: Will this run locally, in Docker, or both? This affects configuration and documentation approach.

---

## 14. References

### Official Documentation

1. **LangGraph Platform API Reference**
   [https://docs.langchain.com/langgraph-platform/server-api-ref](https://docs.langchain.com/langgraph-platform/server-api-ref)
   - Primary API specification and endpoint documentation

2. **LangGraph Assistants API**
   [https://docs.langchain.com/langsmith/agent-server-api/assistants](https://docs.langchain.com/langsmith/agent-server-api/assistants)
   - Detailed Assistant endpoint schemas

3. **LangGraph Threads API**
   [https://docs.langchain.com/langsmith/agent-server-api/threads](https://docs.langchain.com/langsmith/agent-server-api/threads)
   - Thread management endpoint schemas

4. **LangGraph Runs API**
   [https://docs.langchain.com/langsmith/agent-server-api/thread-runs](https://docs.langchain.com/langsmith/agent-server-api/thread-runs)
   - Run execution endpoint schemas

5. **LangGraph JavaScript SDK**
   [https://langchain-ai.github.io/langgraphjs/reference/modules/sdk](https://langchain-ai.github.io/langgraphjs/reference/modules/sdk)
   - JavaScript client implementation and types

6. **LangGraph Streaming Documentation**
   [https://docs.langchain.com/oss/python/langgraph/streaming](https://docs.langchain.com/oss/python/langgraph/streaming)
   - Stream modes and event types

### Framework & Library Documentation

7. **Fastify Official Documentation**
   [https://fastify.dev/docs/latest/](https://fastify.dev/docs/latest/)
   - Core Fastify framework documentation

8. **Fastify TypeScript Reference**
   [https://fastify.dev/docs/latest/Reference/TypeScript/](https://fastify.dev/docs/latest/Reference/TypeScript/)
   - TypeScript integration guide

9. **TypeBox GitHub Repository**
   [https://github.com/sinclairzx81/typebox](https://github.com/sinclairzx81/typebox)
   - TypeBox schema builder documentation

10. **@fastify/type-provider-typebox**
    [https://github.com/fastify/fastify-type-provider-typebox](https://github.com/fastify/fastify-type-provider-typebox)
    - Official Fastify TypeBox integration

11. **@fastify/swagger**
    [https://github.com/fastify/fastify-swagger](https://github.com/fastify/fastify-swagger)
    - OpenAPI specification generation for Fastify

12. **better-sse Documentation**
    [https://github.com/MatthewWid/better-sse](https://github.com/MatthewWid/better-sse)
    - Server-Sent Events implementation

13. **better-sse npm Package**
    [https://www.npmjs.com/package/better-sse](https://www.npmjs.com/package/better-sse)
    - NPM package information

### Comparison & Analysis Articles

14. **Express.js vs Fastify: An In-Depth Framework Comparison**
    [https://betterstack.com/community/guides/scaling-nodejs/fastify-express/](https://betterstack.com/community/guides/scaling-nodejs/fastify-express/)
    - Comprehensive framework comparison (2026)

15. **Best TypeScript Backend Frameworks in 2026**
    [https://encore.dev/articles/best-typescript-backend-frameworks](https://encore.dev/articles/best-typescript-backend-frameworks)
    - Modern framework landscape analysis

16. **Express vs Fastify: Performance Benchmark Comparison**
    [https://michaelguay.dev/express-vs-fastify-a-performance-benchmark-comparison/](https://michaelguay.dev/express-vs-fastify-a-performance-benchmark-comparison/)
    - Performance benchmarks

17. **TypeBox vs Zod: Choosing the Right TypeScript Validation Library**
    [https://betterstack.com/community/guides/scaling-nodejs/typebox-vs-zod/](https://betterstack.com/community/guides/scaling-nodejs/typebox-vs-zod/)
    - Schema validation library comparison

18. **Zod vs Yup vs TypeBox: The Ultimate Schema Validation Guide for 2025**
    [https://dev.to/dataformathub/zod-vs-yup-vs-typebox-the-ultimate-schema-validation-guide-for-2025-1l4l](https://dev.to/dataformathub/zod-vs-yup-vs-typebox-the-ultimate-schema-validation-guide-for-2025-1l4l)
    - Detailed validation library comparison

19. **Zod is amazing. Here's why we're also using TypeBox**
    [https://blog.val.town/blog/typebox/](https://blog.val.town/blog/typebox/)
    - Real-world comparison from Val Town's migration

### Implementation Patterns

20. **How to Stream Updates with Server-Sent Events in Node.js**
    [https://oneuptime.com/blog/post/2026-01-24-nodejs-server-sent-events/view](https://oneuptime.com/blog/post/2026-01-24-nodejs-server-sent-events/view)
    - SSE implementation guide (2026)

21. **Server-Sent Events (SSE) Implementation Guide**
    [https://mvolkmann.github.io/blog/server-sent-events/](https://mvolkmann.github.io/blog/server-sent-events/)
    - SSE protocol explanation

22. **The Repository Pattern with TypeScript**
    [https://www.abdou.dev/blog/the-repository-pattern-with-typescript](https://www.abdou.dev/blog/the-repository-pattern-with-typescript)
    - Repository pattern implementation

23. **How we started using the repository pattern (Updated)**
    [https://engineering.spendesk.com/posts/repository-pattern-at-spendesk/](https://engineering.spendesk.com/posts/repository-pattern-at-spendesk/)
    - Real-world repository pattern usage

24. **Implementing DTOs, Mappers & the Repository Pattern**
    [https://khalilstemmler.com/articles/typescript-domain-driven-design/repository-dto-mapper/](https://khalilstemmler.com/articles/typescript-domain-driven-design/repository-dto-mapper/)
    - DDD patterns in TypeScript

25. **Building Scalable APIs with Node.js and TypeScript**
    [https://nodesource.com/blog/scalable-api-with-node.js-and-typescript](https://nodesource.com/blog/scalable-api-with-node.js-and-typescript)
    - API architecture patterns

26. **Node.js Project Structure: Best Practices**
    [https://medium.com/@jayjethava101/node-js-project-structure-best-practices-and-example-for-clean-code-3e1f5530fd3b](https://medium.com/@jayjethava101/node-js-project-structure-best-practices-and-example-for-clean-code-3e1f5530fd3b)
    - Project organization patterns

27. **Fastify Modular Architecture**
    [https://github.com/sujeet-agrahari/node-fastify-architecture](https://github.com/sujeet-agrahari/node-fastify-architecture)
    - Example modular Fastify project

### Authentication & Security

28. **Protect Fastify routes with Authorization**
    [https://kevincunningham.co.uk/posts/protect-fastify-routes-with-authorization/](https://kevincunningham.co.uk/posts/protect-fastify-routes-with-authorization/)
    - Fastify authentication patterns

29. **How to Create an Authorization Middleware for Fastify**
    [https://www.permit.io/blog/how-to-create-an-authorization-middleware-for-fastify](https://www.permit.io/blog/how-to-create-an-authorization-middleware-for-fastify)
    - Custom middleware implementation

30. **fastify-api-key npm Package**
    [https://www.npmjs.com/package/fastify-api-key](https://www.npmjs.com/package/fastify-api-key)
    - API key authentication plugin

### OpenAPI & Documentation

31. **Self-Documenting APIs with OpenAPI 3.1 | 2026 Guide**
    [https://1xapi.com/blog/build-self-documenting-apis-openapi-3-1-nodejs-2026](https://1xapi.com/blog/build-self-documenting-apis-openapi-3-1-nodejs-2026)
    - OpenAPI 3.1 best practices (2026)

32. **How to Generate an OpenAPI Spec With Fastify**
    [https://www.speakeasy.com/openapi/frameworks/fastify](https://www.speakeasy.com/openapi/frameworks/fastify)
    - Fastify OpenAPI generation guide

33. **tsoa: Build OpenAPI-compliant REST APIs**
    [https://github.com/lukeautry/tsoa](https://github.com/lukeautry/tsoa)
    - TypeScript OpenAPI generator for Express

### LangGraph-Specific Resources

34. **LangGraph Streaming and Events**
    [https://deepwiki.com/langchain-ai/langgraph/7.4-streaming-and-events](https://deepwiki.com/langchain-ai/langgraph/7.4-streaming-and-events)
    - Detailed streaming documentation

35. **LangGraph SSE Pattern**
    [https://langwatch.ai/scenario/examples/testing-remote-agents/sse/](https://langwatch.ai/scenario/examples/testing-remote-agents/sse/)
    - SSE testing patterns for LangGraph

36. **LangGraph API Endpoints**
    [https://deepwiki.com/langchain-ai/langgraphjs/5.3-commands-and-control-flow](https://deepwiki.com/langchain-ai/langgraphjs/5.3-commands-and-control-flow)
    - JavaScript SDK API documentation

### Recommended for Deep Reading

- **Fastify Official Docs** - Essential for understanding Fastify's plugin system and encapsulation model
- **TypeBox GitHub** - Critical for understanding schema definition patterns
- **better-sse README** - Complete SSE implementation guide
- **LangGraph Platform API Reference** - Primary source for endpoint specifications
- **Express.js vs Fastify: An In-Depth Framework Comparison** - Best framework comparison available (2026)

---

## 15. Next Steps

1. **Review this investigation** with the team to validate technical decisions
2. **Prototype core infrastructure** (Fastify + TypeBox + better-sse) to validate assumptions
3. **Create sample endpoints** (e.g., 2-3 Assistant endpoints) to test integration
4. **Test with LangGraph SDK** early to validate compatibility
5. **Set up project structure** following the recommended pattern
6. **Begin Phase 1 implementation** per the roadmap

---

**Document prepared by:** Claude (Anthropic)
**Date:** 2026-03-08
**Review Status:** Ready for team review
