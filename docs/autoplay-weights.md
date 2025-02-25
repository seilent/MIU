# Autoplay Weight Configuration for POOL Mode

In POOL mode, the system uses a weighted selection algorithm to choose the next track to play. The weights are distributed across different sources of tracks as follows:

## Weight Distribution

1. **Playlist Tracks: 25%**
   - Tracks from the active playlist
   - Weight calculation: `25 / availablePlaylistTracks.length`
   - Source identifier: 'Pool: Playlist'

2. **User Favorites: 25%**
   - Tracks based on user listening history and preferences
   - Weight calculation: `(25 / allFavorites.length) * (1 - index * 0.05)`
   - Includes decay factor of 0.05 per index position
   - Source identifier: 'Pool: History'

3. **Popular Tracks: 20%**
   - Tracks with high play counts from the database
   - Weight calculation: `(20 / popularTrackDetails.length) * (1 + Math.log(playCount))`
   - Includes logarithmic boost based on play count
   - Source identifier: 'Pool: Popular'

4. **YouTube Recommendations: 20%**
   - Tracks recommended by YouTube's algorithm
   - Weight calculation: `20 / youtubeRecommendations.length`
   - Source identifier: 'Pool: YouTube Mix'

5. **Random Tracks: 10%**
   - Random tracks from the database with non-negative scores
   - Weight calculation: `10 / randomTracks.length`
   - Source identifier: 'Pool: Random'

## Selection Process

The track selection process follows these steps:

1. Filter out duplicate tracks (tracks that have been played recently)
2. Calculate the total weight of all remaining tracks
3. Generate a random number between 0 and the total weight
4. Iterate through the tracks, subtracting each track's weight from the random number
5. Select the track when the random number becomes less than or equal to zero

## Additional Features

- **Duplicate Prevention**: Tracks are checked against recently played tracks to prevent repetition
- **Score Requirements**: Random tracks must have non-negative global scores to be eligible
- **Dynamic Pool**: The selection pool is refreshed when running low on tracks
- **Automatic Prefetching**: Audio is prefetched for upcoming tracks to ensure smooth playback

## Code Example

```javascript
// Calculate total weight
const totalWeight = filteredPool.reduce((sum, item) => sum + item.weight, 0);

// Random number between 0 and total weight
let random = Math.random() * totalWeight;

// Select track based on weights
for (const item of filteredPool) {
  random -= item.weight;
  if (random <= 0) {
    selectedTrack = { track: item.track };
    sourceType = item.source;
    break;
  }
}
```

## Summary of Weights

| Source Type | Weight |
|------------|--------|
| Playlist Tracks | 25% |
| User Favorites | 25% |
| Popular Tracks | 20% |
| YouTube Recommendations | 20% |
| Random Tracks | 10% |

This weighted approach ensures a good mix of:
- Curated content (playlist tracks)
- Personal preferences (user favorites)
- Community favorites (popular tracks)
- Discovery (YouTube recommendations)
- Variety (random tracks) 