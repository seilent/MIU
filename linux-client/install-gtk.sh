#!/bin/bash
# MIU GTK Player Installation Script
# Installs system dependencies for the GTK4 + Libadwaita music player

set -e

echo "🎵 Installing MIU GTK Player dependencies..."

# Detect distribution
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$NAME
    VER=$VERSION_ID
else
    echo "Cannot detect OS. Please install manually."
    exit 1
fi

echo "Detected OS: $OS"

# Install based on distribution
case "$OS" in
    "Ubuntu"|"Debian"*)
        echo "Installing for Ubuntu/Debian..."
        sudo apt update
        sudo apt install -y \
            python3-gi \
            python3-gi-cairo \
            gir1.2-gtk-4.0 \
            gir1.2-adw-1 \
            gir1.2-gstreamer-1.0 \
            gir1.2-gst-plugins-base-1.0 \
            gir1.2-notify-0.7 \
            gstreamer1.0-plugins-good \
            gstreamer1.0-plugins-bad \
            gstreamer1.0-libav
        ;;

    "Arch Linux"|"EndeavourOS"|"Manjaro"*)
        echo "Installing for Arch Linux..."
        sudo pacman -S --needed \
            python-gobject \
            gtk4 \
            libadwaita \
            gstreamer \
            gst-plugins-base \
            gst-plugins-good \
            gst-plugins-bad \
            gst-libav \
            libnotify
        ;;

    "Fedora"*)
        echo "Installing for Fedora..."
        sudo dnf install -y \
            python3-gobject \
            gtk4-devel \
            libadwaita-devel \
            gstreamer1-devel \
            gstreamer1-plugins-base-devel \
            gstreamer1-plugins-good \
            gstreamer1-plugins-bad-free \
            gstreamer1-libav \
            libnotify-devel
        ;;

    "openSUSE"*)
        echo "Installing for openSUSE..."
        sudo zypper install -y \
            python3-gobject \
            python3-gobject-Gdk \
            typelib-1_0-Gtk-4_0 \
            typelib-1_0-Adw-1 \
            typelib-1_0-Gst-1_0 \
            typelib-1_0-GstPbutils-1_0 \
            typelib-1_0-Notify-0_7 \
            gstreamer-plugins-good \
            gstreamer-plugins-bad \
            gstreamer-plugins-libav
        ;;

    *)
        echo "Unsupported distribution: $OS"
        echo "Please install the following packages manually:"
        echo "- PyGObject (python3-gobject)"
        echo "- GTK4 development files"
        echo "- Libadwaita development files"
        echo "- GStreamer and plugins"
        echo "- libnotify"
        exit 1
        ;;
esac

echo ""
echo "✅ Dependencies installed successfully!"
echo ""
echo "🚀 You can now run the GTK player:"
echo "   python3 miu_gtk_player.py --server https://your-miu-server.com"
echo ""
echo "💡 For development, you may also want to install:"
echo "   - gtk4-dev-tools (for GTK Inspector)"
echo "   - devhelp (for GTK documentation)"