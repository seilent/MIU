let invoke = null;
let listen = null;
let appWindow = null;
let windowModule = null;
let webviewWindowModule = null;

function resolveTauriApis() {
    const namespace = window.__TAURI__;
    if (!namespace) {
        console.debug('resolveTauriApis: window.__TAURI__ missing at', Date.now());
        return null;
    }

    const resolvedInvoke = namespace?.tauri?.invoke || namespace?.core?.invoke;
    if (!resolvedInvoke) {
        return null;
    }

    let currentWindow = null;
    try {
        const windowCandidates = [namespace?.window, namespace?.webviewWindow];
        for (const candidate of windowCandidates) {
            if (!candidate || currentWindow) {
                continue;
            }
            if (typeof candidate.getCurrent === 'function') {
                currentWindow = candidate.getCurrent();
            } else if (candidate.appWindow) {
                currentWindow = candidate.appWindow;
            } else if (
                candidate.WebviewWindow &&
                typeof candidate.WebviewWindow.getCurrent === 'function'
            ) {
                currentWindow = candidate.WebviewWindow.getCurrent();
            }
        }
    } catch (error) {
        console.warn('resolveTauriApis: failed to resolve current window', error);
    }

    console.debug('resolveTauriApis namespace snapshot', namespace);
    return {
        invoke: resolvedInvoke,
        listen: namespace?.event?.listen || namespace?.tauri?.listen || null,
        windowModule: namespace?.window || null,
        webviewWindowModule: namespace?.webviewWindow || null,
        appWindow: currentWindow || null,
    };
}

function waitForTauriApis(timeout = 5000) {
    const start = Date.now();

    return new Promise((resolve, reject) => {
        function poll() {
            const apis = resolveTauriApis();
            if (apis) {
                resolve(apis);
                return;
            }

            if (Date.now() - start >= timeout) {
                const namespace = window.__TAURI__ || {};
                reject(new Error('Timed out waiting for Tauri APIs: ' + JSON.stringify({
                    hasNamespace: !!window.__TAURI__,
                    keys: Object.keys(namespace || {}),
                })));
                return;
            }

            requestAnimationFrame(poll);
        }

        poll();
    });
}

function getSliderVolume() {
    const numeric = volumeSlider.valueAsNumber;
    if (Number.isFinite(numeric)) {
        return numeric;
    }

    const parsed = parseFloat(volumeSlider.value);
    return Number.isFinite(parsed) ? parsed : 0;
}

// DOM elements
const playerSection = document.getElementById('player-section');
const connectionStatus = document.getElementById('connection-status');

const albumArt = document.getElementById('album-art');
const albumArtContainer = document.getElementById('album-art-container');
const playIcon = document.getElementById('play-icon');
const trackTitle = document.getElementById('track-title');
const requesterName = document.getElementById('requester-name');
const requesterAvatar = document.getElementById('requester-avatar');

const volumeSlider = document.getElementById('volume-slider');
const volumeIndicator = document.getElementById('volume-indicator');

const DEFAULT_ALBUM_ART = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><rect fill='%23222222' width='200' height='200'/><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' fill='%23555555' font-size='48'>♪</text></svg>";
const DEFAULT_SERVER_URL = 'https://miu.gacha.boo';
const RECONNECT_DELAY = 5000;

// Application state
let currentTrack = null;
let isPlaying = false;
let isConnected = false;
let playerStateInterval = null;
let reconnectTimeout = null;

function setCssVariable(name, value) {
    if (!name || typeof value === 'undefined' || value === null) {
        return;
    }
    document.documentElement.style.setProperty(name, value);
}

function normalizeHexColor(input) {
    if (typeof input !== 'string') {
        return null;
    }

    let hex = input.trim().toLowerCase();
    if (!hex) {
        return null;
    }

    if (hex.startsWith('0x')) {
        hex = hex.slice(2);
    }

    if (hex.startsWith('#')) {
        hex = hex.slice(1);
    }

    if (hex.length === 3) {
        hex = hex.split('').map((char) => char + char).join('');
    }

    if (hex.length !== 6) {
        return null;
    }

    return `#${hex}`;
}

function hexToRgba(hex, alpha = 1) {
    const normalized = normalizeHexColor(hex);
    if (!normalized) {
        return null;
    }

    const r = parseInt(normalized.slice(1, 3), 16);
    const g = parseInt(normalized.slice(3, 5), 16);
    const b = parseInt(normalized.slice(5, 7), 16);

    const clampedAlpha = Math.min(Math.max(alpha, 0), 1);
    return `rgba(${r}, ${g}, ${b}, ${clampedAlpha})`;
}

