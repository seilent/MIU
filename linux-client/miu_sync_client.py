#!/usr/bin/env python3
"""
MIU Synchronized Linux Client
A Linux audio client that properly synchronizes with the MIU server's timing system.
Features:
- High-precision timing synchronization
- Network latency compensation
- SSE integration for real-time updates
- Server-coordinated playback
- Position tracking and seeking
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
import asyncio
from typing import Optional, Dict, Any, Callable
import socket
import ssl

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

class SyncTiming:
    """Precise timing utilities for sync with server"""

    def __init__(self, server_url: str):
        self.server_url = server_url
        self.last_measured_latency: Optional[float] = None

    def measure_network_latency(self) -> float:
        """Measure one-way network latency using performance timing"""
        start_time = time.perf_counter()

        try:
            # Use status endpoint for latency measurement
            status_url = f"{self.server_url}/api/music/minimal-status"
            request = Request(status_url)
            request.add_header('User-Agent', 'MIU-Sync-Client/1.0')

            with urlopen(request, timeout=5) as response:
                response.read()

            # Calculate round-trip time
            round_trip_time = time.perf_counter() - start_time

            # Estimate one-way latency (half of round-trip)
            one_way_latency = round_trip_time / 2

            print(f"Measured one-way network latency: {one_way_latency*1000:.2f}ms")
            return one_way_latency

        except Exception as e:
            print(f"Failed to measure network latency: {e}")
            # Return conservative default value
            return 0.1  # 100ms

    def get_network_latency(self) -> float:
        """Get current network latency, measuring if not available"""
        if self.last_measured_latency is None:
            self.last_measured_latency = self.measure_network_latency()
        return self.last_measured_latency

    def calculate_time_until_play(self, server_play_timestamp: float,
                                server_timestamp: float, received_timestamp: float) -> float:
        """Calculate time until scheduled play event should occur"""
        # Current high-precision time
        now = time.perf_counter()

        # Get estimated one-way network latency
        latency = self.get_network_latency()

        # Time passed since we received the message
        time_passed_since_received = now - received_timestamp

        # Time buffer provided by the server (difference between play time and message send time)
        server_buffer = (server_play_timestamp - server_timestamp) / 1000.0  # Convert to seconds

        # Calculate time until playback should begin
        time_until_play = server_buffer - time_passed_since_received - latency

        print(f"Sync timing calculation:")
        print(f"  Server buffer: {server_buffer*1000:.2f}ms")
        print(f"  Time since message: {time_passed_since_received*1000:.2f}ms")
        print(f"  Network latency: {latency*1000:.2f}ms")
        print(f"  Time until play: {time_until_play*1000:.2f}ms")

        return time_until_play

    def schedule_with_precision(self, callback: Callable, delay_seconds: float) -> Optional[threading.Timer]:
        """Schedule a function to run at a precise time"""
        if delay_seconds <= 0:
            callback()
            return None

        # For very short delays, just use threading.Timer
        if delay_seconds < 0.025:  # 25ms
            timer = threading.Timer(delay_seconds, callback)
            timer.start()
            return timer

        # For longer delays, use a combination approach for higher precision
        def precision_scheduler():
            # Sleep for most of the time
            if delay_seconds > 0.025:
                time.sleep(delay_seconds - 0.025)

            # Busy wait for the last 25ms for precision
            target_time = time.perf_counter() + 0.025
            while time.perf_counter() < target_time:
                time.sleep(0.001)  # 1ms sleep

            callback()

        timer = threading.Thread(target=precision_scheduler, daemon=True)
        timer.start()
        return timer

class SSEClient:
    """Server-Sent Events client for real-time server updates"""

    def __init__(self, server_url: str, on_event: Callable[[str, Dict], None]):
        self.server_url = server_url
        self.on_event = on_event
        self.running = False
        self.thread: Optional[threading.Thread] = None

    def start(self):
        """Start SSE connection"""
        if self.running:
            return

        self.running = True
        self.thread = threading.Thread(target=self._sse_worker, daemon=True)
        self.thread.start()
        print("SSE client started")

    def stop(self):
        """Stop SSE connection"""
        self.running = False
        if self.thread:
            self.thread.join(timeout=2)
        print("SSE client stopped")

    def _sse_worker(self):
        """Main SSE worker thread"""
        sse_url = f"{self.server_url}/api/music/state/live"

        while self.running:
            try:
                request = Request(sse_url)
                request.add_header('Accept', 'text/event-stream')
                request.add_header('Cache-Control', 'no-cache')
                request.add_header('User-Agent', 'MIU-Sync-Client/1.0')

                with urlopen(request, timeout=30) as response:
                    print("SSE connection established")

                    event_type = None
                    event_data = ""

                    for line_bytes in response:
                        if not self.running:
                            break

                        line = line_bytes.decode('utf-8').strip()

                        if line.startswith('event: '):
                            event_type = line[7:]
                        elif line.startswith('data: '):
                            event_data = line[6:]
                        elif line == '':
                            # Empty line indicates end of event
                            if event_type and event_data:
                                try:
                                    data = json.loads(event_data)
                                    # Add receive timestamp for sync calculations
                                    data['_received_time'] = time.perf_counter()
                                    self.on_event(event_type, data)
                                except json.JSONDecodeError as e:
                                    print(f"Failed to parse SSE data: {e}")

                            event_type = None
                            event_data = ""

            except Exception as e:
                print(f"SSE connection error: {e}")
                if self.running:
                    time.sleep(5)  # Retry after 5 seconds

class MIUSyncClient:
    """Main synchronized MIU client"""

    def __init__(self, server_url: str):
        if server_url is None:
            raise ValueError("Server URL is required")

        self.server_url = server_url.rstrip('/')

        # Always use reverse proxy endpoints under /backend/
        base_url = self.server_url
        if not base_url.endswith('/backend'):
            base_url = f"{base_url}/backend"

        # API endpoints
        self.stream_url = f"{base_url}/api/music/stream"
        self.status_url = f"{base_url}/api/music/minimal-status"
        self.sync_play_url = f"{base_url}/api/music/command/sync-play"

        # Timing and sync components
        self.sync_timing = SyncTiming(base_url)
        self.sse_client = SSEClient(base_url, self._handle_sse_event)

        # Application state
        self.current_track: Optional[Dict] = None
        self.server_position = 0.0
        self.server_duration = 0.0
        self.last_sync_time = 0.0
        self.current_server_position = 0.0
        self.player_status = "stopped"
        self.volume = 0.7

        # Audio state
        self.is_playing = False
        self.is_paused = False
        self.audio_buffer = io.BytesIO()
        self.metadata_callback: Optional[Callable] = None

        # Threading
        self.running = False
        self.position_timer: Optional[threading.Timer] = None

        # GUI
        self.root = None
        self.tray_icon = None

        # Initialize pygame mixer if available
        if PYGAME_AVAILABLE:
            pygame.mixer.pre_init(frequency=44100, size=-16, channels=2, buffer=1024)
            pygame.mixer.init()
            pygame.mixer.music.set_volume(self.volume)

    def log(self, message: str):
        """Simple logging"""
        print(f"[MIU-Sync] {message}")

    def start(self):
        """Start the synchronized client"""
        if self.running:
            return

        self.running = True

        # Start SSE connection for real-time updates
        self.sse_client.start()

        # Start position sync timer
        self._start_position_timer()

        # Get initial status
        self._refresh_status()

        self.log("Synchronized client started")

    def stop(self):
        """Stop the synchronized client"""
        self.running = False

        # Stop SSE connection
        self.sse_client.stop()

        # Stop position timer
        if self.position_timer:
            self.position_timer.cancel()

        # Stop audio
        if PYGAME_AVAILABLE:
            pygame.mixer.music.stop()

        self.log("Synchronized client stopped")

    def _handle_sse_event(self, event_type: str, data: Dict):
        """Handle SSE events from server"""
        received_time = data.get('_received_time', time.perf_counter())

        if event_type == 'state':
            self._handle_state_update(data)
        elif event_type == 'sync_play':
            self._handle_sync_play(data, received_time)
        elif event_type == 'heartbeat':
            pass  # Just keep connection alive

    def _handle_state_update(self, data: Dict):
        """Handle server state updates"""
        current_time = time.perf_counter()

        if 'status' in data:
            self.player_status = data['status']

        if 'currentTrack' in data:
            new_track = data['currentTrack']
            if new_track != self.current_track:
                self.current_track = new_track
                self._on_track_changed()

        if 'position' in data:
            self.server_position = data['position']
            self.last_sync_time = current_time

        # Update UI if callback is set
        if self.metadata_callback:
            self.metadata_callback({
                'track': self.current_track,
                'status': self.player_status,
                'position': self.current_server_position,
                'timestamp': current_time * 1000
            })

    def _handle_sync_play(self, data: Dict, received_time: float):
        """Handle synchronized play command"""
        track_id = data.get('trackId')
        position = data.get('position', 0)
        server_time = data.get('serverTime', 0)
        play_at = data.get('playAt', 0)

        if not track_id:
            return

        self.log(f"Received sync_play for track {track_id}")

        # Calculate when to start playing
        time_until_play = self.sync_timing.calculate_time_until_play(
            play_at, server_time, received_time
        )

        # Schedule synchronized playback
        if time_until_play > 0:
            self.sync_timing.schedule_with_precision(
                lambda: self._sync_play_now(track_id, position),
                time_until_play
            )
        else:
            # Play immediately if we're already past the target time
            self._sync_play_now(track_id, position)

    def _sync_play_now(self, track_id: str, position: float):
        """Execute synchronized playback"""
        self.log(f"Starting synchronized playback of {track_id} at position {position}")

        # Ensure we have the correct track loaded
        if not self.current_track or self.current_track.get('youtubeId') != track_id:
            self._refresh_status()

        # Start audio playback with position offset
        self._play_audio_with_position(position)

    def _play_audio_with_position(self, start_position: float = 0):
        """Start audio playback, optionally from a specific position"""
        if not PYGAME_AVAILABLE or not self.current_track:
            return

        try:
            # For simplicity, we'll stream from the beginning
            # In a more advanced implementation, you could seek to the position
            # by requesting a range from the server or using ffmpeg

            request = Request(self.stream_url)
            request.add_header('User-Agent', 'MIU-Sync-Client/1.0')

            # If we need to start from a specific position, we could add Range header
            # request.add_header('Range', f'bytes={position_bytes}-')

            with urlopen(request, timeout=30) as response:
                self.log("Connected to audio stream for synchronized playback")

                # Create temporary file for pygame
                import tempfile
                with tempfile.NamedTemporaryFile(suffix='.m4a', delete=False) as temp_file:
                    temp_path = temp_file.name

                    # Stream enough data to start playback
                    bytes_read = 0
                    while self.running and bytes_read < 1024 * 100:  # 100KB
                        chunk = response.read(8192)
                        if not chunk:
                            break
                        temp_file.write(chunk)
                        bytes_read += len(chunk)
                        temp_file.flush()

                    # Start playback
                    try:
                        pygame.mixer.music.load(temp_path)
                        pygame.mixer.music.play()
                        self.is_playing = True
                        self.is_paused = False

                        # Continue streaming the rest
                        while self.running:
                            chunk = response.read(8192)
                            if not chunk:
                                break
                            temp_file.write(chunk)

                    except Exception as play_error:
                        self.log(f"Audio playback error: {play_error}")

                # Clean up temp file
                try:
                    import os
                    os.unlink(temp_path)
                except:
                    pass

        except Exception as e:
            self.log(f"Audio streaming error: {e}")

    def _on_track_changed(self):
        """Called when current track changes"""
        if self.current_track:
            self.log(f"Track changed: {self.current_track.get('title', 'Unknown')}")
            # Load new track audio (this will be triggered by sync_play command)

    def _refresh_status(self):
        """Refresh current status from server"""
        try:
            with urlopen(self.status_url, timeout=5) as response:
                data = json.loads(response.read().decode())
                current_time = time.perf_counter()

                if data.get('track'):
                    track = data['track']
                    if not self.current_track or self.current_track.get('youtubeId') != track.get('youtubeId'):
                        self.current_track = track
                        self._on_track_changed()

                    # Update sync data
                    self.server_position = data.get('position', 0)
                    self.server_duration = track.get('duration', 0)
                    self.last_sync_time = current_time

                self.player_status = data.get('status', 'stopped')

                return True
        except Exception as e:
            self.log(f"Failed to refresh status: {e}")
            return False

    def _start_position_timer(self):
        """Start timer for position tracking"""
        def update_position():
            if not self.running:
                return

            current_time = time.perf_counter()

            if self.current_track and self.server_duration > 0:
                # Calculate current position like frontend does
                elapsed_seconds = current_time - self.last_sync_time

                if self.player_status == "playing":
                    self.current_server_position = self.server_position + elapsed_seconds
                    self.current_server_position = min(self.current_server_position, self.server_duration)
                else:
                    self.current_server_position = self.server_position

            # Schedule next update
            if self.running:
                self.position_timer = threading.Timer(0.1, update_position)  # 100ms updates
                self.position_timer.start()

        update_position()

    def toggle_playback(self):
        """Toggle play/pause (local control)"""
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

    def set_volume(self, volume: float):
        """Set playback volume (0.0 to 1.0)"""
        self.volume = max(0.0, min(1.0, volume))
        if PYGAME_AVAILABLE:
            pygame.mixer.music.set_volume(self.volume)
        self.log(f"Volume: {int(self.volume * 100)}%")

    def create_gui(self):
        """Create simple GUI (similar to original but with sync info)"""
        if not GUI_AVAILABLE:
            self.log("GUI not available")
            return None

        self.root = tk.Tk()
        self.root.title("MIU Synchronized Client")
        self.root.geometry("450x250")

        # Track info
        self.track_label = tk.Label(self.root, text="No track playing", wraplength=430)
        self.track_label.pack(pady=10)

        # Sync info
        self.sync_label = tk.Label(self.root, text="Sync: Disconnected", fg="red")
        self.sync_label.pack(pady=5)

        # Position info
        self.position_label = tk.Label(self.root, text="Position: --:-- / --:--")
        self.position_label.pack(pady=5)

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
        self.status_label = tk.Label(self.root, text="Status: Stopped", fg="orange")
        self.status_label.pack(pady=5)

        # Set metadata callback
        self.metadata_callback = self._update_gui

        return self.root

    def _on_volume_change(self, value):
        """Handle volume slider change"""
        self.set_volume(int(value) / 100.0)

    def _update_gui(self, metadata: Dict):
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

            # Update sync info
            sync_status = "Connected" if self.sse_client.running else "Disconnected"
            sync_color = "green" if self.sse_client.running else "red"
            self.sync_label.config(text=f"Sync: {sync_status}", fg=sync_color)

            # Update position
            position = self.current_server_position
            duration = self.server_duration
            pos_text = f"Position: {self._format_time(position)} / {self._format_time(duration)}"
            self.position_label.config(text=pos_text)

            # Update status
            status = metadata.get('status', 'unknown')
            status_color = "green" if status == "playing" else "orange"
            self.status_label.config(text=f"Status: {status}", fg=status_color)

        except Exception as e:
            self.log(f"GUI update error: {e}")

    def _format_time(self, seconds: float) -> str:
        """Format time as mm:ss"""
        mins = int(seconds // 60)
        secs = int(seconds % 60)
        return f"{mins}:{secs:02d}"

def main():
    parser = argparse.ArgumentParser(description='MIU Synchronized Linux Client')
    parser.add_argument('--server', required=True,
                      help='MIU server URL (e.g., https://miu.gacha.boo)')
    parser.add_argument('--console', action='store_true',
                      help='Run in console mode only')

    args = parser.parse_args()

    client = MIUSyncClient(args.server)

    # Test connection
    if not client._refresh_status():
        print(f"Cannot connect to MIU server at {args.server}")
        print("Make sure the server is running and accessible.")
        return 1

    print(f"Connected to MIU server. Status: {client.player_status}")

    # Start synchronized client
    client.start()

    try:
        if args.console or not GUI_AVAILABLE:
            # Console mode
            print("Running in synchronized console mode. Press Ctrl+C to quit.")
            print("Commands: p (play/pause), v+ (volume up), v- (volume down), q (quit)")
            print("Note: Playback is controlled by server synchronization")

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
                # Handle window close
                def on_closing():
                    client.stop()
                    root.quit()

                root.protocol("WM_DELETE_WINDOW", on_closing)
                root.mainloop()
            else:
                print("GUI creation failed, falling back to console mode")
                input("Press Enter to quit...")

    except KeyboardInterrupt:
        print("\nShutting down...")

    finally:
        client.stop()

    return 0

if __name__ == "__main__":
    sys.exit(main())