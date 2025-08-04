const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Récupérer la dernière IP connue
  requestInitialServerIP: () => ipcRenderer.invoke('request-initial-server-ip'),
  // Récupérer les conteneurs actifs
  requestActiveContainers: () => ipcRenderer.invoke('request-active-containers'),
  // Récupérer le statut du serveur
  requestServerStatus: () => ipcRenderer.invoke('request-server-status'),
  // Écouter les événements en temps réel
  onRyvieIP: (callback) => ipcRenderer.on('ryvie-ip', callback),
  onContainersUpdated: (callback) => ipcRenderer.on('containers-updated', callback),
  onServerStatus: (callback) => ipcRenderer.on('server-status', callback),
  // Recevoir l'ID utilisateur actuel
  onSetCurrentUser: (callback) => ipcRenderer.on('set-current-user', callback),
  // Recevoir le token d'authentification
  onSetAuthToken: (callback) => ipcRenderer.on('set-auth-token', callback),

  // Fonctions de gestion du dossier de téléchargement
  changeDownloadFolder: () => ipcRenderer.invoke('change-download-folder'),
  getDownloadFolder: () => ipcRenderer.invoke('get-download-folder'),

  // Mettre à jour le mode d'accès global
  updateAccessMode: (mode) => ipcRenderer.send('update-access-mode', mode),

  // Nouvelles fonctions pour la gestion des sessions utilisateur
  invoke: (channel, ...args) => {
    const validChannels = ['create-user-window', 'clear-user-session', 'create-user-window-with-mode', 'update-session-partition', 'close-current-window', 'redirect-to-login'];
    if (validChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, ...args);
    }
    throw new Error(`Channel "${channel}" is not allowed`);
  },
  
  // Fermer la fenêtre actuelle
  closeCurrentWindow: () => ipcRenderer.invoke('close-current-window'),
  
  // Rediriger vers la page de connexion
  redirectToLogin: () => ipcRenderer.invoke('redirect-to-login')
});

// Ce script sera chargé avant que la page soit rendue
window.addEventListener('DOMContentLoaded', () => {
  const replaceText = (selector, text) => {
    const element = document.getElementById(selector);
    if (element) element.innerText = text;
  }

  // Remplacer les versions dans la page par les versions des dépendances
  for (const type of ['chrome', 'node', 'electron']) {
    replaceText(`${type}-version`, process.versions[type]);
  }
});