function applyThemeOverrides(theme) {
    if (!theme || !theme.variables) {
        return;
    }

    if (theme.source) {
        console.debug('Applying theme overrides from', theme.source);
    }

    Object.entries(theme.variables).forEach(([name, value]) => {
        setCssVariable(name, value);
    });
}

function applyHyprlandTheme(theme) {
    if (!theme || !theme.is_hyprland) {
        return;
    }

    const root = document.documentElement;
    root.classList.add('hyprland');

    if (theme.prefers_tiling) {
        root.classList.add('hyprland-prefers-tiling');
    }

    if (theme.accent_color) {
        const accent = normalizeHexColor(theme.accent_color);
        if (accent) {
            setCssVariable('--miu-accent', accent);
            setCssVariable('--miu-success', accent);
            setCssVariable('--miu-slider-thumb', accent);
            const softBase = hexToRgba(accent, 0.18);
            const softHover = hexToRgba(accent, 0.28);
            const softActive = hexToRgba(accent, 0.38);
            const borderColor = hexToRgba(accent, 0.4);
            const scrollThumb = hexToRgba(accent, 0.27);
            const scrollThumbHover = hexToRgba(accent, 0.42);
            const placeholder = hexToRgba(accent, 0.3);

            if (softBase) setCssVariable('--miu-accent-soft', softBase);
            if (softHover) setCssVariable('--miu-accent-soft-hover', softHover);
            if (softActive) setCssVariable('--miu-accent-soft-active', softActive);
            if (borderColor) setCssVariable('--miu-surface-border', borderColor);
            if (scrollThumb) setCssVariable('--miu-scroll-thumb', scrollThumb);
            if (scrollThumbHover) setCssVariable('--miu-scroll-thumb-hover', scrollThumbHover);
            if (placeholder) setCssVariable('--miu-placeholder', placeholder);
        }
    }

    if (theme.inactive_color) {
        const inactive = normalizeHexColor(theme.inactive_color);
        if (inactive) {
            const secondary = hexToRgba(inactive, 0.7);
            const muted = hexToRgba(inactive, 0.75);
            const dim = hexToRgba(inactive, 0.65);
            if (secondary) setCssVariable('--miu-text-secondary', secondary);
            if (muted) setCssVariable('--miu-text-muted', muted);
            if (dim) setCssVariable('--miu-text-dim', dim);
        }
    }
}

async function hydrateHyprlandTheme() {
    if (!invoke) {
        return;
    }

    try {
        const theme = await invoke('get_hyprland_theme');
        if (theme) {
            applyHyprlandTheme(theme);
        }
    } catch (error) {
        console.debug('Hyprland theme unavailable', error);
    }
}

async function hydrateThemeOverrides() {
    if (!invoke) {
        return;
    }

    try {
        const theme = await invoke('get_theme_overrides');
        if (theme) {
            applyThemeOverrides(theme);
        }
    } catch (error) {
        console.debug('Theme overrides unavailable', error);
    }
}

// Initialize application
document.addEventListener('DOMContentLoaded', async () => {
    initializeEventListeners();
    albumArt.src = DEFAULT_ALBUM_ART;

    try {
        const apis = await waitForTauriApis();
        invoke = apis.invoke;
        listen = apis.listen;
        windowModule = apis.windowModule;
        webviewWindowModule = apis.webviewWindowModule;
        appWindow = await resolveAppWindowHandle(apis);

        if (appWindow && typeof appWindow.onShow === 'function') {
            try {
                await appWindow.onShow(async () => {
                    if (typeof appWindow.setSkipTaskbar === 'function') {
                        await appWindow.setSkipTaskbar(false);
                    }
                });
            } catch (error) {
                console.warn('Failed to attach onShow handler', error);
            }
        }

        console.debug('Tauri APIs resolved', { hasInvoke: !!invoke, hasListen: !!listen });

        if (!listen) {
            console.warn('Tauri listen API unavailable; realtime updates disabled.');
        }

        initializeTauriListeners();
        await hydrateThemeOverrides();
        await hydrateHyprlandTheme();
        connectToServer();
    } catch (error) {
        console.error('Failed to acquire Tauri APIs', error);
        setConnectionStatus('Unable to connect to desktop bridge. See console.', 'error');
    }
});

function initializeEventListeners() {
    albumArtContainer.addEventListener('click', handlePlayPause);
    volumeSlider.addEventListener('input', handleVolumeChange);
    volumeSlider.addEventListener('mousemove', updateVolumeIndicator);
}

