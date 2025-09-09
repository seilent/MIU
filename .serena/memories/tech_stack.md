# Technology Stack

## Frontend (Next.js App)
- **Framework**: Next.js 14 with App Router
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **State Management**: Zustand
- **Data Fetching**: TanStack Query (React Query)
- **UI Components**: Custom components with Heroicons
- **Animations**: Framer Motion
- **Notifications**: React Hot Toast
- **Authentication**: Discord OAuth integration

### Frontend Dependencies
- React 18, Next.js 14
- Tailwind CSS with custom styling
- Zustand for global state
- TanStack Query for server state
- Framer Motion for animations
- clsx and tailwind-merge utilities

## Backend (Node.js/Express)
- **Runtime**: Node.js with ES modules
- **Framework**: Express.js
- **Language**: TypeScript
- **Database ORM**: Prisma
- **Authentication**: JWT + Express sessions
- **Rate Limiting**: express-rate-limit
- **Discord Integration**: Discord.js v14
- **Audio Processing**: FFmpeg, play-dl, ytdl-core
- **API Documentation**: Swagger
- **Logging**: Winston with daily rotation
- **Monitoring**: Prometheus metrics

### Backend Dependencies
- Express.js with TypeScript
- Discord.js for bot functionality
- Prisma for database operations
- Redis for caching and sessions
- YouTube APIs (googleapis, play-dl, ytdl-core)
- Audio processing (ffmpeg-static, opusscript)
- Security (bcrypt, jsonwebtoken, cors)
- Monitoring (winston, prom-client)

## Infrastructure
- **Database**: PostgreSQL 15
- **Cache/Sessions**: Redis 7
- **Containerization**: Docker + Docker Compose
- **Process Management**: PM2 (implied from scripts)
- **Web Server**: Can be deployed with Apache (config provided)