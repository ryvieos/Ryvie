#!/usr/bin/env node

/**
 * Ryvie Apps Manifest Generator
 * Scanne les applications dans /data/apps/ et génère automatiquement les manifests dans /data/config/manifests/
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('🚀 Ryvie Apps Manifest Generator');
console.log('=================================\n');

// Configuration
const APPS_SOURCE_DIR = '/data/apps';
const MANIFESTS_DIR = '/data/config/manifests';
const GENERIC_ICON_PATH = path.join(__dirname, 'Ryvie-Front/src/icons/app-generic.svg');

/**
 * Scanne automatiquement tous les dossiers dans /data/apps/
 */
function scanAppsDirectories() {
  const apps = [];
  
  try {
    const entries = fs.readdirSync(APPS_SOURCE_DIR, { withFileTypes: true });
    
    entries.forEach(entry => {
      // Traiter tous les dossiers
      if (entry.isDirectory()) {
        const appDir = path.join(APPS_SOURCE_DIR, entry.name);
        
        // Si le dossier commence par "Ryvie-", enlever le préfixe
        let appId, appName;
        if (entry.name.startsWith('Ryvie-')) {
          appId = entry.name.replace('Ryvie-', '').toLowerCase();
          appName = entry.name.replace('Ryvie-', '');
        } else {
          appId = entry.name.toLowerCase();
          appName = entry.name;
        }
        
        // Chercher le docker-compose.yml
        const dockerComposePath = findDockerCompose(appDir);
        
        if (dockerComposePath) {
          console.log(`✅ App détectée: ${entry.name} -> ${appId}`);
          
          apps.push({
            dirName: entry.name,
            id: appId,
            name: appName,
            description: `Application ${appName}`,
            category: 'Productivity',
            developer: 'Ryvie Project',
            dockerComposePath: dockerComposePath,
            appDir: appDir,
            launchType: detectLaunchType(appId, dockerComposePath)
          });
        } else {
          console.log(`⚠️  Aucun docker-compose trouvé pour ${entry.name}`);
        }
      }
    });
  } catch (error) {
    console.error('Erreur lors du scan des apps:', error);
  }
  
  return apps;
}

/**
 * Cherche le docker-compose.yml récursivement dans un dossier d'app
 */
function findDockerCompose(appDir) {
  const foundPath = searchDockerComposeRecursive(appDir, appDir, 0, 5);
  return foundPath;
}

/**
 * Recherche récursive du docker-compose.yml
 */
function searchDockerComposeRecursive(baseDir, currentDir, depth, maxDepth) {
  if (depth >= maxDepth) return null;
  
  try {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    
    // D'abord chercher docker-compose.yml dans le dossier actuel
    for (const entry of entries) {
      if (entry.isFile() && entry.name === 'docker-compose.yml') {
        const fullPath = path.join(currentDir, entry.name);
        const relativePath = path.relative(baseDir, fullPath);
        console.log(`   ✅ docker-compose.yml trouvé: ${relativePath}`);
        return relativePath;
      }
    }
    
    // Puis chercher dans les sous-dossiers
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        const found = searchDockerComposeRecursive(baseDir, path.join(currentDir, entry.name), depth + 1, maxDepth);
        if (found) return found;
      }
    }
  } catch (error) {
    // Ignorer les erreurs de permission
  }
  
  return null;
}

/**
 * Détecte le type de lancement (docker-compose standard pour toutes les apps)
 */
function detectLaunchType(appId, dockerComposePath) {
  return 'docker-compose';
}

/**
 * Tente de lire le port depuis un fichier ryvie-app.yml (ou .yaml)
 * Priorité: dossier du docker-compose -> racine de l'app
 */
