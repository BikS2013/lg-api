# Code Style & Conventions

- TypeScript strict mode, ESM modules
- Fastify v5 with TypeBox for schema validation
- TypeBox schemas: no $id fields (Fastify serializer conflicts)
- Config: env vars only, no fallback values - throw on missing
- Storage: pluggable via YAML config (storage-config.yaml)
- Agent system: CLI tools communicating via stdin/stdout JSON
- SSE streaming: manual implementation via reply.raw
- Database naming: singular table names (Customer, not Customers)
