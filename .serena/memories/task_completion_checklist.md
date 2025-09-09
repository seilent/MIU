# Task Completion Checklist

## When a Development Task is Completed

### Code Quality Checks
1. **Linting**: Run `npm run lint` from root (or individual app directories)
2. **Type Checking**: Ensure TypeScript compilation passes with `npm run build`
3. **Formatting**: Backend has `npm run format` available
4. **Testing**: Run `npm test` (backend) if tests exist

### Database Changes
If database schema was modified:
1. **Generate Prisma Client**: `npm run prisma:generate`
2. **Run Migrations**: `npm run prisma:migrate`
3. **Verify Schema**: Check with `npm run prisma:studio`

### Before Deployment
1. **Build Both Apps**: `npm run build` from root
2. **Test Production Build**: `npm start` to verify production mode works
3. **Docker Test**: `docker-compose up` to test containerized deployment

### Development Environment
- **Hot Reload**: Development mode with `npm run dev` should work
- **Port Configuration**: Frontend (3300), Backend (varies), Prisma Studio (5000)
- **Environment Variables**: Ensure all required env vars are documented

### Security & Performance
- **Rate Limiting**: Verify API endpoints have appropriate rate limits
- **Authentication**: Check Discord OAuth integration works
- **Caching**: Ensure Redis caching is working properly
- **Logging**: Verify Winston logging captures appropriate information

## Commands to Run After Task Completion
```bash
# 1. Lint everything
npm run lint

# 2. Build to check for compilation errors  
npm run build

# 3. If database changes were made
cd backend
npm run prisma:generate
npm run prisma:migrate

# 4. Test the application
npm run dev  # Verify development mode
npm start    # Verify production mode
```