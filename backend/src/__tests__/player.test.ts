/// <reference types="jest" />
import { Player } from '../discord/player';
import { Client } from 'discord.js';
import { prisma } from '../db';

jest.mock('../db', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
    },
    cache: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    request: {
      create: jest.fn(),
      update: jest.fn(),
    },
  },
}));

describe('Player', () => {
  let player: Player;
  let mockClient: Client;

  beforeEach(() => {
    mockClient = new Client({ intents: [] });
    player = new Player(mockClient);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('play', () => {
    it('should add track to queue when user has not reached limit', async () => {
      const mockUser = {
        id: 'user-1',
        username: 'Test User',
        avatar: 'avatar-url',
      };

      const mockTrackInfo = {
        youtubeId: 'video-1',
        title: 'Test Song',
        artist: 'Test Artist',
        thumbnail: 'thumbnail-url',
        duration: 180,
        filePath: '/path/to/audio',
      };

      (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
      (prisma.cache.findUnique as jest.Mock).mockResolvedValue(mockTrackInfo);

      const mockVoiceState = {
        channel: {
          id: 'channel-1',
          guild: { id: 'guild-1', voiceAdapterCreator: {} },
        },
      };

      const result = await player.play(mockVoiceState as any, 'video-1', 'user-1');

      expect(result).toMatchObject({
        id: 'video-1',
        title: 'Test Song',
        artist: 'Test Artist',
      });
      expect(prisma.request.create).toHaveBeenCalled();
    });

    it('should throw error when user reaches queue limit', async () => {
      const mockUser = {
        id: 'user-1',
        username: 'Test User',
      };

      (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

      // Add mock tracks to queue to reach limit
      for (let i = 0; i < 3; i++) {
        player['queue'].push({
          id: `track-${i}`,
          youtubeId: `video-${i}`,
          title: `Test Song ${i}`,
          duration: 180,
          thumbnail: 'thumb-url',
          requestedBy: mockUser,
        });
      }

      const mockVoiceState = {
        channel: {
          id: 'channel-1',
          guild: { id: 'guild-1', voiceAdapterCreator: {} },
        },
      };

      await expect(
        player.play(mockVoiceState as any, 'video-new', 'user-1')
      ).rejects.toThrow('Queue limit reached');
    });
  });

  describe('skip', () => {
    it('should skip current track and play next in queue', async () => {
      const mockTrack = {
        id: 'track-1',
        title: 'Test Song',
      };
      player['currentTrack'] = mockTrack as any;

      await player.skip();

      expect(prisma.request.update).toHaveBeenCalledWith({
        where: { id: 'track-1' },
        data: { status: 'skipped' },
      });
    });
  });

  describe('stop', () => {
    it('should clear queue and stop playback', async () => {
      player['queue'] = [{ id: 'track-1' } as any];
      player['currentTrack'] = { id: 'track-2' } as any;

      await player.stop();

      expect(player['queue']).toHaveLength(0);
      expect(player['currentTrack']).toBeUndefined();
    });
  });
}); 