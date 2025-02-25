import client from 'prom-client';

// Create a Registry
const register = new client.Registry();

// Add default metrics
client.collectDefaultMetrics({ register });

// Custom metrics
const songsPlayedCounter = new client.Counter({
  name: 'miu_songs_played_total',
  help: 'Total number of songs played',
  labelNames: ['status'] // 'completed', 'skipped', 'error'
});

const queueLengthGauge = new client.Gauge({
  name: 'miu_queue_length',
  help: 'Current length of the song queue'
});

const activeListenersGauge = new client.Gauge({
  name: 'miu_active_listeners',
  help: 'Number of active listeners in voice channels'
});

const requestLatencyHistogram = new client.Histogram({
  name: 'miu_request_duration_seconds',
  help: 'Duration of song requests in seconds',
  buckets: [0.1, 0.5, 1, 2, 5]
});

const cacheHitRatio = new client.Gauge({
  name: 'miu_cache_hit_ratio',
  help: 'Ratio of cache hits to total requests'
});

// Audio streaming metrics
const audioStreamRequestsCounter = new client.Counter({
  name: 'miu_audio_stream_requests_total',
  help: 'Total number of audio streaming requests',
  labelNames: ['type'] // 'range', 'full'
});

const audioStreamBytesCounter = new client.Counter({
  name: 'miu_audio_stream_bytes_total',
  help: 'Total bytes streamed for audio',
  labelNames: ['type'] // 'range', 'full'
});

const audioStreamLatencyHistogram = new client.Histogram({
  name: 'miu_audio_stream_latency_seconds',
  help: 'Latency of audio streaming requests',
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5]
});

// Register custom metrics
register.registerMetric(songsPlayedCounter);
register.registerMetric(queueLengthGauge);
register.registerMetric(activeListenersGauge);
register.registerMetric(requestLatencyHistogram);
register.registerMetric(cacheHitRatio);
register.registerMetric(audioStreamRequestsCounter);
register.registerMetric(audioStreamBytesCounter);
register.registerMetric(audioStreamLatencyHistogram);

export {
  register,
  songsPlayedCounter,
  queueLengthGauge,
  activeListenersGauge,
  requestLatencyHistogram,
  cacheHitRatio,
  audioStreamRequestsCounter,
  audioStreamBytesCounter,
  audioStreamLatencyHistogram
};