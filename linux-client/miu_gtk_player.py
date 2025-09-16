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

        # Icon will be set up when display is available
        self.icon_name = "audio-x-generic"

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
        self.pending_seek_ns = None
        self.pending_seek_position_us = None

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

        # Background tasks
        self.sse_thread = None
        self.running = False

        # MPRIS interface placeholder
        self.mpris = None

        # Initialize notifications
        if NOTIFY_AVAILABLE:
            Notify.init("MIU Player")

        self.connect('activate', self.on_activate)
        self.init_mpris()

    def setup_custom_icon(self):
        """Setup custom application icon"""
        import os

        # Get the icon path
        icon_path = os.path.join(os.path.dirname(__file__), "miu-icon.svg")

        if os.path.exists(icon_path):
            try:
                # Add icon to the default icon theme
                icon_theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default())

                # Create a custom icon name
                self.icon_name = "miu-music-player"

                # For GTK4, we need to add the icon directory to the search path
                icon_dir = os.path.dirname(icon_path)
                icon_theme.add_search_path(icon_dir)

                # Copy the icon with the expected name
                custom_icon_path = os.path.join(icon_dir, f"{self.icon_name}.svg")
                if not os.path.exists(custom_icon_path):
                    import shutil
                    shutil.copy2(icon_path, custom_icon_path)

                # Set the application icon
                self.set_icon_name(self.icon_name)

                print(f"Custom icon loaded: {self.icon_name}")

            except Exception as e:
                print(f"Failed to setup custom icon: {e}")
                self.icon_name = "audio-x-generic"
        else:
            self.icon_name = "audio-x-generic"

    def on_activate(self, app):
        """Called when the application is activated"""
        if not self.window:
            # Setup custom icon now that display is available
            self.setup_custom_icon()

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

        # Create audio-only video renderer (no video output)
        config = self.gst_player.get_config()
        self.gst_player.set_config(config)

    def init_mpris(self):
        """Initialize MPRIS interface for desktop integration"""
        try:
            self.mpris = MPRISInterface(self)
        except Exception:
            self.mpris = None

    def load_settings(self):
        """Load persisted user settings"""
        try:
            if os.path.exists(self.settings_path):
                with open(self.settings_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                saved_volume = float(data.get('volume', self.volume))
                self.volume = max(0.0, min(1.0, saved_volume))
        except Exception:
            pass

    def save_settings(self):
        """Persist user settings to disk"""
        try:
            os.makedirs(self.settings_dir, exist_ok=True)
            data = {
                'volume': round(self.volume, 3)
            }
            with open(self.settings_path, 'w', encoding='utf-8') as f:
                json.dump(data, f)
        except Exception:
            pass

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

        if 'queue' in data:
            self.queue = data['queue']

        if sync_position is not None:
            self.position = sync_position

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
            return


        # Schedule synchronized playback
        if time_until_play_ms > 0:
            # Use GLib timeout for precise timing
            GLib.timeout_add(max(1, int(time_until_play_ms)), self._sync_play_now, track_id, position)
        else:
            # Play immediately if we're already past the target time
            self._sync_play_now(track_id, position)

    def _sync_play_now(self, track_id: str, position: float):
        """Execute synchronized playback"""

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

            icon_name = getattr(self, 'icon_name', 'audio-x-generic')

            notification = Notify.Notification.new(
                "Now Playing",
                f"{title}\nby {artist}",
                icon_name
            )
            notification.show()

        # Load audio stream
        self.load_current_track()

        if self.mpris:
            self.mpris.notify_metadata()

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


        # Set the stream URL
        self.gst_player.set_uri(self.stream_url)

        # Defer seeking until pipeline reaches PLAYING to ensure it sticks
        if server_pos_seconds > 0:
            self.pending_seek_ns = int(server_pos_seconds * 1000000000)
            self.pending_seek_position_us = int(server_pos_seconds * 1000000)
        elif server_pos_seconds == 0:
            self.pending_seek_ns = None
            self.pending_seek_position_us = None

        # Start playback
        self.gst_player.play()

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
            seek_result = self.gst_player.seek(self.pending_seek_ns)
            self.pending_seek_ns = None
            if self.mpris and seek_result and self.pending_seek_position_us is not None:
                self.mpris.emit_seeked(self.pending_seek_position_us)
            self.pending_seek_position_us = None

        # Update play/pause icon when state changes
        if self.player_widget:
            GLib.idle_add(self.player_widget.update_play_icon)

        if self.mpris:
            self.mpris.notify_playback_status()
            self.mpris.notify_position()

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
        else:
            # Resume/Play from current server position
            self.user_paused = False
            self.sync_and_play()

    def set_volume(self, volume):
        """Set player volume (0.0 to 1.0)"""
        self.volume = max(0.0, min(1.0, volume))
        if self.gst_player:
            self.gst_player.set_volume(self.volume)
        self.save_settings()
        if self.mpris:
            self.mpris.notify_volume_changed()
        if self.player_widget and hasattr(self.player_widget, 'volume_slider'):
            def _update_slider():
                current = self.player_widget.volume_slider.get_value()
                if abs(current - self.volume) > 0.001:
                    self.player_widget.volume_slider.set_value(self.volume)
                return False

            GLib.idle_add(_update_slider)

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

        if self.mpris:
            self.mpris.cleanup()

        self.quit()


class MIUMainWindow(Adw.ApplicationWindow):
    """Main application window"""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        self.app = self.get_application()

        # Window setup
        self.set_title("MIU Music Player")
        self.set_default_size(400, 600)

        # Set window icon from application
        if hasattr(self.app, 'icon_name'):
            self.set_icon_name(self.app.icon_name)
        else:
            self.set_icon_name("audio-x-generic")

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
        icon_name = getattr(self.app, 'icon_name', 'audio-x-generic')

        dialog = Adw.AboutWindow(
            transient_for=self,
            modal=True,
            application_name="MIU Music Player",
            application_icon=icon_name,
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
        self.art_button.set_size_request(200, 200)
        self.art_button.add_css_class("flat")
        self.art_button.connect("clicked", self.on_album_art_clicked)

        # Create overlay for album art + play/pause icon
        overlay = Gtk.Overlay()
        overlay.set_size_request(200, 200)

        # Album art image
        self.album_art = Gtk.Image()
        self.album_art.set_size_request(200, 200)
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
        self.track_title.add_css_class("title-2")
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
            self.album_art.set_pixel_size(200)
            return

        youtube_id = self.app.current_track.get('youtubeId')
        if not youtube_id:
            self.album_art.set_from_icon_name("audio-x-generic")
            self.album_art.set_pixel_size(200)
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
                scaled_pixbuf = pixbuf.scale_simple(200, 200, GdkPixbuf.InterpType.BILINEAR)

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
        self.album_art.set_pixel_size(200)

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
        if self.app.mpris:
            self.app.mpris.notify_position()

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



class MPRISInterface:
    """Expose playback controls via the MPRIS D-Bus interface"""

    BUS_NAME = "org.mpris.MediaPlayer2.MIU"
    OBJECT_PATH = "/org/mpris/MediaPlayer2"
    MEDIA_IFACE = "org.mpris.MediaPlayer2"
    PLAYER_IFACE = "org.mpris.MediaPlayer2.Player"

    INTROSPECTION_XML = """
    <node>
      <interface name="org.mpris.MediaPlayer2">
        <method name="Raise"/>
        <method name="Quit"/>
        <property name="CanQuit" type="b" access="read"/>
        <property name="CanRaise" type="b" access="read"/>
        <property name="HasTrackList" type="b" access="read"/>
        <property name="Identity" type="s" access="read"/>
        <property name="DesktopEntry" type="s" access="read"/>
        <property name="SupportedUriSchemes" type="as" access="read"/>
        <property name="SupportedMimeTypes" type="as" access="read"/>
      </interface>
      <interface name="org.mpris.MediaPlayer2.Player">
        <method name="Next"/>
        <method name="Previous"/>
        <method name="Pause"/>
        <method name="PlayPause"/>
        <method name="Stop"/>
        <method name="Play"/>
        <method name="Seek">
          <arg name="Offset" type="x" direction="in"/>
        </method>
        <method name="SetPosition">
          <arg name="TrackId" type="o" direction="in"/>
          <arg name="Position" type="x" direction="in"/>
        </method>
        <method name="OpenUri">
          <arg name="Uri" type="s" direction="in"/>
        </method>
        <signal name="Seeked">
          <arg name="Position" type="x"/>
        </signal>
        <property name="PlaybackStatus" type="s" access="read"/>
        <property name="Metadata" type="a{sv}" access="read"/>
        <property name="Position" type="x" access="read"/>
        <property name="Rate" type="d" access="read"/>
        <property name="MinimumRate" type="d" access="read"/>
        <property name="MaximumRate" type="d" access="read"/>
        <property name="Volume" type="d" access="readwrite"/>
        <property name="CanGoNext" type="b" access="read"/>
        <property name="CanGoPrevious" type="b" access="read"/>
        <property name="CanPlay" type="b" access="read"/>
        <property name="CanPause" type="b" access="read"/>
        <property name="CanSeek" type="b" access="read"/>
        <property name="CanControl" type="b" access="read"/>
        <property name="Shuffle" type="b" access="read"/>
        <property name="LoopStatus" type="s" access="read"/>
      </interface>
    </node>
    """

    def __init__(self, app: MIUGtkPlayer):
        self.app = app
        self.connection: Optional[Gio.DBusConnection] = None
        self._node_info = Gio.DBusNodeInfo.new_for_xml(self.INTROSPECTION_XML)
        self._registration_ids = []
        self._bus_owner_id = Gio.bus_own_name(
            Gio.BusType.SESSION,
            self.BUS_NAME,
            Gio.BusNameOwnerFlags.NONE,
            self.on_bus_acquired,
            None,
            self.on_name_lost
        )

    def on_bus_acquired(self, connection: Gio.DBusConnection, name: str):
        self.connection = connection
        for interface in self._node_info.interfaces:
            registration_id = connection.register_object(
                self.OBJECT_PATH,
                interface,
                self.handle_method_call,
                self.handle_get_property,
                self.handle_set_property
            )
            self._registration_ids.append(registration_id)
        GLib.idle_add(self.publish_initial_state)

    def on_name_lost(self, connection: Optional[Gio.DBusConnection], name: str):
        self.cleanup()

    def cleanup(self):
        if self.connection:
            for registration_id in self._registration_ids:
                self.connection.unregister_object(registration_id)
        self._registration_ids = []
        if hasattr(self, '_bus_owner_id') and self._bus_owner_id is not None:
            Gio.bus_unown_name(self._bus_owner_id)
            self._bus_owner_id = None
        self.connection = None

    def handle_method_call(self, connection, sender, object_path, interface_name, method_name, parameters, invocation):
        if interface_name == self.MEDIA_IFACE:
            if method_name == 'Raise':
                if self.app.window:
                    GLib.idle_add(self.app.window.present)
                invocation.return_value(None)
            elif method_name == 'Quit':
                GLib.idle_add(self.app.quit_application)
                invocation.return_value(None)
            else:
                invocation.return_error_literal(Gio.DBusError, Gio.DBusError.UNKNOWN_METHOD, 'Unknown method')
            return

        if interface_name == self.PLAYER_IFACE:
            if method_name == 'Play':
                GLib.idle_add(self.ensure_playing)
                invocation.return_value(None)
            elif method_name == 'Pause':
                GLib.idle_add(self.ensure_paused)
                invocation.return_value(None)
            elif method_name == 'PlayPause':
                GLib.idle_add(self.app.play_pause)
                invocation.return_value(None)
            elif method_name == 'Stop':
                GLib.idle_add(self.ensure_stopped)
                invocation.return_value(None)
            elif method_name in ('Next', 'Previous', 'Seek', 'SetPosition', 'OpenUri'):
                invocation.return_error_literal(Gio.DBusError, Gio.DBusError.NOT_SUPPORTED, 'Not supported')
            else:
                invocation.return_error_literal(Gio.DBusError, Gio.DBusError.UNKNOWN_METHOD, 'Unknown method')

    def handle_get_property(self, connection, sender, object_path, interface_name, property_name):
        if interface_name == self.MEDIA_IFACE:
            return self.get_media_property(property_name)
        if interface_name == self.PLAYER_IFACE:
            return self.get_player_property(property_name)
        raise AttributeError('Unknown property')

    def handle_set_property(self, connection, sender, object_path, interface_name, property_name, value):
        if interface_name == self.PLAYER_IFACE and property_name == 'Volume':
            volume = max(0.0, min(1.0, value.get_double()))
            GLib.idle_add(self.app.set_volume, volume)
            return True
        return False

    def ensure_playing(self):
        if self.app.player_status != "playing":
            self.app.user_paused = False
            self.app.sync_and_play()

    def ensure_paused(self):
        if self.app.player_status == "playing" and self.app.gst_player:
            self.app.gst_player.pause()
            self.app.user_paused = True

    def ensure_stopped(self):
        if self.app.gst_player:
            self.app.gst_player.stop()
            self.app.user_paused = True

    def get_media_property(self, name: str):
        if name == 'CanQuit':
            return GLib.Variant('b', True)
        if name == 'CanRaise':
            return GLib.Variant('b', True)
        if name == 'HasTrackList':
            return GLib.Variant('b', False)
        if name == 'Identity':
            return GLib.Variant('s', 'MIU Player')
        if name == 'DesktopEntry':
            return GLib.Variant('s', 'miu-gtk')
        if name == 'SupportedUriSchemes':
            return GLib.Variant('as', [])
        if name == 'SupportedMimeTypes':
            return GLib.Variant('as', ['audio/mpeg', 'audio/mp4'])
        raise AttributeError('Unknown media property')

    def get_player_property(self, name: str):
        if name == 'PlaybackStatus':
            return GLib.Variant('s', self.get_playback_status())
        if name == 'Metadata':
            return self._dict_to_variant(self.build_metadata())
        if name == 'Position':
            return GLib.Variant('x', self.get_position_us())
        if name == 'Rate':
            return GLib.Variant('d', 1.0)
        if name == 'MinimumRate':
            return GLib.Variant('d', 1.0)
        if name == 'MaximumRate':
            return GLib.Variant('d', 1.0)
        if name == 'Volume':
            return GLib.Variant('d', float(self.app.volume))
        if name == 'CanGoNext':
            return GLib.Variant('b', False)
        if name == 'CanGoPrevious':
            return GLib.Variant('b', False)
        if name == 'CanPlay':
            return GLib.Variant('b', self.app.current_track is not None)
        if name == 'CanPause':
            return GLib.Variant('b', self.app.current_track is not None)
        if name == 'CanSeek':
            return GLib.Variant('b', False)
        if name == 'CanControl':
            return GLib.Variant('b', True)
        if name == 'Shuffle':
            return GLib.Variant('b', False)
        if name == 'LoopStatus':
            return GLib.Variant('s', 'None')
        raise AttributeError('Unknown player property')

    def get_playback_status(self) -> str:
        status = self.app.player_status
        if status == 'playing':
            return 'Playing'
        if status == 'paused':
            return 'Paused'
        return 'Stopped'

    def build_metadata(self) -> Dict[str, GLib.Variant]:
        metadata: Dict[str, GLib.Variant] = {}
        track = self.app.current_track
        if not track:
            return metadata

        youtube_id = track.get('youtubeId', 'unknown')
        metadata['mpris:trackid'] = GLib.Variant('o', f"/org/mpris/MediaPlayer2/track/{youtube_id}")
        metadata['xesam:title'] = GLib.Variant('s', track.get('title', 'Unknown Track'))

        artist = track.get('requestedBy', {}).get('username')
        if artist:
            metadata['xesam:artist'] = GLib.Variant('as', [artist])
        else:
            metadata['xesam:artist'] = GLib.Variant('as', [])

        duration = track.get('duration', 0)
        metadata['mpris:length'] = GLib.Variant('x', int(duration * 1000000))

        art_url = f"{self.app.server_url}/backend/api/albumart/{youtube_id}"
        metadata['mpris:artUrl'] = GLib.Variant('s', art_url)

        return metadata

    def get_position_us(self) -> int:
        if self.app.player_widget and hasattr(self.app.player_widget, 'get_synced_position'):
            position = self.app.player_widget.get_synced_position()
        else:
            position = getattr(self.app, 'position', 0)
        return int(position * 1000000)

    def notify_playback_status(self):
        self.emit_properties_changed(self.PLAYER_IFACE, {
            'PlaybackStatus': GLib.Variant('s', self.get_playback_status())
        })

    def notify_metadata(self):
        self.emit_properties_changed(self.PLAYER_IFACE, {
            'Metadata': self._dict_to_variant(self.build_metadata())
        })

    def notify_position(self):
        self.emit_properties_changed(self.PLAYER_IFACE, {
            'Position': GLib.Variant('x', self.get_position_us())
        })

    def notify_volume_changed(self):
        self.emit_properties_changed(self.PLAYER_IFACE, {
            'Volume': GLib.Variant('d', float(self.app.volume))
        })

    def emit_seeked(self, position_us: int):
        if not self.connection:
            return
        self.connection.emit_signal(
            None,
            self.OBJECT_PATH,
            self.PLAYER_IFACE,
            'Seeked',
            GLib.Variant('(x)', (int(position_us),))
        )

    def emit_properties_changed(self, interface_name: str, properties: Dict[str, GLib.Variant]):
        if not self.connection or not properties:
            return
        # Convert to plain dict for GLib.Variant constructor
        converted = {}
        for key, value in properties.items():
            if not isinstance(value, GLib.Variant):
                value = GLib.Variant('s', str(value))
            converted[str(key)] = value

        self.connection.emit_signal(
            None,
            self.OBJECT_PATH,
            'org.freedesktop.DBus.Properties',
            'PropertiesChanged',
            GLib.Variant('(sa{sv}as)', (interface_name, converted, []))
        )

    def _dict_to_variant(self, mapping: Dict[str, GLib.Variant]) -> GLib.Variant:
        converted = {}
        for key, value in mapping.items():
            if not isinstance(value, GLib.Variant):
                value = GLib.Variant('s', str(value))
            converted[str(key)] = value
        return GLib.Variant('a{sv}', converted)

    def publish_initial_state(self):
        self.notify_metadata()
        self.notify_playback_status()
        self.notify_volume_changed()
        self.notify_position()
        return False



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
