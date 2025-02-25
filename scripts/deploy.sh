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

# Function to check if script is running with sudo
check_sudo() {
  if [ "$EUID" -ne 0 ]; then
    echo -e "${YELLOW}This script is not running with sudo privileges.${NC}"
    echo -e "${YELLOW}Some operations might fail due to permission issues.${NC}"
    echo -e "${YELLOW}If you encounter permission errors, you can:${NC}"
    echo -e "${YELLOW}1. Run the script with sudo: sudo ./deploy.sh [OPTIONS]${NC}"
    echo -e "${YELLOW}2. Use local installations instead of global ones${NC}"
    echo -e "${YELLOW}3. Configure npm to use a different directory for global packages:${NC}"
    echo -e "${YELLOW}   mkdir -p ~/.npm-global${NC}"
    echo -e "${YELLOW}   npm config set prefix '~/.npm-global'${NC}"
    echo -e "${YELLOW}   Add to ~/.profile: export PATH=~/.npm-global/bin:\$PATH${NC}"
    echo -e "${YELLOW}   source ~/.profile${NC}"
    
    read -p "Do you want to continue without sudo? (y/n): " CONTINUE_WITHOUT_SUDO
    if [[ "$CONTINUE_WITHOUT_SUDO" != "y" ]]; then
      echo -e "${RED}Deployment aborted. Please run with sudo or fix permissions.${NC}"
      exit 1
    fi
    
    echo -e "${YELLOW}Continuing without sudo...${NC}"
  fi
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
    
    # Try installing PM2 with sudo first
    if [ "$EUID" -eq 0 ]; then
      npm install -g pm2
    else
      # Try with sudo
      echo -e "${YELLOW}Attempting to install PM2 with sudo...${NC}"
      sudo npm install -g pm2 || {
        echo -e "${YELLOW}Sudo installation failed. Trying local installation...${NC}"
        
        # Create a directory for global npm packages in user's home
        mkdir -p "$HOME/.npm-global"
        npm config set prefix "$HOME/.npm-global"
        
        # Add to PATH temporarily
        export PATH="$HOME/.npm-global/bin:$PATH"
        
        # Install PM2
        npm install -g pm2
        
        # Add to .profile for persistence if not already there
        if ! grep -q "PATH=\"\$HOME/.npm-global/bin:\$PATH\"" "$HOME/.profile"; then
          echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> "$HOME/.profile"
          echo -e "${YELLOW}Added ~/.npm-global/bin to PATH in ~/.profile${NC}"
          echo -e "${YELLOW}Run 'source ~/.profile' to update your current session${NC}"
        fi
        
        echo -e "${YELLOW}PM2 installed in user's home directory.${NC}"
      }
    fi
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
  
  # Install comprehensive dependencies for building native modules
  echo -e "${YELLOW}Installing comprehensive dependencies for building native modules...${NC}"
  
  # Install build essentials and Python
  echo -e "${YELLOW}Installing build-essential and Python tools...${NC}"
  sudo apt-get install -y build-essential python3-pip python3-dev
  
  # Install specific dependencies for native modules (from reference guide)
  echo -e "${YELLOW}Installing specific dependencies for native modules...${NC}"
  sudo apt-get install -y libopus-dev libvips-dev ffmpeg
  sudo apt-get install -y make g++ libtool autoconf automake
  sudo apt-get install -y gyp
  
  # Install YouTube audio dependencies
  echo -e "${YELLOW}Installing YouTube audio dependencies...${NC}"
  
  # Install ffmpeg if not already installed (should be installed above, but double-check)
  if ! command_exists ffmpeg; then
    echo -e "${YELLOW}Installing ffmpeg...${NC}"
    sudo apt-get install -y ffmpeg
  fi
  
  # Install yt-dlp globally
  echo -e "${YELLOW}Installing yt-dlp globally...${NC}"
  sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
  sudo chmod a+rx /usr/local/bin/yt-dlp
  
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
    fi
  fi
  
  echo -e "${GREEN}System dependency installation completed.${NC}"
}

