# MIU Deployment Guide

This guide explains how to deploy the MIU application (frontend and backend) on a Linux server without using Docker.

## Prerequisites

- A Linux server (Ubuntu/Debian recommended)
- Root or sudo access
- Domain name configured to point to your server (if using Nginx)
- PostgreSQL database server
- Redis server

## Deployment Script

The `deploy.sh` script automates the deployment process. It can:

- Install system dependencies (Node.js, PM2, Nginx, Certbot)
- Deploy the backend and/or frontend
- Configure Nginx as a reverse proxy
- Set up SSL certificates with Let's Encrypt

### Basic Usage

```bash
# Deploy both frontend and backend
./scripts/deploy.sh --domain=yourdomain.com

# Deploy only the frontend
./scripts/deploy.sh --frontend-only --domain=yourdomain.com

# Deploy only the backend
./scripts/deploy.sh --backend-only --domain=yourdomain.com

# Deploy with SSL
./scripts/deploy.sh --domain=yourdomain.com --with-ssl

# Change the backend path (default is 'backend')
./scripts/deploy.sh --domain=yourdomain.com --backend-path=api
```

### Command Line Options

| Option | Description |
|--------|-------------|
| `--frontend-only` | Deploy only the frontend |
| `--backend-only` | Deploy only the backend |
| `--skip-deps` | Skip installing dependencies |
| `--no-pm2` | Don't use PM2 for process management |
| `--no-nginx` | Don't configure Nginx |
| `--with-ssl` | Configure SSL with Let's Encrypt |
| `--domain=DOMAIN` | Set the domain name (required for Nginx and SSL) |
| `--backend-path=PATH` | Set the backend path (default: backend) |
| `--help` | Display help message |

## Manual Deployment Steps

If you prefer to deploy manually or need to customize the deployment, follow these steps:

### Backend Deployment

1. Navigate to the backend directory:
   ```bash
   cd backend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create an environment file:
   ```bash
   cp .env.production .env
   ```
   
4. Edit the `.env` file to update configuration values:
   ```bash
   nano .env
   ```
   
   Important variables to configure:
   - `DATABASE_URL`: PostgreSQL connection string
   - `REDIS_URL`: Redis connection string
   - `JWT_SECRET`: Secret for JWT token generation
   - `DISCORD_TOKEN`: Your Discord bot token
   - `CORS_ORIGIN`: Frontend URL for CORS
   - `API_URL`: Set to `https://yourdomain.com/backend` (or your chosen path)

5. Run database migrations:
   ```bash
   npm run prisma:migrate
   ```

6. Build the application:
   ```bash
   npm run build
   ```

7. Start the application:
   ```bash
   # Using Node.js directly
   npm run start
   
   # Using PM2 (recommended for production)
   pm2 start dist/index.js --name miu-backend
   pm2 save
   ```

### Frontend Deployment

1. Navigate to the frontend directory:
   ```bash
   cd frontend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create an environment file:
   ```bash
   cp .env.production .env.local
   ```
   
4. Edit the `.env.local` file to update configuration values:
   ```bash
   nano .env.local
   ```
   
   Important variables to configure:
   - `NEXT_PUBLIC_API_URL`: URL of your backend API (e.g., `https://yourdomain.com/backend`)
   - `NEXT_PUBLIC_URL`: URL of your frontend (e.g., `https://yourdomain.com`)
   - `NEXT_PUBLIC_DISCORD_CLIENT_ID`: Your Discord application client ID

5. Build the application:
   ```bash
   npm run build
   ```

6. Start the application:
   ```bash
   # Using Node.js directly
   npm run start
   
   # Using PM2 (recommended for production)
   pm2 start npm --name miu-frontend -- start
   ```

## Nginx Configuration

If you're setting up Nginx manually, here's an example configuration that serves both frontend and backend from the same domain:

```nginx
server {
    listen 80;
    server_name yourdomain.com;
    
    # Frontend location
    location / {
        proxy_pass http://localhost:3300;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
    
    # Backend location
    location /backend/ {
        proxy_pass http://localhost:3000/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        
        # Remove the path prefix when forwarding to the backend
        rewrite ^/backend/(.*) /$1 break;
    }
    
    # Backend API location (for compatibility)
    location /backend/api/ {
        proxy_pass http://localhost:3000/api/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## SSL Configuration

To set up SSL with Let's Encrypt manually:

```bash
# Install Certbot
sudo apt-get update
sudo apt-get install certbot python3-certbot-nginx

# Obtain certificates
sudo certbot --nginx -d yourdomain.com
```

## Database Setup

Ensure PostgreSQL is installed and configured:

```bash
# Install PostgreSQL
sudo apt-get update
sudo apt-get install postgresql postgresql-contrib

# Create a database and user
sudo -u postgres psql
postgres=# CREATE USER miu WITH PASSWORD 'your_password';
postgres=# CREATE DATABASE miu OWNER miu;
postgres=# \q

# Update the DATABASE_URL in your .env file
# DATABASE_URL=postgresql://miu:your_password@localhost:5432/miu
```

## Redis Setup

Ensure Redis is installed and configured:

```bash
# Install Redis
sudo apt-get update
sudo apt-get install redis-server

# Configure Redis to start on boot
sudo systemctl enable redis-server

# Update the REDIS_URL in your .env file
# REDIS_URL=redis://localhost:6379
```

## Troubleshooting

### Common Issues

1. **Database connection errors**:
   - Check if PostgreSQL is running: `sudo systemctl status postgresql`
   - Verify database credentials in `.env`
   - Ensure the database exists and is accessible

2. **Redis connection errors**:
   - Check if Redis is running: `sudo systemctl status redis-server`
   - Verify Redis connection string in `.env`

3. **Nginx configuration errors**:
   - Test Nginx configuration: `sudo nginx -t`
   - Check Nginx error logs: `sudo tail -f /var/log/nginx/error.log`

4. **Application errors**:
   - Check application logs: `pm2 logs`
   - Verify environment variables are set correctly

5. **CORS issues**:
   - Ensure the backend is properly configured to accept requests from the frontend
   - With the path-based approach, CORS issues should be minimal since both frontend and backend are on the same domain

### Getting Help

If you encounter issues not covered in this guide, please:

1. Check the application logs for specific error messages
2. Consult the project documentation
3. Open an issue on the project repository 