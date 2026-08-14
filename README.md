# Mnemos — Persistent Memory & Context Engine

Mnemos is a persistent memory and context engine designed for personal AI applications. It enables autonomous AI agents and systems to persist, recall, reason over, and continuously update user-specific context and memories across session boundaries.

---

## 1. Product Overview & Problem Statement

### The Problem
Traditional LLM interactions are stateless. Developers try to solve this by storing conversations and performing basic RAG (Retrieval-Augmented Generation). However, simple chat histories quickly exhaust the context window and capture unnecessary noise, while generic RAG lacks understanding of dynamic human factors (e.g., changes in user preferences, long-term goals, evolving relationship contexts).

### The Solution
Mnemos acts as a specialized cognitive buffer. It continuously processes incoming conversation inputs, extracts key structured facts, updates existing goals/preferences, resolves conflicts (e.g., "I used to like dark coffee, but now I prefer light tea"), and injects only the highly relevant contextual memories back into the prompt window when triggered.

---

## 2. Sprint 1 Scope: Architecture & Infrastructure

Sprint 1 establishes a clean, type-safe, and modular foundation for the engine. It focuses on setup, core domain models, persistence abstraction, dynamic health reporting, and testing. It does **not** include cognitive intelligence (such as embeddings, cognitive extraction, or agent loops), which will be implemented incrementally in subsequent sprints.

---

## 3. Technology Stack

* **Core Framework**: [Next.js](https://nextjs.org/) (App Router, Version 16.3)
* **Language**: [TypeScript](https://www.typescriptlang.org/) (configured with strict compilation rules)
* **Database**: [Neon PostgreSQL](https://neon.tech/) using `@neondatabase/serverless` (connection pooling)
* **Styling**: Pure CSS (using centralized design tokens following the warm minimal DocParse AI design language)
* **Testing**: [Vitest](https://vitest.dev/) (unit testing and endpoint assertions using mocked database boundaries)

---

## 4. Architecture & Project Structure

The project adopts a decoupled structure separating business domains from Next.js framework interfaces:

```text
src/
├── app/                  # Next.js App Router (UI & Route Handlers)
│   ├── api/
│   │   └── health/       # Dynamic health check API (dynamic DB connection check)
│   ├── globals.css       # Central design system CSS variables and styling classes
│   ├── layout.tsx        # System layout config (System UI font stack, no Tailwind)
│   └── page.tsx          # Mnemos developer dashboard
├── core/                 # Core domain models, interfaces, and validations
│   ├── types.ts          # Contracts for Memory, MemoryType, User, etc.
│   └── types.test.ts     # Domain validations tests
├── db/                   # Database client abstraction and connection checks
│   ├── index.ts          # Pool manager & health check logic
│   └── schema.sql        # Reference SQL schema definition
├── memory/               # Persistence layer abstraction and pg vector readiness
│   ├── repository.ts     # MemoryRepository interface and Postgres CRUD implementation
│   └── repository.test.ts# Repository CRUD behavior tests using mocked database boundary
├── context/              # Context engine parameters & window-builder specifications
│   └── types.ts          # Contracts for ContextRequest & ContextResult
├── evaluation/           # (Placeholder for future performance/eval frameworks)
└── lib/                  # Shared utilities
```

---

## 5. Local Setup & Environment Configuration

### Prerequisites
* [Node.js](https://nodejs.org/) (v20+ recommended)
* [npm](https://www.npmjs.com/)

### Environment Variables
Copy `.env.example` to create your local `.env` configuration:

```bash
cp .env.example .env
```

Ensure your `.env` contains a valid Neon connection string:
```env
DATABASE_URL="postgresql://neondb_owner:PASSWORD@ep-fragrant-term-axh8ozwe-pooler.c-4.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
```
*(Note: `.env` is omitted from version control as specified in `.gitignore`)*

---

## 6. How to Run & Build

### Development Server
To start the Next.js development server:
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) to view the Mnemos dashboard.

### Production Build
To verify type-checking, compiling, and optimization:
```bash
npm run build
```

---

## 7. How to Test & Lint

All tests are deterministic and execute locally without requiring a live database connection (using mocked boundaries).

### Run Linter
Verify code style rules:
```bash
npm run lint
```

### Run Tests
Execute the unit testing suite:
```bash
npm run test
```

---

## 8. Current Limitations & Future Roadmap

### Implemented (Sprint 1)
* [x] Strictly type-safe domain contracts (`Memory`, `User`, `MemoryMetadata`, `MemoryType`).
* [x] Postgres persistence repository CRUD operations (`MemoryRepository`).
* [x] Dynamic app and DB connection health checks (`/api/health`).
* [x] Warm-minimal SaaS dashboard visual style.
* [x] Local testing harness with Vitest (no live DB dependency).

### Planned (Sprint 2 & Beyond)
* [ ] **Semantic Retrieval & Embeddings**: Configure pgvector integration using finalized AI models.
* [ ] **Memory Ingestion Pipeline**: Implement cognitive extraction logic using LLM parse-rules to map interactions into structured memory entries.
* [ ] **Conflict Resolution**: Logic to mark conflicting older facts as invalid or update them dynamically.
* [ ] **Context Synthesis**: Compile matching memories into formatted LLM prompts.