# Function to set up Docker for database and Redis
setup_docker_db() {
  if [ "$USE_DOCKER_DB" = true ]; then
    echo -e "${BLUE}Setting up Docker for database and Redis...${NC}"
    
    # Check if Docker containers are already running
    if command_exists docker; then
      # Check if PostgreSQL is already running on port 5432
      if lsof -i:5432 >/dev/null 2>&1 || nc -z localhost 5432 >/dev/null 2>&1; then
        echo -e "${YELLOW}Warning: Port 5432 (PostgreSQL) is already in use.${NC}"
        read -p "Do you want to continue with Docker setup? This might cause conflicts. (y/n): " CONTINUE_DOCKER
        if [[ "$CONTINUE_DOCKER" != "y" ]]; then
          echo -e "${YELLOW}Skipping Docker database setup.${NC}"
          USE_DOCKER_DB=false
          
          # Prompt for database configuration
          setup_external_db
          return
        fi
      fi
      
      # Check if Redis is already running on port 6379
      if lsof -i:6379 >/dev/null 2>&1 || nc -z localhost 6379 >/dev/null 2>&1; then
        echo -e "${YELLOW}Warning: Port 6379 (Redis) is already in use.${NC}"
        read -p "Do you want to continue with Docker setup? This might cause conflicts. (y/n): " CONTINUE_DOCKER
        if [[ "$CONTINUE_DOCKER" != "y" ]]; then
          echo -e "${YELLOW}Skipping Docker database setup.${NC}"
          USE_DOCKER_DB=false
          
          # Prompt for database configuration
          setup_external_db
          return
        fi
      fi
    fi
    
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
    setup_external_db
  fi
}

# Function to set up external database configuration
setup_external_db() {
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
}

