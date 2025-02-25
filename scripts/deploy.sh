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
  
  # Check for dependencies required for building @discordjs/opus
  echo -e "${YELLOW}Checking dependencies for building native modules...${NC}"
  
  # Check for build tools
  if ! command_exists gcc || ! command_exists make; then
    echo -e "${YELLOW}Warning: Build tools (gcc, make) are required for native modules.${NC}"
    echo -e "${YELLOW}You may need to install build-essential package:${NC}"
    echo -e "${YELLOW}  sudo apt-get install -y build-essential${NC}"
  fi
  
  # Check for Python and handle externally managed environments
  if command_exists python3; then
    PYTHON_VERSION=$(python3 --version 2>&1 | cut -d' ' -f2)
    echo -e "${YELLOW}Found Python $PYTHON_VERSION${NC}"
    
    # Check if Python is from pyenv
    if python3 -c "import sys; print(sys.executable)" 2>/dev/null | grep -q ".pyenv"; then
      PYTHON_PATH=$(python3 -c "import sys; print(sys.executable)" 2>/dev/null)
      echo -e "${YELLOW}Detected Python installed via pyenv: $PYTHON_PATH${NC}"
      echo -e "${YELLOW}For native module builds with pyenv Python, you may need to:${NC}"
      echo -e "${YELLOW}1. Install gyp in your pyenv environment:${NC}"
      echo -e "${YELLOW}   pip install gyp${NC}"
      echo -e "${YELLOW}2. Or set NODE_GYP_FORCE_PYTHON to use system Python instead:${NC}"
      echo -e "${YELLOW}   export NODE_GYP_FORCE_PYTHON=/usr/bin/python3${NC}"
      
      # Check if system Python is also available as a fallback
      if [ -f /usr/bin/python3 ]; then
        echo -e "${YELLOW}System Python is available and will be used as a fallback.${NC}"
      else
        echo -e "${RED}Warning: No system Python detected. Native module builds may fail.${NC}"
        echo -e "${YELLOW}Consider installing system Python as a fallback:${NC}"
        echo -e "${YELLOW}  sudo apt-get install -y python3 python3-dev${NC}"
      fi
    else
      # Check if system has python3-dev package
      if ! dpkg -l | grep -q python3-dev; then
        echo -e "${YELLOW}Warning: python3-dev package is required for building native modules.${NC}"
        echo -e "${YELLOW}Install it with:${NC}"
        echo -e "${YELLOW}  sudo apt-get install -y python3-dev${NC}"
      fi
      
      # Check if system has python3-full package (needed for venv)
      if ! dpkg -l | grep -q python3-full; then
        echo -e "${YELLOW}Warning: python3-full package is recommended for creating virtual environments.${NC}"
        echo -e "${YELLOW}Install it with:${NC}"
        echo -e "${YELLOW}  sudo apt-get install -y python3-full${NC}"
      fi
      
      # Check if system has python3-pip
      if ! command_exists pip3; then
        echo -e "${YELLOW}Warning: pip3 not found. It's needed for Python package management.${NC}"
        echo -e "${YELLOW}Install it with:${NC}"
        echo -e "${YELLOW}  sudo apt-get install -y python3-pip${NC}"
      fi
      
      # Check if this is an externally managed environment
      if python3 -m pip --version 2>&1 | grep -q "externally-managed-environment"; then
        echo -e "${YELLOW}Detected externally managed Python environment (PEP 668).${NC}"
        echo -e "${YELLOW}To install gyp, you have several options:${NC}"
        echo -e "${YELLOW}1. Use system package if available:${NC}"
        echo -e "${YELLOW}   sudo apt-get install -y python3-gyp${NC}"
        echo -e "${YELLOW}2. Create a virtual environment:${NC}"
        echo -e "${YELLOW}   python3 -m venv $HOME/.venvs/miu-build${NC}"
        echo -e "${YELLOW}   source $HOME/.venvs/miu-build/bin/activate${NC}"
        echo -e "${YELLOW}   pip install gyp${NC}"
        echo -e "${YELLOW}   # Then run this deployment script from within the activated environment${NC}"
        echo -e "${YELLOW}3. Use pipx for isolated installation:${NC}"
        echo -e "${YELLOW}   sudo apt-get install -y pipx${NC}"
        echo -e "${YELLOW}   pipx install gyp${NC}"
        echo -e "${YELLOW}4. Use --break-system-packages flag (not recommended):${NC}"
        echo -e "${YELLOW}   pip install --break-system-packages gyp${NC}"
      fi
    fi
  else
    echo -e "${RED}Warning: Python 3 is required for building native modules but was not found.${NC}"
    echo -e "${YELLOW}Please install Python 3 manually before continuing:${NC}"
    echo -e "${YELLOW}  sudo apt-get install -y python3 python3-dev python3-full${NC}"
  fi
  
  # Check for audio dependencies
  if ! command_exists ffmpeg; then
    echo -e "${YELLOW}Warning: ffmpeg is required for audio processing but was not found.${NC}"
    echo -e "${YELLOW}You may need to install it manually:${NC}"
    echo -e "${YELLOW}  sudo apt-get install -y ffmpeg${NC}"
  fi
  
  # Check for libopus
  if [ ! -f /usr/include/opus/opus.h ] && [ ! -f /usr/local/include/opus/opus.h ]; then
    echo -e "${YELLOW}Warning: libopus development files not found. These are required for @discordjs/opus.${NC}"
    echo -e "${YELLOW}You may need to install them manually:${NC}"
    echo -e "${YELLOW}  sudo apt-get install -y libopus-dev${NC}"
  fi
  
  echo -e "${GREEN}System dependency check completed.${NC}"
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
    
    # First try to install all dependencies
    npm install || true
    
    # Check if @discordjs/opus installation failed
    if [ ! -d "node_modules/@discordjs/opus" ]; then
      echo -e "${YELLOW}@discordjs/opus installation failed. This is likely due to missing build dependencies.${NC}"
      echo -e "${YELLOW}Please ensure you have the following installed:${NC}"
      echo -e "${YELLOW}  - Python 3 with development headers (python3-dev)${NC}"
      echo -e "${YELLOW}  - Build tools (build-essential)${NC}"
      echo -e "${YELLOW}  - libopus-dev${NC}"
      echo -e "${YELLOW}  - ffmpeg${NC}"
      
      # Check if Python is installed via pyenv
      if command -v python3 >/dev/null 2>&1 && python3 --version | grep -q "Python" && python3 -c "import sys; print(sys.executable)" | grep -q ".pyenv"; then
        echo -e "${YELLOW}Detected Python installed via pyenv.${NC}"
        PYTHON_PATH=$(command -v python3)
        echo -e "${YELLOW}Python path: $PYTHON_PATH${NC}"
        
        echo -e "${YELLOW}For pyenv Python installations, you need to install gyp in your active Python environment:${NC}"
        echo -e "${YELLOW}  pip install gyp${NC}"
        echo -e "${YELLOW}If you encounter 'externally-managed-environment' error, use:${NC}"
        echo -e "${YELLOW}  pip install --break-system-packages gyp${NC}"
        echo -e "${YELLOW}Or create a dedicated virtual environment for building:${NC}"
        echo -e "${YELLOW}  python -m venv $HOME/.venvs/build-env${NC}"
        echo -e "${YELLOW}  source $HOME/.venvs/build-env/bin/activate${NC}"
        echo -e "${YELLOW}  pip install gyp${NC}"
        
        # Try to install gyp in the current Python environment
        echo -e "${YELLOW}Attempting to install gyp in the current Python environment...${NC}"
        pip install gyp 2>/dev/null || pip install --break-system-packages gyp 2>/dev/null || true
      fi
      
      # Check if we're in an externally managed Python environment
      if command_exists python3 && python3 -m pip --version 2>&1 | grep -q "externally-managed-environment"; then
        echo -e "${RED}Detected externally managed Python environment (PEP 668).${NC}"
        echo -e "${YELLOW}To build native modules, you need to either:${NC}"
        echo -e "${YELLOW}1. Install system package: sudo apt-get install -y python3-gyp${NC}"
        echo -e "${YELLOW}2. Create and activate a virtual environment before running this script:${NC}"
        echo -e "${YELLOW}   python3 -m venv $HOME/.venvs/miu-build${NC}"
        echo -e "${YELLOW}   source $HOME/.venvs/miu-build/bin/activate${NC}"
        echo -e "${YELLOW}   pip install gyp${NC}"
        echo -e "${YELLOW}   # Then run this deployment script again${NC}"
        echo -e "${YELLOW}3. Use --break-system-packages flag (not recommended but works for quick testing):${NC}"
        echo -e "${YELLOW}   pip install --break-system-packages gyp${NC}"
        
        # Try to use system python3-gyp if available
        if apt-cache show python3-gyp &>/dev/null; then
          echo -e "${YELLOW}Attempting to install system python3-gyp package...${NC}"
          sudo apt-get install -y python3-gyp || true
        fi
      fi
      
      # Set NODE_GYP_FORCE_PYTHON to use the system Python if available
      if command_exists /usr/bin/python3; then
        echo -e "${YELLOW}Setting NODE_GYP_FORCE_PYTHON to use system Python...${NC}"
        export NODE_GYP_FORCE_PYTHON=/usr/bin/python3
      fi
      
      echo -e "${YELLOW}Attempting to fix @discordjs/opus installation...${NC}"
      
      # Try to install with --build-from-source flag
      echo -e "${YELLOW}Trying to build @discordjs/opus from source...${NC}"
      npm install @discordjs/opus --no-save --build-from-source || true
      
      # If still failing, try with an alternative voice implementation
      if [ ! -d "node_modules/@discordjs/opus" ]; then
        echo -e "${YELLOW}Building from source failed. Using alternative voice implementation...${NC}"
        # Install opusscript as a fallback (pure JS implementation, less efficient but more compatible)
        npm install opusscript
        
        # Create a patch to use opusscript instead if needed
        if [ -f "src/services/discord/voice.ts" ]; then
          echo -e "${YELLOW}Patching voice service to use alternative implementation...${NC}"
          # This is a simple patch that might need to be adjusted based on your actual code
          sed -i 's/@discordjs\/opus/opusscript/g' src/services/discord/voice.ts
          echo -e "${YELLOW}Note: Using opusscript instead of @discordjs/opus may result in lower voice quality${NC}"
        fi
      fi
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
  
  # Run database migrations
  echo -e "${YELLOW}Running database migrations...${NC}"
  npm run prisma:migrate
  
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

# Main deployment process
echo -e "${BOLD}Starting MIU deployment...${NC}"

# Install system dependencies if needed
if [ "$INSTALL_DEPS" = true ]; then
  install_system_dependencies
fi

# Pull from Git repository if specified
pull_repository

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

# Final message
echo -e "${BOLD}${GREEN}Deployment completed successfully!${NC}"

if [ "$USE_PM2" = true ]; then
  echo -e "${YELLOW}Services are managed by PM2. Use 'pm2 list' to see running processes.${NC}"
  echo -e "${YELLOW}To make PM2 start on boot, run: 'pm2 startup' and follow the instructions.${NC}"
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