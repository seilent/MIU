#!/usr/bin/env python3
"""
MIU Minimal Linux Client
A lightweight audio streaming client for the MIU music bot.
Features:
- Stream audio with embedded metadata
- Play/pause control (client-side)
- Volume control
- System tray integration
- Minimal resource usage
"""

import sys
import json
import struct
import threading
import time
import argparse
from urllib.request import urlopen, Request
from urllib.error import URLError
import io

try:
    import pygame
    PYGAME_AVAILABLE = True
except ImportError:
    PYGAME_AVAILABLE = False
    print("Warning: pygame not available. Audio playback disabled.")

try:
    from PIL import Image, ImageTk
    import tkinter as tk
    from tkinter import ttk
    GUI_AVAILABLE = True
except ImportError:
    GUI_AVAILABLE = False
    print("Warning: GUI libraries not available. Running in console mode.")

try:
    import pystray
    from pystray import MenuItem, Menu
    TRAY_AVAILABLE = True
except ImportError:
    TRAY_AVAILABLE = False
    print("Warning: pystray not available. System tray disabled.")

class MIUClient:
    def __init__(self, server_url=None):
        if server_url is None:
            raise ValueError("Server URL is required. Use --server parameter to specify MIU server address.")

        self.server_url = server_url.rstrip('/')

        # Always use reverse proxy endpoints under /backend/
        base_url = self.server_url
        if not base_url.endswith('/backend'):
            base_url = f"{base_url}/backend"

        # Use the regular stream endpoint that works like the frontend
        self.stream_url = f"{base_url}/api/music/stream"
        self.status_url = f"{base_url}/api/music/minimal-status"

        # Audio state
        self.is_playing = False
        self.is_paused = False
        self.volume = 0.7
        self.current_track = None
        self.position = 0

        # Streaming
        self.stream_thread = None
        self.audio_thread = None
        self.running = False
        self.audio_buffer = io.BytesIO()
        self.metadata_callback = None

        # GUI
        self.root = None
        self.tray_icon = None

        # Initialize pygame mixer if available
        if PYGAME_AVAILABLE:
            pygame.mixer.pre_init(frequency=44100, size=-16, channels=2, buffer=1024)
            pygame.mixer.init()
            pygame.mixer.music.set_volume(self.volume)

    def log(self, message):
        """Simple logging"""
        print(f"[MIU] {message}")

    def get_status(self):
        """Get current server status"""
        try:
            with urlopen(self.status_url, timeout=5) as response:
                data = json.loads(response.read().decode())
                return data
        except Exception as e:
            self.log(f"Failed to get status: {e}")
            return None

    def start_streaming(self):
        """Start streaming audio and metadata"""
        if self.running:
            return

        self.running = True
        self.stream_thread = threading.Thread(target=self._stream_worker, daemon=True)
        self.stream_thread.start()
        self.log("Started streaming")

    def stop_streaming(self):
        """Stop streaming"""
        self.running = False
        if self.stream_thread:
            self.stream_thread.join(timeout=2)
        if PYGAME_AVAILABLE:
            pygame.mixer.music.stop()
        self.log("Stopped streaming")

    def _stream_worker(self):
        """Main streaming worker thread"""
        while self.running:
            try:
                # Get current track info first
                status = self.get_status()
                if status and status.get('track'):
                    track = status['track']
                    self.current_track = track
                    self.log(f"Now playing: {track['title']} - {track['requestedBy']['username']}")

                    # Call metadata callback for GUI updates
                    if self.metadata_callback:
                        self.metadata_callback({'track': track, 'status': status.get('status'), 'position': 0, 'timestamp': time.time() * 1000})

                    # Start audio stream
                    self._stream_audio()

                # Wait before checking for track changes
                time.sleep(5)

            except Exception as e:
                self.log(f"Stream error: {e}")
                time.sleep(5)

    def _stream_audio(self):
        """Stream audio data directly to pygame"""
        if not PYGAME_AVAILABLE:
            return

        try:
            request = Request(self.stream_url)
            request.add_header('User-Agent', 'MIU-Linux-Client/1.0')
            request.add_header('Range', 'bytes=0-')  # Request from beginning

            with urlopen(request, timeout=30) as response:
                self.log("Connected to audio stream")

                # Create temporary file for pygame
                import tempfile
                with tempfile.NamedTemporaryFile(suffix='.m4a', delete=False) as temp_file:
                    temp_path = temp_file.name

                    # Stream data to temporary file
                    while self.running:
                        chunk = response.read(8192)  # 8KB chunks
                        if not chunk:
                            break
                        temp_file.write(chunk)
                        temp_file.flush()

                        # Try to load and play when we have enough data
                        if temp_file.tell() > 1024 * 100:  # 100KB threshold
                            try:
                                pygame.mixer.music.load(temp_path)
                                if not self.is_paused:
                                    pygame.mixer.music.play()
                                    self.is_playing = True
                                break
                            except Exception as play_error:
                                # Continue downloading, might need more data
                                pass

                    # Continue reading the rest of the file
                    while self.running:
                        chunk = response.read(8192)
                        if not chunk:
                            break
                        temp_file.write(chunk)

                # Clean up temp file
                try:
                    import os
                    os.unlink(temp_path)
                except:
                    pass

        except Exception as e:
            self.log(f"Audio streaming error: {e}")


    def toggle_playback(self):
        """Toggle play/pause (client-side control)"""
        if not PYGAME_AVAILABLE:
            return

        if self.is_playing and not self.is_paused:
            pygame.mixer.music.pause()
            self.is_paused = True
            self.log("Paused")
        elif self.is_paused:
            pygame.mixer.music.unpause()
            self.is_paused = False
            self.log("Resumed")

    def set_volume(self, volume):
        """Set playback volume (0.0 to 1.0)"""
        self.volume = max(0.0, min(1.0, volume))
        if PYGAME_AVAILABLE:
            pygame.mixer.music.set_volume(self.volume)
        self.log(f"Volume: {int(self.volume * 100)}%")

    def create_gui(self):
        """Create simple GUI"""
        if not GUI_AVAILABLE:
            self.log("GUI not available")
            return None

        self.root = tk.Tk()
        self.root.title("MIU Music Client")
        self.root.geometry("400x200")

        # Track info
        self.track_label = tk.Label(self.root, text="No track playing", wraplength=380)
        self.track_label.pack(pady=10)

        # Controls frame
        controls_frame = tk.Frame(self.root)
        controls_frame.pack(pady=10)

        # Play/Pause button
        self.play_button = tk.Button(controls_frame, text="⏯", command=self.toggle_playback, font=("Arial", 16))
        self.play_button.pack(side=tk.LEFT, padx=5)

        # Volume control
        volume_frame = tk.Frame(self.root)
        volume_frame.pack(pady=10)

        tk.Label(volume_frame, text="Volume:").pack(side=tk.LEFT)
        self.volume_scale = tk.Scale(volume_frame, from_=0, to=100, orient=tk.HORIZONTAL,
                                   command=self._on_volume_change)
        self.volume_scale.set(int(self.volume * 100))
        self.volume_scale.pack(side=tk.LEFT, padx=5)

        # Status
        self.status_label = tk.Label(self.root, text="Disconnected", fg="red")
        self.status_label.pack(pady=5)

        # Set metadata callback
        self.metadata_callback = self._update_gui

        return self.root

    def _on_volume_change(self, value):
        """Handle volume slider change"""
        self.set_volume(int(value) / 100.0)

    def _update_gui(self, metadata):
        """Update GUI with new metadata"""
        if not self.root:
            return

        try:
            # Update track info
            if metadata.get('track'):
                track = metadata['track']
                track_text = f"{track['title']}\nby {track['requestedBy']['username']}"
                self.track_label.config(text=track_text)
            else:
                self.track_label.config(text="No track playing")

            # Update status
            status = metadata.get('status', 'unknown')
            self.status_label.config(text=f"Status: {status}", fg="green" if status == "playing" else "orange")

        except Exception as e:
            self.log(f"GUI update error: {e}")

    def create_tray_icon(self):
        """Create system tray icon"""
        if not TRAY_AVAILABLE:
            self.log("System tray not available")
            return None

        # Create a simple icon (you can replace with an actual icon file)
        image = Image.new('RGB', (64, 64), color='blue')

        menu = Menu(
            MenuItem("Toggle Play/Pause", self.toggle_playback),
            MenuItem("Volume Up", lambda: self.set_volume(self.volume + 0.1)),
            MenuItem("Volume Down", lambda: self.set_volume(self.volume - 0.1)),
            Menu.SEPARATOR,
            MenuItem("Show Window", self._show_window),
            MenuItem("Quit", self._quit_app)
        )

        self.tray_icon = pystray.Icon("MIU Client", image, menu=menu)
        return self.tray_icon

    def _show_window(self):
        """Show main window"""
        if self.root:
            self.root.deiconify()
            self.root.lift()

    def _quit_app(self):
        """Quit application"""
        self.stop_streaming()
        if self.root:
            self.root.quit()
        if self.tray_icon:
            self.tray_icon.stop()

