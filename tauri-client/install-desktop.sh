#!/bin/bash

# MIU Player Desktop Integration Script
# Run this script from the same directory as the miu-player binary

SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
BINARY_PATH="$SCRIPT_DIR/miu-player"
DESKTOP_FILE="$HOME/.local/share/applications/miu-player.desktop"

echo "🎵 Installing MIU Player desktop integration..."

# Check if binary exists
if [ ! -f "$BINARY_PATH" ]; then
    echo "❌ Error: miu-player binary not found in $SCRIPT_DIR"
    echo "Please place this script in the same directory as miu-player"
    exit 1
fi

# Create applications directory if it doesn't exist
mkdir -p "$HOME/.local/share/applications"

# Create desktop entry
cat > "$DESKTOP_FILE" << EOF
[Desktop Entry]
Name=MIU Player
Comment=MIU Music Player
Exec=$BINARY_PATH
Terminal=false
Type=Application
Categories=AudioVideo;Audio;Music;
StartupWMClass=miu-player
EOF

chmod +x "$DESKTOP_FILE"

echo "✅ Desktop entry created!"
echo "📱 Binary: $BINARY_PATH"
echo "🖥️ Desktop entry: $DESKTOP_FILE"
echo "🚀 MIU Player should now appear in your application launcher"
echo ""
echo "To uninstall: rm '$DESKTOP_FILE'"