# Function to update environment files
update_env_files() {
  echo -e "${BLUE}Updating environment files...${NC}"
  
  # Check if Node.js is installed
  if command_exists node; then
    # Check if the update-env.ts script exists
    if [ -f "$PROJECT_ROOT/scripts/update-env.ts" ]; then
      echo -e "${YELLOW}Running environment updater script...${NC}"
      
      # Create a temporary directory for local installation
      TEMP_DIR=$(mktemp -d)
      cd "$TEMP_DIR"
      
      # Try to run with npx first (which avoids global installation)
      echo -e "${YELLOW}Attempting to run with npx...${NC}"
      cd "$PROJECT_ROOT"
      if npx ts-node scripts/update-env.ts; then
        echo -e "${GREEN}Environment files updated successfully with npx.${NC}"
        rm -rf "$TEMP_DIR"
        return 0
      fi
      
      # If npx fails, try local installation
      echo -e "${YELLOW}Npx approach failed. Trying local installation...${NC}"
      cd "$TEMP_DIR"
      
      # Create a minimal package.json
      echo '{"name":"ts-node-temp","private":true}' > package.json
      
      # Install ts-node locally
      if npm install ts-node typescript; then
        echo -e "${GREEN}Successfully installed ts-node locally.${NC}"
        
        # Run the update-env.ts script with local ts-node
        cd "$PROJECT_ROOT"
        if "$TEMP_DIR/node_modules/.bin/ts-node" scripts/update-env.ts; then
          echo -e "${GREEN}Environment files updated successfully with local ts-node.${NC}"
          rm -rf "$TEMP_DIR"
          return 0
        fi
      fi
      
      # If all automated approaches fail, guide the user
      echo -e "${YELLOW}Automated environment update failed. You can try manually:${NC}"
      echo -e "${YELLOW}1. Install ts-node with sudo: sudo npm install -g ts-node typescript${NC}"
      echo -e "${YELLOW}2. Run the update script: ts-node $PROJECT_ROOT/scripts/update-env.ts${NC}"
      echo -e "${YELLOW}Or alternatively:${NC}"
      echo -e "${YELLOW}1. Install ts-node locally: npm install --save-dev ts-node typescript${NC}"
      echo -e "${YELLOW}2. Run with npx: npx ts-node scripts/update-env.ts${NC}"
      
      # Clean up
      rm -rf "$TEMP_DIR"
      
      # Ask if user wants to continue without environment update
      read -p "Do you want to continue deployment without environment update? (y/n): " CONTINUE_DEPLOY
      if [[ "$CONTINUE_DEPLOY" != "y" ]]; then
        echo -e "${RED}Deployment aborted.${NC}"
        exit 1
      fi
      
      echo -e "${YELLOW}Continuing deployment without environment update...${NC}"
    else
      echo -e "${YELLOW}Environment updater script not found. Skipping environment update.${NC}"
    fi
  else
    echo -e "${YELLOW}Node.js not found. Skipping environment update.${NC}"
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

# Function to run PM2 commands
run_pm2() {
  local command="$1"
  local args="${@:2}"
  
  # Check if PM2 is in PATH
  if command_exists pm2; then
    pm2 $command $args
  else
    # Try with npx
    echo -e "${YELLOW}PM2 not found in PATH. Trying with npx...${NC}"
    npx pm2 $command $args
  fi
}

# Function to install and configure YouTube audio dependencies
install_youtube_audio_deps() {
  echo -e "${BLUE}Installing and configuring YouTube audio dependencies...${NC}"
  
  # Install ffmpeg if not already installed
  if ! command_exists ffmpeg; then
    echo -e "${YELLOW}Installing ffmpeg...${NC}"
    sudo apt-get install -y ffmpeg
  else
    echo -e "${GREEN}ffmpeg is already installed.${NC}"
  fi
  
  # Install yt-dlp globally
  echo -e "${YELLOW}Installing yt-dlp globally...${NC}"
  sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
  sudo chmod a+rx /usr/local/bin/yt-dlp
  
  # Check if we're in the backend directory or need to navigate there
  if [ -d "$PROJECT_ROOT/backend" ]; then
    cd "$PROJECT_ROOT/backend"
  fi
  
  # Create symbolic links for yt-dlp
  echo -e "${YELLOW}Creating symbolic links for yt-dlp...${NC}"
  mkdir -p node_modules/yt-dlp-exec/bin
  ln -sf /usr/local/bin/yt-dlp node_modules/yt-dlp-exec/bin/yt-dlp
  
  # Create symbolic links for ffmpeg
  echo -e "${YELLOW}Creating symbolic links for ffmpeg...${NC}"
  mkdir -p node_modules/ffmpeg-static
  ln -sf $(which ffmpeg) node_modules/ffmpeg-static/ffmpeg
  
  # Verify installations
  echo -e "${YELLOW}Verifying installations...${NC}"
  if command_exists yt-dlp; then
    YT_DLP_VERSION=$(yt-dlp --version)
    echo -e "${GREEN}yt-dlp version $YT_DLP_VERSION installed successfully.${NC}"
  else
    echo -e "${RED}yt-dlp installation failed. Please install it manually.${NC}"
  fi
  
  if command_exists ffmpeg; then
    FFMPEG_VERSION=$(ffmpeg -version | head -n1)
    echo -e "${GREEN}$FFMPEG_VERSION installed successfully.${NC}"
  else
    echo -e "${RED}ffmpeg installation failed. Please install it manually.${NC}"
  fi
  
  echo -e "${GREEN}YouTube audio dependencies setup completed.${NC}"
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
    
    # Clean installation (from reference guide)
    echo -e "${YELLOW}Cleaning previous installation...${NC}"
    rm -rf node_modules package-lock.json
    npm cache clean --force
    
    # Two-phase installation (from reference guide)
    echo -e "${YELLOW}Phase 1: Installing dependencies (skipping scripts)...${NC}"
    npm install --ignore-scripts --no-optional --no-fund || true
    
    echo -e "${YELLOW}Phase 2: Completing installation...${NC}"
    npm install || true
    
    # Install sharp separately with multiple approaches if it failed
    if [ ! -d "node_modules/sharp" ] || [ ! -f "node_modules/sharp/build/Release/sharp.node" ]; then
      echo -e "${YELLOW}Sharp not properly installed. Trying multiple approaches...${NC}"
      
      # Approach 1: Try with prebuild-install
      echo -e "${YELLOW}Approach 1: Using prebuild-install...${NC}"
      npm install --save-dev prebuild-install
      npx prebuild-install -r sharp || true
      
      # Approach 2: Try with specific environment variables
      echo -e "${YELLOW}Approach 2: Using specific environment variables...${NC}"
      export SHARP_DIST_BASE_URL=https://sharp.pixelplumbing.com/vendor/
      npm install sharp --no-save || true
      
      # Approach 3: Try with build from source
      if [ ! -d "node_modules/sharp" ] || [ ! -f "node_modules/sharp/build/Release/sharp.node" ]; then
        echo -e "${YELLOW}Approach 3: Building from source...${NC}"
        npm install sharp --no-save --build-from-source || true
      fi
      
      # Approach 4: Try with a specific version
      if [ ! -d "node_modules/sharp" ] || [ ! -f "node_modules/sharp/build/Release/sharp.node" ]; then
        echo -e "${YELLOW}Approach 4: Trying with a specific version...${NC}"
        npm install sharp@0.32.6 --no-save || true
      fi
      
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
      else
        echo -e "${GREEN}Sharp installed successfully.${NC}"
      fi
    fi
    
    # Install @discordjs/opus separately if needed
    if [ ! -d "node_modules/@discordjs/opus" ]; then
      echo -e "${YELLOW}Installing @discordjs/opus separately...${NC}"
      npm install @discordjs/opus --no-save --build-from-source || npm install opusscript --no-save || true
    fi
  fi
  
  # Install and configure YouTube audio dependencies
  install_youtube_audio_deps
  
  # Check if .env.example exists and copy to .env if needed
  if [ ! -f .env ] && [ -f "$PROJECT_ROOT/.env.example" ]; then
    echo -e "${YELLOW}Creating .env from .env.example...${NC}"
    cp "$PROJECT_ROOT/.env.example" .env
    
    # Update environment variables if domain is provided
    if [ ! -z "$DOMAIN_NAME" ]; then
      # Updated to use path-based approach
      sed -i "s|API_URL=.*|API_URL=https://${DOMAIN_NAME}/${BACKEND_PATH}|g" .env
      sed -i "s|CORS_ORIGIN=.*|CORS_ORIGIN=https://${DOMAIN_NAME}|g" .env
      sed -i "s|FRONTEND_URL=.*|FRONTEND_URL=https://${DOMAIN_NAME}|g" .env
      sed -i "s|URL=.*|URL=https://${DOMAIN_NAME}/${BACKEND_PATH}|g" .env
    fi
  # Check if .env.production exists and copy to .env if needed
  elif [ ! -f .env ] && [ -f .env.production ]; then
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
  
  # Check if Prisma schema exists
  if [ ! -d "prisma" ]; then
    echo -e "${RED}Error: Prisma schema directory not found.${NC}"
    echo -e "${YELLOW}Creating Prisma directory structure...${NC}"
    mkdir -p prisma/migrations
    
    # Create a basic schema.prisma file if it doesn't exist
    if [ ! -f "prisma/schema.prisma" ]; then
      echo -e "${YELLOW}Creating basic schema.prisma file...${NC}"
      cat > prisma/schema.prisma << EOF
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
EOF
    fi
  fi
  
  # Run database migrations
  echo -e "${YELLOW}Running database migrations...${NC}"
  npx prisma migrate deploy || {
    echo -e "${RED}Database migration failed. Retrying after a delay...${NC}"
    sleep 10
    npx prisma migrate deploy || {
      echo -e "${RED}Database migration failed again. Please check your database configuration.${NC}"
      echo -e "${YELLOW}You can try running migrations manually later with:${NC}"
      echo -e "${YELLOW}  cd $PROJECT_ROOT/backend && npx prisma migrate deploy${NC}"
    }
  }
  
  # Generate Prisma client
  echo -e "${YELLOW}Generating Prisma client...${NC}"
  
  # Check if @prisma/client is installed
  if [ ! -d "node_modules/@prisma" ]; then
    echo -e "${YELLOW}@prisma/client not found. Installing...${NC}"
    npm install @prisma/client prisma --save
  fi
  
  npx prisma generate || {
    echo -e "${RED}Failed to generate Prisma client. Retrying...${NC}"
    sleep 5
    npx prisma generate || {
      echo -e "${RED}Failed to generate Prisma client again. This may cause build errors.${NC}"
      echo -e "${YELLOW}You can try generating the Prisma client manually with:${NC}"
      echo -e "${YELLOW}  cd $PROJECT_ROOT/backend && npx prisma generate${NC}"
    }
  }
  
  # Build the application
  echo -e "${YELLOW}Building backend...${NC}"
  npm run build || {
    echo -e "${RED}Build failed. This might be due to TypeScript errors.${NC}"
    echo -e "${YELLOW}You can try fixing the errors and building manually:${NC}"
    echo -e "${YELLOW}  cd $PROJECT_ROOT/backend && npm run build${NC}"
    
    # Continue deployment despite build errors if the user wants to
    read -p "Do you want to continue deployment despite build errors? (y/n): " CONTINUE_DEPLOY
    if [[ "$CONTINUE_DEPLOY" != "y" ]]; then
      echo -e "${RED}Deployment aborted due to build errors.${NC}"
      exit 1
    fi
    
    echo -e "${YELLOW}Continuing deployment despite build errors...${NC}"
  }
  
  # Start the application with PM2 if enabled
  if [ "$USE_PM2" = true ]; then
    echo -e "${YELLOW}Starting backend with PM2...${NC}"
    
    # Check if Prisma client is properly generated
    if [ ! -d "node_modules/.prisma/client" ]; then
      echo -e "${RED}Warning: Prisma client may not be properly generated.${NC}"
      echo -e "${YELLOW}This might cause runtime errors. Consider regenerating the Prisma client:${NC}"
      echo -e "${YELLOW}  cd $PROJECT_ROOT/backend && npx prisma generate${NC}"
      
      # Ask if user wants to continue
      read -p "Do you want to continue starting the application? (y/n): " CONTINUE_START
      if [[ "$CONTINUE_START" != "y" ]]; then
        echo -e "${RED}Application startup aborted.${NC}"
        return 1
      fi
    fi
    
    run_pm2 delete miu-backend 2>/dev/null || true
    run_pm2 start dist/index.js --name miu-backend
    run_pm2 save
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
  
  # Check if .env.example exists and copy to .env.local if needed
  if [ ! -f .env.local ] && [ -f "$PROJECT_ROOT/.env.example" ]; then
    echo -e "${YELLOW}Creating .env.local from .env.example...${NC}"
    cp "$PROJECT_ROOT/.env.example" .env.local
    
    # Update environment variables if domain is provided
    if [ ! -z "$DOMAIN_NAME" ]; then
      # Updated to use path-based approach
      sed -i "s|NEXT_PUBLIC_API_URL=.*|NEXT_PUBLIC_API_URL=https://${DOMAIN_NAME}/${BACKEND_PATH}|g" .env.local
      sed -i "s|NEXT_PUBLIC_URL=.*|NEXT_PUBLIC_URL=https://${DOMAIN_NAME}|g" .env.local
      sed -i "s|NEXT_PUBLIC_DISCORD_REDIRECT_URI=.*|NEXT_PUBLIC_DISCORD_REDIRECT_URI=https://${DOMAIN_NAME}/auth/callback|g" .env.local
    fi
  # Check if .env.production exists and copy to .env.local if needed
  elif [ ! -f .env.local ] && [ -f .env.production ]; then
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
    run_pm2 delete miu-frontend 2>/dev/null || true
    run_pm2 start npm --name miu-frontend -- start
    run_pm2 save
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

# Set up environment variables for native modules
export NODE_GYP_FORCE_PYTHON=/usr/bin/python3
export SHARP_IGNORE_GLOBAL_LIBVIPS=1
export SHARP_DIST_BASE_URL=https://sharp.pixelplumbing.com/vendor/

# Add npm global bin to PATH if it exists
if [ -d "\$HOME/.npm-global/bin" ]; then
  export PATH="\$HOME/.npm-global/bin:\$PATH"
fi

# Check YouTube audio dependencies
check_youtube_audio_deps() {
  echo "Checking YouTube audio dependencies..."
  
  # Check if yt-dlp is installed
  if ! command -v yt-dlp >/dev/null 2>&1; then
    echo "Warning: yt-dlp not found. YouTube audio features may not work."
    echo "Run the reinstall-packages.sh script and select option 5 to fix this issue."
  else
    # Check if symbolic links exist
    if [ -d "$PROJECT_ROOT/backend" ]; then
      if [ ! -f "$PROJECT_ROOT/backend/node_modules/yt-dlp-exec/bin/yt-dlp" ]; then
        echo "Creating symbolic link for yt-dlp..."
        mkdir -p "$PROJECT_ROOT/backend/node_modules/yt-dlp-exec/bin"
        ln -sf /usr/local/bin/yt-dlp "$PROJECT_ROOT/backend/node_modules/yt-dlp-exec/bin/yt-dlp"
      fi
    fi
  fi
  
  # Check if ffmpeg is installed
  if ! command -v ffmpeg >/dev/null 2>&1; then
    echo "Warning: ffmpeg not found. Audio processing features may not work."
    echo "Run the reinstall-packages.sh script and select option 5 to fix this issue."
  else
    # Check if symbolic links exist
    if [ -d "$PROJECT_ROOT/backend" ]; then
      if [ ! -f "$PROJECT_ROOT/backend/node_modules/ffmpeg-static/ffmpeg" ]; then
        echo "Creating symbolic link for ffmpeg..."
        mkdir -p "$PROJECT_ROOT/backend/node_modules/ffmpeg-static"
        ln -sf \$(which ffmpeg) "$PROJECT_ROOT/backend/node_modules/ffmpeg-static/ffmpeg"
      fi
    fi
  fi
}

# Check YouTube audio dependencies
check_youtube_audio_deps

# Start Docker services if using Docker
if [ -f "$PROJECT_ROOT/docker-compose.db.yml" ]; then
  echo "Starting Docker services..."
  docker-compose -f "$PROJECT_ROOT/docker-compose.db.yml" up -d
fi

# Start PM2 processes
if command -v pm2 >/dev/null 2>&1; then
  echo "Starting PM2 processes..."
  pm2 resurrect || pm2 start all
else
  # Try with npx
  echo "PM2 not found in PATH. Trying with npx..."
  if command -v npx >/dev/null 2>&1; then
    npx pm2 resurrect || npx pm2 start all
  else
    echo "Neither PM2 nor npx found. Cannot start PM2 processes."
  fi
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

# Function to create a helper script for reinstalling problematic packages
create_reinstall_script() {
  echo -e "${BLUE}Creating package reinstallation helper script...${NC}"
  
  # Create a script to reinstall problematic packages
  cat > "$PROJECT_ROOT/reinstall-packages.sh" << EOF
#!/bin/bash

# MIU Package Reinstallation Script
# This script helps reinstall problematic native packages

# Set up environment variables for native modules
export NODE_GYP_FORCE_PYTHON=/usr/bin/python3
export SHARP_IGNORE_GLOBAL_LIBVIPS=1
export SHARP_DIST_BASE_URL=https://sharp.pixelplumbing.com/vendor/

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

# Function to reinstall a package
reinstall_package() {
  local package=\$1
  local directory=\$2
  
  echo -e "\${YELLOW}Reinstalling \${package}...\${NC}"
  
  # Remove the package
  rm -rf "\${directory}/node_modules/\${package}"
  
  # Clean npm cache for the package
  npm cache clean --force \${package}
  
  # Try different installation methods
  echo -e "\${YELLOW}Trying standard installation...\${NC}"
  npm install \${package} --save || {
    echo -e "\${YELLOW}Standard installation failed. Trying build from source...\${NC}"
    npm install \${package} --build-from-source --save || {
      echo -e "\${RED}All installation methods failed for \${package}.\${NC}"
      return 1
    }
  }
  
  echo -e "\${GREEN}\${package} reinstalled successfully.\${NC}"
  return 0
}

# Function to fix YouTube audio dependencies
fix_youtube_audio_deps() {
  echo -e "\${YELLOW}Fixing YouTube audio dependencies...\${NC}"
  
  # Install ffmpeg if not already installed
  if ! command -v ffmpeg >/dev/null 2>&1; then
    echo -e "\${YELLOW}Installing ffmpeg...\${NC}"
    sudo apt-get install -y ffmpeg
  else
    echo -e "\${GREEN}ffmpeg is already installed.\${NC}"
  fi
  
  # Install yt-dlp globally
  echo -e "\${YELLOW}Installing yt-dlp globally...\${NC}"
  sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
  sudo chmod a+rx /usr/local/bin/yt-dlp
  
  # Create symbolic links for yt-dlp
  echo -e "\${YELLOW}Creating symbolic links for yt-dlp...\${NC}"
  mkdir -p node_modules/yt-dlp-exec/bin
  ln -sf /usr/local/bin/yt-dlp node_modules/yt-dlp-exec/bin/yt-dlp
  
  # Create symbolic links for ffmpeg
  echo -e "\${YELLOW}Creating symbolic links for ffmpeg...\${NC}"
  mkdir -p node_modules/ffmpeg-static
  ln -sf \$(which ffmpeg) node_modules/ffmpeg-static/ffmpeg
  
  # Verify installations
  echo -e "\${YELLOW}Verifying installations...\${NC}"
  if command -v yt-dlp >/dev/null 2>&1; then
    YT_DLP_VERSION=\$(yt-dlp --version)
    echo -e "\${GREEN}yt-dlp version \$YT_DLP_VERSION installed successfully.\${NC}"
  else
    echo -e "\${RED}yt-dlp installation failed. Please install it manually.\${NC}"
  fi
  
  if command -v ffmpeg >/dev/null 2>&1; then
    FFMPEG_VERSION=\$(ffmpeg -version | head -n1)
    echo -e "\${GREEN}\$FFMPEG_VERSION installed successfully.\${NC}"
  else
    echo -e "\${RED}ffmpeg installation failed. Please install it manually.\${NC}"
  fi
  
  echo -e "\${GREEN}YouTube audio dependencies fixed successfully.\${NC}"
}

# Check which directory to use
if [ -d "./backend" ]; then
  cd ./backend
  echo -e "\${YELLOW}Working in backend directory.\${NC}"
elif [ -d "../backend" ]; then
  cd ../backend
  echo -e "\${YELLOW}Working in backend directory.\${NC}"
else
  echo -e "\${YELLOW}Working in current directory.\${NC}"
fi

# Current directory
CURRENT_DIR=\$(pwd)

# Menu
echo "Select an option:"
echo "1) Reinstall @discordjs/opus"
echo "2) Reinstall sharp"
echo "3) Reinstall all problematic packages"
echo "4) Clean installation (remove all node_modules)"
echo "5) Fix YouTube audio dependencies (yt-dlp and ffmpeg)"
echo "6) Exit"

read -p "Enter your choice (1-6): " CHOICE

case \$CHOICE in
  1)
    reinstall_package "@discordjs/opus" "\$CURRENT_DIR"
    ;;
  2)
    reinstall_package "sharp" "\$CURRENT_DIR"
    ;;
  3)
    reinstall_package "@discordjs/opus" "\$CURRENT_DIR"
    reinstall_package "sharp" "\$CURRENT_DIR"
    ;;
  4)
    echo -e "\${YELLOW}Performing clean installation...\${NC}"
    rm -rf node_modules package-lock.json
    npm cache clean --force
    
    echo -e "\${YELLOW}Phase 1: Installing dependencies (skipping scripts)...\${NC}"
    npm install --ignore-scripts --no-optional --no-fund
    
    echo -e "\${YELLOW}Phase 2: Completing installation...\${NC}"
    npm install
    
    echo -e "\${GREEN}Clean installation completed.\${NC}"
    ;;
  5)
    fix_youtube_audio_deps
    ;;
  6)
    echo -e "\${YELLOW}Exiting.\${NC}"
    exit 0
    ;;
  *)
    echo -e "\${RED}Invalid choice.\${NC}"
    exit 1
    ;;
