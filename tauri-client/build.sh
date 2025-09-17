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

# Build the application
echo "🔨 Building Tauri application..."
cargo tauri build

echo "✅ Build complete!"
echo ""
echo "📱 Your MIU Player executable can be found in:"
echo "   src-tauri/target/release/"
echo ""
echo "🚀 To run in development mode:"
echo "   npm run dev"