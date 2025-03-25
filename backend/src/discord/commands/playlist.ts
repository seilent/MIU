import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { prisma } from '../../db';
import { getYoutubeId, getYoutubeInfo, getPlaylistItems, downloadYoutubeAudio } from '../../utils/youtube';
import type { Prisma } from '@prisma/client';

// Get API base URL from environment
const API_BASE_URL = process.env.API_URL || 'http://localhost:3000';

type DefaultPlaylistTrack = Prisma.DefaultPlaylistTrackGetPayload<{}>;

export const data = new SlashCommandBuilder()
  .setName('playlist')
  .setDescription('Manage default playlists for autoplay')
  .setDefaultMemberPermissions('0') // Restrict to administrators
  .addSubcommand(subcommand =>
    subcommand
      .setName('list')
      .setDescription('List all playlists')
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('create')
      .setDescription('Create a new default playlist')
      .addStringOption(option =>
        option
          .setName('name')
          .setDescription('Name of the playlist')
          .setRequired(true)
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('delete')
      .setDescription('Delete a default playlist')
      .addStringOption(option =>
        option
          .setName('name')
          .setDescription('Name of the playlist to delete')
          .setRequired(true)
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('add')
      .setDescription('Add tracks to a playlist (supports single track or YouTube playlist)')
      .addStringOption(option =>
        option
          .setName('name')
          .setDescription('Name of the playlist')
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName('url')
          .setDescription('YouTube URL (video or playlist) or search query')
          .setRequired(true)
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('remove')
      .setDescription('Remove a track from a default playlist')
      .addStringOption(option =>
        option
          .setName('playlist')
          .setDescription('Name of the playlist')
          .setRequired(true)
      )
      .addIntegerOption(option =>
        option
          .setName('position')
          .setDescription('Position of the track to remove')
          .setRequired(true)
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('toggle')
      .setDescription('Toggle playlist active status')
      .addStringOption(option =>
        option
          .setName('name')
          .setDescription('Name of the playlist to toggle')
          .setRequired(true)
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('songs')
      .setDescription('List all songs in a playlist')
      .addStringOption(option =>
        option
          .setName('name')
          .setDescription('Name of the playlist')
          .setRequired(true)
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('mode')
      .setDescription('Toggle playlist mode between Linear and Pool')
      .addStringOption(option =>
        option
          .setName('name')
          .setDescription('Name of the playlist')
          .setRequired(true)
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand();

  try {
    switch (subcommand) {
      case 'list':
        await listPlaylists(interaction);
        break;
      case 'create':
        await handleCreate(interaction);
        break;
      case 'delete':
        await handleDelete(interaction);
        break;
      case 'add':
        await handleAdd(interaction);
        break;
      case 'remove':
        await handleRemove(interaction);
        break;
      case 'toggle':
        await togglePlaylist(interaction);
        break;
      case 'songs':
        await listSongs(interaction);
        break;
      case 'mode':
        await toggleMode(interaction);
        break;
    }
  } catch (error) {
    console.error(`Error executing playlist command (${subcommand}):`, error);
    await interaction.reply({ 
      content: 'An error occurred while executing the command.',
      ephemeral: true 
    });
  }
}

async function listPlaylists(interaction: ChatInputCommandInteraction) {
  const playlists = await prisma.defaultPlaylist.findMany({
    orderBy: { name: 'asc' }
  });

  if (playlists.length === 0) {
    await interaction.reply('No playlists found.');
    return;
  }

  const playlistInfo = playlists.map(playlist => {
    const status = playlist.active ? '🟢 Active' : '⚫ Inactive';
    const mode = playlist.mode === 'LINEAR' ? '📝 Linear' : '🔄 Pool';
    return `${status} | ${mode} | ${playlist.name}`;
  }).join('\n');

  await interaction.reply({
    embeds: [{
      title: '📋 Playlists',
      description: playlistInfo,
      footer: {
        text: `Total playlists: ${playlists.length}`
      }
    }]
  });
}

async function togglePlaylist(interaction: ChatInputCommandInteraction) {
  const playlistName = interaction.options.getString('name', true);

  const playlist = await prisma.defaultPlaylist.findUnique({
    where: { name: playlistName }
  });

  if (!playlist) {
    await interaction.reply({
      content: `Playlist "${playlistName}" not found.`,
      ephemeral: true
    });
    return;
  }

  // If we're activating this playlist, deactivate all others first
  if (!playlist.active) {
    await prisma.defaultPlaylist.updateMany({
      where: { NOT: { id: playlist.id } },
      data: { active: false }
    });
    // Reset the played tracks in the player when activating a new playlist
    interaction.client.player.resetAutoplayTracking();
    // Set this as the current playlist in the player
    await interaction.client.player.setCurrentPlaylist(playlist.id);
  } else {
    // If we're deactivating the playlist, clear it from the player
    await interaction.client.player.setCurrentPlaylist(undefined);
  }

  const updatedPlaylist = await prisma.defaultPlaylist.update({
    where: { id: playlist.id },
    data: { active: !playlist.active }
  });

  const status = updatedPlaylist.active ? 'activated' : 'deactivated';
  await interaction.reply({
    content: `Playlist "${playlistName}" has been ${status}.`,
    ephemeral: true
  });
}

async function handleCreate(interaction: ChatInputCommandInteraction) {
  const name = interaction.options.getString('name', true);

  const playlist = await prisma.defaultPlaylist.create({
    data: { name }
  });

  await interaction.reply(`Created new playlist: ${playlist.name}`);
}

async function handleDelete(interaction: ChatInputCommandInteraction) {
  const name = interaction.options.getString('name', true);

  const playlist = await prisma.defaultPlaylist.findFirst({
    where: { name },
    include: { tracks: true }
  });

  if (!playlist) {
    await interaction.reply(`Playlist "${name}" not found.`);
    return;
  }

  // Delete all tracks first (due to foreign key constraint)
  await prisma.defaultPlaylistTrack.deleteMany({
    where: { playlistId: playlist.id }
  });

  // Then delete the playlist
  await prisma.defaultPlaylist.delete({
    where: { id: playlist.id }
  });

  await interaction.reply({
    embeds: [{
      title: 'Playlist Deleted',
      description: `Successfully deleted playlist "${name}" with ${playlist.tracks.length} tracks.`,
      color: 0xFF0000 // Red color
    }]
  });
}

async function handleAdd(interaction: ChatInputCommandInteraction) {
  try {
    const playlistName = interaction.options.getString('name', true);
    const url = interaction.options.getString('url', true);
    
    // Get playlist from database
    const playlist = await prisma.defaultPlaylist.findUnique({
      where: { name: playlistName }
    });

    if (!playlist) {
      await interaction.reply({ content: `Playlist "${playlistName}" not found.`, ephemeral: true });
      return;
    }

    // Get video IDs from playlist URL
    const videoIds = await getPlaylistItems(url);
    if (!videoIds.length) {
      await interaction.reply({ content: 'No videos found in the playlist.', ephemeral: true });
      return;
    }

    await interaction.reply({ content: `Adding ${videoIds.length} tracks to playlist "${playlistName}"...` });

    let addedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    // Get the current highest position
    const lastTrack = await prisma.defaultPlaylistTrack.findFirst({
      where: { playlistId: playlist.id },
      orderBy: { position: 'desc' }
    });
    let nextPosition = (lastTrack?.position ?? 0) + 1;

    // Check if it's a YouTube Music URL
    const isMusicUrl = url.includes('music.youtube.com');

    // Process videos in batches of 5
    for (let i = 0; i < videoIds.length; i += 5) {
      const batch = videoIds.slice(i, i + 5);
      
      // Process each video in the batch
      await Promise.all(batch.map(async (videoId) => {
        try {
          if (!videoId) {
            skippedCount++;
            return;
          }

          // Check if track already exists in database
          const existingTrack = await prisma.track.findUnique({
            where: { youtubeId: videoId }
          });

          if (existingTrack) {
            // Add to playlist if not already in it
            const existingPlaylistTrack = await prisma.defaultPlaylistTrack.findFirst({
              where: {
                playlistId: playlist.id,
                trackId: existingTrack.youtubeId
              }
            });

            if (!existingPlaylistTrack) {
              await prisma.defaultPlaylistTrack.create({
                data: {
                  position: nextPosition++,
                  playlist: {
                    connect: { id: playlist.id }
                  },
                  track: {
                    connect: { youtubeId: existingTrack.youtubeId }
                  }
                }
              });
              addedCount++;
            } else {
              skippedCount++;
            }
          } else {
            // Create minimal track entry - queue will handle fetching details
            await prisma.track.upsert({
              where: { youtubeId: videoId },
              create: {
                youtubeId: videoId,
                title: videoId, // Temporary title, will be updated by queue
                duration: 0, // Will be updated by queue
                isMusicUrl: isMusicUrl // Set flag for YouTube Music URLs
              },
              update: {} // No update needed
            });

            // Add to playlist
            await prisma.defaultPlaylistTrack.create({
              data: {
                position: nextPosition++,
                playlist: {
                  connect: { id: playlist.id }
                },
                track: {
                  connect: { youtubeId: videoId }
                }
              }
            });
            addedCount++;
          }
        } catch (error) {
          console.error(`Error processing video ${videoId}:`, error);
          errorCount++;
        }
      }));

      // Update progress every 5 tracks
      if ((i + 5) % 25 === 0 || i + 5 >= videoIds.length) {
        const progress = Math.min(100, Math.round(((i + 5) / videoIds.length) * 100));
        await interaction.editReply({
          content: `Progress: ${progress}%\nAdded: ${addedCount}\nSkipped: ${skippedCount}\nErrors: ${errorCount}`
        });
      }
    }

    await interaction.editReply({
      content: `Finished adding tracks to playlist "${playlistName}".\nAdded: ${addedCount}\nSkipped: ${skippedCount}\nErrors: ${errorCount}${isMusicUrl ? '\nNote: YouTube Music tracks will be resolved when played.' : ''}`
    });
  } catch (error) {
    console.error('Error in handleAdd:', error);
    const message = error instanceof Error ? error.message : 'An unknown error occurred';
    await interaction.editReply({ content: `Error: ${message}` });
  }
}

async function handleRemove(interaction: ChatInputCommandInteraction) {
  const playlistName = interaction.options.getString('playlist', true);
  const position = interaction.options.getInteger('position', true);

  const playlist = await prisma.defaultPlaylist.findFirst({
    where: { name: playlistName }
  });

  if (!playlist) {
    await interaction.reply(`Playlist "${playlistName}" not found.`);
    return;
  }

  const track = await prisma.defaultPlaylistTrack.findFirst({
    where: { 
      playlistId: playlist.id,
      position 
    },
    include: {
      track: true
    }
  });

  if (!track) {
    await interaction.reply(`No track found at position ${position}.`);
    return;
  }

  // Delete the track
  await prisma.defaultPlaylistTrack.delete({
    where: { id: track.id }
  });

  // Reorder remaining tracks
  await prisma.defaultPlaylistTrack.updateMany({
    where: {
      playlistId: playlist.id,
      position: { gt: position }
    },
    data: {
      position: { decrement: 1 }
    }
  });

  await interaction.reply(`Removed "${track.track.title}" from position ${position}.`);
}

async function listSongs(interaction: ChatInputCommandInteraction) {
  try {
    const playlist = await prisma.defaultPlaylist.findFirst({
      where: { active: true },
      include: {
        tracks: {
          include: {
            track: true
          },
          orderBy: {
            position: 'asc'
          }
        }
      }
    });

    if (!playlist) {
      await interaction.reply({
        content: 'No active playlist found.',
        ephemeral: true
      });
      return;
    }

    // Get downloaded tracks
    const downloadedTracks = await prisma.audioCache.findMany({
      where: {
        youtubeId: {
          in: playlist.tracks.map(t => t.track.youtubeId)
        }
      },
      include: {
        track: true
      }
    });

    const downloadedIds = new Set(downloadedTracks.map(t => t.youtubeId));
    const totalTracks = playlist.tracks.length;
    const downloadedCount = downloadedTracks.length;

    let description = `**${playlist.name}** (Mode: ${playlist.mode})\n`;
    description += `Downloaded: ${downloadedCount}/${totalTracks} tracks\n\n`;
    description += `**Downloaded Tracks:**\n`;

    // Only list downloaded tracks
    const trackList = playlist.tracks
      .filter(pt => downloadedIds.has(pt.track.youtubeId))
      .map((pt, i) => `${i + 1}. ${pt.track.title} (${Math.floor(pt.track.duration / 60)}:${String(pt.track.duration % 60).padStart(2, '0')})`);

    if (trackList.length > 0) {
      description += trackList.join('\n');
    } else {
      description += 'No tracks downloaded yet. They will be downloaded as needed.';
    }

    const embed = new EmbedBuilder()
      .setTitle('Playlist Songs')
      .setDescription(description)
      .setColor('#0099ff');

    await interaction.reply({
      embeds: [embed],
      ephemeral: true
    });
  } catch (error) {
    console.error('Error listing songs:', error);
    await interaction.reply({
      content: 'Failed to list songs.',
      ephemeral: true
    });
  }
}

async function toggleMode(interaction: ChatInputCommandInteraction) {
  const playlistName = interaction.options.getString('name', true);

  const playlist = await prisma.defaultPlaylist.findFirst({
    where: { name: playlistName }
  });

  if (!playlist) {
    await interaction.reply({
      content: `Playlist "${playlistName}" not found.`,
      ephemeral: true
    });
    return;
  }

  // Toggle between LINEAR and POOL
  const newMode = playlist.mode === 'LINEAR' ? 'POOL' : 'LINEAR';

  await prisma.defaultPlaylist.update({
    where: { id: playlist.id },
    data: { mode: newMode }
  });

  await interaction.reply({
    embeds: [{
      title: '🔄 Playlist Mode Updated',
      description: `Switched "${playlistName}" to ${newMode === 'LINEAR' ? '📝 Linear' : '🔄 Pool'} mode`,
      fields: [
        {
          name: newMode === 'LINEAR' ? '📝 Linear Mode' : '🔄 Pool Mode',
          value: newMode === 'LINEAR' 
            ? 'Plays tracks in sequence, following the playlist order'
            : 'Randomly selects tracks with weighted preferences'
        }
      ],
      color: 0x00FF00
    }]
  });
} 