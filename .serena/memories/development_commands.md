# Development Commands and Workflows

## Root Level Commands (package.json)
```bash
# Development (runs both frontend and backend in parallel)
npm run dev

# Build both applications
npm run build

# Start both applications in production
npm start

# Lint both applications
npm run lint
```

## Frontend Commands (frontend/package.json)
```bash
cd frontend

# Development server (port 3300)
npm run dev

# Production build
npm run build

# Start production server (port 3300)  
npm start

# Lint code
npm run lint
```

## Backend Commands (backend/package.json)
```bash
cd backend

# Development with hot reload
npm run dev

# Build TypeScript to dist/
npm run build

# Build without linting
npm run build-no-lint

# Start production server
npm start

# Stop server
npm run stop

# Linting and formatting
npm run lint
npm run format

# Testing
npm test
npm run test:watch

# Database operations
npm run prisma:generate
npm run prisma:migrate
npm run prisma:studio     # Port 5000
npm run prisma:create-admin

# Docker operations
npm run docker:up
npm run docker:down
```

## Docker Commands
```bash
# Start all services (app, postgres, redis)
docker-compose up -d

# Stop all services
docker-compose down

# View logs
docker-compose logs -f
```

## Key Scripts
- **start-miu.sh**: Starts the complete application
- **stop-miu.sh**: Stops the complete application
- **backend/scripts/kill-server.sh**: Kills backend server process

## Development Workflow
1. **Initial Setup**: Run database migrations and generate Prisma client
2. **Development**: Use `npm run dev` from root to start both services
3. **Database**: Use Prisma Studio for database inspection
4. **Testing**: Run tests before commits
5. **Linting**: Always lint before building
6. **Production**: Build both apps, then use Docker Compose