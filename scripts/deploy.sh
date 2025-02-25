#!/bin/bash

# MIU Deployment Script for Linux
# This script deploys the MIU application (frontend and backend) without Docker
# Usage: ./deploy.sh [--frontend-only] [--backend-only] [--skip-deps] [--help]

set -e

# Default configuration
FRONTEND_PORT=3300
BACKEND_PORT=3000
INSTALL_DEPS=true
DEPLOY_FRONTEND=true
DEPLOY_BACKEND=true
USE_PM2=true
SETUP_NGINX=true
SETUP_SSL=false
DOMAIN_NAME=""
BACKEND_PATH="backend"
PROJECT_ROOT=$(pwd)
GIT_REPO="https://github.com/seilent/MIU"
GIT_BRANCH="master"
DEPLOY_DIR="$HOME/miu"
PULL_REPO=true
USE_DOCKER_DB=true  # Default to using Docker for database

# Text formatting
BOLD='\033[1m'
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Parse command line arguments
for arg in "$@"; do
  case $arg in
    --frontend-only)
      DEPLOY_BACKEND=false
      shift
      ;;
    --backend-only)
      DEPLOY_FRONTEND=false
      shift
      ;;
    --skip-deps)
      INSTALL_DEPS=false
      shift
      ;;
    --no-pm2)
      USE_PM2=false
      shift
      ;;
    --no-nginx)
      SETUP_NGINX=false
      shift
      ;;
    --with-ssl)
      SETUP_SSL=true
      shift
      ;;
    --domain=*)
      DOMAIN_NAME="${arg#*=}"
      shift
      ;;
    --backend-path=*)
      BACKEND_PATH="${arg#*=}"
      shift
      ;;
    --git-repo=*)
      GIT_REPO="${arg#*=}"
      shift
      ;;
    --git-branch=*)
      GIT_BRANCH="${arg#*=}"
      shift
      ;;
    --deploy-dir=*)
      DEPLOY_DIR="${arg#*=}"
      shift
      ;;
    --no-pull)
      PULL_REPO=false
      shift
      ;;
    --no-docker-db)
      USE_DOCKER_DB=false
      shift
      ;;
    --help)
      echo -e "${BOLD}MIU Deployment Script${NC}"
      echo "Usage: ./deploy.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --frontend-only       Deploy only the frontend"
      echo "  --backend-only        Deploy only the backend"
      echo "  --skip-deps           Skip installing dependencies"
      echo "  --no-pm2              Don't use PM2 for process management"
      echo "  --no-nginx            Don't configure Nginx"
      echo "  --with-ssl            Configure SSL with Let's Encrypt"
      echo "  --domain=DOMAIN       Set the domain name (required for Nginx and SSL)"
      echo "  --backend-path=PATH   Set the backend path (default: backend)"
      echo "  --git-repo=URL        Git repository URL to pull from (default: https://github.com/seilent/MIU)"
      echo "  --git-branch=BRANCH   Git branch to use (default: master)"
      echo "  --deploy-dir=DIR      Directory to deploy to (default: $HOME/miu)"
      echo "  --no-pull             Skip pulling from Git repository"
      echo "  --no-docker-db        Don't use Docker for database and Redis (use external services)"
      echo "  --help                Display this help message"
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $arg${NC}"
      echo "Use --help for usage information"
      exit 1
      ;;
  esac
done

# Check if domain is provided when needed
if [ "$SETUP_NGINX" = true ] && [ -z "$DOMAIN_NAME" ]; then
  echo -e "${RED}Error: Domain name is required for Nginx setup. Use --domain=yourdomain.com${NC}"
  exit 1
fi

if [ "$SETUP_SSL" = true ] && [ -z "$DOMAIN_NAME" ]; then
  echo -e "${RED}Error: Domain name is required for SSL setup. Use --domain=yourdomain.com${NC}"
  exit 1
fi

# Function to check if a command exists
command_exists() {
  command -v "$1" >/dev/null 2>&1
}

