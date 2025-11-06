# AGENTS.md

## Objective
- Guide automation agents contributing to the Rekkoo Express/Socket backend.

## Read Before You Change Anything
- `CLAUDE.md` for security mandates and commit etiquette.
- `README.md` plus `docs/` for deployment, Docker, and feature-specific notes.
- Review relevant controller/service files to understand injected dependencies before editing.

## Project Snapshot
- Node.js/Express 5 application with factory-based controllers and routers in `src/controllers` and `src/routes`.
- Offline-first data pipeline anchored by sync controllers/services (`src/routes/sync.routes.js`, socket notifications).
- PostgreSQL persistence; SQL migrations live in `sql/migrations/` and must be extended, not modified in place.
- Real-time features handled through Socket.IO services (`src/services/socket`) and scheduled jobs via `node-cron` workers.
- Configuration is layered via `.env.common` + environment-specific files; `config/` assembles typed settings.

## Working Agreements
- Never hardcode credentials or URLs with secrets—wire them through environment variables and configuration helpers.
- Preserve the dependency-injection pattern: update factory functions and pass new services explicitly.
- Align request validation with `express-validator`; keep DTOs, services, and SQL queries in sync.
- Treat sync flows as mission-critical: coordinate updates with SyncController/socket services and preserve change-log semantics.
- When changing persistence, add a new migration file and update the associated repository/service logic.
- Maintain API versioning (`/v1.0/`) and update documentation/tests whenever routes change.
- Prefer unit/integration tests over manual verification; mock external services to keep tests deterministic.

## Testing & Verification
- `npm test` runs Jest + Supertest suites; add coverage for new controllers, middleware, and services.
- For database-dependent changes, run the suite against the Dockerized Postgres defined in `docker-compose.override.yml`.
- Document manual verification steps when touching Socket.IO, cron jobs, or external integrations.

## Delivery Checklist
- Update API or ops documentation in `docs/` after modifying endpoints, jobs, or infrastructure scripts.
- Rotate session secrets or other keys via scripts (e.g., `npm run generate:session-secret`) but never commit their output.
- Ensure new scripts, migrations, or cron jobs are wired into the appropriate startup/bootstrap files.
