#!/usr/bin/env python3
"""
MIU GTK Music Player
A modern GNOME-integrated music player for MIU music bot.
Features:
- Native GTK4 + Libadwaita interface
- GStreamer audio backend
- Real-time server synchronization
- MPRIS media controls integration
- System notifications and tray support
"""

import sys
import json
import threading
import time
import argparse
import asyncio
from urllib.request import urlopen, Request
from urllib.error import URLError
import tempfile
import os
from typing import Optional, Dict, Any

try:
    import gi
    gi.require_version('Gtk', '4.0')
    gi.require_version('Adw', '1')
    gi.require_version('Gst', '1.0')
    gi.require_version('GstPlayer', '1.0')
    gi.require_version('Gio', '2.0')
    from gi.repository import Gtk, Adw, Gst, GstPlayer, Gio, GLib, GObject, Gdk, GdkPixbuf
    GTK_AVAILABLE = True
except ImportError as e:
    GTK_AVAILABLE = False
    print(f"GTK4/Libadwaita not available: {e}")

try:
    gi.require_version('Notify', '0.7')
    from gi.repository import Notify
    NOTIFY_AVAILABLE = True
except ImportError:
    NOTIFY_AVAILABLE = False

# Initialize GStreamer
if GTK_AVAILABLE:
    # Initialize with empty argv to avoid argument parsing conflicts
    Gst.init([])

