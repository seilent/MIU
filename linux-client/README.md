# MIU Linux Client

A lightweight audio streaming client for MIU music servers. Perfect for listening to music from MIU Discord bots with minimal resource usage.

## Features

- 🎵 **Live Audio Streaming** - Real-time audio with embedded metadata
- ⏯️ **Client-side Controls** - Play/pause without server interaction
- 🔊 **Volume Control** - Local volume adjustment
- 🖥️ **System Tray** - Minimize to system tray for background listening
- 🚀 **Minimal Resources** - Lightweight design for efficient performance
- 🌐 **No Authentication** - Guest listening without login requirements
- 💻 **Cross-mode** - GUI and console modes available

## Quick Start

### Installation

#### Option 1: Simple Install Script
```bash
git clone <your-repo>
cd linux-client
./install.sh
```

#### Option 2: Manual Installation
```bash
# Install dependencies
pip3 install --user pygame Pillow pystray

# Install the client
pip3 install --user .
```

#### Option 3: Package Installation
- **Debian/Ubuntu**: `sudo dpkg -i miu-client_1.0.0-1_all.deb`
- **Fedora/RHEL**: `sudo rpm -i miu-client-1.0.0-1.noarch.rpm`
- **Arch**: `pacman -U miu-client-1.0.0-1-any.pkg.tar.xz`

### Usage

```bash
# Start with GUI (default)
miu-client

# Console mode only
miu-client --console

# Connect to specific server (direct)
miu-client --server http://your-server:3000

# Connect to MIU through reverse proxy
miu-client --server https://miu.gacha.boo

# Disable system tray
miu-client --no-tray
```

## Endpoints Used

The client connects to these MIU server endpoints:

**Direct connection (localhost:3000):**
- `GET /api/music/minimal-stream` - Audio stream with embedded metadata
- `GET /api/music/minimal-status` - Current playback status

**Through reverse proxy (miu.gacha.boo):**
- `GET /backend/api/music/minimal-stream` - Audio stream with embedded metadata
- `GET /backend/api/music/minimal-status` - Current playback status

## Protocol

The client uses a custom streaming protocol:

```
Stream Format:
[META][4-byte length][JSON metadata]
[AUDI][4-byte length][audio data]
```

Metadata includes:
- Current track information
- Playback position
- Server status
- Requester details

## System Requirements

- **Python**: 3.8 or higher
- **OS**: Linux (any distribution)
- **RAM**: ~50MB
- **Dependencies**:
  - `pygame` (audio playback)
  - `Pillow` (GUI/tray icons) - optional
  - `pystray` (system tray) - optional
  - `tkinter` (GUI) - usually included with Python

## Building Packages

To build packages for distribution:

```bash
./build-packages.sh
```

This creates:
- Debian package (`.deb`)
- RPM package (`.rpm`)
- Arch package (`.pkg.tar.xz`)
- Python wheel (`.whl`)
- AppImage (if tools available)

## Controls

### GUI Mode
- **Play/Pause Button**: Toggle playback
- **Volume Slider**: Adjust volume (0-100%)
- **System Tray**: Right-click for menu

### Console Mode
- `p` - Toggle play/pause
- `v+` - Volume up
- `v-` - Volume down
- `q` - Quit

### System Tray Menu
- Toggle Play/Pause
- Volume Up/Down
- Show Window
- Quit

## Configuration

The client connects to `http://localhost:3000` by default. Change with:

```bash
miu-client --server http://your-miu-server:port
```

## Troubleshooting

### Audio Issues
```bash
# Check if pygame can access audio
python3 -c "import pygame; pygame.mixer.init(); print('Audio OK')"

# Check ALSA/PulseAudio
aplay -l  # List audio devices
```

### Connection Issues
```bash
# Test server connectivity
curl http://your-server:3000/api/music/minimal-status

# Check if server endpoints are available
curl http://your-server:3000/api/music/minimal-stream
```

### GUI Issues
```bash
# Check if tkinter is available
python3 -c "import tkinter; print('GUI OK')"

# Run in console mode if GUI fails
miu-client --console
```

## Development

### Running from Source
```bash
python3 miu_client.py --server http://localhost:3000
```

### Dependencies for Development
```bash
pip3 install pygame Pillow pystray setuptools wheel
```

## License

MIT License - see LICENSE file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## Support

- **Issues**: Report bugs on GitHub
- **Documentation**: Check the MIU project documentation
- **Community**: Join the MIU Discord server