let invoke = null;
let listen = null;

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

    console.debug('resolveTauriApis namespace snapshot', namespace);
    return {
        invoke: resolvedInvoke,
        listen: namespace?.event?.listen || namespace?.tauri?.listen || null,
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

// Initialize application
document.addEventListener('DOMContentLoaded', async () => {
    initializeEventListeners();
    albumArt.src = DEFAULT_ALBUM_ART;

    try {
        const apis = await waitForTauriApis();
        invoke = apis.invoke;
        listen = apis.listen;

        console.debug('Tauri APIs resolved', { hasInvoke: !!invoke, hasListen: !!listen });

        if (!listen) {
            console.warn('Tauri listen API unavailable; realtime updates disabled.');
        }

        initializeTauriListeners();
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

function initializeTauriListeners() {
    if (!listen) {
        console.warn('Skipping Tauri event listener registration: listen API unavailable');
        return;
    }
    listen('player_state_updated', (event) => {
        if (event && event.payload) {
            updatePlayerState(event.payload);
        }
    });
}

async function connectToServer(serverUrl = DEFAULT_SERVER_URL) {
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }

    setConnectionStatus(`Connecting to ${serverUrl}…`, 'info');

    try {
        if (!invoke) {
            throw new Error('Tauri invoke API unavailable');
        }

        await invoke('connect_to_server', { serverUrl });

        isConnected = true;
        setConnectionStatus('Connected', 'success');
        hideConnectionStatusWithDelay();

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

function hideConnectionStatusWithDelay(delay = 1500) {
    if (!connectionStatus) return;
    setTimeout(() => {
        setConnectionStatus('');
    }, delay);
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