class MIUGtkPlayer(Gtk.Application):
    """Main MIU GTK Application"""

    def __init__(self, server_url: str):
        super().__init__(
            application_id="com.miu.gtk.player",
            flags=Gio.ApplicationFlags.DEFAULT_FLAGS
        )

        self.server_url = server_url.rstrip('/')
        base_url = self.server_url if self.server_url.endswith('/backend') else f"{self.server_url}/backend"

        # API endpoints
        self.stream_url = f"{base_url}/api/music/stream"
        self.status_url = f"{base_url}/api/music/minimal-status"
        self.sse_url = f"{base_url}/api/music/state/live"

        # Application state
        self.current_track = None
        self.queue = []
        self.player_status = "stopped"
        self.server_status = "stopped"
        self.position = 0
        self.volume = 0.8
        self.user_paused = False

        # Settings storage
        config_dir = GLib.get_user_config_dir() if GTK_AVAILABLE else os.path.expanduser('~/.config')
        self.settings_dir = os.path.join(config_dir, "miu-gtk")
        self.settings_path = os.path.join(self.settings_dir, "settings.json")
        self.load_settings()

        # UI components
        self.window = None
        self.player_widget = None

        # Audio player
        self.gst_player = None
        self.audio_duration = 0
        self.pending_seek_ns = None

        # Background tasks
        self.sse_thread = None
        self.running = False

        # Initialize notifications
        if NOTIFY_AVAILABLE:
            Notify.init("MIU Player")

        self.connect('activate', self.on_activate)

    def on_activate(self, app):
        """Called when the application is activated"""
        if not self.window:
            self.window = MIUMainWindow(application=self)
            self.player_widget = self.window.player_widget

            # Initialize GStreamer player
            self.init_gst_player()

        self.window.present()

        # Start background tasks
        if not self.running:
            self.start_background_tasks()

    def init_gst_player(self):
        """Initialize GStreamer player"""
        self.gst_player = GstPlayer.Player()

        # Connect signals
        self.gst_player.connect('position-updated', self.on_position_updated)
        self.gst_player.connect('duration-changed', self.on_duration_changed)
        self.gst_player.connect('state-changed', self.on_state_changed)
        self.gst_player.connect('end-of-stream', self.on_end_of_stream)

        # Set initial volume
        self.gst_player.set_volume(self.volume)
        print(f"[INIT] Initial volume set to {self.volume:.2f}")

        # Create audio-only video renderer (no video output)
        config = self.gst_player.get_config()
        self.gst_player.set_config(config)

    def load_settings(self):
        """Load persisted user settings"""
        try:
            if os.path.exists(self.settings_path):
                with open(self.settings_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                saved_volume = float(data.get('volume', self.volume))
                self.volume = max(0.0, min(1.0, saved_volume))
                print(f"[SETTINGS] Loaded volume {self.volume:.2f} from {self.settings_path}")
        except Exception as e:
            print(f"[SETTINGS] Failed to load settings: {e}")

    def save_settings(self):
        """Persist user settings to disk"""
        try:
            os.makedirs(self.settings_dir, exist_ok=True)
            data = {
                'volume': round(self.volume, 3)
            }
            with open(self.settings_path, 'w', encoding='utf-8') as f:
                json.dump(data, f)
            print(f"[SETTINGS] Saved settings to {self.settings_path}")
        except Exception as e:
            print(f"[SETTINGS] Failed to save settings: {e}")

    def start_background_tasks(self):
        """Start background tasks for server communication"""
        self.running = True

        # Start SSE connection in separate thread
        self.sse_thread = threading.Thread(target=self.sse_worker, daemon=True)
        self.sse_thread.start()

    def sse_worker(self):
        """SSE worker for real-time server updates"""
        while self.running:
            try:
                request = Request(self.sse_url)
                request.add_header('Accept', 'text/event-stream')
                request.add_header('Cache-Control', 'no-cache')

                with urlopen(request, timeout=30) as response:
                    event_type = None
                    event_data = ""

                    for line in response:
                        if not self.running:
                            break

                        line = line.decode('utf-8').strip()

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
                                    data['_received_time'] = time.time() * 1000
                                    GLib.idle_add(self.handle_sse_event, event_type, data)
                                except json.JSONDecodeError:
                                    continue

                            event_type = None
                            event_data = ""

            except Exception as e:
                print(f"SSE connection error: {e}")
                time.sleep(5)  # Retry after 5 seconds

    def handle_sse_event(self, event_type: str, data):
        """Handle SSE events from server"""
        if event_type == 'state':
            self.handle_state_update(data)
        elif event_type == 'sync_play':
            self.handle_sync_play(data)
        elif event_type == 'heartbeat':
            pass  # Keep connection alive

        return False  # Remove from GLib main loop

    def handle_state_update(self, data):
        """Handle server state updates"""
        current_time = time.time() * 1000  # Current timestamp in milliseconds

        if 'status' in data:
            self.server_status = data['status']
            print(f"[STATE] Server status updated to {self.server_status}")

        sync_position = data.get('position', None)
        sync_updated = False

        if 'currentTrack' in data:
            new_track = data['currentTrack']
            if new_track != self.current_track:
                self.current_track = new_track
                if self.player_widget and sync_position is not None:
                    duration = new_track.get('duration', 0)
                    self.player_widget.update_server_sync(sync_position, duration, current_time)
                    sync_updated = True
                self.on_track_changed()
                if new_track:
                    print(f"[STATE] Track changed to {new_track.get('title', 'Unknown')} ({new_track.get('youtubeId')})")

        if 'queue' in data:
            self.queue = data['queue']

        if sync_position is not None:
            self.position = sync_position
            print(f"[STATE] Server reported position {self.position}s")

        # Update server sync data for position calculation
        if self.player_widget and self.current_track and not sync_updated:
            # Get duration from current track if available
            duration = self.current_track.get('duration', 0)
            position = sync_position if sync_position is not None else getattr(self.player_widget, 'server_position', 0)

            # Update sync data in player widget
            self.player_widget.update_server_sync(position, duration, current_time)

        # Update UI
        if self.player_widget:
            self.player_widget.update_state()

    def handle_sync_play(self, data):
        """Handle synchronized play command"""
        track_id = data.get('trackId')
        position = data.get('position', 0)
        server_time = data.get('serverTime', 0)
        play_at = data.get('playAt', 0)
        received_time = data.get('_received_time', time.time() * 1000)

        if not track_id:
            return

        print(f"Received sync_play for track {track_id}")

        current_time_ms = time.time() * 1000
        # Estimate network latency (simplified - could be more sophisticated)
        estimated_latency = 50  # 50ms default

        # Calculate timing like frontend does if we have timing data
        if play_at and server_time:
            server_buffer = play_at - server_time
        else:
            server_buffer = 0

        time_passed_since_received = current_time_ms - received_time
        time_until_play_ms = server_buffer - time_passed_since_received - estimated_latency

        if self.user_paused:
            # Keep local playback paused but update sync data for resume
            if self.player_widget and self.current_track:
                duration = self.current_track.get('duration', 0)
                # Estimate current server position even while staying paused
                target_play_time = received_time + server_buffer - estimated_latency
                elapsed_since_play = max(0, current_time_ms - target_play_time)
                calculated_position = position + max(0, elapsed_since_play / 1000.0)
                self.player_widget.update_server_sync(calculated_position, duration, current_time_ms)
            print("Skipping sync_play because user paused playback")
            return

        print(f"Sync timing calculation:")
        print(f"  Server buffer: {server_buffer}ms")
        print(f"  Time since message: {time_passed_since_received}ms")
        print(f"  Estimated latency: {estimated_latency}ms")
        print(f"  Time until play: {time_until_play_ms}ms")

        # Schedule synchronized playback
        if time_until_play_ms > 0:
            # Use GLib timeout for precise timing
            GLib.timeout_add(max(1, int(time_until_play_ms)), self._sync_play_now, track_id, position)
        else:
            # Play immediately if we're already past the target time
            self._sync_play_now(track_id, position)

    def _sync_play_now(self, track_id: str, position: float):
        """Execute synchronized playback"""
        print(f"Starting synchronized playback of {track_id} at position {position}")

        # Ensure we have the correct track loaded
        if not self.current_track or self.current_track.get('youtubeId') != track_id:
            self.refresh_current_track()

        # Start synchronized audio playback
        self.sync_and_play()

        return False  # Don't repeat timeout

    def on_track_changed(self):
        """Called when current track changes"""
        if not self.current_track:
            return

        # Show notification
        if NOTIFY_AVAILABLE:
            title = self.current_track.get('title', 'Unknown Track')
            artist = self.current_track.get('requestedBy', {}).get('username', 'Unknown Artist')

            notification = Notify.Notification.new(
                "Now Playing",
                f"{title}\nby {artist}",
                "audio-x-generic"
            )
            notification.show()

        # Load audio stream
        self.load_current_track()

    def sync_and_play(self):
        """Synchronize with server and play from correct position"""
        if not self.current_track or not self.gst_player:
            return

        self.user_paused = False

        server_pos_seconds = 0
        if self.player_widget:
            # Calculate a fresh synced position to align with server progress
            if hasattr(self.player_widget, 'get_synced_position'):
                server_pos_seconds = self.player_widget.get_synced_position()
            else:
                server_pos_seconds = getattr(self.player_widget, 'current_server_position', 0)

        track_id = self.current_track.get('youtubeId') if self.current_track else 'unknown'
        print(f"[SYNC] Preparing playback for {track_id} at {server_pos_seconds:.3f}s (paused={self.user_paused})")

        # Set the stream URL
        self.gst_player.set_uri(self.stream_url)

        # Defer seeking until pipeline reaches PLAYING to ensure it sticks
        if server_pos_seconds > 0:
            self.pending_seek_ns = int(server_pos_seconds * 1000000000)
            print(f"[SYNC] Queued seek to {server_pos_seconds:.3f}s ({self.pending_seek_ns}ns)")
        else:
            self.pending_seek_ns = None
            print("[SYNC] No seek requested; starting from stream head")

        # Start playback
        self.gst_player.play()
        print("[SYNC] Issued play() command")

    def load_current_track(self):
        """Load current track into GStreamer and sync position"""
        if not self.current_track or not self.gst_player:
            return

        if self.user_paused:
            # Ensure player is stopped while we remain paused
            self.gst_player.stop()
            return

        # Use sync_and_play for proper positioning
        self.sync_and_play()

    def on_position_updated(self, player, position):
        """Called when playback position updates"""
        self.position = position // 1000000000  # Convert from nanoseconds to seconds
        # Position updates are handled by server sync, not GStreamer

    def on_duration_changed(self, player, duration):
        """Called when track duration changes"""
        self.audio_duration = duration // 1000000000  # Convert from nanoseconds to seconds
        # Duration updates are handled by server sync, not GStreamer

    def on_state_changed(self, player, state):
        """Called when player state changes"""
        if state == GstPlayer.PlayerState.PLAYING:
            self.player_status = "playing"
        elif state == GstPlayer.PlayerState.PAUSED:
            self.player_status = "paused"
        elif state == GstPlayer.PlayerState.STOPPED:
            self.player_status = "stopped"

        if state == GstPlayer.PlayerState.PLAYING and self.pending_seek_ns is not None:
            seek_seconds = self.pending_seek_ns / 1000000000
            print(f"[SYNC] Applying pending seek: {seek_seconds:.3f}s")
            seek_result = self.gst_player.seek(self.pending_seek_ns)
            print(f"[SYNC] Seek result: {seek_result}")
            self.pending_seek_ns = None

        # Update play/pause icon when state changes
        if self.player_widget:
            GLib.idle_add(self.player_widget.update_play_icon)

    def on_end_of_stream(self, player):
        """Called when track ends"""
        # Server should automatically advance to next track
        pass

    def play_pause(self):
        """Toggle play/pause with server position sync"""
        if not self.gst_player or not self.current_track:
            return

        if self.player_status == "playing":
            # Pause audio
            self.gst_player.pause()
            self.user_paused = True
            print("[CONTROL] User paused playback")
        else:
            # Resume/Play from current server position
            self.user_paused = False
            print("[CONTROL] User requested play; syncing with server")
            self.sync_and_play()

    def set_volume(self, volume):
        """Set player volume (0.0 to 1.0)"""
        self.volume = max(0.0, min(1.0, volume))
        if self.gst_player:
            self.gst_player.set_volume(self.volume)
        self.save_settings()
        print(f"[CONTROL] Volume set to {self.volume:.2f}")

    def seek(self, position):
        """Seek to position in seconds"""
        if self.gst_player and self.audio_duration > 0:
            # Convert to nanoseconds
            position_ns = position * 1000000000
            self.gst_player.seek(position_ns)

    def get_status(self):
        """Get current server status"""
        try:
            with urlopen(self.status_url, timeout=5) as response:
                data = json.loads(response.read().decode())
                return data
        except Exception as e:
            print(f"Failed to get status: {e}")
            return None

    def refresh_current_track(self):
        """Refresh current track info from server"""
        try:
            # Get fresh status from server
            status = self.get_status()
            if status and status.get('track'):
                track = status['track']

                # Update cached server status
                self.server_status = status.get('status', self.server_status)

                # Check if track changed
                if not self.current_track or self.current_track.get('youtubeId') != track.get('youtubeId'):
                    print(f"Track changed: {track.get('title', 'Unknown')}")
                    self.current_track = track
                    self.on_track_changed()

                # Update server position data
                current_time = time.time() * 1000
                if self.player_widget:
                    duration = track.get('duration', 0)
                    position = status.get('position', 0)
                    self.player_widget.update_server_sync(position, duration, current_time)

                return True
            else:
                print("No track currently playing on server")
                self.server_status = status.get('status', self.server_status) if status else self.server_status
                self.current_track = None
                if self.player_widget:
                    self.player_widget.update_state()
                if self.gst_player:
                    self.gst_player.stop()
                return False
        except Exception as e:
            print(f"Failed to refresh track: {e}")
            return False

    def quit_application(self):
        """Quit application cleanly"""
        self.running = False

        if self.sse_thread:
            self.sse_thread.join(timeout=2)

        if self.gst_player:
            self.gst_player.stop()

        if NOTIFY_AVAILABLE:
            Notify.uninit()

        self.quit()


class MIUMainWindow(Adw.ApplicationWindow):
    """Main application window"""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        self.app = self.get_application()

        # Window setup
        self.set_title("MIU Music Player")
        self.set_default_size(400, 600)

        # Create header bar
        self.setup_header_bar()

        # Create main content
        self.setup_content()

    def setup_header_bar(self):
        """Setup application header bar"""
        # AdwApplicationWindow automatically has a header bar, we just need to configure it
        header_bar = Adw.HeaderBar()

        # Menu button
        menu_button = Gtk.MenuButton()
        menu_button.set_icon_name("open-menu-symbolic")
        header_bar.pack_end(menu_button)

        # Create menu
        menu = Gio.Menu()
        menu.append("About", "app.about")
        menu.append("Quit", "app.quit")

        menu_button.set_menu_model(menu)

        # Add actions
        about_action = Gio.SimpleAction.new("about", None)
        about_action.connect("activate", self.on_about)
        self.app.add_action(about_action)

        quit_action = Gio.SimpleAction.new("quit", None)
        quit_action.connect("activate", self.on_quit)
        self.app.add_action(quit_action)

        # Store header bar reference and add to content
        self.header_bar = header_bar

    def setup_content(self):
        """Setup main window content"""
        # Main container with header bar
        main_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)

        # Add header bar to main box
        main_box.append(self.header_bar)

        # Player widget (now a simple horizontal card)
        self.player_widget = PlayerWidget(self.app)
        main_box.append(self.player_widget)

        self.set_content(main_box)

    def on_about(self, action, param):
        """Show about dialog"""
        dialog = Adw.AboutWindow(
            transient_for=self,
            modal=True,
            application_name="MIU Music Player",
            application_icon="audio-x-generic",
            version="1.0.0",
            developer_name="MIU Team",
            website="https://github.com/your-org/MIU",
            copyright="© 2024 MIU Team"
        )
        dialog.present()

    def on_quit(self, action, param):
        """Quit application"""
        self.app.quit_application()