# Function to install system dependencies
install_system_dependencies() {
  echo -e "${BLUE}Checking and installing system dependencies...${NC}"
  
  # Update package lists
  sudo apt-get update
  
  # Install Git if not installed
  if ! command_exists git; then
    echo -e "${YELLOW}Installing Git...${NC}"
    sudo apt-get install -y git
  fi
  
  # Install Node.js if not installed
  if ! command_exists node; then
    echo -e "${YELLOW}Installing Node.js...${NC}"
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
  
  # Install PM2 if needed and not installed
  if [ "$USE_PM2" = true ] && ! command_exists pm2; then
    echo -e "${YELLOW}Installing PM2...${NC}"
    sudo npm install -g pm2
  fi
  
  # Install Nginx if needed and not installed
  if [ "$SETUP_NGINX" = true ] && ! command_exists nginx; then
    echo -e "${YELLOW}Installing Nginx...${NC}"
    sudo apt-get install -y nginx
  fi
  
  # Install Certbot if SSL is needed
  if [ "$SETUP_SSL" = true ] && ! command_exists certbot; then
    echo -e "${YELLOW}Installing Certbot for Let's Encrypt...${NC}"
    sudo apt-get install -y certbot python3-certbot-nginx
  fi
  
  # Install Docker if needed for database
  if [ "$USE_DOCKER_DB" = true ]; then
    if ! command_exists docker; then
      echo -e "${YELLOW}Installing Docker...${NC}"
      curl -fsSL https://get.docker.com -o get-docker.sh
      sudo sh get-docker.sh
      sudo usermod -aG docker $(whoami)
      echo -e "${YELLOW}Added $(whoami) to the docker group. You may need to log out and back in for this to take effect.${NC}"
    fi
    
    if ! command_exists docker-compose; then
      echo -e "${YELLOW}Installing Docker Compose...${NC}"
      sudo curl -L "https://github.com/docker/compose/releases/download/v2.23.3/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
      sudo chmod +x /usr/local/bin/docker-compose
    fi
  fi
  
  # Check for dependencies required for building native modules
  echo -e "${YELLOW}Checking dependencies for building native modules...${NC}"
  
  # Check for build tools
  if ! command_exists gcc || ! command_exists make; then
    echo -e "${YELLOW}Installing build tools (gcc, make)...${NC}"
    sudo apt-get install -y build-essential
  fi
  
  # Check for Python and handle externally managed environments
  if command_exists python3; then
    PYTHON_VERSION=$(python3 --version 2>&1 | cut -d' ' -f2)
    echo -e "${YELLOW}Found Python $PYTHON_VERSION${NC}"
    
    # Check if Python is from pyenv
    if python3 -c "import sys; print(sys.executable)" 2>/dev/null | grep -q ".pyenv"; then
      PYTHON_PATH=$(python3 -c "import sys; print(sys.executable)" 2>/dev/null)
      echo -e "${YELLOW}Detected Python installed via pyenv: $PYTHON_PATH${NC}"
      
      # Check if system Python is also available as a fallback
      if [ -f /usr/bin/python3 ]; then
        echo -e "${YELLOW}System Python is available and will be used as a fallback.${NC}"
        export NODE_GYP_FORCE_PYTHON=/usr/bin/python3
      else
        echo -e "${YELLOW}Installing system Python as a fallback...${NC}"
        sudo apt-get install -y python3 python3-dev python3-pip
        export NODE_GYP_FORCE_PYTHON=/usr/bin/python3
      fi
    else
      # Install Python development packages
      echo -e "${YELLOW}Installing Python development packages...${NC}"
      sudo apt-get install -y python3-dev python3-pip
    fi
  else
    echo -e "${YELLOW}Installing Python 3...${NC}"
    sudo apt-get install -y python3 python3-dev python3-pip
  fi
  
  # Install dependencies for native modules
  echo -e "${YELLOW}Installing dependencies for native modules...${NC}"
  sudo apt-get install -y libopus-dev libvips-dev ffmpeg
  
  echo -e "${GREEN}System dependency check completed.${NC}"
}

