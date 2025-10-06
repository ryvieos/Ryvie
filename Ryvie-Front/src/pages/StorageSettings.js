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
import urlsConfig from '../config/urls';
const { getServerUrl } = urlsConfig;
import { getCurrentAccessMode } from '../utils/detectAccessMode';

const StorageSettings = () => {
  const navigate = useNavigate();
  const logsEndRef = useRef(null);

  // États pour les données
  const [loading, setLoading] = useState(true);
  const [disks, setDisks] = useState([]); // Seulement les disques, pas les partitions
  const [dataSource, setDataSource] = useState(null); // Info sur /data
  const [raidStatus, setRaidStatus] = useState(null); // État du RAID actuel
  const [raidMemberPartitions, setRaidMemberPartitions] = useState([]); // Ex: ['/dev/sda6', '/dev/sdb1']
  const [raidMemberDisksMap, setRaidMemberDisksMap] = useState({}); // Map disque -> partition membre
  
  // États pour la sélection
  const [sourceDevice, setSourceDevice] = useState('');
  const [selectedDisk, setSelectedDisk] = useState(''); // Pour mdadm: un seul disque à la fois
  const [raidType, setRaidType] = useState(null); // 'mdadm' ou 'btrfs'
  
  // États pour les options
  const [dryRun, setDryRun] = useState(false);
  const [raidLevel, setRaidLevel] = useState('raid1');
  
  // États pour les logs et l'exécution
  const [logs, setLogs] = useState([]);
  const [executionStatus, setExecutionStatus] = useState('idle'); // idle, running, success, error
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [commandsList, setCommandsList] = useState([]);
  
  // États pour la progression du resync
  const [resyncProgress, setResyncProgress] = useState(null); // { percent, eta, speed }
  
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
      
      // Détecter le type de RAID (mdadm ou btrfs)
      const response = await axios.get(`${serverUrl}/api/storage/mdraid-status`, {
        timeout: 30000 // 30 secondes
      });
      
      if (response.data.success && response.data.status) {
        const status = response.data.status;
        
        console.log('RAID Status received:', status);
        
        // Déterminer le type de RAID
        if (status.mounted && status.source === '/dev/md0' && status.fstype === 'btrfs') {
          // Mode mdadm
          setRaidType('mdadm');
          
          // Construire la liste de partitions membres et la map disque -> partition
          const members = [];
          const diskMap = {};
          if (status.members && status.members.length > 0) {
            status.members.forEach(member => {
              const part = member.device; // ex: /dev/sda6
              if (part) {
                members.push(part);
                const diskMatch = part.match(/\/dev\/(sd[a-z]+|nvme\d+n\d+|vd[a-z]+)/);
                if (diskMatch) {
                  const diskPath = `/dev/${diskMatch[1]}`;
                  diskMap[diskPath] = part;
                }
              }
            });
          }
          setRaidMemberPartitions(members);
          setRaidMemberDisksMap(diskMap);
          setRaidStatus({
            isRaid: status.exists && status.activeDevices > 0,
            level: 'raid1', // mdadm RAID1
            deviceCount: status.activeDevices || 0,
            totalDevices: status.totalDevices || 0,
            state: status.state,
            syncProgress: status.syncProgress,
            details: status.mdstat,
            type: 'mdadm'
          });
        } else {
          // Pas de mdadm détecté
          setRaidType(null);
          setRaidMemberPartitions([]);
          setRaidMemberDisksMap({});
          setRaidStatus(null);
        }
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
        
        // Fonction récursive pour chercher md0 dans toute la hiérarchie
        const findMd0 = (devices) => {
          if (!devices) return;
          devices.forEach(device => {
            if (device.name === 'md0' && device.type === 'raid1') {
              if (device.mountpoints && device.mountpoints.length > 0 && device.mountpoints[0] === '/data') {
                setDataSource({
                  device: '/dev/md0',
                  size: device.size,
                  fstype: 'btrfs (on mdadm RAID1)'
                });
                setSourceDevice('/dev/md0');
              }
            }
            // Chercher récursivement dans les enfants
            if (device.children) {
              findMd0(device.children);
            }
          });
        };
        
        if (devicesData.blockdevices) {
          // Chercher md0 dans toute la hiérarchie
          findMd0(devicesData.blockdevices);
          
          // Extraire les disques
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
                  }
                });
              }
              // Enregistrer les enfants minimaux utiles
              const children = (device.children || []).map(ch => ({
                path: ch.path || (ch.name ? `/dev/${ch.name}` : null),
                name: ch.name,
                size: ch.size,
                mountpoints: ch.mountpoints || []
              }));

              disksList.push({
                path: device.path || `/dev/${device.name}`,
                name: device.name,
                size: device.size,
                isMounted,
                mountInfo,
                isSystemDisk: mountInfo === '/' || mountInfo.startsWith('/boot'),
                children
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


  // Gérer la sélection d'un disque (mdadm: un seul à la fois)
  const handleDiskSelect = (devicePath) => {
    if (selectedDisk === devicePath) {
      setSelectedDisk('');
    } else {
      setSelectedDisk(devicePath);
    }
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

  // Effectuer les pré-checks (mdadm)
  const performPrechecks = async () => {
    try {
      setValidationErrors([]);
      setValidationWarnings([]);
      setCanProceed(false);
      
      if (!selectedDisk) {
        setValidationErrors(['No disk selected']);
        return;
      }
      
      addLog('Running pre-checks...', 'info');
      
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      
      const response = await axios.post(`${serverUrl}/api/storage/mdraid-prechecks`, {
        array: '/dev/md0',
        disk: selectedDisk
      }, {
        timeout: 60000
      });
      
      if (response.data.success) {
        const { canProceed, reasons, plan } = response.data;
        
        // Réinitialiser les erreurs et warnings
        const errors = [];
        const warnings = [];
        
        // Afficher les raisons
        reasons.forEach(reason => {
          if (reason.startsWith('❌')) {
            errors.push(reason);
            addLog(reason, 'error');
          } else if (reason.startsWith('⚠')) {
            warnings.push(reason);
            addLog(reason, 'warning');
          } else {
            addLog(reason, 'info');
          }
        });
        
        setValidationErrors(errors);
        setValidationWarnings(warnings);
        
        // Stocker le plan pour la modale
        setCommandsList(plan.map(cmd => ({ command: cmd, description: cmd })));
        
        if (canProceed) {
          addLog('Pre-checks passed successfully', 'success');
          setCanProceed(true);
        } else {
          setCanProceed(false);
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
    if (selectedDisk) {
      performPrechecks();
    } else {
      setCanProceed(false);
      setValidationErrors([]);
      setValidationWarnings([]);
    }
  }, [selectedDisk]);

  // Ouvrir la modale de confirmation
  const openConfirmModal = async () => {
    // Les commandes sont déjà dans commandsList depuis les prechecks
    setShowConfirmModal(true);
  };

  // Exécuter l'ajout du disque au RAID
  const executeRaidCreation = async () => {
    try {
      setShowConfirmModal(false);
      setExecutionStatus('running');
      setLogs([]);
      addLog('Starting disk addition to RAID...', 'info');
      
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      
      const response = await axios.post(`${serverUrl}/api/storage/mdraid-add-disk`, {
        array: '/dev/md0',
        disk: selectedDisk,
        dryRun: dryRun
      }, {
        timeout: 1800000 // 30 minutes
      });
      
      if (response.data.success) {
        // Ajouter tous les logs du backend et parser la progression
        response.data.logs.forEach(log => {
          setLogs(prev => [...prev, log]);
          
          // Parser la progression du resync depuis les logs
          if (log.message && log.message.includes('Resync progress:')) {
            const percentMatch = log.message.match(/(\d+\.\d+)%/);
            const etaMatch = log.message.match(/ETA:\s*([\d.]+min)/);
            const speedMatch = log.message.match(/Speed:\s*([\d.]+[KMG]\/sec)/);
            
            if (percentMatch) {
              setResyncProgress({
                percent: parseFloat(percentMatch[1]),
                eta: etaMatch ? etaMatch[1] : null,
                speed: speedMatch ? speedMatch[1] : null
              });
            }
          }
          
          // Détecter la fin du resync
          if (log.message && log.message.includes('Resynchronization completed')) {
            setResyncProgress({ percent: 100, eta: null, speed: null });
          }
        });
        
        setExecutionStatus('success');
        addLog('Disk added to RAID successfully!', 'success');
        
        // Rafraîchir le statut RAID et l'inventaire
        setTimeout(() => {
          checkRaidStatus();
          loadInventory();
          setResyncProgress(null); // Réinitialiser la progression
        }, 2000);
      } else {
        setExecutionStatus('error');
        addLog(`Failed to add disk: ${response.data.error}`, 'error');
      }
    } catch (error) {
      console.error('Error adding disk to RAID:', error);
      const errorMsg = error.response?.data?.error || error.message || 'Unknown error';
      setExecutionStatus('error');
      addLog(`Failed to add disk: ${errorMsg}`, 'error');
    }
  };


  // Formater une taille en bytes en format lisible
  const formatBytes = (bytes) => {
    if (bytes === null || bytes === undefined || isNaN(bytes)) return 'N/A';
    const units = ['B','KB','MB','GB','TB','PB'];
    let i = 0;
    let val = Number(bytes);
    while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
    return `${val.toFixed(val >= 10 || i === 0 ? 0 : 1)}${units[i]}`;
  };

  // Parser tailles lsblk (ex: "80G", "59,5G", bytes en number) vers bytes
  const parseSizeToBytes = (s) => {
    if (s === null || s === undefined) return NaN;
    if (typeof s === 'number') return s;
    const str = String(s).trim().replace(',', '.');
    const m = str.match(/^(\d+(?:\.\d+)?)(\s*[KMGTP]?B?)?$/i);
    if (!m) return NaN;
    const num = parseFloat(m[1]);
    const unit = (m[2] || '').replace(/\s+/g, '').toUpperCase();
    const pow = unit.startsWith('P') ? 5 : unit.startsWith('T') ? 4 : unit.startsWith('G') ? 3 : unit.startsWith('M') ? 2 : unit.startsWith('K') ? 1 : 0;
    return Math.round(num * Math.pow(1024, pow));
  };

  return (
    <div className="storage-settings-container">
      <div className="storage-header">
        <h1>
          <FontAwesomeIcon icon={faHdd} /> Assistant RAID
        </h1>
        <p className="subtitle">Ajouter des disques au RAID1 /dev/md0</p>
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

          {!dataSource && raidType !== 'mdadm' && (
            <div className="alert-warning">
              <FontAwesomeIcon icon={faExclamationTriangle} />
              <div>
                <strong>Info :</strong> Aucun RAID mdadm détecté sur /data. Assurez-vous que /dev/md0 est monté sur /data.
              </div>
            </div>
          )}

          {/* Info sur l'état du RAID */}
          {raidStatus && raidStatus.type === 'mdadm' && (
            <div className="raid-status-card">
              <div className="raid-status-title">
                <FontAwesomeIcon icon={faCheckCircle} /> RAID mdadm actif
              </div>
              <div className="raid-status-meta">
                <span className="raid-badge">Array: /dev/md0</span>
                <span className={`raid-badge raid-badge-state`}>État: {raidStatus.state}</span>
                <span className="raid-badge">Membres: {raidStatus.deviceCount}/{raidStatus.totalDevices}</span>
                {raidStatus.syncProgress !== null && (
                  <span className="raid-badge">Resync: {raidStatus.syncProgress.toFixed(1)}%</span>
                )}
              </div>
            </div>
          )}

          {/* Sélection du disque à ajouter */}
          <div className="targets-section">
            <h2>Sélectionnez un disque à ajouter au RAID</h2>
            <p className="section-subtitle">
              Le disque sera effacé, partitionné (GPT), et ajouté comme membre du RAID /dev/md0
            </p>
            
            <div className="disks-grid">
              {disks.map((disk) => {
                const isSelected = selectedDisk === disk.path;
                const diskHasRaidPartition = !!raidMemberDisksMap[disk.path];
                const isDisabled = disk.isSystemDisk || disk.isMounted || diskHasRaidPartition;
                const canSelect = !isDisabled;
                // Calculer taille affichée: si partition RAID présente, sommer tailles des partitions hors partition RAID
                // Calcul exact en bytes si possible
                let displaySizeBytes = parseSizeToBytes(disk.size);
                if (diskHasRaidPartition && Array.isArray(disk.children) && disk.children.length > 0) {
                  const raidPart = raidMemberDisksMap[disk.path];
                  let sum = 0;
                  let counted = 0;
                  disk.children.forEach(ch => {
                    const chPath = ch.path || (ch.name ? `/dev/${ch.name}` : null);
                    if (chPath && chPath !== raidPart) {
                      const v = parseSizeToBytes(ch.size);
                      if (!isNaN(v)) { sum += v; counted++; }
                    }
                  });
                  if (counted > 0) {
                    displaySizeBytes = sum;
                  } else {
                    // Fallback: total disque - taille partition RAID
                    const total = parseSizeToBytes(disk.size);
                    const raidSize = (() => {
                      const child = (disk.children || []).find(ch => (ch.path || (ch.name ? `/dev/${ch.name}` : null)) === raidPart);
                      return child ? parseSizeToBytes(child.size) : NaN;
                    })();
                    if (!isNaN(total) && !isNaN(raidSize) && total >= raidSize) {
                      displaySizeBytes = total - raidSize;
                    } else {
                      displaySizeBytes = 0;
                    }
                  }
                }
                
                return (
                  <div
                    key={disk.path}
                    className={`disk-card-simple ${isSelected ? 'selected' : ''} ${isDisabled ? 'disabled' : ''}`}
                    onClick={() => canSelect && handleDiskSelect(disk.path)}
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
                    <div className="disk-size">{formatBytes(displaySizeBytes)}</div>
                    
                    <div className="disk-status">
                      {diskHasRaidPartition && disk.isSystemDisk && <span className="storage-badge-system">Système</span>}
                      {(!diskHasRaidPartition) && disk.isSystemDisk && <span className="storage-badge-system">Système</span>}
                      {(!diskHasRaidPartition) && disk.isMounted && !disk.isSystemDisk && <span className="storage-badge-mounted">Monté ({disk.mountInfo})</span>}
                      {(!diskHasRaidPartition) && !disk.isMounted && !disk.isSystemDisk && <span className="storage-badge-available">Disponible</span>}
                    </div>
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

          {/* Options supprimées: mode simulation */}

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
              // Bloquer si le disque sélectionné contient déjà une partition RAID
              const hasRaidPart = selectedDisk && raidMemberDisksMap[selectedDisk];
              if (hasRaidPart) {
                return (
                  <button className="btn-raid-active" disabled>
                    <FontAwesomeIcon icon={faCheckCircle} /> Ce disque contient déjà une partition RAID ({raidMemberDisksMap[selectedDisk]})
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
                      <FontAwesomeIcon icon={faSpinner} spin /> Ajout en cours...
                    </>
                  ) : (
                    <>
                      <FontAwesomeIcon icon={faPlay} /> Ajouter au RAID
                    </>
                  )}
                </button>
              );
            })()}
          </div>

          {/* Barre de progression du resync */}
          {resyncProgress && (
            <div className="resync-progress-section" style={{ 
              background: '#fff', 
              border: '1px solid #e0e0e0', 
              borderRadius: '8px', 
              padding: '1.5rem', 
              marginBottom: '1rem' 
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: '600' }}>
                  🔄 Resynchronisation en cours
                </h3>
                <span style={{ fontSize: '1.2rem', fontWeight: 'bold', color: '#2196f3' }}>
                  {resyncProgress.percent.toFixed(1)}%
                </span>
              </div>
              
              {/* Barre de progression */}
              <div style={{ 
                width: '100%', 
                height: '24px', 
                background: '#e0e0e0', 
                borderRadius: '12px', 
                overflow: 'hidden',
                marginBottom: '0.5rem'
              }}>
                <div style={{ 
                  width: `${resyncProgress.percent}%`, 
                  height: '100%', 
                  background: 'linear-gradient(90deg, #2196f3, #1976d2)',
                  transition: 'width 0.5s ease',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  paddingRight: '8px',
                  color: 'white',
                  fontSize: '0.85rem',
                  fontWeight: 'bold'
                }}>
                  {resyncProgress.percent > 10 && `${resyncProgress.percent.toFixed(1)}%`}
                </div>
              </div>
              
              {/* Infos supplémentaires */}
              <div style={{ display: 'flex', gap: '1rem', fontSize: '0.9rem', color: '#666' }}>
                {resyncProgress.eta && (
                  <span>⏱️ Temps restant: <strong>{resyncProgress.eta}</strong></span>
                )}
                {resyncProgress.speed && (
                  <span>⚡ Vitesse: <strong>{resyncProgress.speed}</strong></span>
                )}
              </div>
            </div>
          )}

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
                  <strong>Array:</strong> /dev/md0
                </div>
                <div className="summary-item">
                  <strong>Disk to add:</strong> {selectedDisk}
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
              <strong>ATTENTION:</strong> Le disque {selectedDisk} sera complètement effacé (wipefs, mklabel gpt). 
              Toutes les données seront perdues. Assurez-vous d'avoir des sauvegardes.
            </div>

            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setShowConfirmModal(false)}>
                Cancel
              </button>
              <button className="btn-danger" onClick={executeRaidCreation}>
                {dryRun ? 'Simuler' : 'Ajouter au RAID'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default StorageSettings;