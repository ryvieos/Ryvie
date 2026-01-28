# Système de Mise à Jour d'Applications avec SSE

## Problème Résolu

Les notifications de mise à jour d'applications disparaissaient et revenaient, contrairement aux notifications d'installation qui restaient persistantes.

## Solution Implémentée

### Backend

#### 1. Service de Mise à Jour (`/opt/Ryvie/Ryvie-Back/services/updateService.ts`)

**Ajouts:**
- `EventEmitter` pour émettre les événements de progression
- Fonction `sendUpdateProgress(appName, progress, message, stage)` pour envoyer les mises à jour
- Progression détaillée à chaque étape (0% → 100%)

**Étapes de progression:**
- 0-5%: Initialisation et snapshot
- 15-40%: Git fetch et pull
- 45-75%: Reconstruction Docker
- 80-85%: Vérification containers
- 95-100%: Finalisation

#### 2. Routes Settings (`/opt/Ryvie/Ryvie-Back/routes/settings.ts`)

**Nouveaux endpoints:**

```typescript
GET /api/settings/update-progress/:appName
```
- Server-Sent Events pour suivre la progression
- Heartbeat toutes les 5 secondes
- Fermeture automatique à 100% ou en cas d'erreur

```typescript
GET /api/settings/active-updates
```
- Liste des mises à jour en cours
- Utilisé pour restaurer l'état après rechargement de page

```typescript
POST /api/settings/update-app
```
- Lance la mise à jour dans un worker séparé (non-bloquant)
- Vérifie qu'aucune mise à jour n'est déjà en cours
- Répond immédiatement au client

#### 3. Worker de Mise à Jour (`/opt/Ryvie/Ryvie-Back/workers/updateWorker.js`)

- Processus séparé pour ne pas bloquer le serveur
- Écoute les événements de `updateProgressEmitter`
- Retransmet la progression au processus parent
- Gère les codes de sortie (0 = succès, autre = erreur)

### Frontend (À Implémenter dans Settings.tsx)

**Fonction handleUpdateApp à créer:**

```typescript
const handleUpdateApp = async (appName) => {
  try {
    // 1. Appel API pour démarrer la mise à jour
    const serverUrl = getServerUrl(accessMode);
    const response = await axios.post(`${serverUrl}/api/settings/update-app`, { appName });
    
    if (!response.data.success) {
      showToast(response.data.message || 'Erreur', 'error');
      return;
    }
    
    // 2. Marquer comme en cours
    setUpdateInProgress(appName);
    
    // 3. Attendre 500ms pour que le worker démarre
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // 4. Connexion SSE pour suivre la progression
    const progressUrl = `${serverUrl}/api/settings/update-progress/${appName}`;
    const eventSource = new EventSource(progressUrl);
    
    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      console.log(`[Settings] Progression ${appName}:`, data.progress, data.message);
      
      // Afficher la progression (à adapter selon votre UI)
      // Vous pouvez utiliser le même système que InstallIndicator
      
      if (data.progress >= 100 || data.stage === 'completed') {
        eventSource.close();
        setUpdateInProgress(null);
        showToast(`${appName} mis à jour avec succès !`, 'success');
        
        // Recharger les mises à jour disponibles
        checkForUpdates();
      }
      
      if (data.stage === 'error') {
        eventSource.close();
        setUpdateInProgress(null);
        showToast(`Erreur: ${data.message}`, 'error');
      }
    };
    
    eventSource.onerror = (error) => {
      console.error('[Settings] Erreur SSE:', error);
      eventSource.close();
      setUpdateInProgress(null);
      showToast('Erreur de connexion', 'error');
    };
    
  } catch (error) {
    console.error('[Settings] Erreur mise à jour:', error);
    setUpdateInProgress(null);
    showToast(error.response?.data?.message || 'Erreur', 'error');
  }
};
```

**Restauration après rechargement:**

```typescript
useEffect(() => {
  const checkOngoingUpdates = async () => {
    try {
      const serverUrl = getServerUrl(accessMode);
      const response = await axios.get(`${serverUrl}/api/settings/active-updates`);
      const activeUpdates = response.data.updates || [];
      
      // Reconnecter aux SSE pour chaque mise à jour en cours
      activeUpdates.forEach(appName => {
        setUpdateInProgress(appName);
        
        const progressUrl = `${serverUrl}/api/settings/update-progress/${appName}`;
        const eventSource = new EventSource(progressUrl);
        
        eventSource.onmessage = (event) => {
          const data = JSON.parse(event.data);
          // Gérer la progression...
        };
      });
    } catch (error) {
      console.error('[Settings] Erreur vérification mises à jour:', error);
    }
  };
  
  checkOngoingUpdates();
}, [accessMode]);
```

## Différences avec le Système d'Installation

### Similitudes
- Utilisation de SSE (Server-Sent Events)
- Worker séparé pour ne pas bloquer
- EventEmitter pour la progression
- Heartbeat pour maintenir la connexion
- Restauration après rechargement de page

### Différences
- **Installation**: `appId` (identifiant unique)
- **Mise à jour**: `appName` (nom de l'app dans /data/apps/)
- **Installation**: Route `/api/appstore/...`
- **Mise à jour**: Route `/api/settings/...`
- **Installation**: Peut utiliser `install.sh` pour nouvelles installations
- **Mise à jour**: Toujours `docker compose up -d --build` (ignore install.sh)

## Avantages de la Solution

1. **Persistance**: La notification reste affichée de 0% à 100%
2. **Asynchrone**: Ne bloque pas le serveur ni l'interface
3. **Temps réel**: Mises à jour instantanées via SSE
4. **Résilience**: Restauration automatique après rechargement
5. **Cohérence**: Même système que les installations

## Fichiers Modifiés

### Backend
- `/opt/Ryvie/Ryvie-Back/services/updateService.ts` - Ajout EventEmitter et progression
- `/opt/Ryvie/Ryvie-Back/routes/settings.ts` - Endpoints SSE et worker
- `/opt/Ryvie/Ryvie-Back/workers/updateWorker.js` - Nouveau fichier

### Frontend (À compléter)
- `/opt/Ryvie/Ryvie-Front/src/pages/Settings.tsx` - Fonction handleUpdateApp avec SSE
- `/opt/Ryvie/Ryvie-Front/src/pages/Home.tsx` - Déjà corrigé pour persistance

## Tests Recommandés

1. Lancer une mise à jour d'application
2. Vérifier que la notification reste affichée
3. Recharger la page pendant la mise à jour
4. Vérifier que la notification se restaure
5. Attendre la fin (100%)
6. Vérifier que la notification disparaît après 2-3 secondes

## Notes Importantes

- Les mises à jour n'utilisent **jamais** `install.sh` (uniquement `docker compose`)
- Les installations peuvent utiliser `install.sh` si présent
- Le système est compatible avec plusieurs mises à jour simultanées
- Timeout de sécurité: 30 minutes par mise à jour