# Function to set up Docker for database and Redis
setup_docker_db() {
  if [ "$USE_DOCKER_DB" = true ]; then
    echo -e "${BLUE}Setting up Docker for database and Redis...${NC}"
    
    # Create docker-compose file for database and Redis
    cat > "$PROJECT_ROOT/docker-compose.db.yml" << EOF
version: '3.8'

services:
  postgres:
    image: postgres:15-alpine
    ports:
      - "5432:5432"
    environment:
      - POSTGRES_USER=miu
      - POSTGRES_PASSWORD=miu
      - POSTGRES_DB=miu
    volumes:
      - postgres_data:/var/lib/postgresql/data
    restart: always

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes
    restart: always

volumes:
  postgres_data:
  redis_data:
EOF
    
    # Start the database and Redis containers
    echo -e "${YELLOW}Starting database and Redis containers...${NC}"
    docker-compose -f "$PROJECT_ROOT/docker-compose.db.yml" up -d
    
    # Wait for the database to be ready
    echo -e "${YELLOW}Waiting for database to be ready...${NC}"
    sleep 5
    
    # Set the DATABASE_URL and REDIS_URL environment variables
    DB_URL="postgresql://miu:miu@localhost:5432/miu"
    REDIS_URL="redis://localhost:6379"
    
    echo -e "${GREEN}Docker database and Redis setup completed.${NC}"
  else
    echo -e "${YELLOW}Skipping Docker database setup as requested.${NC}"
    
    # Prompt for database configuration
    echo -e "${YELLOW}Please enter your PostgreSQL database configuration:${NC}"
    read -p "Database host (default: localhost): " DB_HOST
    DB_HOST=${DB_HOST:-localhost}
    
    read -p "Database port (default: 5432): " DB_PORT
    DB_PORT=${DB_PORT:-5432}
    
    read -p "Database name (default: miu): " DB_NAME
    DB_NAME=${DB_NAME:-miu}
    
    read -p "Database user (default: miu): " DB_USER
    DB_USER=${DB_USER:-miu}
    
    read -p "Database password (default: miu): " DB_PASSWORD
    DB_PASSWORD=${DB_PASSWORD:-miu}
    
    # Set the DATABASE_URL
    DB_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
    
    # Prompt for Redis configuration
    echo -e "${YELLOW}Please enter your Redis configuration:${NC}"
    read -p "Redis host (default: localhost): " REDIS_HOST
    REDIS_HOST=${REDIS_HOST:-localhost}
    
    read -p "Redis port (default: 6379): " REDIS_PORT
    REDIS_PORT=${REDIS_PORT:-6379}
    
    # Set the REDIS_URL
    REDIS_URL="redis://${REDIS_HOST}:${REDIS_PORT}"
  fi
}

# Function to pull from Git repository
pull_repository() {
  if [ "$PULL_REPO" = true ]; then
    echo -e "${BLUE}Pulling code from Git repository (${GIT_REPO})...${NC}"
    
    # Create deployment directory if it doesn't exist
    if [ ! -d "$DEPLOY_DIR" ]; then
      echo -e "${YELLOW}Creating deployment directory: $DEPLOY_DIR${NC}"
      sudo mkdir -p "$DEPLOY_DIR"
      sudo chown $(whoami):$(whoami) "$DEPLOY_DIR"
    fi
    
    # Check if it's a new clone or update
    if [ -d "$DEPLOY_DIR/.git" ]; then
      echo -e "${YELLOW}Updating existing repository...${NC}"
      cd "$DEPLOY_DIR"
      git fetch
      git checkout "$GIT_BRANCH"
      git pull origin "$GIT_BRANCH"
    else
      echo -e "${YELLOW}Cloning repository...${NC}"
      git clone --branch "$GIT_BRANCH" "$GIT_REPO" "$DEPLOY_DIR"
      cd "$DEPLOY_DIR"
    fi
    
    # Update PROJECT_ROOT to the deployment directory
    PROJECT_ROOT="$DEPLOY_DIR"
    
    echo -e "${GREEN}Repository updated successfully.${NC}"
  fi
}

