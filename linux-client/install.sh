#!/bin/bash
# Simple installation script for MIU Linux Client

set -e

echo "MIU Linux Client Installer"
echo "=========================="

# Check Python version
if ! python3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" 2>/dev/null; then
    echo "Error: Python 3.8 or higher is required"
    exit 1
fi

echo "Python version check: OK"

# Check if pip is available
if ! command -v pip3 &> /dev/null; then
    echo "Error: pip3 is not available. Please install pip for Python 3"
    exit 1
fi

echo "Installing dependencies..."

# Install minimal dependencies
pip3 install --user pygame

# Try to install optional GUI dependencies
echo "Installing optional GUI dependencies..."
pip3 install --user Pillow pystray 2>/dev/null || echo "Warning: Some GUI dependencies failed to install. GUI mode may not work."

# Install the client
echo "Installing MIU Client..."
pip3 install --user .

echo ""
echo "Installation complete!"
echo ""
echo "Usage:"
echo "  miu-client                    # Start with GUI (if available)"
echo "  miu-client --console          # Console mode only"
echo "  miu-client --server URL       # Connect to specific server"
echo "  miu-client --help             # Show all options"
echo ""
echo "Default server: http://localhost:3000"
echo "Make sure your MIU server is running and accessible."