const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

const client = createClient({ url: REDIS_URL });

client.on('error', (err) => {
  console.warn('[redis] client error:', err?.message || err);
});

async function ensureConnected() {
  if (!client.isOpen) {
    await client.connect();
    console.log('[redis] connected');
  }
  return client;
}

module.exports = { client, ensureConnected };