def main():
    parser = argparse.ArgumentParser(description='MIU Linux Client')
    parser.add_argument('--server', required=True,
                      help='MIU server URL (e.g., https://miu.gacha.boo)')
    parser.add_argument('--console', action='store_true',
                      help='Run in console mode only')
    parser.add_argument('--no-tray', action='store_true',
                      help='Disable system tray')

    args = parser.parse_args()

    client = MIUClient(args.server)

    # Test connection
    status = client.get_status()
    if status is None:
        print(f"Cannot connect to MIU server at {args.server}")
        print("Make sure the server is running and accessible.")
        return 1

    print(f"Connected to MIU server. Current status: {status.get('status', 'unknown')}")

    # Start streaming
    client.start_streaming()

    try:
        if args.console or not GUI_AVAILABLE:
            # Console mode
            print("Running in console mode. Press Ctrl+C to quit.")
            print("Commands: p (play/pause), v+ (volume up), v- (volume down), q (quit)")

            while True:
                try:
                    cmd = input().strip().lower()
                    if cmd == 'p':
                        client.toggle_playback()
                    elif cmd == 'v+':
                        client.set_volume(client.volume + 0.1)
                    elif cmd == 'v-':
                        client.set_volume(client.volume - 0.1)
                    elif cmd == 'q':
                        break
                except EOFError:
                    break
        else:
            # GUI mode
            root = client.create_gui()
            if root:
                # Create tray icon if available and not disabled
                if not args.no_tray:
                    tray = client.create_tray_icon()
                    if tray:
                        # Run tray icon in separate thread
                        tray_thread = threading.Thread(target=tray.run, daemon=True)
                        tray_thread.start()

                # Handle window close
                def on_closing():
                    if not args.no_tray and client.tray_icon:
                        root.withdraw()  # Hide instead of quit
                    else:
                        client._quit_app()

                root.protocol("WM_DELETE_WINDOW", on_closing)
                root.mainloop()
            else:
                print("GUI creation failed, falling back to console mode")
                input("Press Enter to quit...")

    except KeyboardInterrupt:
        print("\nShutting down...")

    finally:
        client.stop_streaming()

    return 0

if __name__ == "__main__":
    sys.exit(main())