#!/bin/bash

# MIU Player Tauri Build Script

echo "🎵 Building MIU Player Tauri Edition..."

# Check if Rust is installed
if ! command -v cargo &> /dev/null; then
    echo "❌ Rust is not installed. Please install Rust first:"
    echo "   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    exit 1
fi

# Check if Tauri CLI is installed
if ! command -v cargo-tauri &> /dev/null; then
    echo "📦 Installing Tauri CLI..."
    cargo install tauri-cli
fi

# Create dist directory and copy frontend
echo "📁 Preparing frontend assets..."
mkdir -p dist
cp -r frontend/* dist/

# Detect OS and build accordingly
OS=$(uname -s)
case $OS in
    Linux*)
        echo "🐧 Building for Linux..."
        cargo tauri build --target x86_64-unknown-linux-gnu

        # Copy to download server
        if [ -f "target/x86_64-unknown-linux-gnu/release/miu" ]; then
            echo "📤 Deploying to download server..."
            sudo cp target/x86_64-unknown-linux-gnu/release/miu /srv/http/miu.gacha.boo/dl/
            sudo cp icons/icon.png /srv/http/miu.gacha.boo/dl/miu.png
            echo "✅ Binary and icon deployed to https://miu.gacha.boo/dl/"
        fi

        echo ""
        echo "📱 Local binary: target/x86_64-unknown-linux-gnu/release/miu"
        echo "🌐 Download URL: https://miu.gacha.boo/dl/miu"
        echo "🚀 Install command: curl -fsSL https://miu.gacha.boo/dl/install.sh | bash"
        ;;
    *)
        echo "🔨 Building generic application..."
        cargo tauri build
        echo ""
        echo "📱 Executable: target/release/"
        ;;
esac

echo "✅ Build complete!"
echo ""
echo "🚀 To run in development mode:"
echo "   npm run dev"