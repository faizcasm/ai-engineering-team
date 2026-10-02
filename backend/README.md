# AI Engineering Team — Backend

The API backbone of **AI Engineering Team**: an Express 5 + TypeScript service that runs a
LangGraph-style workflow where a team of AI roles (`tech-lead`, `architect`, `backend-engineer`,
`frontend-engineer`, `ai-engineer`, `qa-engineer`, `reviewer`, `devops`) plans, executes, reviews
and finalizes a goal — plus a provider-agnostic LLM chat API and an MCP server registry.

---

## Features

- **Agent workflow graph** — plan → assign → execute → review → finalize, with conditional edges,
  reviewer-driven rework loops, iteration limits and cycle protection. Implemented as a tiny,
  dependency-free graph runtime (`src/graph/workflow.ts`).
- **Provider-agnostic LLM client** — Anthropic Messages API and OpenAI Chat Completions over native
  `fetch`, with SSE streaming, retries with backoff and typed errors (`src/ai/llm.ts`).
- **MCP registry** — CRUD for MCP servers backed by an in-memory store plus optional config
  (`MCP_SERVERS` / `MCP_CONFIG_PATH`), with HTTP/stdio ping checks.
- **Production middleware** — Helmet, CORS allow-list, compression, morgan→winston logging,
  Redis rate limiting, centralized error handling.
- **Queues** — BullMQ email queue consumed by a dedicated worker process.

## Tech stack

| Layer      | Choice                                        |
| ---------- | --------------------------------------------- |
| Runtime    | Node.js 20+ (ESM)                             |
| Framework  | Express 5                                     |
| Language   | TypeScript (strict)                           |
| Validation | Zod v4                                        |
| Database   | PostgreSQL + Prisma 7 (`src/generated/prisma`)|
| Cache      | Redis (ioredis)                               |
| Queues     | BullMQ                                        |
| LLMs       | Anthropic / OpenAI via native `fetch`         |
| Logging    | Winston                                       |

---

## Architecture

```
backend/
├── prisma/
│   ├── schema.prisma        # Prisma schema (client → src/generated/prisma)
│   ├── seed.ts              # Type-safe demo seed (npm run seed)
│   └── seed.d.ts            # Seed type contract
└── src/
    ├── index.ts             # Express app factory (middleware + routers)
    ├── server.ts            # HTTP entry point (listens on PORT)
    ├── ai/
    │   └── llm.ts           # chat() + streamChat() for Anthropic/OpenAI
    ├── graph/
    │   ├── state.ts         # Workflow state, roles and reducers
    │   ├── nodes.ts         # plan / assign / execute / review / finalize nodes
    │   ├── workflow.ts      # Graph runtime: compile().invoke() / .stream()
    │   └── routes.ts        # POST /invoke, POST /stream
    ├── routes/              # Routers (ai, graph, mcp, user)
    ├── controller/          # Request handlers (asyncHandler wrapped)
    ├── services/            # AppError, JWT, OTP, MCP registry
    ├── validations/         # Zod schemas
    ├── middleware/          # auth, asyncHandler, errorHandler
    ├── config/              # db, redis, logger, mail, queue, rate limit
    ├── workers/             # BullMQ workers
    └── jobs/                # Queue producers
```

### Workflow graph

```
          ┌────────────────────────────────────────────┐
          ▼                                            │
        plan ──► assign ──► execute ──► review ──► finalize ──► END
                                 ▲          │
                                 └──────────┘   (rework while
                                                  iteration < maxIterations)
```

| Node       | Role             | What it does                                                     |
| ---------- | ---------------- | ---------------------------------------------------------------- |
| `plan`     | `tech-lead`      | Turns the goal into an ordered implementation plan               |
| `assign`   | `tech-lead`      | Splits the plan into typed tasks and assigns a role to each      |
| `execute`  | current task role| Runs the role prompt through the LLM and records the result      |
| `review`   | `reviewer`       | Approves the output or reopens tasks (bounded by `maxIterations`)|
| `finalize` | `tech-lead`      | Merges the results into one final deliverable                    |

Every node is a pure `async (state) => Partial<WorkflowState>` function. The runtime in
`workflow.ts` enforces `maxSteps`/`maxVisits` on top of the graph's own loop guards, so a run can
never spin forever.

---

## Setup

### Prerequisites

- Node.js 20+ and npm
- PostgreSQL (for persistence)
- Redis (for rate limiting and BullMQ)

### 1. Install

```bash
cd backend
npm install
```

### 2. Environment

```bash
cp .env.example .env
```

Fill in `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` and at least one LLM key
(`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`). Every variable is documented in `.env.example`.

### 3. Prisma

