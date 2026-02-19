# LLM Instructions — MediaTransfer

You are helping build **MediaTransfer**, a **locally-run** cloud-to-cloud media asset transfer tool. This tool runs entirely on the user's local machine — it is not a hosted or cloud-deployed service. All services (API, database, queue) run locally via Docker Compose. Follow these rules strictly.

---

## Core Rules

1. **Implement one step at a time.** Complete a single plan step fully before moving to the next. Do not skip ahead or implement multiple steps in one pass.

2. **Do NOT commit or push.** Never run `git commit`, `git push`, or any version control commands. The developer will handle all version control manually.

3. **Always create tests for every plan step.** Every step you implement must include corresponding tests. No step is considered complete without test coverage. Use **Vitest** as the test runner.

4. **Follow the plan file.** Refer to `PLAN.md` for the ordered list of implementation steps. Work through them sequentially. Mark each step's status when beginning and completing it.

5. **Ask before deviating.** If you believe the plan needs adjustment, propose the change rather than silently deviating.

6. **Never disclose secrets or personal information.** Never hardcode API keys, passwords, tokens, or any personal data in source files. All sensitive values must be stored in a local `.env` file (which is `.gitignore`d). Reference them via environment variables only.

7. **Up to date plan.** Always rememeber to update `PLAN.md` according to the progress

8. **Involve user.** After implemneting and tests passed, add a manual user verficiation step, both to involve the user in the implemenetion but also as a quality gate

---

## Tech Stack Constraints

- **Primary language:** TypeScript (Node.js 20+)
- **API framework:** Fastify
- **Database:** PostgreSQL 16 with Prisma ORM
- **Job queue:** BullMQ + Redis
- **Testing:** Vitest
- **Frontend (if needed):** React + Vite + shadcn/ui
- **Java (if needed):** Spring Boot 3, Java 21
- **NEVER use Python** for any part of this project

Refer to `TECH_STACK.md` for full details.

---

## Coding Standards

- Use **ESM** (`"type": "module"`) throughout
- Prefer `async/await` over callbacks
- Use **Zod** for all runtime input validation
- Use **Pino** for structured logging — never `console.log` in production code
- All files use `.ts` extension (no `.js` source files)
- Follow the existing project structure and naming conventions
- Keep functions small and focused — one responsibility per function
- Use descriptive variable and function names

---

## Test Requirements

- Every plan step **must** produce at least one test file
- Place tests adjacent to source files: `foo.ts` → `foo.test.ts`
- Test files must pass before a step is considered complete
- Use descriptive `describe`/`it` blocks that read like specifications
- Mock external services (cloud SDKs, database) — do not make real API calls in tests
- Include both happy-path and error-path tests

---

## File & Project Awareness

- Always read relevant existing files before making changes
- Check for errors after editing files
- Respect the project structure defined in the plan
- Reference these project docs as needed:
  - `README.md` — project overview
  - `TECH_STACK.md` — technology choices and rationale
  - `PLAN.md` — ordered implementation steps
  - `LLM_INSTRUCTIONS.md` — this file (your rules)
