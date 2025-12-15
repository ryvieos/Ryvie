module.exports = {
  apps: [
    // ========================================
    // MODE DÉVELOPPEMENT
    // ========================================
    {
      name: 'ryvie-backend-dev',
      script: 'npm',
      args: 'run dev',
      cwd: '/opt/Ryvie/Ryvie-Back',
      watch: false, // nodemon gère déjà le watch
      env: {
        NODE_ENV: 'development',
        PORT: 3002
      },
      error_file: '/data/logs/backend-dev-error.log',
      out_file: '/data/logs/backend-dev-out.log',
      time: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s'
    },
    {
      name: 'ryvie-frontend-dev',
      script: 'npm',
      args: 'run dev',
      cwd: '/opt/Ryvie/Ryvie-Front',
      watch: false, // webpack-dev-server gère déjà le watch
      env: {
        NODE_ENV: 'development',
        PORT: 3000
      },
      error_file: '/data/logs/frontend-dev-error.log',
      out_file: '/data/logs/frontend-dev-out.log',
      time: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s'
    },

    // ========================================
    // MODE PRODUCTION
    // ========================================
    {
      name: 'ryvie-backend-prod',
      script: 'dist/index.js',
      cwd: '/opt/Ryvie/Ryvie-Back',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 3002
      },
      error_file: '/data/logs/backend-prod-error.log',
      out_file: '/data/logs/backend-prod-out.log',
      time: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      // Optimisations production
      max_memory_restart: '500M',
      kill_timeout: 5000
    },
    {
      name: 'ryvie-frontend-prod',
      script: 'npm',
      args: 'run serve',
      cwd: '/opt/Ryvie/Ryvie-Front',
      watch: false,
      env: {
        NODE_ENV: 'production'
      },
      error_file: '/data/logs/frontend-prod-error.log',
      out_file: '/data/logs/frontend-prod-out.log',
      time: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s'
    }
  ]
};