# Function to deploy the backend
deploy_backend() {
  echo -e "${BLUE}Deploying backend...${NC}"
  
  # Navigate to backend directory
  cd "$PROJECT_ROOT/backend"
  
  # Install dependencies if needed
  if [ "$INSTALL_DEPS" = true ]; then
    echo -e "${YELLOW}Installing backend dependencies...${NC}"
    
    # Set up environment for native module builds
    export NODE_GYP_FORCE_PYTHON=/usr/bin/python3
    export SHARP_IGNORE_GLOBAL_LIBVIPS=1
    
    # First try to install all dependencies except problematic ones
    echo -e "${YELLOW}Installing main dependencies...${NC}"
    npm install --no-optional || true
    
    # Install sharp separately with specific options
    echo -e "${YELLOW}Installing sharp separately...${NC}"
    npm install sharp --no-save --build-from-source || npm install sharp@0.32.6 --no-save || true
    
    # Check if sharp installation failed
    if [ ! -d "node_modules/sharp" ] || [ ! -f "node_modules/sharp/build/Release/sharp.node" ]; then
      echo -e "${YELLOW}Sharp installation failed. Creating a dummy module...${NC}"
      mkdir -p node_modules/sharp
      cat > node_modules/sharp/index.js << EOF
console.warn('Sharp module not available. Image processing functionality is limited.');
module.exports = {
  // Provide minimal dummy implementation
  cache: () => module.exports,
  clone: () => module.exports,
  resize: () => module.exports,
  toBuffer: () => Promise.resolve(Buffer.from([])),
  toFile: () => Promise.resolve({}),
  metadata: () => Promise.resolve({}),
  // Factory function
  default: function() { return module.exports; }
};
EOF
    fi
    
    # Install @discordjs/opus separately if needed
    if [ ! -d "node_modules/@discordjs/opus" ]; then
      echo -e "${YELLOW}Installing @discordjs/opus separately...${NC}"
      npm install @discordjs/opus --no-save --build-from-source || npm install opusscript --no-save || true
    fi
  fi
  
  # Check if .env.production exists and copy to .env if needed
  if [ -f .env.production ] && [ ! -f .env ]; then
    echo -e "${YELLOW}Creating .env from .env.production...${NC}"
    cp .env.production .env
    
    # Update environment variables if domain is provided
    if [ ! -z "$DOMAIN_NAME" ]; then
      # Updated to use path-based approach
      sed -i "s|API_URL=.*|API_URL=https://${DOMAIN_NAME}/${BACKEND_PATH}|g" .env
      sed -i "s|CORS_ORIGIN=.*|CORS_ORIGIN=https://${DOMAIN_NAME}|g" .env
      sed -i "s|FRONTEND_URL=.*|FRONTEND_URL=https://${DOMAIN_NAME}|g" .env
      sed -i "s|URL=.*|URL=https://${DOMAIN_NAME}/${BACKEND_PATH}|g" .env
    fi
  fi
  
  # Update DATABASE_URL and REDIS_URL in .env
  if [ -f .env ]; then
    echo -e "${YELLOW}Updating database and Redis configuration in .env...${NC}"
    
    # Update or add DATABASE_URL
    if grep -q "DATABASE_URL=" .env; then
      sed -i "s|DATABASE_URL=.*|DATABASE_URL=${DB_URL}|g" .env
    else
      echo "DATABASE_URL=${DB_URL}" >> .env
    fi
    
    # Update or add REDIS_URL
    if grep -q "REDIS_URL=" .env; then
      sed -i "s|REDIS_URL=.*|REDIS_URL=${REDIS_URL}|g" .env
    else
      echo "REDIS_URL=${REDIS_URL}" >> .env
    fi
  else
    echo -e "${RED}Error: .env file not found. Creating a new one...${NC}"
    echo "DATABASE_URL=${DB_URL}" > .env
    echo "REDIS_URL=${REDIS_URL}" >> .env
    echo -e "${YELLOW}Created basic .env file. You may need to add more configuration.${NC}"
  fi
  
  # Run database migrations
  echo -e "${YELLOW}Running database migrations...${NC}"
  npm run prisma:migrate || {
    echo -e "${RED}Database migration failed. Retrying after a delay...${NC}"
    sleep 10
    npm run prisma:migrate || {
      echo -e "${RED}Database migration failed again. Please check your database configuration.${NC}"
      echo -e "${YELLOW}You can try running migrations manually later with:${NC}"
      echo -e "${YELLOW}  cd $PROJECT_ROOT/backend && npm run prisma:migrate${NC}"
    }
  }
  
  # Build the application
  echo -e "${YELLOW}Building backend...${NC}"
  npm run build
  
  # Start the application with PM2 if enabled
  if [ "$USE_PM2" = true ]; then
    echo -e "${YELLOW}Starting backend with PM2...${NC}"
    pm2 delete miu-backend 2>/dev/null || true
    pm2 start dist/index.js --name miu-backend
    pm2 save
  else
    echo -e "${YELLOW}To start the backend manually, run:${NC}"
    echo "cd $PROJECT_ROOT/backend && npm run start"
  fi
  
  echo -e "${GREEN}Backend deployed successfully.${NC}"
}

