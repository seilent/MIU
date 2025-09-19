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

# Check build target argument
TARGET="$1"

if [ "$TARGET" = "windows" ]; then
    echo "🪟 Building for Windows (x86_64-pc-windows-gnu)..."

    # Check if Windows target is installed
    if ! rustup target list --installed | grep -q "x86_64-pc-windows-gnu"; then
        echo "📦 Installing Windows target..."
        rustup target add x86_64-pc-windows-gnu
    fi

    cargo tauri build --target x86_64-pc-windows-gnu

    if [ -f "target/x86_64-pc-windows-gnu/release/miu.exe" ]; then
        echo "📤 Deploying to download server..."
        sudo cp target/x86_64-pc-windows-gnu/release/miu.exe /srv/http/miu.gacha.boo/dl/

        # WebView2Loader.dll is now optional - only copy if it exists
        if [ -f "target/x86_64-pc-windows-gnu/release/WebView2Loader.dll" ]; then
            sudo cp target/x86_64-pc-windows-gnu/release/WebView2Loader.dll /srv/http/miu.gacha.boo/dl/
            WEBVIEW2_STATUS="✅ WebView2Loader.dll included (legacy support)"
        else
            WEBVIEW2_STATUS="⚡ WebView2Loader.dll not included (will prompt for download)"
        fi

        sudo cp icons/tray-icon.ico /srv/http/miu.gacha.boo/dl/miu.ico
        echo "✅ Windows executable deployed to https://miu.gacha.boo/dl/"

        echo ""
        echo "✅ Windows build complete!"
        echo "📱 Local executable: target/x86_64-pc-windows-gnu/release/miu.exe"
        echo "🌐 Download URLs:"
        echo "   📱 Executable: https://miu.gacha.boo/dl/miu.exe"

        if [ -f "target/x86_64-pc-windows-gnu/release/WebView2Loader.dll" ]; then
            echo "   📦 WebView2 DLL: https://miu.gacha.boo/dl/WebView2Loader.dll"
        fi

        echo "   🖼️ Icon: https://miu.gacha.boo/dl/miu.ico"
        echo ""
        echo "📋 Usage: Download miu.exe and run - WebView2 will be downloaded automatically if needed"
        echo "📊 Size: $(ls -lh target/x86_64-pc-windows-gnu/release/miu.exe | awk '{print $5}') (exe)"
        echo "$WEBVIEW2_STATUS"
    fi

elif [ "$TARGET" = "linux" ] || [ -z "$TARGET" ]; then
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
else
    echo "❌ Unknown target: $TARGET"
    echo "Usage: $0 [windows|linux]"
    exit 1
fi

echo "✅ Build complete!"
echo ""
echo "🚀 To run in development mode:"
echo "   npm run dev"
echo ""
echo "📥 Download URLs:"
echo "   🐧 Linux: https://miu.gacha.boo/dl/miu"
echo "   🪟 Windows: https://miu.gacha.boo/dl/miu.exe (WebView2 auto-downloaded if needed)"
echo "   🖼️ Icons: https://miu.gacha.boo/dl/miu.png (Linux) | https://miu.gacha.boo/dl/miu.ico (Windows)"