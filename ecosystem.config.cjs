// PM2 on a VPS: `npm ci && npm run build && pm2 start ecosystem.config.cjs`
module.exports = {
  apps: [
    {
      name: 'be-social-listening',
      script: 'dist/main.js',
      instances: 1, // ingestion runs in-process; keep one instance unless a queue is added
      env: { NODE_ENV: 'production' },
      max_memory_restart: '512M',
    },
  ],
};
