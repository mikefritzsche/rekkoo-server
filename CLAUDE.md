# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 🔒 SECURITY NOTICE - CRITICAL

**NEVER include sensitive information in files that will be committed to git:**
- Database credentials (use environment variables)
- API keys or authentication tokens
- Connection strings with passwords
- Private server IPs or ports
- JWT secrets or encryption keys
- Any user personal data

**Always use environment variables for sensitive data:**
```javascript
// ✅ CORRECT
const dbPassword = process.env.DB_PASSWORD;

// ❌ WRONG - Never hardcode credentials
const dbPassword = 'TQMJ75khpYAiEb';
```

## Development Guidelines

### Git Commit Messages
- **IMPORTANT**: Never include any reference to Claude, AI, or automated generation in commit messages
- Focus commit messages on WHAT changed and WHY, not WHO made the changes
- Use conventional commit format when appropriate (feat:, fix:, docs:, etc.)
- Keep commit messages concise and descriptive of the actual changes made

## Development Commands

### Docker Commands
- **Local development**: `npm run build:dev` - Build and start with development configuration
- **Start development**: `npm run start:dev` - Start existing containers
- **Stop development**: `npm run stop:dev` - Stop development containers
- **Production**: `docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d`

### Testing
- **Run all tests**: `npm test`
- **Run specific test**: `npm test -- --testPathPattern=<path>`
- Test files are located in `src/**/__tests__/` directories

### Other Commands
- **Start server**: `npm start` or `npm run dev` (with nodemon)
- **Generate session secret**: `npm run generate:session-secret`
- **Environment sync**: `npm run sync:env` (syncs to CircleCI)

## Architecture Overview

### Core Application Structure

**Rekkoo** is a social recommendation platform built with Node.js/Express that allows users to create, share, and collaborate on lists of recommendations across various categories (books, movies, music, places, etc.).

### Key Architectural Patterns

1. **Factory Pattern Controllers**: Controllers are created via factory functions that inject dependencies (primarily SocketService)
   - Example: `favoritesControllerFactory(socketService)` in `src/controllers/FavoritesController.js`
   - This pattern enables real-time updates via WebSocket connections

2. **Route Initialization**: Routes are created through factory functions that accept controller instances
   - Example: `createFavoritesRouter(favoritesController)` in `src/routes/favorites.routes.js`

3. **Database Connection**: PostgreSQL with connection pooling via `src/config/db.js`
   - Includes transaction helpers and query performance monitoring
   - Pool configuration with error handling and automatic reconnection

### Environment Configuration

The application uses a multi-layered environment configuration:
- Base: `.env`
- Shared: `.env.common` (OAuth credentials, shared config)
- Environment-specific: `.env.development`, `.env.staging`, `.env.production`

### Real-time Features

Socket.IO integration provides real-time updates for:
- List collaborations and sharing
- Favorite updates
- Connection requests and group invitations
- Notification system

Authentication uses JWT tokens with session middleware for cross-subdomain support.

### Database Schema

The application uses PostgreSQL with extensive migration system:
- **Core entities**: Users, Lists, List Items, Favorites
- **Social features**: Connections, Group Invitations, List Sharing
- **Advanced features**: Embeddings for search, Sync tracking, Change logs
- **Migration files**: Located in `sql/migrations/` with comprehensive versioning

### API Structure

RESTful API with versioned endpoints (`/v1.0/`):
- Authentication: `/v1.0/auth/*` (OAuth providers: Google, Apple, GitHub, etc.)
- Core features: `/v1.0/favorites/*`, `/v1.0/lists/*`, `/v1.0/users/*`
- External integrations: `/v1.0/spotify/*`, `/v1.0/media/*`, `/v1.0/books/*`
- Social features: `/v1.0/connections/*`, `/v1.0/groups/*`

### Key Services

- **SocketService**: Real-time communication hub
- **EmbeddingService**: AI-powered search using vector embeddings
- **ListService**: Core list management with collaboration features
- **NotificationService**: Cross-platform notifications
- **R2Service**: Cloudflare R2 for file storage

### External Integrations

- **Media**: TMDB (movies/TV), Spotify (music), OpenLibrary (books)
- **Places**: OpenStreetMap integration
- **AI**: Google Gemini for recommendations
- **Storage**: Cloudflare R2 for uploads
- **Cache**: Valkey/Redis for session and performance caching

### Testing

Jest configuration with PostgreSQL mocking. Tests located in `src/**/__tests__/` directories with focus on:
- Controller integration tests
- Service layer unit tests
- Database migration validation

### Development Notes

- The application supports both private and public list modes
- Connection system enables friend-to-friend sharing
- Group invitations allow collaborative list management
- Embedding system provides semantic search across all content types
- Comprehensive audit logging tracks all changes for sync purposes