# Suggested Commands for MIU Development

## Most Important Commands

### Daily Development
```bash
# Start development environment (both frontend and backend)
npm run dev

# Build everything
npm run build

# Lint all code
npm run lint
```

### Database Operations
```bash
cd backend
npm run prisma:studio      # Database browser (port 5000)
npm run prisma:generate    # Generate Prisma client after schema changes
npm run prisma:migrate     # Apply database migrations
npm run prisma:create-admin # Create admin user
```

### Docker Operations
```bash
# Start all services (postgres, redis, app)
docker-compose up -d

# Stop all services  
docker-compose down

# View logs
docker-compose logs -f
```

### System Commands (Linux)
```bash
# File operations
ls                    # List files
find . -name "*.ts"   # Find TypeScript files  
grep -r "search"      # Search in files
cd /path              # Change directory

# Process management
ps aux | grep node    # Find Node processes
kill -9 <PID>         # Kill process
```

### Git Operations
```bash
git status            # Check repository status
git add .             # Stage all changes
git commit -m "msg"   # Commit changes
git push              # Push to remote
git pull              # Pull from remote
```

## Specialized Commands

### Frontend Only
```bash
cd frontend
npm run dev           # Dev server on port 3300
npm run build         # Production build
npm run lint          # ESLint check
```

### Backend Only  
```bash
cd backend
npm run dev           # Development with tsx watch
npm run build         # TypeScript compilation
npm run start         # Production server
npm run stop          # Kill server
npm run format        # Prettier formatting
npm test              # Run Jest tests
```

### Utility Scripts
```bash
./start-miu.sh        # Start complete application
./stop-miu.sh         # Stop complete application
backend/scripts/kill-server.sh  # Kill backend server
```

## Environment Setup
- Set up `.env` file with Discord tokens and database URL
- Ensure Docker is running for postgres/redis
- Use Node.js version compatible with ES modules