# Function to deploy the frontend
deploy_frontend() {
  echo -e "${BLUE}Deploying frontend...${NC}"
  
  # Navigate to frontend directory
  cd "$PROJECT_ROOT/frontend"
  
  # Install dependencies if needed
  if [ "$INSTALL_DEPS" = true ]; then
    echo -e "${YELLOW}Installing frontend dependencies...${NC}"
    npm install
  fi
  
  # Check if .env.production exists and copy to .env.local if needed
  if [ -f .env.production ] && [ ! -f .env.local ]; then
    echo -e "${YELLOW}Creating .env.local from .env.production...${NC}"
    cp .env.production .env.local
    
    # Update environment variables if domain is provided
    if [ ! -z "$DOMAIN_NAME" ]; then
      # Updated to use path-based approach
      sed -i "s|NEXT_PUBLIC_API_URL=.*|NEXT_PUBLIC_API_URL=https://${DOMAIN_NAME}/${BACKEND_PATH}|g" .env.local
      sed -i "s|NEXT_PUBLIC_URL=.*|NEXT_PUBLIC_URL=https://${DOMAIN_NAME}|g" .env.local
      sed -i "s|NEXT_PUBLIC_DISCORD_REDIRECT_URI=.*|NEXT_PUBLIC_DISCORD_REDIRECT_URI=https://${DOMAIN_NAME}/auth/callback|g" .env.local
    fi
  fi
  
  # Build the application
  echo -e "${YELLOW}Building frontend...${NC}"
  npm run build
  
  # Start the application with PM2 if enabled
  if [ "$USE_PM2" = true ]; then
    echo -e "${YELLOW}Starting frontend with PM2...${NC}"
    pm2 delete miu-frontend 2>/dev/null || true
    pm2 start npm --name miu-frontend -- start
    pm2 save
  else
    echo -e "${YELLOW}To start the frontend manually, run:${NC}"
    echo "cd $PROJECT_ROOT/frontend && npm run start"
  fi
  
  echo -e "${GREEN}Frontend deployed successfully.${NC}"
}