function getRyvieAppPort(appDir, dockerComposeRelativePath) {
  try {
    const composeDir = dockerComposeRelativePath
      ? path.dirname(path.join(appDir, dockerComposeRelativePath))
      : appDir;
    const candidates = [
      path.join(composeDir, 'ryvie-app.yml'),
      path.join(composeDir, 'ryvie-app.yaml'),
      path.join(appDir, 'ryvie-app.yml'),
      path.join(appDir, 'ryvie-app.yaml'),
    ];

    for (const file of candidates) {
      if (fs.existsSync(file)) {
        try {
          const content = fs.readFileSync(file, 'utf8');
          // Extraction simple du champ top-level `port:` (nombre ou string)
          const match = content.match(/^\s*port\s*:\s*["']?(\d{1,5})["']?/mi);
          if (match) {
            const p = parseInt(match[1], 10);
            if (!Number.isNaN(p)) return p;
          }
        } catch (_) {
          // ignorer et essayer le prochain candidat
        }
      }
    }
  } catch (_) {
    // silencieux pour ne pas polluer les logs
  }
  return null;
}

/**
 * Extrait des métadonnées (id, name, port) depuis ryvie-app.yml si présent
 */
function getRyvieAppMeta(appDir, dockerComposeRelativePath) {
  const meta = { id: null, name: null, port: null };
  try {
    const composeDir = dockerComposeRelativePath
      ? path.dirname(path.join(appDir, dockerComposeRelativePath))
      : appDir;
    const candidates = [
      path.join(composeDir, 'ryvie-app.yml'),
      path.join(composeDir, 'ryvie-app.yaml'),
      path.join(appDir, 'ryvie-app.yml'),
      path.join(appDir, 'ryvie-app.yaml'),
    ];

    for (const file of candidates) {
      if (fs.existsSync(file)) {
        try {
          const content = fs.readFileSync(file, 'utf8');
          const idMatch = content.match(/^\s*id\s*:\s*["']?([A-Za-z0-9-_\.]+)["']?/mi);
          if (idMatch) meta.id = idMatch[1].trim().toLowerCase();
          const nameMatch = content.match(/^\s*name\s*:\s*["']?([^"'\n]+)["']?/mi);
          if (nameMatch) meta.name = nameMatch[1].trim();
          const portMatch = content.match(/^\s*port\s*:\s*["']?(\d{1,5})["']?/mi);
          if (portMatch) meta.port = parseInt(portMatch[1], 10);
          // Dès qu'on a lu un fichier, on peut retourner (le plus proche du compose est prioritaire)
          return meta;
        } catch (_) {
          // passer au candidat suivant
        }
      }
    }
  } catch (_) {
    // silencieux
  }
  return meta;
}

/**
 * Trouve l'icône d'une app (recherche récursive)
 */
function findAppIcon(appDir, metadata) {
  // Si un chemin d'icône est spécifié dans les métadonnées
  if (metadata.iconPath) {
    const iconPath = path.join(appDir, metadata.iconPath);
    if (fs.existsSync(iconPath)) {
      return iconPath;
    }
  }

  const possibleIcons = ['icon.svg', 'icon.png', 'icon.jpg', 'icon.jpeg'];
  
  // 1. Chercher à la racine
  for (const iconName of possibleIcons) {
    const iconPath = path.join(appDir, iconName);
    if (fs.existsSync(iconPath)) {
      console.log(`   ✅ Icône trouvée: ${iconName}`);
      return iconPath;
    }
  }

  // 2. Chercher dans les sous-dossiers courants (docker/, tdrive/, snapdrop-master/, etc.)
  const commonSubdirs = [
    'docker',
    'tdrive',
    'snapdrop-master/snapdrop-master',
    path.dirname(metadata.dockerComposePath || '')
  ];
  
  for (const subdir of commonSubdirs) {
    if (!subdir) continue;
    const subdirPath = path.join(appDir, subdir);
    if (fs.existsSync(subdirPath)) {
      for (const iconName of possibleIcons) {
        const iconPath = path.join(subdirPath, iconName);
        if (fs.existsSync(iconPath)) {
          console.log(`   ✅ Icône trouvée: ${subdir}/${iconName}`);
          return iconPath;
        }
      }
    }
  }

  // 3. Recherche récursive (limitée à 3 niveaux de profondeur)
  const foundIcon = searchIconRecursive(appDir, possibleIcons, 0, 3);
  if (foundIcon) {
    console.log(`   ✅ Icône trouvée: ${path.relative(appDir, foundIcon)}`);
    return foundIcon;
  }

  // Utiliser l'icône générique
  console.log(`   ⚠️  Aucune icône trouvée, utilisation de l'icône générique`);
  return GENERIC_ICON_PATH;
}

/**
 * Recherche récursive d'icône
 */
function searchIconRecursive(dir, iconNames, currentDepth, maxDepth) {
  if (currentDepth >= maxDepth) return null;
  
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    // D'abord chercher les icônes dans le dossier actuel
    for (const entry of entries) {
      if (entry.isFile() && iconNames.includes(entry.name)) {
        return path.join(dir, entry.name);
      }
    }
    
    // Puis chercher dans les sous-dossiers
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        const found = searchIconRecursive(path.join(dir, entry.name), iconNames, currentDepth + 1, maxDepth);
        if (found) return found;
      }
    }
  } catch (error) {
    // Ignorer les erreurs de permission
  }
  
  return null;
}

/**
 * Analyse un docker-compose.yml pour extraire les ports
 */
function extractPortsFromCompose(composePath) {
  try {
    const composeContent = fs.readFileSync(composePath, 'utf8');
    const ports = {};
    
    // Regex simple pour extraire les ports (format "host:container")
    const portRegex = /- ["']?(\d+):(\d+)["']?/g;
    let match;
    
    while ((match = portRegex.exec(composeContent)) !== null) {
      const hostPort = match[1];
      const containerPort = match[2];
      ports[hostPort] = parseInt(containerPort);
    }
    
    // Support du format long YAML (ports: - target: <container> ... published: <host>)
    // On capture des blocs où target et published apparaissent, dans n'importe quel ordre
    // Exemple:
    // ports:\n  - target: 2283\n    published: 3013\n
    const longFormRegex1 = /target:\s*(\d+)[\s\S]*?published:\s*(\d+)/g;
    while ((match = longFormRegex1.exec(composeContent)) !== null) {
      const containerPort = match[1];
      const hostPort = match[2];
      if (!ports[hostPort]) {
        ports[hostPort] = parseInt(containerPort);
      }
    }
    // Cas inversé (published avant target)
    const longFormRegex2 = /published:\s*(\d+)[\s\S]*?target:\s*(\d+)/g;
    while ((match = longFormRegex2.exec(composeContent)) !== null) {
      const hostPort = match[1];
      const containerPort = match[2];
      if (!ports[hostPort]) {
        ports[hostPort] = parseInt(containerPort);
      }
    }
    
    return ports;
  } catch (error) {
    console.log(`   ⚠️  Impossible de lire ${composePath}: ${error.message}`);
    return {};
  }
}

/**
 * Génère le manifest pour une app
 */
function generateManifest(appData) {
  console.log(`\n📦 Génération du manifest pour ${appData.name}...`);
  
  const appDir = appData.appDir;
  const metadata = appData;
  const ryvieMeta = getRyvieAppMeta(appDir, metadata.dockerComposePath);
  const finalId = ryvieMeta.id || metadata.id;
  const finalName = ryvieMeta.name || metadata.name;
  
  // Trouver l'icône
  const iconPath = findAppIcon(appDir, metadata);
  const iconExt = path.extname(iconPath);
  
  // Chemin du docker-compose
  const composePath = path.join(appDir, metadata.dockerComposePath);
  
  // Extraire les ports si pas définis
  let ports = metadata.ports || {};
  if (Object.keys(ports).length === 0 && fs.existsSync(composePath)) {
    ports = extractPortsFromCompose(composePath);
  }
  
  // Créer le manifest
  const manifest = {
    id: finalId,
    name: finalName,
    version: '1.0.0',
    description: metadata.description,
    icon: `icon${iconExt}`,
    category: metadata.category,
    developer: metadata.developer,
    ports: ports,
    // mainPort doit refléter le port hôte (clé du mapping)
    mainPort: metadata.mainPort || (Object.keys(ports).length > 0 ? parseInt(Object.keys(ports)[0]) : null),
    launchType: metadata.launchType,
    dockerComposePath: metadata.dockerComposePath,
    sourceDir: appDir,
    autostart: false,
    installed: true,
    installedAt: new Date().toISOString()
  };
  
  // Créer le dossier de destination dans /data/config/manifests/
  const destDir = path.join(MANIFESTS_DIR, finalId);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  
  // Écrire le manifest
  const manifestPath = path.join(destDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`   ✅ Manifest créé: ${manifestPath}`);
  
  // Supprimer toutes les anciennes icônes (différentes extensions possibles)
  const oldIconExtensions = ['.svg', '.png', '.jpg', '.jpeg'];
  oldIconExtensions.forEach(ext => {
    const oldIconPath = path.join(destDir, `icon${ext}`);
    if (fs.existsSync(oldIconPath)) {
      fs.unlinkSync(oldIconPath);
      console.log(`   🗑️  Ancienne icône supprimée: icon${ext}`);
    }
  });
  
  // Copier la nouvelle icône
  const destIconPath = path.join(destDir, `icon${iconExt}`);
  fs.copyFileSync(iconPath, destIconPath);
  console.log(`   ✅ Icône copiée: ${destIconPath}`);
  
  return manifest;
}

/**
 * Crée une icône générique si elle n'existe pas
 */
function createGenericIcon() {
  const genericIconDir = path.dirname(GENERIC_ICON_PATH);
  if (!fs.existsSync(genericIconDir)) {
    fs.mkdirSync(genericIconDir, { recursive: true });
  }
  
  if (!fs.existsSync(GENERIC_ICON_PATH)) {
    // SVG simple pour l'icône générique
    const genericSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#4A90E2" rx="15"/>
  <text x="50" y="65" font-family="Arial" font-size="50" fill="white" text-anchor="middle">R</text>
</svg>`;
    fs.writeFileSync(GENERIC_ICON_PATH, genericSvg);
    console.log(`✅ Icône générique créée: ${GENERIC_ICON_PATH}`);
  }
}

/**
 * Fonction principale
 */
function main() {
  console.log(`📂 Scan du répertoire: ${APPS_SOURCE_DIR}`);
  console.log(`📁 Destination: ${MANIFESTS_DIR}\n`);
  
  // Créer l'icône générique
  createGenericIcon();
  
  // Créer le dossier de destination
  if (!fs.existsSync(MANIFESTS_DIR)) {
    fs.mkdirSync(MANIFESTS_DIR, { recursive: true });
    console.log(`✅ Dossier créé: ${MANIFESTS_DIR}\n`);
  }
  
  // Scanner automatiquement les apps
  console.log('🔍 Scan automatique de tous les dossiers dans /data/apps/...\n');
  const scannedApps = scanAppsDirectories();
  
  if (scannedApps.length === 0) {
    console.log('❌ Aucune app trouvée dans /data/apps/');
    console.log('💡 Assurez-vous que vos apps sont dans des dossiers avec un docker-compose.yml');
    return;
  }
  
  console.log(`\n✅ ${scannedApps.length} app(s) détectée(s)\n`);
  
  // Nettoyer les manifests orphelins (apps supprimées de /data/apps/)
  try {
    const existingManifests = fs.readdirSync(MANIFESTS_DIR, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
    
    const scannedIds = scannedApps.map(app => app.id);
    const orphans = existingManifests.filter(id => !scannedIds.includes(id));
    
    if (orphans.length > 0) {
      console.log(`🗑️  Nettoyage de ${orphans.length} manifest(s) orphelin(s):`);
      orphans.forEach(id => {
        const orphanPath = path.join(MANIFESTS_DIR, id);
        try {
          fs.rmSync(orphanPath, { recursive: true, force: true });
          console.log(`   ✅ Supprimé: ${id}`);
        } catch (e) {
          console.warn(`   ⚠️  Impossible de supprimer ${id}:`, e.message);
        }
      });
      console.log('');
    }
  } catch (e) {
    console.warn('⚠️  Erreur lors du nettoyage des manifests orphelins:', e.message);
  }
  
  // Générer les manifests
  const generatedManifests = [];
  
  for (const appData of scannedApps) {
    try {
      const manifest = generateManifest(appData);
      generatedManifests.push(manifest);
    } catch (error) {
      console.error(`❌ Erreur lors de la génération du manifest pour ${appData.name}:`, error.message);
    }
  }
  
  console.log('\n' + '='.repeat(50));
  console.log(`✅ ${generatedManifests.length} manifests générés avec succès`);
  console.log('='.repeat(50));
  
  console.log('\n📋 Résumé des apps:');
  const appPorts = {};
  const allPorts = {};
  generatedManifests.forEach(manifest => {
    const ryviePort = getRyvieAppPort(manifest.sourceDir, manifest.dockerComposePath);
    const displayPort = ryviePort || manifest.mainPort || 'N/A';
    console.log(`   • ${manifest.name} (${manifest.id}) - Port: ${displayPort}`);
    if (ryviePort || manifest.mainPort) {
      appPorts[manifest.id] = ryviePort || manifest.mainPort;
    }
    if (manifest.ports && Object.keys(manifest.ports).length > 0) {
      allPorts[manifest.id] = manifest.ports;
    }
  });

  // Écrire le mapping des ports pour le frontend
  try {
    const frontendPortsPath = path.join(__dirname, 'Ryvie-Front/src/config/app-ports.json');
    const dir = path.dirname(frontendPortsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(frontendPortsPath, JSON.stringify(appPorts, null, 2));
    console.log(`\n📝 Ports des apps écrits pour le frontend: ${frontendPortsPath}`);
  } catch (e) {
    console.log(`\n⚠️  Impossible d'écrire app-ports.json pour le frontend: ${e.message}`);
  }

  // Écrire tous les ports détaillés pour le frontend
  try {
    const allPortsPath = path.join(__dirname, 'Ryvie-Front/src/config/all-ports.json');
    const dir = path.dirname(allPortsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(allPortsPath, JSON.stringify(allPorts, null, 2));
    console.log(`📝 Ports détaillés écrits pour le frontend: ${allPortsPath}`);
  } catch (e) {
    console.log(`⚠️  Impossible d'écrire all-ports.json pour le frontend: ${e.message}`);
  }
  
  console.log('\n🎉 Génération terminée !');
  console.log(`\n💡 Prochaines étapes:`);
  console.log(`   1. Vérifiez les manifests dans ${MANIFESTS_DIR}`);
  console.log(`   2. Redémarrez le backend Ryvie`);
  console.log(`   3. Les apps apparaîtront automatiquement dans l'interface\n`);
}

// Exécution
if (require.main === module) {
  main();
}

module.exports = { generateManifest, findAppIcon };
