# MIU - Discord Music Bot with Web Interface

## Project Purpose
MIU is a Discord music bot with a comprehensive web interface that allows users to play music from YouTube/YouTube Music through Discord voice channels. The project consists of:

- **Discord Bot**: Handles voice channel playback, Discord slash commands, and user management
- **Web Interface**: Provides a modern UI for controlling music playback, viewing queues, and managing playlists
- **Real-time Synchronization**: Keeps web clients synchronized with Discord bot state via WebSocket/SSE

## Architecture Overview
- **Frontend**: Next.js 14 React application with TypeScript
- **Backend**: Node.js/Express server with TypeScript 
- **Database**: PostgreSQL with Prisma ORM
- **Cache**: Redis for session storage and caching
- **Discord Integration**: Discord.js for bot functionality
- **Audio Processing**: FFmpeg for audio streaming and processing
- **Deployment**: Docker containerization with docker-compose

## Key Features
- YouTube/YouTube Music integration for music streaming
- Discord slash commands for music control
- Web-based music player with real-time sync
- User authentication via Discord OAuth
- Role-based permissions system
- Music recommendation engine
- Audio caching and thumbnail management
- Session persistence with Redis
- Comprehensive logging and monitoring
- Rate limiting and security middleware