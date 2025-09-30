import React, { useState, useEffect, useRef } from 'react';
import '../styles/StorageSettings.css';
import { useNavigate } from 'react-router-dom';
import axios from '../utils/setupAxios';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { 
  faHdd, 
  faCheckCircle, 
  faExclamationTriangle, 
  faSpinner,
  faPlay,
  faCopy,
  faArrowLeft,
  faCheck
} from '@fortawesome/free-solid-svg-icons';
const { getServerUrl } = require('../config/urls');
import { getCurrentAccessMode } from '../utils/detectAccessMode';

const StorageSettings = () => {
  const navigate = useNavigate();
  const logsEndRef = useRef(null);

  // États pour les données
  const [loading, setLoading] = useState(true);
  const [disks, setDisks] = useState([]); // Seulement les disques, pas les partitions
  const [dataSource, setDataSource] = useState(null); // Info sur /data
  const [raidStatus, setRaidStatus] = useState(null); // État du RAID actuel
  const [raidDevices, setRaidDevices] = useState([]); // Liste des devices déjà dans le RAID
  
  // États pour la sélection
  const [sourceDevice, setSourceDevice] = useState('');
  const [targetDevices, setTargetDevices] = useState([]);
  const [targetLabels, setTargetLabels] = useState({});
  
  // États pour les options
  const [dryRun, setDryRun] = useState(false);
  const [raidLevel, setRaidLevel] = useState('raid1');
  
  // États pour les logs et l'exécution
  const [logs, setLogs] = useState([]);
  const [executionStatus, setExecutionStatus] = useState('idle'); // idle, running, success, error
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [commandsList, setCommandsList] = useState([]);
  
  // États pour les validations
  const [validationErrors, setValidationErrors] = useState([]);
  const [validationWarnings, setValidationWarnings] = useState([]);
  const [canProceed, setCanProceed] = useState(false);

  // Charger l'inventaire au montage
  useEffect(() => {
    const loadData = async () => {
      await checkRaidStatus(); // Charger d'abord le statut RAID
      await loadInventory(); // Puis l'inventaire
    };
    loadData();
  }, []);

  // Auto-scroll des logs
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  // Vérifier l'état du RAID actuel
  const checkRaidStatus = async () => {
    try {
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      
      const response = await axios.get(`${serverUrl}/api/storage/btrfs-status`, {
        timeout: 30000 // 30 secondes
      });
      
      if (response.data.success && response.data.status) {
        const status = response.data.status;
        
        // Debug: afficher le statut reçu
        console.log('RAID Status received:', {
          isRaidIncomplete: status.isRaidIncomplete,
          hasMixedProfiles: status.hasMixedProfiles,
          needsRebalance: status.needsRebalance,
          mixedProfilesWarning: status.mixedProfilesWarning
        });
        
        // Parser le niveau RAID depuis filesystemDf
        let currentRaidLevel = 'single';
        let deviceCount = 1;
        const devicesInRaid = [];
        
        if (status.filesystemDf) {
          // Chercher "Data, RAID1" ou "Data, RAID1C3" dans la sortie
          const dataMatch = status.filesystemDf.match(/Data,\s*(\w+):/i);
          if (dataMatch && dataMatch[1].toLowerCase() !== 'single') {
            currentRaidLevel = dataMatch[1].toLowerCase();
          }
        }
        
        if (status.filesystemShow) {
          // Compter le nombre de devices et extraire leurs paths
          const deviceMatches = status.filesystemShow.match(/devid\s+\d+/g);
          if (deviceMatches) {
            deviceCount = deviceMatches.length;
          }
          
          // Extraire les paths des devices (ex: /dev/sda6, /dev/sdb)
          const pathMatches = status.filesystemShow.match(/path\s+(\/dev\/\w+)/g);
          if (pathMatches) {
            pathMatches.forEach(match => {
              const path = match.replace('path ', '');
              // Extraire le disque parent (ex: /dev/sda6 -> /dev/sda, /dev/sdb -> /dev/sdb)
              const diskMatch = path.match(/\/dev\/(sd[a-z]+|nvme\d+n\d+|vd[a-z]+)/);
              if (diskMatch) {
                const diskPath = `/dev/${diskMatch[1]}`;
                if (!devicesInRaid.includes(diskPath)) {
                  devicesInRaid.push(diskPath);
                }
              }
            });
          }
        }
        
        setRaidDevices(devicesInRaid);
        setRaidStatus({
          isRaid: currentRaidLevel !== 'single' && deviceCount > 1,
          level: currentRaidLevel,
          deviceCount: deviceCount,
          details: status.filesystemDf,
          isIncomplete: status.isRaidIncomplete || false,
          hasMixedProfiles: status.hasMixedProfiles || false,
          needsRebalance: status.needsRebalance || false,
          mixedProfilesWarning: status.mixedProfilesWarning || null
        });
      }
    } catch (error) {
      console.error('Error checking RAID status:', error);
    }
  };

  // Charger l'inventaire des devices
  const loadInventory = async () => {
    try {
      setLoading(true);
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      
      const response = await axios.get(`${serverUrl}/api/storage/inventory`, {
        timeout: 30000 // 30 secondes
      });
      
      if (response.data.success) {
        const { devices: devicesData } = response.data.data;
        
        // Extraire seulement les disques (type disk)
        const disksList = [];
        if (devicesData.blockdevices) {
          devicesData.blockdevices.forEach(device => {
            if (device.type === 'disk' && !device.name.includes('sr')) {
              // Calculer si le disque est monté (lui ou ses partitions)
              let isMounted = false;
              let mountInfo = '';
              
              if (device.mountpoints && device.mountpoints.length > 0 && device.mountpoints[0]) {
                isMounted = true;
                mountInfo = device.mountpoints[0];
              }
              
              // Vérifier les partitions
              if (device.children) {
                device.children.forEach(child => {
                  if (child.mountpoints && child.mountpoints.length > 0 && child.mountpoints[0]) {
                    isMounted = true;
                    if (!mountInfo) mountInfo = child.mountpoints[0];
                    
                    // Détecter si c'est la source /data
                    if (child.mountpoints[0] === '/data' && child.fstype === 'btrfs') {
                      setDataSource({
                        device: child.path || `/dev/${child.name}`,
                        size: child.size,
                        fstype: child.fstype
                      });
                      setSourceDevice(child.path || `/dev/${child.name}`);
                    }
                  }
                });
              }
              
              disksList.push({
                path: device.path || `/dev/${device.name}`,
                name: device.name,
                size: device.size,
                isMounted,
                mountInfo,
                isSystemDisk: mountInfo === '/' || mountInfo.startsWith('/boot')
              });
            }
          });
        }
        
        setDisks(disksList);
      }
    } catch (error) {
      console.error('Error loading inventory:', error);
      addLog('Failed to load storage inventory: ' + error.message, 'error');
    } finally {
      setLoading(false);
    }
  };


  // Gérer la sélection des cibles
  const handleTargetToggle = (devicePath) => {
    setTargetDevices(prev => {
      if (prev.includes(devicePath)) {
        // Retirer
        const newTargets = prev.filter(d => d !== devicePath);
        const newLabels = { ...targetLabels };
        delete newLabels[devicePath];
        setTargetLabels(newLabels);
        return newTargets;
      } else {
        // Ajouter
        const newTargets = [...prev, devicePath];
        const labelIndex = newTargets.length + 1;
        setTargetLabels({
          ...targetLabels,
          [devicePath]: `DATA${labelIndex}`
        });
        return newTargets;
      }
    });
  };

  // Gérer le changement de label
  const handleLabelChange = (devicePath, newLabel) => {
    setTargetLabels({
      ...targetLabels,
      [devicePath]: newLabel
    });
  };

  // Ajouter un log
  const addLog = (message, type = 'info') => {
    const logEntry = {
      timestamp: new Date().toISOString(),
      type,
      message
    };
    setLogs(prev => [...prev, logEntry]);
  };

  // Copier les logs
  const copyLogs = () => {
    const logsText = logs.map(log => `[${log.timestamp}] [${log.type.toUpperCase()}] ${log.message}`).join('\n');
    navigator.clipboard.writeText(logsText);
    addLog('Logs copied to clipboard', 'success');
  };

  // Effectuer les pré-checks
  const performPrechecks = async () => {
    try {
      setValidationErrors([]);
      setValidationWarnings([]);
      setCanProceed(false);
      
      if (!sourceDevice) {
        setValidationErrors(['No source device selected']);
        return;
      }
      
      if (targetDevices.length === 0) {
        setValidationErrors(['No target devices selected']);
        return;
      }
      
      addLog('Running pre-checks...', 'info');
      
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      
      const response = await axios.post(`${serverUrl}/api/storage/btrfs-prechecks`, {
        source: sourceDevice,
        targets: targetDevices
      }, {
        timeout: 60000 // 60 secondes pour les prechecks
      });
      
      if (response.data.success) {
        const { checks } = response.data;
        
        if (checks.warnings.length > 0) {
          setValidationWarnings(checks.warnings);
          checks.warnings.forEach(w => addLog(`Warning: ${w}`, 'warning'));
        }
        
        if (checks.errors.length > 0) {
          setValidationErrors(checks.errors);
          checks.errors.forEach(e => addLog(`Error: ${e}`, 'error'));
          setCanProceed(false);
        } else {
          addLog('Pre-checks passed successfully', 'success');
          setCanProceed(true);
        }
      } else {
        setValidationErrors([response.data.error]);
        addLog(`Pre-checks failed: ${response.data.error}`, 'error');
      }
    } catch (error) {
      console.error('Error performing pre-checks:', error);
      const errorMsg = error.response?.data?.error || error.message;
      setValidationErrors([errorMsg]);
      addLog(`Pre-checks failed: ${errorMsg}`, 'error');
    }
  };

  // Exécuter les pré-checks quand la sélection change
  useEffect(() => {
    if (sourceDevice && targetDevices.length > 0) {
      performPrechecks();
    } else {
      setCanProceed(false);
      setValidationErrors([]);
      setValidationWarnings([]);
      // Effacer les logs si pas de sélection complète
      if (logs.length > 0 && logs[logs.length - 1].type === 'error') {
        setLogs([]);
      }
    }
  }, [sourceDevice, targetDevices]);

  // Ouvrir la modale de confirmation
  const openConfirmModal = async () => {
    try {
      // Générer la liste des commandes en mode dry-run
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      
      const targets = targetDevices.map(device => ({
        device,
        label: targetLabels[device] || 'DATA'
      }));
      
      const response = await axios.post(`${serverUrl}/api/storage/btrfs-raid-create`, {
        source: sourceDevice,
        targets,
        dryRun: true,
        raidLevel
      }, {
        timeout: 30000 // 30 secondes pour le dry-run
      });
      
      if (response.data.success) {
        setCommandsList(response.data.commands);
        setShowConfirmModal(true);
      }
    } catch (error) {
      console.error('Error generating commands:', error);
      addLog('Failed to generate commands list', 'error');
    }
  };

  // Exécuter la création du RAID
  const executeRaidCreation = async () => {
    try {
      setShowConfirmModal(false);
      setExecutionStatus('running');
      setLogs([]);
      addLog('Starting RAID creation...', 'info');
      
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      
      const targets = targetDevices.map(device => ({
        device,
        label: targetLabels[device] || 'DATA'
      }));
      
      // Timeout de 30 minutes pour les opérations Btrfs longues (balance peut prendre du temps)
      const response = await axios.post(`${serverUrl}/api/storage/btrfs-raid-create`, {
        source: sourceDevice,
        targets,
        dryRun: false,
        raidLevel
      }, {
        timeout: 1800000 // 30 minutes
      });
      
      if (response.data.success) {
        // Ajouter tous les logs du backend
        response.data.logs.forEach(log => {
          setLogs(prev => [...prev, log]);
        });
        
        setExecutionStatus('success');
        addLog('RAID creation completed successfully!', 'success');
        
        // Rafraîchir le statut RAID et l'inventaire
        setTimeout(() => {
          checkRaidStatus();
          loadInventory();
        }, 2000);
      } else {
        setExecutionStatus('error');
        addLog(`RAID creation failed: ${response.data.error}`, 'error');
      }
    } catch (error) {
      console.error('Error creating RAID:', error);
      const errorMsg = error.response?.data?.error || error.message || 'Unknown error';
      setExecutionStatus('error');
      addLog(`RAID creation failed: ${errorMsg}`, 'error');
    }
  };

  // Relancer le balance pour corriger les profils mixtes
  const fixMixedProfiles = async () => {
    try {
      setExecutionStatus('running');
      setLogs([]);
      addLog('Fixing mixed RAID profiles...', 'info');
      
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      
      const response = await axios.post(`${serverUrl}/api/storage/btrfs-fix-raid-profiles`, {
        raidLevel: raidLevel
      }, {
        timeout: 1800000 // 30 minutes
      });
      
      if (response.data.success) {
        // Ajouter tous les logs du backend
        response.data.logs.forEach(log => {
          setLogs(prev => [...prev, log]);
        });
        
        setExecutionStatus('success');
        addLog('RAID profiles fixed successfully!', 'success');
        
        // Rafraîchir le statut RAID
        setTimeout(() => {
          checkRaidStatus();
          loadInventory();
        }, 2000);
      } else {
        setExecutionStatus('error');
        addLog(`Failed to fix RAID profiles: ${response.data.error}`, 'error');
      }
    } catch (error) {
      console.error('Error fixing RAID profiles:', error);
      const errorMsg = error.response?.data?.error || error.message || 'Unknown error';
      setExecutionStatus('error');
      addLog(`Failed to fix RAID profiles: ${errorMsg}`, 'error');
    }
  };

  // Formater la taille
  const formatSize = (size) => {
    if (!size) return 'N/A';
    return size;
  };

  return (
    <div className="storage-settings-container">
      <div className="storage-header">
        <button className="back-button" onClick={() => navigate(-1)}>
          <FontAwesomeIcon icon={faArrowLeft} /> Retour
        </button>
        <h1>
          <FontAwesomeIcon icon={faHdd} /> Assistant RAID Btrfs
        </h1>
        <p className="subtitle">Créer un miroir RAID1 pour /data</p>
      </div>

      {loading ? (
        <div className="loading-container">
          <FontAwesomeIcon icon={faSpinner} spin size="3x" />
          <p>Chargement des disques...</p>
        </div>
      ) : (
        <>
          {/* Info /data source */}
          {dataSource && (
            <div className="data-source-card">
              <div className="storage-source-icon">
                <FontAwesomeIcon icon={faHdd} />
              </div>
              <div className="source-info">
                <div className="source-label">Volume /data (source)</div>
                <div className="source-device">{dataSource.device}</div>
                <div className="source-meta">{dataSource.size} · {dataSource.fstype}</div>
              </div>
              <div className="source-badge">
                <FontAwesomeIcon icon={faCheck} /> Détecté
              </div>
            </div>
          )}

          {!dataSource && (
            <div className="alert-error">
              <FontAwesomeIcon icon={faExclamationTriangle} />
              <div>
                <strong>Erreur :</strong> Aucune partition Btrfs montée sur /data détectée.
              </div>
            </div>
          )}

          {/* Alerte pour profils mixtes */}
          {raidStatus && raidStatus.isIncomplete && (
            <div className="alert-warning">
              <FontAwesomeIcon icon={faExclamationTriangle} />
              <div>
                <strong>RAID incomplet détecté !</strong>
                <p>Le RAID n'a pas été complètement converti. Des profils mixtes (single/DUP/RAID) ont été détectés.</p>
                <p>Cliquez sur le bouton ci-dessous pour terminer la conversion en RAID.</p>
                <button 
                  className="btn-create-raid" 
                  style={{ marginTop: '1rem' }}
                  onClick={fixMixedProfiles}
                  disabled={executionStatus === 'running'}
                >
                  {executionStatus === 'running' ? (
                    <>
                      <FontAwesomeIcon icon={faSpinner} spin /> Correction en cours...
                    </>
                  ) : (
                    <>
                      <FontAwesomeIcon icon={faPlay} /> Terminer la conversion RAID
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Sélection des disques cibles */}
          <div className="targets-section">
            <h2>
              {raidStatus && raidStatus.isRaid 
                ? 'Ajouter des disques au RAID existant' 
                : 'Sélectionnez les disques pour le RAID'}
            </h2>
            <p className="section-subtitle">
              {raidStatus && raidStatus.isRaid
                ? 'Vous pouvez ajouter des disques supplémentaires à votre RAID existant'
                : 'Les disques sélectionnés seront formatés et ajoutés au RAID1'}
            </p>
            
            <div className="disks-grid">
              {disks.map((disk) => {
                const isSelected = targetDevices.includes(disk.path);
                const isDisabled = disk.isSystemDisk || disk.isMounted;
                const canSelect = !isDisabled;
                const isInRaid = raidDevices.includes(disk.path);
                
                return (
                  <div 
                    key={disk.path}
                    className={`disk-card-simple ${isSelected ? 'selected' : ''} ${isDisabled ? 'disabled' : ''} ${isInRaid ? 'in-raid' : ''}`}
                    onClick={() => canSelect && handleTargetToggle(disk.path)}
                  >
                    {isSelected && (
                      <div className="disk-check">
                        <FontAwesomeIcon icon={faCheckCircle} />
                      </div>
                    )}
                    
                    <div className="storage-disk-icon">
                      <FontAwesomeIcon icon={faHdd} />
                    </div>
                    
                    <div className="disk-name">{disk.path}</div>
                    <div className="disk-size">{disk.size}</div>
                    
                    <div className="disk-status">
                      {isInRaid && <span className="storage-badge-raid-active"><FontAwesomeIcon icon={faCheckCircle} /> Dans le RAID</span>}
                      {!isInRaid && disk.isSystemDisk && <span className="storage-badge-system">Système</span>}
                      {!isInRaid && disk.isMounted && !disk.isSystemDisk && <span className="storage-badge-mounted">Monté ({disk.mountInfo})</span>}
                      {!isInRaid && !disk.isMounted && !disk.isSystemDisk && <span className="storage-badge-available">Disponible</span>}
                    </div>
                    
                    {isSelected && (
                      <div className="disk-label-input">
                        <input
                          type="text"
                          placeholder="Label (ex: DATA2)"
                          value={targetLabels[disk.path] || ''}
                          onChange={(e) => {
                            e.stopPropagation();
                            handleLabelChange(disk.path, e.target.value);
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {disks.length === 0 && (
              <div className="empty-state">
                <FontAwesomeIcon icon={faHdd} size="3x" />
                <p>Aucun disque détecté</p>
              </div>
            )}
          </div>

          {/* Options */}
          <div className="options-section">
            <div className="options-row">
              <div className="option-item">
                <label>Niveau RAID</label>
                <select value={raidLevel} onChange={(e) => setRaidLevel(e.target.value)}>
                  <option value="raid1">RAID1 (2 copies)</option>
                  <option value="raid1c3">RAID1C3 (3 copies)</option>
                </select>
              </div>

              <div className="option-item checkbox">
                <label>
                  <input
                    type="checkbox"
                    checked={dryRun}
                    onChange={(e) => setDryRun(e.target.checked)}
                  />
                  <span>Mode simulation (aucune modification)</span>
                </label>
              </div>
            </div>
          </div>

          {/* Validation messages */}
          {validationErrors.length > 0 && (
            <div className="alert-error">
              <FontAwesomeIcon icon={faExclamationTriangle} />
              <div>
                {validationErrors.map((error, index) => (
                  <div key={index}>{error}</div>
                ))}
              </div>
            </div>
          )}

          {validationWarnings.length > 0 && (
            <div className="alert-warning">
              <FontAwesomeIcon icon={faExclamationTriangle} />
              <div>
                {validationWarnings.map((warning, index) => (
                  <div key={index}>{warning}</div>
                ))}
              </div>
            </div>
          )}

          {/* Bouton d'exécution */}
          <div className="action-section">
            {(() => {
              // Vérifier si tous les disques sélectionnés sont déjà dans le RAID
              const allSelectedInRaid = targetDevices.length > 0 && 
                targetDevices.every(device => raidDevices.includes(device));
              
              // Ne pas afficher "RAID déjà actif" si le RAID est incomplet
              if (allSelectedInRaid && (!raidStatus || !raidStatus.isIncomplete)) {
                return (
                  <button className="btn-raid-active" disabled>
                    <FontAwesomeIcon icon={faCheckCircle} /> RAID déjà actif
                  </button>
                );
              }
              
              return (
                <button
                  className="btn-create-raid"
                  disabled={!canProceed || executionStatus === 'running'}
                  onClick={openConfirmModal}
                >
                  {executionStatus === 'running' ? (
                    <>
                      <FontAwesomeIcon icon={faSpinner} spin /> Création en cours...
                    </>
                  ) : (
                    <>
                      <FontAwesomeIcon icon={faPlay} /> Créer le RAID
                    </>
                  )}
                </button>
              );
            })()}
          </div>

          {/* Fenêtre de logs */}
          <div className="logs-section">
            <div className="logs-header">
              <h2>Execution Logs</h2>
              <div className="logs-controls">
                <span className={`storage-status-badge storage-status-${executionStatus}`}>
                  {executionStatus === 'idle' && 'Idle'}
                  {executionStatus === 'running' && <><FontAwesomeIcon icon={faSpinner} spin /> Running</>}
                  {executionStatus === 'success' && <><FontAwesomeIcon icon={faCheckCircle} /> Success</>}
                  {executionStatus === 'error' && <><FontAwesomeIcon icon={faExclamationTriangle} /> Error</>}
                </span>
                <button className="btn-copy" onClick={copyLogs} disabled={logs.length === 0}>
                  <FontAwesomeIcon icon={faCopy} /> Copy
                </button>
              </div>
            </div>
            <div className="logs-container">
              {logs.length === 0 ? (
                <p className="logs-placeholder">No logs yet. Configure and execute RAID creation to see logs here.</p>
              ) : (
                logs.map((log, index) => (
                  <div key={index} className={`log-entry log-${log.type}`}>
                    <span className="log-timestamp">{new Date(log.timestamp).toLocaleTimeString()}</span>
                    <span className="log-type">[{log.type.toUpperCase()}]</span>
                    <span className="log-message">{log.message}</span>
                  </div>
                ))
              )}
              <div ref={logsEndRef} />
            </div>
          </div>
        </>
      )}

      {/* Modale de confirmation */}
      {showConfirmModal && (
        <div className="modal-overlay" onClick={() => setShowConfirmModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h2>Confirm RAID Creation</h2>
            
            <div className="modal-section">
              <h3>Configuration Summary</h3>
              <div className="summary-grid">
                <div className="summary-item">
                  <strong>Source:</strong> {sourceDevice}
                </div>
                <div className="summary-item">
                  <strong>Targets:</strong> {targetDevices.map(d => `${d} (${targetLabels[d]})`).join(', ')}
                </div>
                <div className="summary-item">
                  <strong>RAID Level:</strong> {raidLevel.toUpperCase()}
                </div>
                <div className="summary-item">
                  <strong>Mode:</strong> {dryRun ? 'Dry Run' : 'Live Execution'}
                </div>
              </div>
            </div>

            <div className="modal-section">
              <h3>Commands to Execute</h3>
              <div className="commands-list">
                {commandsList.map((cmd, index) => (
                  <div key={index} className="command-item">
                    <div className="command-description">{cmd.description}</div>
                    <code className="command-code">{cmd.command}</code>
                  </div>
                ))}
              </div>
            </div>

            <div className="modal-warning">
              <FontAwesomeIcon icon={faExclamationTriangle} />
              <strong>Warning:</strong> This operation will format the target devices and is destructive. 
              Make sure you have backups of any important data.
            </div>

            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setShowConfirmModal(false)}>
                Cancel
              </button>
              <button className="btn-danger" onClick={executeRaidCreation}>
                {dryRun ? 'Run Dry Run' : 'Execute RAID Creation'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default StorageSettings;