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
        echo "📤 Creating Windows package..."

        # Create temporary directory for packaging
        TEMP_DIR=$(mktemp -d)
        PACKAGE_NAME="miu-player-windows"
        PACKAGE_DIR="$TEMP_DIR/$PACKAGE_NAME"
        mkdir -p "$PACKAGE_DIR"

        # Copy only essential files to package directory
        cp target/x86_64-pc-windows-gnu/release/miu.exe "$PACKAGE_DIR/"
        cp target/x86_64-pc-windows-gnu/release/WebView2Loader.dll "$PACKAGE_DIR/"

        # Create ZIP file
        cd "$TEMP_DIR"
        ZIP_FILE="miu.zip"
        zip -r "$ZIP_FILE" "$PACKAGE_NAME/"

        # Deploy to server
        echo "📤 Deploying to download server..."
        sudo cp "$ZIP_FILE" /srv/http/miu.gacha.boo/dl/

        # Clean up old individual Windows files from dl folder
        echo "🧹 Cleaning up old Windows files..."
        sudo rm -f /srv/http/miu.gacha.boo/dl/miu.exe
        sudo rm -f /srv/http/miu.gacha.boo/dl/WebView2Loader.dll
        sudo rm -f /srv/http/miu.gacha.boo/dl/miu.ico
        sudo rm -f /srv/http/miu.gacha.boo/dl/README.txt
        sudo rm -f /srv/http/miu.gacha.boo/dl/miu-player-windows.zip

        # Get file sizes
        EXE_SIZE=$(ls -lh "$PACKAGE_DIR/miu.exe" | awk '{print $5}')
        ZIP_SIZE=$(ls -lh "$ZIP_FILE" | awk '{print $5}')

        # Cleanup
        cd - > /dev/null
        rm -rf "$TEMP_DIR"

        echo "✅ Windows package deployed to https://miu.gacha.boo/dl/"

        echo ""
        echo "✅ Windows build complete!"
        echo "📱 Local executable: target/x86_64-pc-windows-gnu/release/miu.exe"
        echo "🌐 Download URL:"
        echo "   📦 Windows Package: https://miu.gacha.boo/dl/$ZIP_FILE"
        echo ""
        echo "📋 Usage: Download ZIP, extract and run miu.exe"
        echo "📊 Package size: $ZIP_SIZE (contains $EXE_SIZE exe + 159KB dll)"
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
echo "   🪟 Windows: https://miu.gacha.boo/dl/miu.zip"
echo "   🖼️ Icon: https://miu.gacha.boo/dl/miu.png (Linux)"