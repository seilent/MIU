import { ChatInputCommandInteraction } from 'discord.js';
import { youtube, getKeyManager } from '../../utils/youtube';
import { prisma } from '../../db';

export async function yttest(interaction: ChatInputCommandInteraction) {
  try {
    await interaction.deferReply();

    // Get recent track from history
    const recentTrack = await prisma.request.findFirst({
      where: { 
        status: 'completed'
      },
      orderBy: { 
        playedAt: 'desc' 
      }
    });

    if (!recentTrack) {
      await interaction.editReply({
        embeds: [{
          title: '❌ No History Found',
          description: 'Play some tracks first to test recommendations',
          color: 0xFF0000
        }]
      });
      return;
    }

    try {
      // Test 1: Basic API Connection with history-based search
      const apiKey = await getKeyManager().getCurrentKey('search.list');
      const response = await youtube.search.list({
        key: apiKey,
        part: ['snippet'],
        q: `${recentTrack.title} ${recentTrack.artist || ''}`, // Use track info as seed
        type: ['video'],
        videoCategoryId: '10', // Music category
        maxResults: 3
      });

      const recommendations = response.data.items;
      
      if (recommendations && recommendations.length > 0) {
        const fields = [
          {
            name: 'Reference Track',
            value: `🎵 ${recentTrack.title}${recentTrack.artist ? ` by ${recentTrack.artist}` : ''}`
          },
          {
            name: 'API Connection',
            value: '✅ Successfully connected to YouTube API'
          },
          {
            name: 'Recommendations',
            value: recommendations.map((item, index) => 
              `${index + 1}. "${item.snippet?.title}"`
            ).join('\n')
          }
        ];

        await interaction.editReply({
          embeds: [{
            title: '✅ YouTube Recommendations Test',
            fields,
            color: 0x00FF00,
            footer: {
              text: 'These are the tracks that would be suggested by autoplay'
            }
          }]
        });
      } else {
        await interaction.editReply({
          embeds: [{
            title: '❌ YouTube API Test Results',
            description: 'API connected but no recommendations found',
            color: 0xFF0000
          }]
        });
      }
    } catch (error: any) {
      console.error('YouTube API test error:', error);
      
      let errorMessage = 'Unknown error occurred';
      if (error.response?.data?.error?.message) {
        errorMessage = error.response.data.error.message;
      } else if (error.message) {
        errorMessage = error.message;
      }

      await interaction.editReply({
        embeds: [{
          title: '❌ YouTube API Test Failed',
          fields: [
            {
              name: 'Error',
              value: errorMessage
            }
          ],
          color: 0xFF0000
        }]
      });
    }
  } catch (error) {
    console.error('Command execution error:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply('An error occurred while testing the YouTube API.');
    } else {
      await interaction.editReply('An error occurred while testing the YouTube API.');
    }
  }
} 