async function resolveAppWindowHandle(apis) {
    if (!apis) return null;

    const candidates = [];
    if (apis.appWindow) {
        candidates.push(apis.appWindow);
    }
    if (apis.windowModule?.appWindow) {
        candidates.push(apis.windowModule.appWindow);
    }
    if (apis.webviewWindowModule?.appWindow) {
        candidates.push(apis.webviewWindowModule.appWindow);
    }
    if (typeof apis.windowModule?.getCurrent === 'function') {
        candidates.push(apis.windowModule.getCurrent());
    }
    if (
        apis.windowModule?.WebviewWindow &&
        typeof apis.windowModule.WebviewWindow.getCurrent === 'function'
    ) {
        candidates.push(apis.windowModule.WebviewWindow.getCurrent());
    }
    if (typeof apis.webviewWindowModule?.getCurrent === 'function') {
        candidates.push(apis.webviewWindowModule.getCurrent());
    }
    if (
        apis.webviewWindowModule?.WebviewWindow &&
        typeof apis.webviewWindowModule.WebviewWindow.getCurrent === 'function'
    ) {
        candidates.push(apis.webviewWindowModule.WebviewWindow.getCurrent());
    }

    for (const candidate of candidates) {
        if (!candidate) continue;
        if (typeof candidate.then === 'function') {
            try {
                const resolved = await candidate;
                if (resolved) {
                    return resolved;
                }
            } catch (error) {
                console.warn('resolveAppWindowHandle: async candidate failed', error);
            }
            continue;
        }

        return candidate;
    }

    return null;
}

async function ensureAppWindow() {
    if (appWindow) {
        return appWindow;
    }

    try {
        let apis = resolveTauriApis();
        if (!apis) {
            apis = await waitForTauriApis().catch((error) => {
                console.warn('ensureAppWindow: waitForTauriApis failed', error);
                return null;
            });
        }

        if (!apis) {
            return null;
        }

        invoke = apis.invoke || invoke;
        listen = apis.listen || listen;
        windowModule = apis.windowModule || windowModule;
        webviewWindowModule = apis.webviewWindowModule || webviewWindowModule;

        const resolved = await resolveAppWindowHandle(apis);
        if (resolved) {
            appWindow = resolved;
            return resolved;
        }
    } catch (error) {
        console.error('ensureAppWindow: unable to resolve app window', error);
    }

    return null;
}


function initializeTauriListeners() {
    if (!listen) {
        console.warn('Skipping Tauri event listener registration: listen API unavailable');
        return;
    }
    listen('player_state_updated', (event) => {
        if (event && event.payload) {
            updatePlayerState(event.payload);
        }
    }).catch((error) => {
        console.error('Failed to register player_state_updated listener', error);
    });

    listen('hyprland_theme', (event) => {
        if (event && event.payload) {
            applyHyprlandTheme(event.payload);
        }
    }).catch((error) => {
        console.error('Failed to register hyprland_theme listener', error);
    });

    listen('theme_overrides', (event) => {
        if (event && event.payload) {
            applyThemeOverrides(event.payload);
        }
    }).catch((error) => {
        console.error('Failed to register theme_overrides listener', error);
    });
}

async function connectToServer(serverUrl = DEFAULT_SERVER_URL) {
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }

    setConnectionStatus('');

    try {
        if (!invoke) {
            throw new Error('Tauri invoke API unavailable');
        }

        await invoke('connect_to_server', { serverUrl });

        isConnected = true;
        setConnectionStatus('');

        await refreshPlayerState();
        startPlayerStatePolling();
    } catch (error) {
        console.error('Connection failed:', error);
        isConnected = false;
        setConnectionStatus('Connection failed. Retrying…', 'error');
        if (playerStateInterval) {
            clearInterval(playerStateInterval);
            playerStateInterval = null;
        }
        currentTrack = null;
        showNoTrackContent();
        scheduleReconnect(serverUrl);
    }
}

function scheduleReconnect(serverUrl) {
    reconnectTimeout = setTimeout(() => {
        connectToServer(serverUrl);
    }, RECONNECT_DELAY);
}

function setConnectionStatus(message, type = 'info') {
    if (!connectionStatus) return;

    if (!message) {
        connectionStatus.textContent = '';
        connectionStatus.classList.add('hidden');
        return;
    }

    connectionStatus.textContent = message;
    connectionStatus.className = `connection-status ${type}`;
    connectionStatus.classList.remove('hidden');
}


