const path = require('path');
const ReactRefreshWebpackPlugin = require('@pmmmwh/react-refresh-webpack-plugin');

module.exports = {
  mode: 'development',
  entry: './src/index.js',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'bundle.js',
  },
  module: {
    rules: [
      // Règle pour les fichiers JavaScript
      {
        test: /\.(js|jsx)$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            plugins: [require.resolve('react-refresh/babel')], // Ajout de React Refresh
          },
        },
      },
      // Règle pour les fichiers CSS Modules
      {
        test: /\.module\.css$/, // Seuls les fichiers *.module.css seront traités comme CSS Modules
        use: [
          'style-loader',
          {
            loader: 'css-loader',
            options: {
              modules: {
                localIdentName: '[name]__[local]___[hash:base64:5]', // Génère des classes uniques
              },
            },
          },
        ],
      },
      // Règle pour les fichiers CSS globaux (optionnel)
      {
        test: /\.css$/,
        exclude: /\.module\.css$/, // Exclut les fichiers *.module.css
        use: ['style-loader', 'css-loader'], // Gère les fichiers CSS globaux
      },
      // Règle pour les fichiers images
      {
        test: /\.(png|jpg|jpeg|gif|svg)$/i,
        type: 'asset/resource',
      },
    ],
  },
  resolve: {
    extensions: ['.js', '.jsx'],
  },
  // ✅ Empêcher la recompilation en boucle des fichiers JSON modifiés par le backend
  watchOptions: {
    ignored: [
      '**/node_modules/**',
      '**/src/config/app-ports.json',
      '**/src/config/netbird-data.json',
    ],
    aggregateTimeout: 600,
    poll: false,
  },
  devServer: {
    static: path.join(__dirname, 'dist'),
    hot: true,
    compress: true,
    port: 3000,
  
    // ✅ indispensable derrière un reverse proxy
    host: '0.0.0.0',
    allowedHosts: 'all', // ou: 'all' en dev
  
    // SPA (si tu fais du routing côté client)
    historyApiFallback: true,
  
    // ✅ HMR via proxy HTTPS (activé seulement si PUBLIC_HMR=1)
    client: process.env.PUBLIC_HMR === '1'
      ? {
          webSocketURL: {
            protocol: 'wss',
            hostname: 'demo.ryvie.fr', // à adapter à ton domaine public
            port: 443,
          },
        }
      : undefined,
  },  
  plugins: [
    new ReactRefreshWebpackPlugin(), // Ajout de React Refresh Plugin
  ],
};
