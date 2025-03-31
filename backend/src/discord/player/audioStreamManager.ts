import { PassThrough } from 'stream';
import fs from 'fs';
import { PlayerStateManager } from './playerStateManager.js';
import { CacheManager } from './cacheManager.js';
import { QueueItem } from './types.js';

// Interface for a client stream entry
interface ClientStream {
    id: string; // Unique identifier for the stream/client
    stream: NodeJS.WritableStream;
    currentAudioStream?: fs.ReadStream; // The stream for the currently playing file
}

export class AudioStreamManager {
    private playerStateManager: PlayerStateManager;
    private cacheManager: CacheManager;
    private activeClientStreams: Map<string, ClientStream> = new Map();
    private currentTrackId: string | null = null;

    constructor(playerStateManager: PlayerStateManager, cacheManager: CacheManager) {
        this.playerStateManager = playerStateManager;
        this.cacheManager = cacheManager;

        // TODO: Listen for state changes from PlayerStateManager
        // This requires PlayerStateManager to emit events or provide a subscription mechanism.
        // For now, we'll rely on polling or direct calls in the main Player logic.
        console.log('[ASM] AudioStreamManager initialized.');
        // Example: this.playerStateManager.on('trackChange', (track) => this.handleTrackChange(track));
        // Example: this.playerStateManager.on('statusChange', (status) => this.handleStatusChange(status));

        // Temporary: Check state periodically until event system is implemented
        setInterval(() => this.checkStateAndStream(), 1000);
    }

     // Temporary method to poll state - Replace with event listeners later
     private async checkStateAndStream(): Promise<void> {
        const currentState = this.playerStateManager.getState();
        const newTrackId = currentState.currentTrack?.youtubeId ?? null;
        const isPlaying = currentState.status === 'playing';

        // If track changed or playback started
        if (newTrackId !== this.currentTrackId || (isPlaying && this.currentTrackId === null)) {
            console.log(`[ASM] State changed: Track ${this.currentTrackId} -> ${newTrackId}, Status: ${currentState.status}`);
            this.currentTrackId = newTrackId;
            await this.streamCurrentTrackToAllClients();
        } else if (!isPlaying && this.currentTrackId !== null) {
             // If playback stopped
             console.log('[ASM] Playback stopped. Stopping client streams.');
             this.currentTrackId = null;
             this.stopAllClientStreams();
        }
    }


    /**
     * Adds a new client stream to manage.
     * @param clientId A unique ID for the client connection.
     * @param outputStream The writable stream to send audio data to.
     */
    public addClientStream(clientId: string, outputStream: NodeJS.WritableStream): void {
        if (this.activeClientStreams.has(clientId)) {
            console.warn(`[ASM] Client stream with ID ${clientId} already exists. Overwriting.`);
            this.removeClientStream(clientId); // Clean up existing first
        }

        const clientStream: ClientStream = { id: clientId, stream: outputStream };
        this.activeClientStreams.set(clientId, clientStream);
        console.log(`[ASM] Added client stream: ${clientId}`);

        // If a track is currently playing, start streaming to the new client immediately
        const currentTrack = this.playerStateManager.getCurrentTrack();
        if (currentTrack && this.playerStateManager.getStatus() === 'playing') {
            console.log(`[ASM] Streaming current track ${currentTrack.title} to new client ${clientId}`);
            this.startStreamingToClient(clientStream, currentTrack);
        }

        // Handle stream closure or errors
        outputStream.on('close', () => {
            console.log(`[ASM] Client stream ${clientId} closed.`);
            this.removeClientStream(clientId);
        });
        outputStream.on('error', (error) => {
            console.error(`[ASM] Client stream ${clientId} error:`, error);
            this.removeClientStream(clientId);
        });
    }

    /**
     * Removes a client stream.
     * @param clientId The ID of the client stream to remove.
     */
    public removeClientStream(clientId: string): void {
        const clientStream = this.activeClientStreams.get(clientId);
        if (clientStream) {
            // Stop any ongoing audio stream piping to this client
            clientStream.currentAudioStream?.unpipe(clientStream.stream);
            clientStream.currentAudioStream?.destroy(); // Close the file read stream
            this.activeClientStreams.delete(clientId);
            console.log(`[ASM] Removed client stream: ${clientId}`);
        }
    }

    /** Stops streaming to all clients and removes them. */
    public removeAllClientStreams(): void {
        console.log('[ASM] Removing all client streams...');
        // Create a copy of keys to avoid issues while iterating and deleting
        const clientIds = Array.from(this.activeClientStreams.keys());
        clientIds.forEach(id => this.removeClientStream(id));
        console.log('[ASM] All client streams removed.');
    }

