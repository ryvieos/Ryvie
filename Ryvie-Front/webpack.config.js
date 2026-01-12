const path = require('path');
const ReactRefreshWebpackPlugin = require('@pmmmwh/react-refresh-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const isDevelopment = process.env.NODE_ENV !== 'production';

module.exports = {
  mode: isDevelopment ? 'development' : 'production',
  entry: './src/index.tsx',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'bundle.js',
  },
  module: {
    rules: [
      // Règle pour les fichiers TypeScript et JavaScript
      {
        test: /\.(ts|tsx|js|jsx)$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            plugins: isDevelopment ? [require.resolve('react-refresh/babel')] : [], // React Refresh seulement en dev
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
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
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
    isDevelopment && new ReactRefreshWebpackPlugin(), // React Refresh seulement en dev
    new HtmlWebpackPlugin({
      template: './public/index.html', // Template HTML source
      filename: 'index.html', // Fichier de sortie
      inject: 'body', // Injecter les scripts dans le body
    }),
    new CopyWebpackPlugin({
      patterns: [
        {
          from: 'src/config/*.json',
          to: 'config/[name][ext]',
          noErrorOnMissing: true,
        },
      ],
    }),
  ].filter(Boolean), // Filtrer les plugins null/undefined
};