esac

echo -e "\${GREEN}Operation completed.\${NC}"
EOF
  
  # Make the script executable
  chmod +x "$PROJECT_ROOT/reinstall-packages.sh"
  
  echo -e "${GREEN}Package reinstallation helper script created at $PROJECT_ROOT/reinstall-packages.sh${NC}"
  echo -e "${YELLOW}You can use this script to reinstall problematic packages if needed.${NC}"
}

# Function to update .env.example based on current .env
update_env_example() {
  echo -e "${BLUE}Updating .env.example file...${NC}"
  
  # Check if .env and .env.example exist
  if [ -f "$PROJECT_ROOT/.env" ] && [ -f "$PROJECT_ROOT/.env.example" ]; then
    echo -e "${YELLOW}Creating updated .env.example from .env...${NC}"
    
    # Create a temporary file
    TEMP_FILE=$(mktemp)
    
    # Read .env.example to get structure and comments
    cat "$PROJECT_ROOT/.env.example" > "$TEMP_FILE"
    
    # Update values from .env but keep structure and comments
    while IFS='=' read -r key value; do
      # Skip comments and empty lines
      if [[ "$key" =~ ^#.*$ ]] || [[ -z "$key" ]]; then
        continue
      fi
      
      # Replace the value in .env.example
      if grep -q "^$key=" "$TEMP_FILE"; then
        # For sensitive values, use placeholders instead of actual values
        if [[ "$key" == *"TOKEN"* ]] || [[ "$key" == *"SECRET"* ]] || [[ "$key" == *"PASSWORD"* ]] || [[ "$key" == *"KEY"* ]]; then
          # Keep the example placeholder
          continue
        else
          # Update with actual value
          sed -i "s|^$key=.*|$key=$value|g" "$TEMP_FILE"
        fi
      fi
    done < "$PROJECT_ROOT/.env"
    
    # Backup the original .env.example
    cp "$PROJECT_ROOT/.env.example" "$PROJECT_ROOT/.env.example.bak"
    
    # Replace .env.example with the updated file
    mv "$TEMP_FILE" "$PROJECT_ROOT/.env.example"
    
    echo -e "${GREEN}.env.example updated successfully. Original backed up to .env.example.bak${NC}"
  else
    echo -e "${YELLOW}Either .env or .env.example not found. Skipping update.${NC}"
  fi
}

# Main deployment process
echo -e "${BOLD}Starting MIU deployment...${NC}"

# Check if running with sudo
check_sudo

# Install system dependencies if needed
if [ "$INSTALL_DEPS" = true ]; then
  install_system_dependencies
fi

# Pull from Git repository if specified
pull_repository

# Set up Docker for database and Redis
setup_docker_db

# Update environment files
update_env_files

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

# Create package reinstallation helper script
create_reinstall_script

# Update .env.example based on current .env
update_env_example

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