async function handlePlayPause() {
    if (!currentTrack) return;
    if (!invoke) {
        console.warn('Cannot toggle playback without Tauri invoke API');
        return;
    }

    // Removed debounce timeout - redundant failsafe

    // INSTANT UI update - don't wait for backend
    isPlaying = !isPlaying;
    updatePlayIcon();

    try {
        invoke('play_pause');
    } catch (error) {
        console.error('Play/pause failed:', error);
        // Revert on error
        isPlaying = !isPlaying;
        updatePlayIcon();
    }
}

async function handleVolumeChange() {
    const volume = getSliderVolume();
    updateVolumeIndicator();

    if (!invoke) {
        console.warn('Cannot set volume without Tauri invoke API');
        return;
    }

    try {
        await invoke('set_volume', { volume });
    } catch (error) {
        console.error('Volume change failed:', error);
    }
}

function updateVolumeIndicator() {
    const volume = getSliderVolume();
    const percentage = Math.round(volume * 100);
    volumeIndicator.textContent = `${percentage}%`;
}

function startPlayerStatePolling() {
    if (playerStateInterval) {
        clearInterval(playerStateInterval);
    }

    playerStateInterval = setInterval(refreshPlayerState, 5000);
    refreshPlayerState();
}

async function refreshPlayerState() {
    if (!invoke) {
        console.warn('Cannot refresh player state without Tauri invoke API');
        return;
    }
    try {
        const state = await invoke('get_player_state');
        if (state) {
            updatePlayerState(state);
        }
    } catch (error) {
        console.error('Failed to refresh player state:', error);
    }
}

function updatePlayerState(state) {
    if (!state) return;

    isPlaying = !!state.isPlaying;
    updatePlayIcon();

    if (typeof state.volume === 'number' && Number.isFinite(state.volume)) {
        volumeSlider.value = state.volume.toString();
        updateVolumeIndicator();
    }

    if (state.currentTrack) {
        currentTrack = state.currentTrack;
        updateTrackDisplay(currentTrack);
        showPlayerContent();
    } else {
        currentTrack = null;
        showNoTrackContent();
    }
}

function updateTrackDisplay(track) {
    trackTitle.textContent = track.title || 'Unknown Track';

    if (track.requestedBy) {
        requesterName.textContent = track.requestedBy.username || 'Unknown';

        if (track.requestedBy.avatar) {
            const avatarUrl = `https://cdn.discordapp.com/avatars/${track.requestedBy.id}/${track.requestedBy.avatar}.png`;
            requesterAvatar.src = avatarUrl;
            requesterAvatar.classList.remove('hidden');
        } else {
            requesterAvatar.classList.add('hidden');
        }
    } else {
        requesterName.textContent = '—';
        requesterAvatar.classList.add('hidden');
    }

    let fallbackUsed = false;

    if (track.albumArtUrl) {
        albumArt.src = track.albumArtUrl;
    } else if (track.thumbnail) {
        albumArt.src = track.thumbnail;
    } else if (track.youtubeId) {
        albumArt.src = `https://img.youtube.com/vi/${track.youtubeId}/hqdefault.jpg`;
    } else {
        albumArt.src = DEFAULT_ALBUM_ART;
        fallbackUsed = true;
    }

    albumArt.onerror = () => {
        if (fallbackUsed) return;

        if (track.thumbnail) {
            albumArt.src = track.thumbnail;
        } else if (track.youtubeId) {
            albumArt.src = `https://img.youtube.com/vi/${track.youtubeId}/hqdefault.jpg`;
        } else {
            albumArt.src = DEFAULT_ALBUM_ART;
        }
        fallbackUsed = true;
    };
}

function updatePlayIcon() {
    playIcon.textContent = isPlaying ? '⏸' : '▶';
}

function showPlayerContent() {
    const playerCard = playerSection.querySelector('.player-card');

    playerCard.style.display = 'flex';

    const noTrackMessage = playerSection.querySelector('.no-track-message');
    if (noTrackMessage) {
        noTrackMessage.remove();
    }
}

function showNoTrackContent() {
    const playerCard = playerSection.querySelector('.player-card');

    playerCard.style.display = 'none';

    if (!playerSection.querySelector('.no-track-message')) {
        const noTrackDiv = document.createElement('div');
        noTrackDiv.className = 'no-track-message';
        noTrackDiv.innerHTML = `
            <div class="no-track-content">
                <div class="default-album-art">
                    <div class="music-note">♪</div>
                </div>
                <h2>No music playing</h2>
                <p>Request a song in Discord to start the music player.</p>
            </div>
        `;
        playerSection.appendChild(noTrackDiv);
    }
}

window.addEventListener('focus', () => {
    if (isConnected) {
        refreshPlayerState();
    }
});