class PlayerWidget(Gtk.Box):
    """Clean horizontal card player widget exactly like frontend"""

    def __init__(self, app):
        super().__init__(orientation=Gtk.Orientation.HORIZONTAL, spacing=24)
        self.app = app

        # Center the whole player in the window
        self.set_halign(Gtk.Align.CENTER)
        self.set_valign(Gtk.Align.CENTER)
        self.set_margin_top(40)
        self.set_margin_bottom(40)
        self.set_margin_start(40)
        self.set_margin_end(40)

        # Server sync timing
        self.server_position = 0
        self.server_duration = 0
        self.last_sync_time = 0
        self.current_server_position = 0

        # Build the layout: [Album Art] [Track Info] [Volume]
        self.create_album_art()
        self.create_track_info()
        self.create_volume_control()

        # Start real-time sync timer
        GLib.timeout_add(100, self.sync_position_timer)

    def create_album_art(self):
        """Create clickable album art section"""
        # Album art overlay button (clickable like frontend)
        self.art_button = Gtk.Button()
        self.art_button.set_size_request(240, 240)
        self.art_button.add_css_class("flat")
        self.art_button.connect("clicked", self.on_album_art_clicked)

        # Create overlay for album art + play/pause icon
        overlay = Gtk.Overlay()
        overlay.set_size_request(240, 240)

        # Album art image
        self.album_art = Gtk.Image()
        self.album_art.set_size_request(240, 240)
        self.load_album_art()  # Load from server
        overlay.set_child(self.album_art)

        # Play/pause overlay (hidden by default, shown on hover)
        self.play_overlay = Gtk.Box()
        self.play_overlay.set_halign(Gtk.Align.CENTER)
        self.play_overlay.set_valign(Gtk.Align.CENTER)
        self.play_overlay.set_size_request(64, 64)
        self.play_overlay.add_css_class("osd")
        self.play_overlay.set_opacity(0.0)

        self.play_icon = Gtk.Image()
        self.play_icon.set_pixel_size(48)
        self.update_play_icon()
        self.play_overlay.append(self.play_icon)

        overlay.add_overlay(self.play_overlay)
        self.art_button.set_child(overlay)

        # Add hover effects
        hover_controller = Gtk.EventControllerMotion()
        hover_controller.connect("enter", self.on_art_hover_enter)
        hover_controller.connect("leave", self.on_art_hover_leave)
        self.art_button.add_controller(hover_controller)

        self.append(self.art_button)

    def create_track_info(self):
        """Create track information section"""
        info_container = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        info_container.set_valign(Gtk.Align.START)
        info_container.set_hexpand(True)

        # "Now Playing" header
        now_playing_label = Gtk.Label(label="Now Playing")
        now_playing_label.set_halign(Gtk.Align.START)
        now_playing_label.add_css_class("title-4")
        info_container.append(now_playing_label)

        # Track title
        self.track_title = Gtk.Label()
        self.track_title.set_text("No track playing")
        self.track_title.set_halign(Gtk.Align.START)
        self.track_title.set_wrap(True)
        self.track_title.set_max_width_chars(40)
        self.track_title.add_css_class("title-1")
        info_container.append(self.track_title)

        # Requested by info
        self.requester_label = Gtk.Label()
        self.requester_label.set_text("")
        self.requester_label.set_halign(Gtk.Align.START)
        self.requester_label.add_css_class("dim-label")
        info_container.append(self.requester_label)


        self.append(info_container)

    def create_volume_control(self):
        """Create vertical volume control (like frontend desktop)"""
        volume_container = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        volume_container.set_valign(Gtk.Align.CENTER)

        # Volume icon
        volume_icon = Gtk.Image()
        volume_icon.set_from_icon_name("audio-volume-medium-symbolic")
        volume_icon.set_halign(Gtk.Align.CENTER)
        volume_container.append(volume_icon)

        # Vertical volume slider
        self.volume_slider = Gtk.Scale.new_with_range(Gtk.Orientation.VERTICAL, 0, 1, 0.01)
        self.volume_slider.set_vexpand(True)
        self.volume_slider.set_size_request(24, 180)
        self.volume_slider.set_draw_value(False)
        self.volume_slider.set_inverted(True)  # High values at top
        self.volume_slider.set_value(self.app.volume)
        self.volume_slider.connect("value-changed", self.on_volume_changed)
        volume_container.append(self.volume_slider)

        self.append(volume_container)

    def load_album_art(self):
        """Load album art from server"""
        if not self.app.current_track:
            self.album_art.set_from_icon_name("audio-x-generic")
            self.album_art.set_pixel_size(240)
            return

        youtube_id = self.app.current_track.get('youtubeId')
        if not youtube_id:
            self.album_art.set_from_icon_name("audio-x-generic")
            self.album_art.set_pixel_size(240)
            return

        # Load album art from server endpoint (like frontend)
        art_url = f"{self.app.server_url}/backend/api/albumart/{youtube_id}"

        try:
            # Use GLib to download image asynchronously
            threading.Thread(target=self.download_album_art, args=(art_url,), daemon=True).start()
        except Exception as e:
            print(f"Failed to load album art: {e}")
            self.album_art.set_from_icon_name("audio-x-generic")
            self.album_art.set_pixel_size(240)

    def download_album_art(self, url):
        """Download album art in background thread"""
        try:
            import urllib.request
            with urllib.request.urlopen(url, timeout=5) as response:
                image_data = response.read()

                # Load image on main thread
                GLib.idle_add(self.set_album_art_from_data, image_data)
        except Exception as e:
            print(f"Album art download failed: {e}")
            GLib.idle_add(self.set_fallback_album_art)

    def set_album_art_from_data(self, image_data):
        """Set album art from downloaded image data"""
        try:
            import io
            from gi.repository import GdkPixbuf, Gdk

            # Create pixbuf from image data
            loader = GdkPixbuf.PixbufLoader()
            loader.write(image_data)
            loader.close()

            pixbuf = loader.get_pixbuf()
            if pixbuf:
                # Scale to 240x240
                scaled_pixbuf = pixbuf.scale_simple(240, 240, GdkPixbuf.InterpType.BILINEAR)

                # Convert to Gdk.Texture (modern GTK4 way)
                texture = Gdk.Texture.new_for_pixbuf(scaled_pixbuf)
                self.album_art.set_from_paintable(texture)
            else:
                self.set_fallback_album_art()
        except Exception as e:
            print(f"Failed to set album art: {e}")
            self.set_fallback_album_art()

    def set_fallback_album_art(self):
        """Set fallback album art icon"""
        self.album_art.set_from_icon_name("audio-x-generic")
        self.album_art.set_pixel_size(240)

    def update_play_icon(self):
        """Update play/pause icon based on state"""
        if self.app.player_status == "playing":
            self.play_icon.set_from_icon_name("media-playback-pause-symbolic")
        else:
            self.play_icon.set_from_icon_name("media-playback-start-symbolic")

    def on_album_art_clicked(self, button):
        """Handle album art click (play/pause)"""
        # Refresh current track info before play/pause
        self.app.refresh_current_track()
        self.app.play_pause()

    def on_art_hover_enter(self, controller, x, y):
        """Show play/pause overlay on hover"""
        self.play_overlay.set_opacity(0.9)

    def on_art_hover_leave(self, controller):
        """Hide play/pause overlay when not hovering"""
        self.play_overlay.set_opacity(0.0)

    def on_volume_changed(self, scale):
        """Handle volume slider change"""
        volume = scale.get_value()
        self.app.set_volume(volume)

    def update_server_sync(self, position, duration, timestamp):
        """Update server sync data for position calculation"""
        self.server_position = position
        self.server_duration = duration
        self.last_sync_time = timestamp
        print(f"[SYNC] Server sync updated: position={position}s duration={duration}s timestamp={timestamp}")

    def get_synced_position(self):
        """Calculate current server position based on latest sync data"""
        if self.server_duration == 0:
            return 0

        current_time_ms = time.time() * 1000
        elapsed_seconds = max(0, (current_time_ms - self.last_sync_time) / 1000.0)

        if self.app.server_status == "playing":
            synced_position = self.server_position + elapsed_seconds
            synced_position = min(synced_position, self.server_duration)
        else:
            synced_position = self.server_position

        # Keep widget cache up to date for UI consumers
        self.current_server_position = synced_position
        self.server_position = synced_position
        self.last_sync_time = current_time_ms
        print(f"[SYNC] Calculated synced position {synced_position:.3f}s (elapsed {elapsed_seconds:.3f}s, status={self.app.server_status})")
        return synced_position

    def sync_position_timer(self):
        """Calculate current server position for resume functionality"""
        if not self.app.current_track or self.server_duration == 0:
            return True  # Continue timer

        # Calculate current position like frontend does
        self.get_synced_position()

        return True  # Continue timer

    def update_state(self):
        """Update widget state when track changes"""
        if self.app.current_track:
            # Update track info
            title = self.app.current_track.get('title', 'Unknown Track')
            username = self.app.current_track.get('requestedBy', {}).get('username', 'Unknown User')

            self.track_title.set_text(title)
            self.requester_label.set_text(f"Requested by {username}")

            # Load new album art
            self.load_album_art()
        else:
            # No track playing
            self.track_title.set_text("No track playing")
            self.requester_label.set_text("")
            self.set_fallback_album_art()

        # Update play/pause icon
        self.update_play_icon()




def main():
    """Main entry point"""
    if not GTK_AVAILABLE:
        print("Error: GTK4 and Libadwaita are required")
        print("Install with: sudo apt install python3-gi python3-gi-cairo gir1.2-gtk-4.0 gir1.2-adw-1")
        return 1

    parser = argparse.ArgumentParser(description='MIU GTK Music Player')
    parser.add_argument('--server', required=True,
                      help='MIU server URL (e.g., https://miu.gacha.boo)')

    args = parser.parse_args()

    # Initialize Adwaita
    Adw.init()

    # Create and run application
    app = MIUGtkPlayer(args.server)

    # Test connection
    status = app.get_status()
    if status is None:
        print(f"Cannot connect to MIU server at {args.server}")
        print("Make sure the server is running and accessible.")
        return 1

    print(f"Connected to MIU server. Current status: {status.get('status', 'unknown')}")

    # Run app with empty argv to prevent GStreamer from parsing our arguments
    return app.run([])


if __name__ == "__main__":
    sys.exit(main())