```bash
npx prisma generate     # generates src/generated/prisma (required for typechecking)
npm run migrate         # create/apply migrations (needs DATABASE_URL)
npm run seed            # optional: insert demo users
```

### 4. Development

```bash
npm run dev             # API on http://localhost:4000 (nodemon, src/server.ts)
```

### 5. Background worker

```bash
npm run worker          # BullMQ email worker
```

### 6. Build & run

```bash
npm run typecheck       # tsc --noEmit
npm run build           # compile to dist/
npm start               # node dist/server.js
```

---

## API

### Core

| Method | Endpoint        | Description                              |
| ------ | --------------- | ---------------------------------------- |
| GET    | `/health`       | Health check                             |
| GET    | `/`             | Service info                             |

### AI (`/api/ai`)

| Method | Endpoint          | Description                                                     |
| ------ | ----------------- | --------------------------------------------------------------- |
| POST   | `/api/ai/chat`    | Chat completion as SSE (`{ messages, model?, system?, ... }`)   |
| POST   | `/api/ai/complete`| Chat completion as JSON                                         |
| GET    | `/api/ai/models`  | Supported providers and models                                  |

### Workflow graph (`/api/graph`)

| Method | Endpoint             | Description                                                     |
| ------ | -------------------- | --------------------------------------------------------------- |
| POST   | `/api/graph/invoke`  | Run the whole team workflow and return the final state          |
| POST   | `/api/graph/stream`  | Run the workflow as SSE (`node_start`, `node_end`, `end`)       |
| GET    | `/api/graph/roles`   | Team roles, their descriptions and the graph node names         |

Example:

```bash
curl -X POST http://localhost:4000/api/graph/invoke \
  -H "Content-Type: application/json" \
  -d '{"goal": "Design and ship a rate-limited REST API for orders", "maxIterations": 3}'
```

### MCP registry (`/api/mcp`)

| Method | Endpoint                    | Description                                   |
| ------ | --------------------------- | --------------------------------------------- |
| GET    | `/api/mcp/servers`          | List registered servers (config + in-memory)  |
| POST   | `/api/mcp/servers`          | Register a server (`stdio`, `sse` or `http`)  |
| GET    | `/api/mcp/servers/:id`      | Fetch one server                              |
| DELETE | `/api/mcp/servers/:id`      | Remove an in-memory server                    |
| POST   | `/api/mcp/servers/:id/ping` | Check reachability (HTTP latency / PATH lookup)|

### Users (`/api/users`)

| Method | Endpoint              | Description        |
| ------ | --------------------- | ------------------ |
| POST   | `/api/users/signup`   | Register           |
| POST   | `/api/users/login`    | Login              |
| POST   | `/api/users/logout`   | Logout             |
| GET    | `/api/users/me`       | Current user       |
| PATCH  | `/api/users/me`       | Update profile     |
| PATCH  | `/api/users/me/password` | Change password |
| DELETE | `/api/users/me`       | Delete account     |

---

## Environment variables

See [`.env.example`](./.env.example) for the complete, commented list:

- **Runtime** — `PORT`, `HOST`, `NODE_ENV`, `CORS_ORIGIN`
- **Database** — `DATABASE_URL`
- **Redis** — `REDIS_URL`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_DB`
- **Auth** — `JWT_SECRET`, `JWT_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN`
- **SMTP** — `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`
- **Queues** — `QUEUE_NAME`, `QUEUE_PREFIX`, `QUEUE_REMOVE_ON_COMPLETE`, `QUEUE_REMOVE_ON_FAIL`
- **Rate limit** — `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS`
- **LLM** — `LLM_PROVIDER`, `LLM_MODEL`, `LLM_BASE_URL`, `LLM_TEMPERATURE`, `LLM_MAX_TOKENS`,
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
- **MCP** — `MCP_SERVERS`, `MCP_CONFIG_PATH`, `MCP_PING_TIMEOUT_MS`

---

## Scripts

| Script                  | Command                      |
| ----------------------- | ---------------------------- |
| `npm run dev`           | API in watch mode            |
| `npm run worker`        | BullMQ worker in watch mode  |
| `npm run typecheck`     | `tsc --noEmit`               |
| `npm run generate`      | `prisma generate`            |
| `npm run migrate`       | `prisma migrate dev`         |
| `npm run migrate:deploy`| `prisma migrate deploy`      |
| `npm run seed`          | Seed demo users              |
| `npm run build`         | Compile TypeScript           |
| `npm start`             | Run the compiled server      |

---

## Author

Author: **Faizan Hameed** — [faizcasm.me](https://faizcasm.me) — Founder of Ryuksaidso

## License

MIT