# Function to configure Nginx
configure_nginx() {
  if [ "$SETUP_NGINX" = true ]; then
    echo -e "${BLUE}Configuring Nginx...${NC}"
    
    # Create a single Nginx configuration for both frontend and backend
    echo -e "${YELLOW}Creating Nginx configuration...${NC}"
    sudo tee /etc/nginx/sites-available/$DOMAIN_NAME > /dev/null << EOF
server {
    listen 80;
    server_name $DOMAIN_NAME;
    
    # Frontend location
    location / {
        proxy_pass http://localhost:$FRONTEND_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
    }
    
    # Backend location
    location /${BACKEND_PATH}/ {
        proxy_pass http://localhost:$BACKEND_PORT/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
        
        # Remove the path prefix when forwarding to the backend
        rewrite ^/${BACKEND_PATH}/(.*) /\$1 break;
    }
    
    # Backend API location (for compatibility)
    location /${BACKEND_PATH}/api/ {
        proxy_pass http://localhost:$BACKEND_PORT/api/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF
    
    # Enable the site
    sudo ln -sf /etc/nginx/sites-available/$DOMAIN_NAME /etc/nginx/sites-enabled/
    
    # Test Nginx configuration
    echo -e "${YELLOW}Testing Nginx configuration...${NC}"
    sudo nginx -t
    
    # Reload Nginx
    echo -e "${YELLOW}Reloading Nginx...${NC}"
    sudo systemctl reload nginx
    
    echo -e "${GREEN}Nginx configured successfully.${NC}"
  fi
}

# Function to set up SSL with Let's Encrypt
setup_ssl() {
  if [ "$SETUP_SSL" = true ]; then
    echo -e "${BLUE}Setting up SSL with Let's Encrypt...${NC}"
    
    # Set up SSL for the domain
    echo -e "${YELLOW}Setting up SSL...${NC}"
    sudo certbot --nginx -d $DOMAIN_NAME --non-interactive --agree-tos --email admin@$DOMAIN_NAME
    
    echo -e "${GREEN}SSL certificates installed successfully.${NC}"
  fi
}

# Function to create a startup script
create_startup_script() {
  echo -e "${BLUE}Creating startup script...${NC}"
  
  # Create a startup script to start all services
  cat > "$PROJECT_ROOT/start.sh" << EOF
#!/bin/bash

# MIU Startup Script
# This script starts all required services for MIU

# Start Docker services if using Docker
if [ -f "$PROJECT_ROOT/docker-compose.db.yml" ]; then
  echo "Starting Docker services..."
  docker-compose -f "$PROJECT_ROOT/docker-compose.db.yml" up -d
fi

# Start PM2 processes
if command -v pm2 >/dev/null 2>&1; then
  echo "Starting PM2 processes..."
  pm2 resurrect || pm2 start all
fi

echo "MIU services started successfully!"
EOF
  
  # Make the script executable
  chmod +x "$PROJECT_ROOT/start.sh"
  
  echo -e "${GREEN}Startup script created at $PROJECT_ROOT/start.sh${NC}"
  echo -e "${YELLOW}You can use this script to start all services after a reboot.${NC}"
  echo -e "${YELLOW}To make it run at startup, add it to your crontab:${NC}"
  echo -e "${YELLOW}  crontab -e${NC}"
  echo -e "${YELLOW}Then add the line:${NC}"
  echo -e "${YELLOW}  @reboot $PROJECT_ROOT/start.sh${NC}"
}

# Main deployment process
echo -e "${BOLD}Starting MIU deployment...${NC}"

# Install system dependencies if needed
if [ "$INSTALL_DEPS" = true ]; then
  install_system_dependencies
fi

# Pull from Git repository if specified
pull_repository

# Set up Docker for database and Redis
setup_docker_db

# Deploy backend if enabled
if [ "$DEPLOY_BACKEND" = true ]; then
  deploy_backend
fi

# Deploy frontend if enabled
if [ "$DEPLOY_FRONTEND" = true ]; then
  deploy_frontend
fi

# Configure Nginx if enabled
configure_nginx

# Set up SSL if enabled
setup_ssl

# Create startup script
create_startup_script

# Final message
echo -e "${BOLD}${GREEN}Deployment completed successfully!${NC}"

if [ "$USE_PM2" = true ]; then
  echo -e "${YELLOW}Services are managed by PM2. Use 'pm2 list' to see running processes.${NC}"
  echo -e "${YELLOW}To make PM2 start on boot, run: 'pm2 startup' and follow the instructions.${NC}"
fi

if [ "$USE_DOCKER_DB" = true ]; then
  echo -e "${YELLOW}Database and Redis are running in Docker containers.${NC}"
  echo -e "${YELLOW}You can manage them with: 'docker-compose -f $PROJECT_ROOT/docker-compose.db.yml'${NC}"
  echo -e "${YELLOW}To make them start on boot, the startup script has been created.${NC}"
fi

if [ "$SETUP_NGINX" = true ]; then
  if [ "$SETUP_SSL" = true ]; then
    echo -e "${YELLOW}Your application is available at: https://$DOMAIN_NAME${NC}"
    echo -e "${YELLOW}Backend API is available at: https://$DOMAIN_NAME/$BACKEND_PATH${NC}"
  else
    echo -e "${YELLOW}Your application is available at: http://$DOMAIN_NAME${NC}"
    echo -e "${YELLOW}Backend API is available at: http://$DOMAIN_NAME/$BACKEND_PATH${NC}"
  fi
fi

exit 0 