    /** Stops the current audio file stream for a specific client. */
    private stopStreamingForClient(clientStream: ClientStream): void {
        if (clientStream.currentAudioStream) {
            // console.log(`[ASM] Stopping stream for client ${clientStream.id}`); // Debug
            clientStream.currentAudioStream.unpipe(clientStream.stream);
            clientStream.currentAudioStream.destroy(); // Ensure file handle is released
            clientStream.currentAudioStream = undefined;
        }
    }

    /** Stops streaming the current track to all connected clients. */
    private stopAllClientStreams(): void {
        this.activeClientStreams.forEach(client => {
            this.stopStreamingForClient(client);
        });
         console.log('[ASM] Stopped streaming to all clients.');
    }


    /** Starts streaming the specified track's audio to a single client. */
    private async startStreamingToClient(clientStream: ClientStream, track: QueueItem): Promise<void> {
         // Stop any previous stream for this client first
         this.stopStreamingForClient(clientStream);

        if (!clientStream.stream.writable) {
            console.warn(`[ASM] Client stream ${clientStream.id} is not writable. Cannot start streaming.`);
            this.removeClientStream(clientStream.id); // Remove non-writable stream
            return;
        }

        try {
            const audioPath = await this.cacheManager.getAudioFilePath(track.youtubeId);
            if (!audioPath) {
                console.error(`[ASM] Audio file not found in cache for track ${track.youtubeId}. Cannot stream to ${clientStream.id}.`);
                 // Optionally trigger caching here?
                 // this.cacheManager.ensureAudioCached(track.youtubeId);
                return;
            }

            console.log(`[ASM] Starting stream of ${track.title} to client ${clientStream.id}`);
            const audioReadStream = fs.createReadStream(audioPath);
            clientStream.currentAudioStream = audioReadStream; // Store reference

            // Handle errors on the read stream
            audioReadStream.on('error', (error) => {
                console.error(`[ASM] Error reading audio file ${audioPath} for client ${clientStream.id}:`, error);
                this.stopStreamingForClient(clientStream);
                // Don't remove the client stream here, just stop the problematic file stream
            });

             // Handle the end of the audio file stream
             audioReadStream.on('end', () => {
                 // console.log(`[ASM] Finished streaming ${track.title} chunk to ${clientStream.id}`); // Debug
                 // Don't close the client's output stream (outputStream), just the file stream.
                 clientStream.currentAudioStream = undefined; // Clear reference
                 // The main logic should handle starting the *next* track stream when it changes.
             });

            // Pipe the audio file to the client's output stream.
            // IMPORTANT: Do NOT end the client's output stream when the file stream ends.
            audioReadStream.pipe(clientStream.stream, { end: false });

        } catch (error) {
            console.error(`[ASM] Failed to start streaming ${track.title} to client ${clientStream.id}:`, error);
             this.stopStreamingForClient(clientStream); // Clean up on error
        }
    }

    /** Streams the currently playing track to all connected clients. */
    private async streamCurrentTrackToAllClients(): Promise<void> {
        const currentTrack = this.playerStateManager.getCurrentTrack();
        const isPlaying = this.playerStateManager.getStatus() === 'playing';

        this.stopAllClientStreams(); // Stop any previous streams first

        if (currentTrack && isPlaying) {
            console.log(`[ASM] Starting stream for current track "${currentTrack.title}" to ${this.activeClientStreams.size} clients.`);
            // Use Promise.all to start streaming to all clients concurrently
            await Promise.all(
                Array.from(this.activeClientStreams.values()).map(clientStream =>
                    this.startStreamingToClient(clientStream, currentTrack)
                )
            );
        } else {
             console.log('[ASM] No track playing or playback stopped. Not streaming.');
        }
    }

    // --- Event Handlers (Placeholder - To be driven by events) ---

    // public handleTrackChange(newTrack: QueueItem | null): void {
    //     console.log(`[ASM] Handling track change event: ${newTrack?.title ?? 'None'}`);
    //     this.streamCurrentTrackToAllClients();
    // }

    // public handleStatusChange(newStatus: 'playing' | 'paused' | 'idle'): void {
    //      console.log(`[ASM] Handling status change event: ${newStatus}`);
    //      if (newStatus !== 'playing') {
    //          this.stopAllClientStreams();
    //      } else {
    //           // If status becomes 'playing', ensure streaming starts/resumes
    //           this.streamCurrentTrackToAllClients();
    //      }
    // }

    // --- Cleanup ---
    public destroy(): void {
        console.log('[ASM] Destroying AudioStreamManager...');
        if (this.checkStateAndStream) {
             clearInterval(this.checkStateAndStream as unknown as NodeJS.Timeout); // Clear polling interval
        }
        this.removeAllClientStreams(); // Ensure all streams are stopped and removed
        console.log('[ASM] AudioStreamManager destroyed.');
    }
}