# MIU GTK Music Player

A modern, native GNOME music player for the MIU music bot, built with GTK4 and Libadwaita.

![GTK Player Preview](https://img.shields.io/badge/GTK-4.0-blue) ![Libadwaita](https://img.shields.io/badge/Libadwaita-1.0-green) ![GStreamer](https://img.shields.io/badge/GStreamer-1.0-orange)

## Features

### 🎨 Modern GNOME Integration
- **Native GTK4 + Libadwaita interface** that follows GNOME HIG
- **Adaptive UI** that works well on different screen sizes
- **System theme integration** with automatic dark/light mode
- **Native window controls** and proper GNOME titlebar

### 🎵 Professional Audio
- **GStreamer backend** for high-quality audio playback
- **Real-time synchronization** with MIU server
- **Seamless track transitions** and queue management
- **Volume control** and seeking support

### 🔔 System Integration
- **Desktop notifications** for track changes
- **Media keys support** (play/pause/volume)
- **Application menu** with proper GNOME integration
- **Desktop entry** for application launcher

### 🌐 MIU Backend Integration
- **Server-Sent Events** for real-time updates
- **REST API** integration for control commands
- **Automatic reconnection** on network issues
- **Queue synchronization** with web interface

## Installation

### Quick Install (Recommended)

Run the installation script to automatically install dependencies:

```bash
./install-gtk.sh
```

### Manual Installation

#### Ubuntu/Debian
```bash
sudo apt install python3-gi python3-gi-cairo gir1.2-gtk-4.0 gir1.2-adw-1 \
                 gir1.2-gstreamer-1.0 gir1.2-gst-plugins-base-1.0 gir1.2-notify-0.7 \
                 gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav
```

#### Arch Linux
```bash
sudo pacman -S python-gobject gtk4 libadwaita gstreamer gst-plugins-base \
               gst-plugins-good gst-plugins-bad gst-libav libnotify
```

#### Fedora
```bash
sudo dnf install python3-gobject gtk4-devel libadwaita-devel gstreamer1-devel \
                 gstreamer1-plugins-base-devel gstreamer1-plugins-good \
                 gstreamer1-plugins-bad-free gstreamer1-libav libnotify-devel
```

## Usage

### Command Line

```bash
# Basic usage
python3 miu_gtk_player.py --server https://your-miu-server.com

# Examples
python3 miu_gtk_player.py --server https://miu.gacha.boo
python3 miu_gtk_player.py --server http://localhost:3000
```

### Desktop Integration

Install the desktop file for launcher integration:

```bash
# Copy to local applications
cp miu-gtk.desktop ~/.local/share/applications/

# Update desktop database
update-desktop-database ~/.local/share/applications/
```

Edit the `Exec` line in `miu-gtk.desktop` to match your server URL.

## Architecture

### Components

```
MIUGtkPlayer (Gtk.Application)
├── MIUMainWindow (Adw.ApplicationWindow)
│   ├── PlayerWidget (playback controls)
│   ├── QueueWidget (track queue)
│   └── HeaderBar (menus/actions)
├── GStreamer Audio Engine
├── SSE Client (real-time updates)
└── HTTP Client (API calls)
```

### Key Features

- **Gtk.Application**: Proper application lifecycle and D-Bus integration
- **Adw.ApplicationWindow**: Modern GNOME window with native styling
- **GstPlayer**: Professional audio backend with codec support
- **SSE Connection**: Real-time track and queue updates
- **Threaded Network**: Non-blocking server communication

### Server Integration

The player integrates with your existing MIU backend:

- **Stream Endpoint**: `/api/music/stream` - Audio data
- **Status Endpoint**: `/api/music/minimal-status` - Current state
- **SSE Endpoint**: `/api/music/state/live` - Real-time updates

## Development

### GTK Inspector

Enable the GTK Inspector for development:

```bash
export GTK_DEBUG=interactive
python3 miu_gtk_player.py --server https://your-server.com
```

Press `Ctrl+Shift+I` to open the inspector.

### CSS Styling

The player uses standard Libadwaita styles and classes:

- `title-2` - Track titles
- `dim-label` - Secondary text
- `circular` - Round buttons
- `suggested-action` - Primary action button
- `boxed-list` - Queue display

### Custom Styling

Create a custom CSS file and load it:

```python
css_provider = Gtk.CssProvider()
css_provider.load_from_path("custom-style.css")
Gtk.StyleContext.add_provider_for_display(
    Gdk.Display.get_default(),
    css_provider,
    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
)
```

## Troubleshooting

### Common Issues

**"GTK4/Libadwaita not available"**
- Install system packages: `sudo apt install gir1.2-gtk-4.0 gir1.2-adw-1`
- Don't use pip for GTK - system packages only

**"Cannot connect to MIU server"**
- Check server URL format: `https://domain.com` (no trailing slash)
- Verify backend is accessible: `curl https://your-server/backend/api/music/minimal-status`
- Check firewall/proxy settings

**"No audio output"**
- Install GStreamer plugins: `gstreamer1.0-plugins-good gstreamer1.0-libav`
- Check audio system: `pactl info` (PulseAudio) or `aplay -l` (ALSA)
- Verify GStreamer: `gst-inspect-1.0 | grep audio`

**"Notifications not working"**
- Install libnotify: `sudo apt install gir1.2-notify-0.7`
- Check notification settings in GNOME Settings > Notifications

### Debug Mode

Enable debug output:

```bash
export G_MESSAGES_DEBUG=all
export GST_DEBUG=2
python3 miu_gtk_player.py --server https://your-server.com
```

## Comparison with Original Client

| Feature | Original Client | GTK Player |
|---------|----------------|------------|
| Interface | Tkinter | GTK4 + Libadwaita |
| Audio | pygame | GStreamer |
| Integration | Basic tray | Full GNOME integration |
| Performance | Python threads | GLib main loop |
| Styling | Fixed | System theme adaptive |
| Notifications | Basic | Native desktop |

## Contributing

1. Follow GNOME Human Interface Guidelines
2. Use Libadwaita components when possible
3. Test on multiple distributions
4. Ensure proper error handling and reconnection
5. Add debug logging for troubleshooting

## License

Same as MIU project license.