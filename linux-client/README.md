# MIU GTK Music Player

A modern, native GNOME music player for the MIU music bot, built with GTK4 and Libadwaita.

![GTK Player Preview](https://img.shields.io/badge/GTK-4.0-blue) ![Libadwaita](https://img.shields.io/badge/Libadwaita-1.0-green) ![GStreamer](https://img.shields.io/badge/GStreamer-1.0-orange)

## Quick Start

### Option 1: AppImage (Recommended)
Download and run the portable version:
```bash
chmod +x MyApp.AppImage
./MyApp.AppImage
```
No installation required! Works on any Linux distribution.

### Option 2: Run from Source
```bash
# Install dependencies
sudo apt install python3-gi python3-gi-cairo gir1.2-gtk-4.0 gir1.2-adw-1 \
                 gir1.2-gstreamer-1.0 gir1.2-gst-plugins-base-1.0 \
                 gstreamer1.0-plugins-good gstreamer1.0-libav

# Run the player
python3 miu_gtk_player.py
```

Default server: `https://miu.gacha.boo` (change with `--server` flag)

## Features

### 🎨 Modern GNOME Integration
- **Native GTK4 + Libadwaita interface** following GNOME HIG
- **Adaptive UI** that works on different screen sizes
- **System theme integration** with automatic dark/light mode
- **Custom icon** with colorful equalizer bars

### 🎵 Professional Audio
- **GStreamer backend** for high-quality audio playback
- **Real-time synchronization** with MIU server
- **MPRIS media controls** (media keys, desktop notifications)
- **Volume control** and seeking support

### 🔔 System Integration
- **Desktop notifications** for track changes
- **Media keys support** (play/pause/volume)
- **Desktop entry** for application launcher
- **System tray integration**

### 🌐 MIU Backend Integration
- **Server-Sent Events** for real-time updates
- **REST API** integration for control commands
- **Automatic reconnection** on network issues
- **Queue synchronization** with web interface

## System Requirements

- **OS**: Linux (any distribution)
- **Python**: 3.8+ (for source version)
- **GTK**: 4.0+ with Libadwaita
- **GStreamer**: 1.0+ with plugins
- **RAM**: ~25MB (AppImage includes all dependencies)

## Installation Options

### AppImage Dependencies (Built-in)
The AppImage includes everything:
- Python 3.12 runtime
- GTK4 and Libadwaita
- GStreamer and plugins
- All Python dependencies

### Source Dependencies

#### Ubuntu/Debian
```bash
sudo apt install python3-gi python3-gi-cairo gir1.2-gtk-4.0 gir1.2-adw-1 \
                 gir1.2-gstreamer-1.0 gir1.2-gst-plugins-base-1.0 \
                 gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav
```

#### Arch Linux
```bash
sudo pacman -S python-gobject gtk4 libadwaita gstreamer \
               gst-plugins-base gst-plugins-good gst-plugins-bad gst-libav
```

#### Fedora
```bash
sudo dnf install python3-gobject gtk4-devel libadwaita-devel \
                 gstreamer1-devel gstreamer1-plugins-base-devel \
                 gstreamer1-plugins-good gstreamer1-plugins-bad-free gstreamer1-libav
```

## Usage

### AppImage
```bash
# Default server (https://miu.gacha.boo)
./MyApp.AppImage

# Custom server
./MyApp.AppImage --server https://your-server.com
```

### Source Code
```bash
# Default server
python3 miu_gtk_player.py

# Custom server
python3 miu_gtk_player.py --server https://your-server.com
```

## Architecture

```
MIUGtkPlayer (Gtk.Application)
├── MIUMainWindow (Adw.ApplicationWindow)
│   ├── PlayerWidget (playback controls)
│   ├── QueueWidget (track queue)
│   └── HeaderBar (menus/actions)
├── GStreamer Audio Engine
├── MPRIS D-Bus Integration
├── SSE Client (real-time updates)
└── HTTP Client (API calls)
```

## Server Endpoints

- **Stream**: `/api/music/stream` - Audio data
- **Status**: `/api/music/minimal-status` - Current state
- **SSE**: `/api/music/state/live` - Real-time updates
- **Album Art**: `/backend/api/albumart/{id}` - Track artwork

## Troubleshooting

### AppImage Issues
```bash
# Extract and run manually if needed
./MyApp.AppImage --appimage-extract
./squashfs-root/AppRun
```

### Source Issues
**"GTK4/Libadwaita not available"**
- Install system packages (don't use pip for GTK)
- Check: `python3 -c "import gi; gi.require_version('Gtk', '4.0')"`

**"Cannot connect to server"**
- Check server URL format: `https://domain.com` (no trailing slash)
- Test: `curl https://your-server/backend/api/music/minimal-status`

**"No audio output"**
- Install GStreamer plugins: `gstreamer1.0-plugins-good gstreamer1.0-libav`
- Test: `gst-launch-1.0 audiotestsrc ! autoaudiosink`

### Debug Mode
```bash
export G_MESSAGES_DEBUG=all
export GST_DEBUG=2
python3 miu_gtk_player.py --server https://your-server.com
```

## Files

- `MyApp.AppImage` - Portable executable (24.5MB)
- `miu_gtk_player.py` - Source code
- `miu-gtk` - Launcher script

## License

MIT License - see LICENSE file for details.