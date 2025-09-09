# Code Style and Conventions

## TypeScript Configuration

### Frontend (Next.js)
- **Target**: ES5 for broad browser compatibility
- **Module System**: ESNext with bundler resolution
- **Strict Mode**: Enabled
- **Path Aliases**: `@/*` points to `./src/*`
- **JSX**: Preserve (handled by Next.js)
- **Linting**: ESLint with Next.js configuration (`next/core-web-vitals`, `next/typescript`)

### Backend (Node.js)
- **Target**: ES2020 for modern Node.js features
- **Module System**: NodeNext with ES modules (`"type": "module"`)
- **Strict Mode**: Enabled (except `noImplicitAny: false`)
- **Path Aliases**: 
  - `@utils/*` → `./utils/*`
  - `@middleware/*` → `./middleware/*`
  - `@routes/*` → `./routes/*`
  - `@discord/*` → `./discord/*`
  - `@types/*` → `./types/*`
- **Output**: `dist/` directory
- **Testing**: Excluded from compilation

## File Organization Patterns

### Frontend Structure
- **Components**: Organized by feature (`ui/`, `player/`, `layout/`)
- **Hooks**: Custom hooks in `/hooks` directory
- **Utils**: Utility functions in `/lib/utils`
- **Types**: Type definitions in `/lib/types`
- **Store**: Zustand stores in `/lib/store`
- **API Routes**: Next.js API routes in `/app/api`

### Backend Structure
- **Routes**: Express routes in `/routes`
- **Discord**: Bot logic in `/discord` with subfolders for commands/events
- **Utils**: Shared utilities with specific modules
- **Middleware**: Express middleware functions
- **Types**: Type definitions and enums
- **Tests**: Jest tests in `__tests__` directory

## Naming Conventions
- **Files**: kebab-case for most files, PascalCase for React components
- **Directories**: kebab-case
- **TypeScript**: PascalCase for types/interfaces, camelCase for variables
- **Database**: camelCase fields with Prisma conventions
- **Environment**: UPPER_SNAKE_CASE for environment variables

## Import/Export Patterns
- **Frontend**: Uses `@/` path alias for internal imports
- **Backend**: Uses `@` prefixed path aliases for internal modules
- **Both**: ES modules with import/export syntax