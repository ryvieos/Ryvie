import React, { useState, useEffect, useRef, useCallback } from 'react';
import '../styles/StorageSettings.css';
import { useNavigate, useLocation } from 'react-router-dom';
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
  faArrowRight,
  faUserPlus,
  faCheck,
  faStop,
  faThermometerHalf,
  faClock,
  faHeartbeat,
  faPlus,
  faShieldAlt,
  faBolt,
  faLayerGroup,
  faExchangeAlt,
  faTrash,
  faExpand,
  faMinus
} from '@fortawesome/free-solid-svg-icons';
import urlsConfig from '../config/urls';
const { getServerUrl } = urlsConfig;
import { getCurrentAccessMode, connectRyvieSocket } from '../utils/detectAccessMode';
import { useLanguage } from '../contexts/LanguageContext';

// RAID level definitions
const RAID_LEVELS = [
  {
    id: 'raid0',
    label: 'RAID 0',
    subtitle: 'Striping',
    minDisks: 2,
    icon: faBolt,
    color: '#f59e0b',
    redundancy: 0,
    description: 'raidLevelDesc.raid0',
    capacityFormula: (n) => n,
    faultTolerance: 0
  },
  {
    id: 'raid1',
    label: 'RAID 1',
    subtitle: 'Mirroring',
    minDisks: 2,
    icon: faShieldAlt,
    color: '#3b82f6',
    redundancy: 1,
    description: 'raidLevelDesc.raid1',
    capacityFormula: (n) => 1,
    faultTolerance: 1
  },
  {
    id: 'raid5',
    label: 'RAID 5',
    subtitle: 'Striping + 1 Parity',
    minDisks: 3,
    icon: faLayerGroup,
    color: '#8b5cf6',
    redundancy: 1,
    description: 'raidLevelDesc.raid5',
    capacityFormula: (n) => n - 1,
    faultTolerance: 1
  },
  {
    id: 'raid6',
    label: 'RAID 6',
    subtitle: 'Striping + 2 Parity',
    minDisks: 4,
    icon: faShieldAlt,
    color: '#6366f1',
    redundancy: 2,
    description: 'raidLevelDesc.raid6',
    capacityFormula: (n) => n - 2,
    faultTolerance: 2
  },
  {
    id: 'raid10',
    label: 'RAID 10',
    subtitle: 'Mirror + Stripe',
    minDisks: 4,
    icon: faBolt,
    color: '#ec4899',
    redundancy: 1,
    description: 'raidLevelDesc.raid10',
    capacityFormula: (n) => n / 2,
    faultTolerance: 1,
    evenOnly: true
  }
];

const StorageSettings = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useLanguage();
  const logsEndRef = useRef(null);

  // Detect if we're in first-time setup mode (no user created yet)
  const isSetupMode = location.pathname === '/setup/storage';

  // Data states
  const [loading, setLoading] = useState(true);
  const [disks, setDisks] = useState([]);
  const [diskHealth, setDiskHealth] = useState({});
  const [dataSource, setDataSource] = useState(null);
  const [raidStatus, setRaidStatus] = useState<any>(null);
  const [raidMemberPartitions, setRaidMemberPartitions] = useState([]);
  const [raidMemberDisksMap, setRaidMemberDisksMap] = useState({});

  // Mode: 'overview' (view disks + health), 'create' (new RAID), 'manage' (existing RAID)
  const [mode, setMode] = useState('overview');

  // Selection states
  const [sourceDevice, setSourceDevice] = useState('');
  const [selectedDisks, setSelectedDisks] = useState([]);
  const [selectedDisk, setSelectedDisk] = useState('');
  const [raidType, setRaidType] = useState(null);

  // RAID creation options
  const [raidLevel, setRaidLevel] = useState('raid1');
  const [dryRun, setDryRun] = useState(false);

  // Logs and execution
  const [logs, setLogs] = useState([]);
  const [executionStatus, setExecutionStatus] = useState('idle');
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [commandsList, setCommandsList] = useState([]);

  // Resync progress
  const [resyncProgress, setResyncProgress] = useState(null);

  // Smart management
  const [smartSuggestion, setSmartSuggestion] = useState(null);
  const [smartOptimization, setSmartOptimization] = useState(null);

  // Prechecks
  const [validationErrors, setValidationErrors] = useState([]);
  const [validationWarnings, setValidationWarnings] = useState([]);
  const [canProceed, setCanProceed] = useState(false);
  const [expectedCapacity, setExpectedCapacity] = useState(0);

  // Reshape (RAID level conversion)
  const [reshapeOptions, setReshapeOptions] = useState<any>(null);
  const [selectedReshapeLevel, setSelectedReshapeLevel] = useState('');
  const [showReshapeModal, setShowReshapeModal] = useState(false);
  const [reshapeStatus, setReshapeStatus] = useState('idle');

  // Remove disk from RAID
  const [showRemoveModal, setShowRemoveModal] = useState(false);
  const [partitionToRemove, setPartitionToRemove] = useState('');
  const [removeStatus, setRemoveStatus] = useState('idle');

  // Grow array to max
  const [growStatus, setGrowStatus] = useState('idle');
  const [showGrowModal, setShowGrowModal] = useState(false);
  const [canGrow, setCanGrow] = useState(false);

  // Auto-migrate
  const [migrateLevel, setMigrateLevel] = useState('raid1');
  const [migrateDisks, setMigrateDisks] = useState<string[]>([]);
  const [showMigrateModal, setShowMigrateModal] = useState(false);
  const [migrationState, setMigrationState] = useState<any>(null);
  const [stoppingMigration, setStoppingMigration] = useState(false);

  // Helper: strip emojis from strings for consistent UI DA
  const stripEmojis = (str) => {
    if (!str) return '';
    try {
      return str.replace(/[\u{1F300}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '');
    } catch {
      return str;
    }
  };

  // Restore state from localStorage on mount
  useEffect(() => {
    try {
      const savedState = localStorage.getItem('raidResyncState');
      if (savedState) {
        const state = JSON.parse(savedState);
        const age = Date.now() - (state.timestamp || 0);
        if (age < 2 * 60 * 1000) {
          const ageSeconds = Math.floor(age / 1000);
          const restoredLogs = state.logs || [];
          restoredLogs.push({
            timestamp: new Date().toISOString(),
            type: 'info',
            message: `Session restored (${ageSeconds}s ago)`
          });
          setLogs(restoredLogs);
          if (state.executionStatus) setExecutionStatus(state.executionStatus);
          if (state.resyncProgress) {
            setResyncProgress(state.resyncProgress);
            setTimeout(() => checkRaidStatus(), 1000);
          }
        } else {
          localStorage.removeItem('raidResyncState');
        }
      }
    } catch (error) {
      console.error('[StorageSettings] Error restoring state:', error);
    }
  }, []);

  // Load data on mount + polling
  useEffect(() => {
    const loadData = async () => {
      await checkRaidStatus();
      await loadInventory();
      await loadDiskHealth();
    };
    loadData();

    const intervalId = setInterval(() => {
      checkRaidStatus();
    }, 5000);
    
    return () => clearInterval(intervalId);
  }, []);

  // Connexion Socket.IO pour les logs en temps réel
  useEffect(() => {
    const accessMode = getCurrentAccessMode() || 'private';
    
    const socket = connectRyvieSocket({
      mode: accessMode,
      onConnect: (sock) => {
        console.log('[StorageSettings] Socket.IO connecté pour les logs RAID');
      },
      onDisconnect: () => {
        console.log('[StorageSettings] Socket.IO déconnecté');
      },
      onError: (err) => {
        console.error('[StorageSettings] Erreur Socket.IO:', err);
      }
    });

    if (socket) {
      // Écouter les logs RAID en temps réel
      socket.on('mdraid-log', (logEntry) => {
        setLogs(prev => [...prev, logEntry]);
        
        // Détecter le début du resync
        if (logEntry.message && logEntry.message.includes('Resynchronization started')) {
          setResyncProgress({ percent: 0, eta: null, speed: null });
        }
        
        // Détecter la fin du resync
        if (logEntry.message && logEntry.message.includes('Resynchronization completed')) {
          setResyncProgress({ percent: 100, eta: null, speed: null });
          // Mettre à jour le statut après la fin
          setTimeout(() => {
            setExecutionStatus('success');
            checkRaidStatus();
            loadInventory();
          }, 1000);
        }
      });

      // Écouter les événements de progression dédiés
      socket.on('mdraid-resync-progress', (progressData) => {
        setResyncProgress({
          percent: progressData.percent || 0,
          eta: progressData.eta,
          speed: progressData.speed
        });
        
        // Si le resync est terminé
        if (progressData.completed) {
          setTimeout(() => {
            setResyncProgress(null);
            setExecutionStatus('success');
            checkRaidStatus();
            loadInventory();
          }, 2000);
        }
      });

      // Écouter les événements de migration auto
      socket.on('mdraid-migration-progress', (state) => {
        setMigrationState(state);
        if (state.status === 'completed') {
          setTimeout(() => {
            checkRaidStatus();
            loadInventory();
          }, 2000);
        }
      });

      // Nettoyage à la destruction du composant
      return () => {
        console.log('[StorageSettings] Déconnexion Socket.IO');
        socket.off('mdraid-log');
        socket.off('mdraid-resync-progress');
        socket.off('mdraid-migration-progress');
        socket.disconnect();
      };
    }
  }, []);

  // Sauvegarder l'état dans localStorage à chaque changement
  useEffect(() => {
    // Ne sauvegarder que si on est en cours d'exécution ou si un resync est en cours
    if (executionStatus === 'running' || resyncProgress) {
      try {
        const state = {
          logs,
          executionStatus,
          resyncProgress,
          timestamp: Date.now()
        };
        localStorage.setItem('raidResyncState', JSON.stringify(state));
      } catch (error) {
        console.error('[StorageSettings] Erreur sauvegarde état:', error);
      }
    } else if (executionStatus === 'success' || executionStatus === 'error' || (!resyncProgress && executionStatus !== 'running')) {
      // Nettoyer après succès/erreur ou si plus de resync en cours (avec délai pour permettre la lecture)
      setTimeout(() => {
        localStorage.removeItem('raidResyncState');
        console.log('[StorageSettings] localStorage nettoyé');
      }, 10000); // 10 secondes
    }
  }, [logs, executionStatus, resyncProgress]);

  // Auto-scroll des logs
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  // Vérifier l'état du RAID actuel (tous les arrays)
  const checkRaidStatus = async () => {
    try {
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      
      // Détecter les arrays RAID (mdadm)
      const response = await axios.get(`${serverUrl}/api/storage/mdraid-status`, {
        timeout: 30000 // 30 secondes
      });
      
      if (response.data.success && response.data.arrays) {
        const arrays = response.data.arrays;
        const dataDevice = response.data.dataDevice;
        
        console.log('RAID Arrays received:', arrays);
        
        // Trouver l'array monté sur /data (principal)
        const dataArray = arrays.find((a: any) => a.mountedOnData) || arrays[0];
        
        if (dataArray && dataArray.exists) {
          // Mode mdadm
          setRaidType('mdadm');
          
          // Construire la liste de partitions membres et la map disque -> partition
          const members = [];
          const diskMap = {};
          if (dataArray.members && dataArray.members.length > 0) {
            dataArray.members.forEach((member: any) => {
              const part = member.device;
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
            isRaid: true,
            level: dataArray.raidLevel || 'raid1',
            deviceCount: dataArray.activeDevices || 0,
            totalDevices: dataArray.totalDevices || 0,
            state: dataArray.state,
            syncProgress: dataArray.syncProgress,
            syncPending: dataArray.syncPending || false,
            details: dataArray.detail,
            members: dataArray.members || [],
            array: dataArray.array || '/dev/md0',
            mounted: dataArray.mountedOnData,
            type: 'mdadm',
            allArrays: arrays // Store all arrays for display
          });
          
          // Détecter si une resynchronisation est en cours (sur n'importe quel array)
          const syncingArray = arrays.find((a: any) => a.syncing);
          if (syncingArray) {
            setResyncProgress({
              percent: syncingArray.syncProgress,
              eta: syncingArray.syncETA || null,
              speed: syncingArray.syncSpeed || null,
              array: syncingArray.array
            });
          } else {
            setResyncProgress(null);
          }
          
          // Analyser pour suggestion intelligente
          analyzeSmartSuggestion(dataArray.members);
        } else {
          // Pas de mdadm détecté
          setRaidType(null);
          setRaidMemberPartitions([]);
          setRaidMemberDisksMap({});
          setRaidStatus(null);
          setSmartSuggestion(null);
        }
      }
    } catch (error) {
      console.error('Error checking RAID status:', error);
    }
  };
  
  // Analyser les membres du RAID pour suggérer des actions intelligentes
  const analyzeSmartSuggestion = (members) => {
    if (!members || members.length < 2) {
      setSmartSuggestion(null);
      return;
    }
    
    // Trouver le plus petit membre
    const sortedMembers = [...members].sort((a, b) => (a.size || 0) - (b.size || 0));
    const smallest = sortedMembers[0];
    const largest = sortedMembers[sortedMembers.length - 1];
    
    if (smallest.size && largest.size && largest.size > smallest.size * 1.5) {
      // Il y a un déséquilibre significatif (>50% de différence)
      setSmartSuggestion({
        type: 'replace_small',
        smallestMember: smallest,
        largestMember: largest,
        message: `${t('storageSettings.memberLimitsCapacity', { device: smallest.device, size: formatBytes(smallest.size) })}`
      });
    } else {
      setSmartSuggestion(null);
    }
  };

  // Load disk health data (SMART)
  const loadDiskHealth = async () => {
    try {
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      const response = await axios.get(`${serverUrl}/api/storage/disk-health`, { timeout: 30000 });
      if (response.data.success) {
        const healthMap = {};
        (response.data.disks || []).forEach(d => {
          healthMap[d.device] = d;
        });
        setDiskHealth(healthMap);
      }
    } catch (error) {
      console.error('Error loading disk health:', error);
    }
  };

  // Load device inventory
  const loadInventory = async () => {
    try {
      setLoading(true);
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      const response = await axios.get(`${serverUrl}/api/storage/inventory`, { timeout: 30000 });

      if (response.data.success) {
        const { devices: devicesData } = response.data.data;
        const disksList = [];

        const findMdArray = (devices) => {
          if (!devices) return;
          devices.forEach(device => {
            if (device.name && device.name.match(/^md\d+$/) && (device.type === 'raid1' || device.type === 'raid5' || device.type === 'raid6' || device.type === 'raid10' || device.type === 'raid0')) {
              if (device.mountpoints && device.mountpoints.length > 0 && device.mountpoints[0] === '/data') {
                const mdDev = `/dev/${device.name}`;
                setDataSource({
                  device: mdDev,
                  size: device.size,
                  fstype: `btrfs (on mdadm ${device.type.toUpperCase()})`
                });
                setSourceDevice(mdDev);
              }
            }
            if (device.children) findMdArray(device.children);
          });
        };

        if (devicesData.blockdevices) {
          findMdArray(devicesData.blockdevices);
          devicesData.blockdevices.forEach(device => {
            if (device.type === 'disk' && !device.name.includes('sr')) {
              let isMounted = false;
              let mountInfo = '';
              if (device.mountpoints && device.mountpoints.length > 0 && device.mountpoints[0]) {
                isMounted = true;
                mountInfo = device.mountpoints[0];
              }
              if (device.children) {
                device.children.forEach(child => {
                  if (child.mountpoints && child.mountpoints.length > 0 && child.mountpoints[0]) {
                    isMounted = true;
                    if (!mountInfo) mountInfo = child.mountpoints[0];
                  }
                });
              }
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

  // Toggle disk selection for multi-select (create mode)
  const handleDiskToggle = (devicePath) => {
    setSelectedDisks(prev =>
      prev.includes(devicePath) ? prev.filter(d => d !== devicePath) : [...prev, devicePath]
    );
  };

  // Multi disk select for manage mode (add to existing RAID)
  const handleDiskSelect = (devicePath) => {
    setSelectedDisks(prev =>
      prev.includes(devicePath) ? prev.filter(d => d !== devicePath) : [...prev, devicePath]
    );
  };

  // Add log
  const addLog = (message, type = 'info') => {
    setLogs(prev => [...prev, { timestamp: new Date().toISOString(), type, message }]);
  };

  // Copy logs
  const copyLogs = () => {
    const logsText = logs.map(log => `[${log.timestamp}] [${log.type.toUpperCase()}] ${log.message}`).join('\n');
    navigator.clipboard.writeText(logsText);
    addLog('Logs copied to clipboard', 'success');
  };

  // Prechecks for adding disks to existing RAID (supports multiple disks)
  const performPrechecks = async () => {
    try {
      setValidationErrors([]);
      setValidationWarnings([]);
      setCanProceed(false);
      if (selectedDisks.length === 0) { setValidationErrors(['No disk selected']); return; }
      addLog(`Running pre-checks for ${selectedDisks.length} disk(s)...`, 'info');
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);

      const results = await Promise.all(selectedDisks.map(disk =>
        axios.post(`${serverUrl}/api/storage/mdraid-prechecks`, {
          array: raidStatus?.array || '/dev/md0', disk
        }, { timeout: 60000 })
      ));

      const allErrors = [];
      const allWarnings = [];
      const allPlans = [];
      let allCanProceed = true;
      let lastSmartOpt = null;

      results.forEach((response, i) => {
        const diskPath = selectedDisks[i];
        if (response.data.success) {
          const { canProceed: cp, reasons, plan, smartOptimization: so } = response.data;
          if (so) lastSmartOpt = so;
          reasons.forEach(reason => {
            const prefixed = selectedDisks.length > 1 ? `[${diskPath}] ${reason}` : reason;
            if (reason.startsWith('\u274C')) { allErrors.push(prefixed); addLog(prefixed, 'error'); }
            else if (reason.startsWith('\u26A0')) { allWarnings.push(prefixed); addLog(prefixed, 'warning'); }
            else addLog(prefixed, 'info');
          });
          plan.forEach(cmd => allPlans.push(selectedDisks.length > 1 ? `[${diskPath}] ${cmd}` : cmd));
          if (!cp) allCanProceed = false;
        } else {
          allErrors.push(`[${diskPath}] ${response.data.error}`);
          allCanProceed = false;
        }
      });

      setSmartOptimization(selectedDisks.length === 1 ? lastSmartOpt : null);
      setValidationErrors(allErrors);
      setValidationWarnings(allWarnings);
      setCommandsList(allPlans.map(cmd => ({ command: cmd, description: cmd })));
      if (allCanProceed) { addLog('Pre-checks passed for all disks', 'success'); setCanProceed(true); }
      else setCanProceed(false);
    } catch (error) {
      const errorMsg = error.response?.data?.error || error.message;
      setValidationErrors([errorMsg]);
      addLog(`Pre-checks failed: ${errorMsg}`, 'error');
    }
  };

  // Smart prechecks: detects current state and plans optimal strategy
  const [setupStrategy, setSetupStrategy] = useState<string | null>(null);

  const performCreatePrechecks = async () => {
    try {
      setValidationErrors([]);
      setValidationWarnings([]);
      setCanProceed(false);
      setExpectedCapacity(0);
      setSetupStrategy(null);
      if (selectedDisks.length === 0) return;

      const raidDef = RAID_LEVELS.find(r => r.id === raidLevel);
      if (!raidDef) return;
      if (selectedDisks.length < raidDef.minDisks) {
        setValidationErrors([`${raidLevel.toUpperCase()} ${t('storageSettings.requiresAtLeast')} ${raidDef.minDisks} ${t('storageSettings.disksLower')}`]);
        return;
      }
      if (raidDef.evenOnly && selectedDisks.length % 2 !== 0) {
        setValidationErrors([t('storageSettings.raid10EvenRequired')]);
        return;
      }

      addLog('Running smart pre-checks...', 'info');
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      const response = await axios.post(`${serverUrl}/api/storage/mdraid-smart-prechecks`, {
        level: raidLevel, disks: selectedDisks
      }, { timeout: 60000 });

      if (response.data.success) {
        const { canProceed: cp, reasons, plan, expectedCapacity: ec, strategy } = response.data;
        setSetupStrategy(strategy);
        const errors = [], warnings = [];
        reasons.forEach(reason => {
          if (reason.startsWith('\u274C')) { errors.push(reason); addLog(reason, 'error'); }
          else if (reason.startsWith('\u26A0')) { warnings.push(reason); addLog(reason, 'warning'); }
          else addLog(reason, 'info');
        });
        setValidationErrors(errors);
        setValidationWarnings(warnings);
        setCommandsList(plan.map(cmd => ({ command: cmd, description: cmd })));
        setExpectedCapacity(ec || 0);
        if (cp) { addLog(`Smart pre-checks passed (strategy: ${strategy})`, 'success'); setCanProceed(true); }
      } else {
        setValidationErrors([response.data.error]);
      }
    } catch (error) {
      const errorMsg = error.response?.data?.error || error.message;
      setValidationErrors([errorMsg]);
    }
  };

  // Run prechecks when selection changes in manage mode
  useEffect(() => {
    if (mode === 'manage' && selectedDisks.length > 0) {
      performPrechecks();
    } else if (mode === 'manage') {
      setCanProceed(false); setValidationErrors([]); setValidationWarnings([]);
    }
  }, [selectedDisks, mode]);

  // Run prechecks when selection/level changes in create mode
  useEffect(() => {
    if (mode === 'create' && selectedDisks.length > 0) {
      performCreatePrechecks();
    } else if (mode === 'create') {
      setCanProceed(false); setValidationErrors([]); setValidationWarnings([]); setExpectedCapacity(0);
    }
  }, [selectedDisks, raidLevel, mode]);

  // Open confirm modal
  const openConfirmModal = () => setShowConfirmModal(true);

  // Execute smart optimization
  const executeSmartOptimization = async () => {
    try {
      setShowConfirmModal(false); setExecutionStatus('running'); setLogs([]); setResyncProgress(null);
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      const response = await axios.post(`${serverUrl}/api/storage/mdraid-optimize-and-add`, {
        array: raidStatus?.array || '/dev/md0', smartOptimization
      }, { timeout: 1800000 });
      if (response.data.success) {
        setExecutionStatus('success');
        setTimeout(() => { checkRaidStatus(); loadInventory(); }, 2000);
      } else {
        setExecutionStatus('error');
        if (!logs.some(l => l.message.includes(response.data.error))) addLog(`Failed: ${response.data.error}`, 'error');
      }
    } catch (error) {
      setExecutionStatus('error');
      const msg = error.response?.data?.error || error.message;
      if (!logs.some(l => l.message.includes(msg))) addLog(`Failed: ${msg}`, 'error');
    }
  };

  // Execute add disk(s) to existing RAID
  const executeAddDisk = async () => {
    try {
      setShowConfirmModal(false); setExecutionStatus('running'); setLogs([]); setResyncProgress(null);
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      const arrayDevice = raidStatus?.array || '/dev/md0';

      let response;
      if (selectedDisks.length === 1) {
        response = await axios.post(`${serverUrl}/api/storage/mdraid-add-disk`, {
          array: arrayDevice, disk: selectedDisks[0], dryRun
        }, { timeout: 1800000 });
      } else {
        response = await axios.post(`${serverUrl}/api/storage/mdraid-add-disks`, {
          array: arrayDevice, disks: selectedDisks, dryRun
        }, { timeout: 1800000 });
      }

      if (response.data.success) {
        if (!resyncProgress) {
          setExecutionStatus('success');
          setTimeout(() => { checkRaidStatus(); loadInventory(); }, 2000);
        }
      } else {
        setExecutionStatus('error'); setResyncProgress(null);
        if (!logs.some(l => l.message.includes(response.data.error))) addLog(`Failed: ${response.data.error}`, 'error');
      }
    } catch (error) {
      setExecutionStatus('error'); setResyncProgress(null);
      const msg = error.response?.data?.error || error.message;
      if (!logs.some(l => l.message.includes(msg))) addLog(`Failed: ${msg}`, 'error');
    }
  };

  // Execute smart RAID setup (handles both fresh create and progressive migration)
  const executeCreateRaid = async () => {
    try {
      setShowConfirmModal(false); setExecutionStatus('running'); setLogs([]); setResyncProgress(null);
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      const response = await axios.post(`${serverUrl}/api/storage/mdraid-smart-setup`, {
        level: raidLevel, disks: selectedDisks, dryRun
      }, { timeout: 0 }); // No timeout — migration can take hours
      if (response.data.success) {
        setExecutionStatus('success');
        setTimeout(() => { checkRaidStatus(); loadInventory(); loadDiskHealth(); }, 2000);
      } else {
        setExecutionStatus('error'); setResyncProgress(null);
        if (!logs.some(l => l.message.includes(response.data.error))) addLog(`Failed: ${response.data.error}`, 'error');
      }
    } catch (error) {
      // Connection may timeout but operation continues server-side — check status
      if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
        addLog('Connection timeout — operation continues server-side. Check RAID status.', 'warning');
        setExecutionStatus('running');
        setTimeout(() => checkRaidStatus(), 5000);
      } else {
        setExecutionStatus('error'); setResyncProgress(null);
        const msg = error.response?.data?.error || error.message;
        if (!logs.some(l => l.message.includes(msg))) addLog(`Failed: ${msg}`, 'error');
      }
    }
  };

  // Activate array (resume PENDING resync after reboot)
  const handleActivateArray = async () => {
    const arrayDev = raidStatus?.array || '/dev/md0';
    try {
      addLog(`Activating ${arrayDev} (resuming resync)...`, 'info');
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      const response = await axios.post(`${serverUrl}/api/storage/mdraid-activate`, { array: arrayDev });
      if (response.data.success) {
        addLog(`✓ ${arrayDev} activated — resync resumed`, 'success');
        setTimeout(() => { checkRaidStatus(); loadInventory(); }, 2000);
      } else {
        addLog(`Error: ${response.data.error}`, 'error');
      }
    } catch (error) {
      addLog(`Error activating array: ${error.response?.data?.error || error.message}`, 'error');
    }
  };

  // Stop resync
  const handleStopResync = async () => {
    if (!window.confirm(t('storageSettings.confirmStopResync'))) return;
    try {
      const arrayDev = raidStatus?.array || '/dev/md0';
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      const response = await axios.post(`${serverUrl}/api/storage/mdraid-stop-resync`, { array: arrayDev });
      if (response.data.success) {
        setResyncProgress(null); setExecutionStatus('success');
        if (response.data.logs) response.data.logs.forEach(log => addLog(log.message, log.type));
        setTimeout(() => { checkRaidStatus(); loadInventory(); }, 1000);
      } else {
        alert(t('storageSettings.error') + ': ' + (response.data.error || t('storageSettings.cannotStopResync')));
      }
    } catch (error) {
      alert(t('storageSettings.errorStoppingResync') + ': ' + (error.response?.data?.error || error.message));
    }
  };

  // Destroy RAID array and rollback to previous config
  const handleDestroyRaid = async () => {
    if (!window.confirm('⚠️ Are you sure you want to destroy the RAID array?\n\nThis will:\n- Stop the RAID array\n- Wipe all member disks\n- Restore the previous configuration if possible\n\nThis action cannot be undone!')) return;
    try {
      setExecutionStatus('running'); setLogs([]); setResyncProgress(null);
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      // If there's a syncing array in progress, destroy that one, otherwise use raidStatus
      const arrayDev = resyncProgress?.array || raidStatus?.array || undefined;
      const response = await axios.post(`${serverUrl}/api/storage/mdraid-destroy`, {
        array: arrayDev
      }, { timeout: 300000 });
      if (response.data.success) {
        setExecutionStatus('success');
        if (response.data.logs) response.data.logs.forEach((log: any) => addLog(log.message, log.type));
        addLog(response.data.message, 'success');
        setTimeout(() => { checkRaidStatus(); loadInventory(); loadDiskHealth(); }, 2000);
      } else {
        setExecutionStatus('error');
        addLog(`Failed: ${response.data.error}`, 'error');
      }
    } catch (error: any) {
      setExecutionStatus('error');
      const msg = error.response?.data?.error || error.message;
      addLog(`Failed to destroy RAID: ${msg}`, 'error');
    }
  };

  // Load reshape options from backend
  const loadReshapeOptions = async () => {
    try {
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      const response = await axios.get(`${serverUrl}/api/storage/mdraid-reshape-options`, { timeout: 30000 });
      if (response.data.success) {
        setReshapeOptions(response.data);
        setSelectedReshapeLevel('');
      }
    } catch (error) {
      console.error('Failed to load reshape options:', error);
    }
  };

  // Execute RAID reshape
  const executeReshape = async () => {
    if (!selectedReshapeLevel) return;
    setShowReshapeModal(false);
    setReshapeStatus('running');
    setLogs([]);
    try {
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      const arrayDev = raidStatus?.array || reshapeOptions?.array || '/dev/md0';
      const response = await axios.post(`${serverUrl}/api/storage/mdraid-reshape`, {
        array: arrayDev,
        targetLevel: selectedReshapeLevel
      }, { timeout: 1800000 });
      if (response.data.success) {
        setReshapeStatus('success');
        if (response.data.logs) response.data.logs.forEach(log => addLog(log.message, log.type));
        setTimeout(() => { checkRaidStatus(); loadReshapeOptions(); }, 3000);
      } else {
        setReshapeStatus('error');
        if (response.data.logs) response.data.logs.forEach(log => addLog(log.message, log.type));
        addLog(`Failed: ${response.data.error}`, 'error');
      }
    } catch (error) {
      setReshapeStatus('error');
      const msg = error.response?.data?.error || error.message;
      if (error.response?.data?.logs) error.response.data.logs.forEach(log => addLog(log.message, log.type));
      addLog(`Reshape failed: ${msg}`, 'error');
    }
  };

  // Remove a disk from the RAID array
  const executeRemoveDisk = async () => {
    if (!partitionToRemove) return;
    setShowRemoveModal(false);
    setRemoveStatus('running');
    setExecutionStatus('running');
    setLogs([]);
    try {
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      const arrayDev = raidStatus?.array || '/dev/md0';
      const response = await axios.post(`${serverUrl}/api/storage/mdraid-remove-disk`, {
        array: arrayDev,
        partition: partitionToRemove
      }, { timeout: 300000 });
      if (response.data.success) {
        setRemoveStatus('success');
        setExecutionStatus('success');
        if (response.data.logs) response.data.logs.forEach(log => addLog(log.message, log.type));
        setTimeout(() => { checkRaidStatus(); loadInventory(); loadReshapeOptions(); checkCanGrow(); }, 2000);
      } else {
        setRemoveStatus('error');
        setExecutionStatus('error');
        if (response.data.logs) response.data.logs.forEach(log => addLog(log.message, log.type));
        addLog(`Failed: ${response.data.error}`, 'error');
      }
    } catch (error) {
      setRemoveStatus('error');
      setExecutionStatus('error');
      const msg = error.response?.data?.error || error.message;
      if (error.response?.data?.logs) error.response.data.logs.forEach(log => addLog(log.message, log.type));
      addLog(`Remove failed: ${msg}`, 'error');
    }
  };

  // Grow the RAID array to max size
  const executeGrowArray = async () => {
    setShowGrowModal(false);
    setGrowStatus('running');
    setExecutionStatus('running');
    setLogs([]);
    try {
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      const arrayDev = raidStatus?.array || '/dev/md0';
      const response = await axios.post(`${serverUrl}/api/storage/mdraid-grow-size`, {
        array: arrayDev
      }, { timeout: 300000 });
      if (response.data.success) {
        setGrowStatus('success');
        setExecutionStatus('success');
        if (response.data.logs) response.data.logs.forEach(log => addLog(log.message, log.type));
        setCanGrow(false);
        setTimeout(() => { checkRaidStatus(); loadInventory(); }, 2000);
      } else {
        setGrowStatus('error');
        setExecutionStatus('error');
        if (response.data.logs) response.data.logs.forEach(log => addLog(log.message, log.type));
        addLog(`Failed: ${response.data.error}`, 'error');
      }
    } catch (error) {
      setGrowStatus('error');
      setExecutionStatus('error');
      const msg = error.response?.data?.error || error.message;
      if (error.response?.data?.logs) error.response.data.logs.forEach(log => addLog(log.message, log.type));
      addLog(`Grow failed: ${msg}`, 'error');
    }
  };

  // Check if the array can be grown (members larger than used dev size)
  const checkCanGrow = useCallback(async () => {
    try {
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      const arrayDev = raidStatus?.array || '/dev/md0';
      const response = await axios.post(`${serverUrl}/api/storage/mdraid-grow-size`, {
        array: arrayDev,
        dryRun: true
      }, { timeout: 30000 });
      if (response.data.success && response.data.potentialGrowKB && response.data.potentialGrowKB > 1024) {
        setCanGrow(true);
      } else {
        setCanGrow(false);
      }
    } catch (error) {
      setCanGrow(false);
    }
  }, [raidStatus]);

  // Pre-select current RAID level and member disks when entering manage mode
  useEffect(() => {
    if (mode !== 'manage' || !raidStatus || raidStatus.type !== 'mdadm') return;
    if (raidStatus.level) {
      setMigrateLevel(raidStatus.level.toLowerCase());
    }
    if (raidStatus.members && raidStatus.members.length > 0) {
      const memberParentDisks = raidStatus.members.map((m: any) => m.device.replace(/p?\d+$/, ''));
      const uniqueDisks = [...new Set(memberParentDisks)] as string[];
      setMigrateDisks(prev => {
        const combined = new Set([...prev, ...uniqueDisks]);
        return [...combined];
      });
    }
  }, [mode, raidStatus]);

  // Toggle migrate disk selection
  const handleMigrateDiskToggle = (devicePath: string) => {
    setMigrateDisks(prev =>
      prev.includes(devicePath) ? prev.filter(d => d !== devicePath) : [...prev, devicePath]
    );
  };

  // Compute estimated capacity for auto-migrate
  const getMigrateCapacity = () => {
    if (migrateDisks.length === 0) return 0;
    const levelDef = RAID_LEVELS.find(r => r.id === migrateLevel);
    if (!levelDef) return 0;
    // Find smallest disk size among selected
    let smallest = Infinity;
    for (const dp of migrateDisks) {
      const d = disks.find(dd => dd.path === dp);
      if (d) {
        const bytes = parseSizeToBytes(d.size);
        if (!isNaN(bytes) && bytes < smallest) smallest = bytes;
      }
    }
    if (smallest === Infinity) return 0;
    // Include current RAID members count if their parent disk is in selection
    const totalDisks = migrateDisks.length;
    return Math.floor(levelDef.capacityFormula(totalDisks) * smallest);
  };

  // Check if enough disks for migrate level
  const getMigrateMinDisks = () => {
    const levelDef = RAID_LEVELS.find(r => r.id === migrateLevel);
    return levelDef ? levelDef.minDisks : 2;
  };

  const canMigrate = () => {
    const levelDef = RAID_LEVELS.find(r => r.id === migrateLevel);
    if (!levelDef) return false;
    if (migrateDisks.length < levelDef.minDisks) return false;
    if (levelDef.evenOnly && migrateDisks.length % 2 !== 0) return false;
    if (migrationState && migrationState.status === 'running') return false;
    return true;
  };

  // Start auto-migration
  const executeAutoMigrate = async () => {
    setLogs([]);
    setExecutionStatus('running');
    try {
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      const levelNum = migrateLevel.replace('raid', '');
      const response = await axios.post(`${serverUrl}/api/storage/mdraid-auto-migrate`, {
        level: parseInt(levelNum),
        disks: migrateDisks
      }, { timeout: 30000 });
      if (response.data.success) {
        addLog('Migration started', 'success');
      } else {
        addLog(`Failed: ${response.data.error}`, 'error');
        setExecutionStatus('error');
      }
    } catch (error: any) {
      const msg = error.response?.data?.error || error.message;
      addLog(`Migration error: ${msg}`, 'error');
      setExecutionStatus('error');
    }
  };

  // Stop running migration
  const stopMigration = async () => {
    setStoppingMigration(true);
    try {
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      const response = await axios.post(`${serverUrl}/api/storage/mdraid-migration-stop`, {}, { timeout: 15000 });
      if (response.data.success) {
        addLog('Migration stop requested', 'warning');
      } else {
        addLog(`Stop failed: ${response.data.error}`, 'error');
      }
    } catch (error: any) {
      const msg = error.response?.data?.error || error.message;
      addLog(`Stop error: ${msg}`, 'error');
    } finally {
      setStoppingMigration(false);
    }
  };

  // Poll migration status (fallback if socket missed)
  useEffect(() => {
    if (!migrationState || migrationState.status !== 'running') return;
    const intervalId = setInterval(async () => {
      try {
        const accessMode = getCurrentAccessMode() || 'private';
        const serverUrl = getServerUrl(accessMode);
        const response = await axios.get(`${serverUrl}/api/storage/mdraid-migration-status`, { timeout: 10000 });
        if (response.data.success) {
          setMigrationState(response.data.migration);
          if (response.data.migration.status !== 'running') {
            clearInterval(intervalId);
            if (response.data.migration.status === 'completed') {
              setTimeout(() => { checkRaidStatus(); loadInventory(); }, 2000);
            }
          }
        }
      } catch (e) {}
    }, 5000);
    return () => clearInterval(intervalId);
  }, [migrationState?.status]);

  // Load migration state on mount (in case page was refreshed during migration)
  useEffect(() => {
    const loadMigrationState = async () => {
      try {
        const accessMode = getCurrentAccessMode() || 'private';
        const serverUrl = getServerUrl(accessMode);
        const response = await axios.get(`${serverUrl}/api/storage/mdraid-migration-status`, { timeout: 10000 });
        if (response.data.success && response.data.migration && response.data.migration.status === 'running') {
          setMigrationState(response.data.migration);
        }
      } catch (e) {}
    };
    loadMigrationState();
  }, []);

  // Format bytes
  const formatBytes = (bytes) => {
    if (bytes === null || bytes === undefined || isNaN(bytes)) return 'N/A';
    const units = ['B','KB','MB','GB','TB','PB'];
    let i = 0; let val = Number(bytes);
    while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
    return `${val.toFixed(val >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  };

  // Parse lsblk sizes to bytes
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

  // Format power-on hours
  const formatHours = (hours) => {
    if (hours === null || hours === undefined) return 'N/A';
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 365) return `${days}d`;
    const years = (days / 365).toFixed(1);
    return `${years}y`;
  };

  // Health color
  const getHealthColor = (health) => {
    switch (health) {
      case 'good': return '#10b981';
      case 'warning': return '#f59e0b';
      case 'failing': return '#ef4444';
      default: return '#94a3b8';
    }
  };

  // Get available disks (not system, not mounted, not already in RAID)
  const getAvailableDisks = () => {
    return disks.filter(d => !d.isSystemDisk && !d.isMounted && !raidMemberDisksMap[d.path]);
  };

  // Compute available RAID levels based on available disk count
  const getAvailableLevels = () => {
    const availCount = mode === 'create' ? getAvailableDisks().length : 0;
    return RAID_LEVELS.map(level => ({
      ...level,
      available: availCount >= level.minDisks && (!level.evenOnly || availCount >= level.minDisks)
    }));
  };

  return (
    <div className="storage-settings-container">
      <div className="storage-header">
        <h1><FontAwesomeIcon icon={faHdd} /> {t('storageSettings.raidAssistant')}</h1>
        <p className="subtitle">{t('storageSettings.raidAssistantDesc')}</p>
      </div>

      {loading ? (
        <div className="loading-container">
          <FontAwesomeIcon icon={faSpinner} spin size="3x" />
          <p>{t('storageSettings.loadingDisks')}</p>
        </div>
      ) : (
        <>
          {/* Mode selector tabs */}
          <div className="mode-tabs">
            <button className={`mode-tab ${mode === 'overview' ? 'active' : ''}`} onClick={() => { setMode('overview'); setSelectedDisks([]); setSelectedDisk(''); }}>
              <FontAwesomeIcon icon={faHeartbeat} /> {t('storageSettings.diskOverview')}
            </button>
            {!(raidStatus && raidStatus.type === 'mdadm') && (
              <button className={`mode-tab ${mode === 'create' ? 'active' : ''}`} onClick={() => { setMode('create'); setSelectedDisks([]); setSelectedDisk(''); setCanProceed(false); setValidationErrors([]); }}>
                <FontAwesomeIcon icon={faPlus} /> {t('storageSettings.createRaid')}
              </button>
            )}
            {raidStatus && raidStatus.type === 'mdadm' && (
              <button className={`mode-tab ${mode === 'manage' ? 'active' : ''}`} onClick={() => { setMode('manage'); setSelectedDisks([]); setSelectedDisk(''); setCanProceed(false); setValidationErrors([]); loadReshapeOptions(); checkCanGrow(); }}>
                <FontAwesomeIcon icon={faHdd} /> {t('storageSettings.manageRaid')}
              </button>
            )}
          </div>

          {/* ==================== OVERVIEW MODE ==================== */}
          {mode === 'overview' && (
            <>
              {/* Existing RAID info */}
              {dataSource && (
                <div className="data-source-card">
                  <div className="storage-source-icon"><FontAwesomeIcon icon={faHdd} /></div>
                  <div className="source-info">
                    <div className="source-label">{t('storageSettings.dataVolumeSource')}</div>
                    <div className="source-device">{dataSource.device}</div>
                    <div className="source-meta">{dataSource.size} · {dataSource.fstype}</div>
                  </div>
                  <div className="source-badge"><FontAwesomeIcon icon={faCheck} /> {t('storageSettings.detected')}</div>
                </div>
              )}

              {raidStatus && raidStatus.type === 'mdadm' && (
                <div className="raid-status-card">
                  <div className="raid-status-title">
                    <FontAwesomeIcon icon={faCheckCircle} /> {t('storageSettings.raidMdadmActive')}
                  </div>
                  <div className="raid-status-meta">
                    <span className="raid-badge">{raidStatus.array || t('storageSettings.arrayMd0')}</span>
                    <span className="raid-badge">{raidStatus.level?.toUpperCase()}</span>
                    <span className="raid-badge raid-badge-state">{t('storageSettings.state')}: {raidStatus.state}</span>
                    <span className="raid-badge">{t('storageSettings.members')}: {raidStatus.deviceCount}/{raidStatus.totalDevices}</span>
                    {raidStatus.syncProgress !== null && raidStatus.syncProgress !== undefined && (
                      <span className="raid-badge">{t('storageSettings.resync')}: {raidStatus.syncProgress.toFixed(1)}%</span>
                    )}
                  </div>
                  {raidStatus.syncPending && (
                    <div className="raid-pending-alert">
                      <div className="alert-warning" style={{ marginTop: '0.75rem' }}>
                        <FontAwesomeIcon icon={faExclamationTriangle} />
                        <div style={{ flex: 1 }}>
                          <strong>{t('storageSettings.resyncPaused')}</strong>
                          <p style={{ margin: '0.3rem 0 0 0', fontSize: '0.9em' }}>{t('storageSettings.resyncPausedDesc')}</p>
                        </div>
                        <button className="btn-create-raid" style={{ marginLeft: '1rem', whiteSpace: 'nowrap', padding: '0.5rem 1rem' }} onClick={handleActivateArray}>
                          <FontAwesomeIcon icon={faPlay} /> {t('storageSettings.resumeResync')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Display all RAID arrays (including non-mounted ones) */}
              {raidStatus && raidStatus.allArrays && raidStatus.allArrays.length > 1 && (
                <div className="targets-section">
                  <h2><FontAwesomeIcon icon={faLayerGroup} /> Tous les arrays RAID</h2>
                  <div className="disks-grid">
                    {raidStatus.allArrays.map((array: any) => (
                      <div key={array.array} className={`disk-card-simple ${array.mountedOnData ? 'in-raid' : ''}`}>
                        <div className="storage-disk-icon" style={{ background: array.syncing ? 'linear-gradient(135deg, #f59e0b, #d97706)' : 'linear-gradient(135deg, #3b82f6, #2563eb)' }}>
                          <FontAwesomeIcon icon={faHdd} />
                        </div>
                        <div className="disk-name">{array.array}</div>
                        <div className="disk-size">{array.raidLevel?.toUpperCase()} · {array.activeDevices || 0} disques</div>
                        <div className="disk-health-row">
                          <span className="health-indicator" style={{ color: array.syncing ? '#f59e0b' : '#10b981' }}>
                            {array.syncing ? (
                              <><FontAwesomeIcon icon={faSpinner} spin /> {array.syncProgress?.toFixed(1)}% — {array.syncETA || 'calcul...'}</>
                            ) : (
                              <><FontAwesomeIcon icon={faCheckCircle} /> {array.state || 'clean'}</>
                            )}
                          </span>
                        </div>
                        {array.mountedOnData && (
                          <div className="disk-status">
                            <span className="storage-badge-raid-active">/data</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {!dataSource && !raidStatus && (
                <div className="alert-warning">
                  <FontAwesomeIcon icon={faExclamationTriangle} />
                  <div><strong>{t('storageSettings.info')}:</strong> {t('storageSettings.noRaidDetected')}</div>
                </div>
              )}

              {/* Disk health overview */}
              <div className="targets-section">
                <h2><FontAwesomeIcon icon={faHeartbeat} /> {t('storageSettings.diskHealth')}</h2>
                <p className="section-subtitle">{t('storageSettings.diskHealthDesc')}</p>

                <div className="disks-grid">
                  {disks.map(disk => {
                    const health = diskHealth[disk.path] || {};
                    const diskHasRaidPartition = !!raidMemberDisksMap[disk.path];
                    const healthColor = getHealthColor(health.health);

                    return (
                      <div key={disk.path} className={`disk-card-simple ${diskHasRaidPartition ? 'in-raid' : ''}`}>
                        <div className="storage-disk-icon" style={health.health === 'good' ? { background: `linear-gradient(135deg, ${healthColor}, #059669)` } : health.health === 'failing' ? { background: `linear-gradient(135deg, #ef4444, #dc2626)` } : {}}>
                          <FontAwesomeIcon icon={faHdd} />
                        </div>

                        <div className="disk-name">{disk.path}</div>
                        <div className="disk-size">{disk.size}</div>
                        {health.model && <div className="disk-model">{health.model}</div>}

                        <div className="disk-health-row">
                          <span className="health-indicator" style={{ color: healthColor }}>
                            <FontAwesomeIcon icon={faHeartbeat} /> {health.health === 'good' ? t('storageSettings.healthGood') : health.health === 'warning' ? t('storageSettings.healthWarning') : health.health === 'failing' ? t('storageSettings.healthFailing') : t('storageSettings.healthUnknown')}
                          </span>
                        </div>

                        <div className="disk-health-details">
                          {health.temperature !== null && health.temperature !== undefined && (
                            <span className="health-detail"><FontAwesomeIcon icon={faThermometerHalf} /> {health.temperature}°C</span>
                          )}
                          {health.powerOnHours !== null && health.powerOnHours !== undefined && (
                            <span className="health-detail"><FontAwesomeIcon icon={faClock} /> {formatHours(health.powerOnHours)}</span>
                          )}
                          {health.reallocatedSectors !== null && health.reallocatedSectors > 0 && (
                            <span className="health-detail health-detail-warn">{t('storageSettings.reallocated')}: {health.reallocatedSectors}</span>
                          )}
                        </div>

                        <div className="disk-status">
                          {diskHasRaidPartition && <span className="storage-badge-raid-active">RAID</span>}
                          {disk.isSystemDisk && <span className="storage-badge-system">{t('storageSettings.system')}</span>}
                          {!diskHasRaidPartition && disk.isMounted && !disk.isSystemDisk && <span className="storage-badge-mounted">{t('storageSettings.mounted')}</span>}
                          {!diskHasRaidPartition && !disk.isMounted && !disk.isSystemDisk && <span className="storage-badge-available">{t('storageSettings.available')}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {disks.length === 0 && (
                  <div className="empty-state"><FontAwesomeIcon icon={faHdd} size="3x" /><p>{t('storageSettings.noDiskDetected')}</p></div>
                )}
              </div>
            </>
          )}

          {/* ==================== CREATE MODE ==================== */}
          {mode === 'create' && (
            <>
              {/* Block creation if RAID sync in progress */}
              {resyncProgress && (
                <div className="alert-error" style={{ marginBottom: '1rem' }}>
                  <FontAwesomeIcon icon={faExclamationTriangle} />
                  <div>
                    <strong>Opération RAID en cours</strong>
                    <p style={{ margin: '0.3rem 0 0 0' }}>
                      Un RAID est actuellement en cours de {resyncProgress.array || 'synchronisation'} ({resyncProgress.percent?.toFixed(1)}%). 
                      Veuillez attendre la fin ou arrêter l'opération avant de créer un nouveau RAID.
                    </p>
                    <div style={{ marginTop: '0.5rem' }}>
                      <button 
                        className="btn-danger" 
                        onClick={handleDestroyRaid}
                        style={{ background: '#ef4444', color: 'white', border: 'none', padding: '0.5rem 1rem', borderRadius: '6px', cursor: 'pointer' }}
                      >
                        <FontAwesomeIcon icon={faStop} /> Arrêter et détruire le RAID en cours
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* RAID level selector */}
              <div className="targets-section">
                <h2>{t('storageSettings.chooseRaidLevel')}</h2>
                <p className="section-subtitle">{t('storageSettings.chooseRaidLevelDesc')}</p>

                <div className="raid-levels-grid">
                  {getAvailableLevels().map(level => {
                    const isActive = raidLevel === level.id;
                    const diskCount = selectedDisks.length;
                    const enoughDisks = diskCount >= level.minDisks && (!level.evenOnly || diskCount % 2 === 0 || diskCount === 0);
                    const capacityDisks = level.capacityFormula(Math.max(diskCount, level.minDisks));

                    return (
                      <div
                        key={level.id}
                        className={`raid-level-card ${isActive ? 'active' : ''} ${!level.available ? 'unavailable' : ''}`}
                        onClick={() => level.available && setRaidLevel(level.id)}
                        style={isActive ? { borderColor: level.color, boxShadow: `0 0 20px ${level.color}33` } : {}}
                      >
                        <div className="raid-level-icon" style={{ background: level.available ? level.color : '#94a3b8' }}>
                          <FontAwesomeIcon icon={level.icon} />
                        </div>
                        <div className="raid-level-info">
                          <div className="raid-level-label">{level.label}</div>
                          <div className="raid-level-subtitle">{level.subtitle}</div>
                          <div className="raid-level-meta">
                            <span>{t('storageSettings.minDisks')}: {level.minDisks}</span>
                            <span>{t('storageSettings.faultTolerance')}: {level.faultTolerance} {level.faultTolerance === 1 ? t('storageSettings.disk') : t('storageSettings.disksLower')}</span>
                          </div>
                          <div className="raid-level-desc">{t(level.description)}</div>
                        </div>
                        {isActive && <div className="raid-level-check"><FontAwesomeIcon icon={faCheck} /></div>}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Disk selection for create */}
              <div className="targets-section">
                <h2>{t('storageSettings.selectDisksForRaid')}</h2>
                <p className="section-subtitle">{t('storageSettings.selectDisksDesc')}</p>

                <div className="disks-grid">
                  {disks.map(disk => {
                    const isSelected = selectedDisks.includes(disk.path);
                    const diskHasRaidPartition = !!raidMemberDisksMap[disk.path];
                    const isNonRaidMounted = disk.isMounted && !diskHasRaidPartition;
                    const isDisabled = disk.isSystemDisk || isNonRaidMounted;
                    const health = diskHealth[disk.path] || {};

                    return (
                      <div
                        key={disk.path}
                        className={`disk-card-simple ${isSelected ? 'selected' : ''} ${isDisabled ? 'disabled' : ''}`}
                        onClick={() => !isDisabled && handleDiskToggle(disk.path)}
                      >
                        {isSelected && <div className="disk-check"><FontAwesomeIcon icon={faCheckCircle} /></div>}
                        <div className="storage-disk-icon"><FontAwesomeIcon icon={faHdd} /></div>
                        <div className="disk-name">{disk.path}</div>
                        <div className="disk-size">{disk.size}</div>
                        {health.model && <div className="disk-model">{health.model}</div>}
                        {health.health && (
                          <div className="disk-health-row">
                            <span className="health-indicator" style={{ color: getHealthColor(health.health) }}>
                              <FontAwesomeIcon icon={faHeartbeat} /> {health.health === 'good' ? t('storageSettings.healthGood') : health.health === 'warning' ? t('storageSettings.healthWarning') : health.health === 'failing' ? t('storageSettings.healthFailing') : t('storageSettings.healthUnknown')}
                            </span>
                          </div>
                        )}
                        <div className="disk-status">
                          {diskHasRaidPartition && <span className="storage-badge-raid-active">RAID</span>}
                          {disk.isSystemDisk && <span className="storage-badge-system">{t('storageSettings.system')}</span>}
                          {!diskHasRaidPartition && !disk.isMounted && !disk.isSystemDisk && <span className="storage-badge-available">{t('storageSettings.available')}</span>}
                          {isNonRaidMounted && !disk.isSystemDisk && <span className="storage-badge-mounted">{t('storageSettings.mounted')}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Selection summary */}
                {selectedDisks.length > 0 && (
                  <div className="create-summary">
                    <div className="create-summary-row">
                      <span><strong>{t('storageSettings.selectedDisks')}:</strong> {selectedDisks.length}</span>
                      <span><strong>{t('storageSettings.raidLevelLabel')}:</strong> {raidLevel.toUpperCase()}</span>
                      {expectedCapacity > 0 && <span><strong>{t('storageSettings.expectedCapacity')}:</strong> {formatBytes(expectedCapacity)}</span>}
                    </div>
                  </div>
                )}
              </div>

              {/* Validation & action */}
              {validationErrors.length > 0 && (
                <div className="alert-error"><FontAwesomeIcon icon={faExclamationTriangle} /><div>{validationErrors.map((e, i) => <div key={i}>{e}</div>)}</div></div>
              )}
              {validationWarnings.length > 0 && (
                <div className="alert-warning"><FontAwesomeIcon icon={faExclamationTriangle} /><div>{validationWarnings.map((w, i) => <div key={i}>{w}</div>)}</div></div>
              )}

              <div className="action-section">
                <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', alignItems: 'center' }}>
                  <button className="btn-create-raid" disabled={!canProceed || executionStatus === 'running' || resyncProgress} onClick={openConfirmModal}>
                    {executionStatus === 'running' ? (
                      <><FontAwesomeIcon icon={faSpinner} spin /> {t('storageSettings.creatingInProgress')}...</>
                    ) : resyncProgress ? (
                      <><FontAwesomeIcon icon={faSpinner} spin /> RAID en cours...</>
                    ) : (
                      <><FontAwesomeIcon icon={faPlay} /> {t('storageSettings.createRaidArray')}</>
                    )}
                  </button>
                  {resyncProgress && (
                    <button onClick={handleDestroyRaid} disabled={executionStatus === 'running'} style={{ background: '#f44336', color: 'white', border: 'none', padding: '0.75rem 1.5rem', borderRadius: '8px', cursor: executionStatus === 'running' ? 'not-allowed' : 'pointer', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '0.5rem', opacity: executionStatus === 'running' ? 0.5 : 1 }}>
                      <FontAwesomeIcon icon={faStop} /> {t('storageSettings.destroyRaid')}
                    </button>
                  )}
                </div>
              </div>
            </>
          )}

          {/* ==================== MANAGE MODE ==================== */}
          {mode === 'manage' && raidStatus && raidStatus.type === 'mdadm' && (
            <>
              {/* Current RAID status */}
              <div className="raid-status-card">
                <div className="raid-status-title"><FontAwesomeIcon icon={faCheckCircle} /> {t('storageSettings.raidMdadmActive')}</div>
                <div className="raid-status-meta">
                  <span className="raid-badge">{raidStatus.array || t('storageSettings.arrayMd0')}</span>
                  <span className="raid-badge">{raidStatus.level?.toUpperCase()}</span>
                  <span className="raid-badge raid-badge-state">{t('storageSettings.state')}: {raidStatus.state}</span>
                  <span className="raid-badge">{t('storageSettings.members')}: {raidStatus.deviceCount}/{raidStatus.totalDevices}</span>
                  {raidStatus.syncProgress !== null && raidStatus.syncProgress !== undefined && (
                    <span className="raid-badge">{t('storageSettings.resync')}: {raidStatus.syncProgress.toFixed(1)}%</span>
                  )}
                </div>
                {raidStatus.syncPending && (
                  <div className="raid-pending-alert">
                    <div className="alert-warning" style={{ marginTop: '0.75rem' }}>
                      <FontAwesomeIcon icon={faExclamationTriangle} />
                      <div style={{ flex: 1 }}>
                        <strong>{t('storageSettings.resyncPaused')}</strong>
                        <p style={{ margin: '0.3rem 0 0 0', fontSize: '0.9em' }}>{t('storageSettings.resyncPausedDesc')}</p>
                      </div>
                      <button className="btn-create-raid" style={{ marginLeft: '1rem', whiteSpace: 'nowrap', padding: '0.5rem 1rem' }} onClick={handleActivateArray}>
                        <FontAwesomeIcon icon={faPlay} /> {t('storageSettings.resumeResync')}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {smartSuggestion && smartSuggestion.type === 'replace_small' && (
                <div className="alert-warning" style={{ marginTop: '1rem' }}>
                  <FontAwesomeIcon icon={faExclamationTriangle} />
                  <div>
                    <strong>{t('storageSettings.smartSuggestion')}:</strong>
                    <p style={{ margin: '0.5rem 0 0 0' }}>{stripEmojis(smartSuggestion.message)}</p>
                  </div>
                </div>
              )}

              {/* RAID Members — show current members with health info */}
              {raidStatus.members && raidStatus.members.length > 0 && (
                <div className="targets-section">
                  <h2><FontAwesomeIcon icon={faHdd} /> {t('storageSettings.raidMembers')}</h2>
                  <p className="section-subtitle">{t('storageSettings.raidMembersDesc')}</p>

                  <div className="disks-grid">
                    {raidStatus.members.map((member: any) => {
                      const parentDisk = member.device.replace(/p?\d+$/, '');
                      const health = diskHealth[parentDisk] || {};
                      const healthColor = getHealthColor(health.health);

                      return (
                        <div key={member.device} className="disk-card-simple in-raid">
                          <div className="storage-disk-icon" style={{ background: member.state === 'active' ? 'linear-gradient(135deg, #10b981, #059669)' : member.state === 'spare' ? 'linear-gradient(135deg, #f59e0b, #d97706)' : 'linear-gradient(135deg, #ef4444, #dc2626)' }}>
                            <FontAwesomeIcon icon={faHdd} />
                          </div>
                          <div className="disk-name">{member.device}</div>
                          <div className="disk-size">{member.size ? formatBytes(member.size) : 'N/A'}</div>
                          {health.model && <div className="disk-model">{health.model}</div>}
                          <div className="disk-health-row">
                            <span className="health-indicator" style={{ color: member.state === 'active' ? '#10b981' : member.state === 'spare' ? '#f59e0b' : '#ef4444' }}>
                              <FontAwesomeIcon icon={faCheckCircle} /> {member.state}
                            </span>
                          </div>
                          <div className="disk-health-details">
                            {health.temperature !== null && health.temperature !== undefined && (
                              <span className="health-detail"><FontAwesomeIcon icon={faThermometerHalf} /> {health.temperature}°C</span>
                            )}
                            {health.powerOnHours !== null && health.powerOnHours !== undefined && (
                              <span className="health-detail"><FontAwesomeIcon icon={faClock} /> {formatHours(health.powerOnHours)}</span>
                            )}
                            {health.health && (
                              <span className="health-detail" style={{ color: healthColor }}>
                                <FontAwesomeIcon icon={faHeartbeat} /> {health.health === 'good' ? t('storageSettings.healthGood') : health.health === 'warning' ? t('storageSettings.healthWarning') : health.health === 'failing' ? t('storageSettings.healthFailing') : t('storageSettings.healthUnknown')}
                              </span>
                            )}
                          </div>
                          {raidStatus.deviceCount > 1 && !resyncProgress && (
                            <button
                              className="btn-remove-member"
                              style={{ marginTop: '0.5rem', background: '#ef4444', color: 'white', border: 'none', padding: '0.4rem 0.8rem', borderRadius: '6px', cursor: 'pointer', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.3rem', width: '100%', justifyContent: 'center' }}
                              disabled={removeStatus === 'running' || executionStatus === 'running'}
                              onClick={(e) => { e.stopPropagation(); setPartitionToRemove(member.device); setShowRemoveModal(true); }}
                            >
                              <FontAwesomeIcon icon={faMinus} /> {t('storageSettings.removeMember')}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Grow array button */}
                  {canGrow && !resyncProgress && (
                    <div style={{ display: 'flex', justifyContent: 'center', marginTop: '1rem' }}>
                      <button
                        className="btn-create-raid"
                        style={{ background: '#10b981' }}
                        disabled={growStatus === 'running' || executionStatus === 'running'}
                        onClick={() => setShowGrowModal(true)}
                      >
                        {growStatus === 'running' ? (
                          <><FontAwesomeIcon icon={faSpinner} spin /> {t('storageSettings.growingInProgress')}...</>
                        ) : (
                          <><FontAwesomeIcon icon={faExpand} /> {t('storageSettings.growArray')}</>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* ==================== MIGRATION / CONFIGURATION SECTION ==================== */}
              <div className="targets-section">
                <h2><FontAwesomeIcon icon={faExchangeAlt} /> {t('storageSettings.autoMigrate')}</h2>
                <p className="section-subtitle">{t('storageSettings.autoMigrateDesc')}</p>

                {/* Migration in progress — show timeline */}
                {migrationState && migrationState.status === 'running' && (
                  <div style={{ marginBottom: '1.5rem' }}>
                    {/* Global progress bar */}
                    <div style={{ marginBottom: '1rem' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.3rem' }}>
                        <strong>{t('storageSettings.globalProgress')}</strong>
                        <span style={{ fontWeight: 'bold', color: '#2196f3' }}>{migrationState.globalProgress}%</span>
                      </div>
                      <div style={{ width: '100%', height: '12px', background: '#e0e0e0', borderRadius: '6px', overflow: 'hidden' }}>
                        <div style={{ width: `${migrationState.globalProgress}%`, height: '100%', background: 'linear-gradient(90deg, #2196f3, #1976d2)', transition: 'width 0.5s ease' }} />
                      </div>
                    </div>

                    {/* Steps timeline */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                      {migrationState.steps && migrationState.steps.map((step: any, idx: number) => {
                        const statusColor = step.status === 'completed' ? '#10b981' : step.status === 'running' ? '#2196f3' : step.status === 'error' ? '#ef4444' : step.status === 'skipped' ? '#94a3b8' : '#d1d5db';
                        const statusIcon = step.status === 'completed' ? faCheckCircle : step.status === 'running' ? faSpinner : step.status === 'error' ? faExclamationTriangle : step.status === 'skipped' ? faMinus : faClock;
                        return (
                          <div key={idx} style={{ background: step.status === 'running' ? '#eff6ff' : '#fff', border: `1px solid ${step.status === 'running' ? '#93c5fd' : '#e5e7eb'}`, borderRadius: '8px', padding: '0.75rem 1rem' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                              <span style={{ color: statusColor, fontSize: '1.1rem', width: '24px', textAlign: 'center' }}>
                                <FontAwesomeIcon icon={statusIcon} spin={step.status === 'running'} />
                              </span>
                              <div style={{ flex: 1 }}>
                                <div style={{ fontWeight: '600', fontSize: '0.95rem' }}>
                                  {t('storageSettings.migrationSteps')} {idx + 1}/{migrationState.totalSteps}: {step.name}
                                </div>
                                {step.message && <div style={{ fontSize: '0.85rem', color: '#666', marginTop: '0.2rem' }}>{step.message}</div>}
                              </div>
                              <span style={{ fontSize: '0.85rem', fontWeight: '600', color: statusColor }}>
                                {step.status === 'completed' ? t('storageSettings.stepCompleted')
                                  : step.status === 'running' ? `${step.progress}%`
                                  : step.status === 'error' ? t('storageSettings.stepError')
                                  : step.status === 'skipped' ? t('storageSettings.stepSkipped')
                                  : t('storageSettings.stepPending')}
                              </span>
                            </div>
                            {step.status === 'running' && step.progress > 0 && (
                              <div style={{ marginTop: '0.5rem' }}>
                                <div style={{ width: '100%', height: '6px', background: '#e0e0e0', borderRadius: '3px', overflow: 'hidden' }}>
                                  <div style={{ width: `${step.progress}%`, height: '100%', background: '#2196f3', transition: 'width 0.5s ease' }} />
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {/* Stop button */}
                    <div style={{ display: 'flex', justifyContent: 'center', marginTop: '1rem' }}>
                      <button
                        className="btn-create-raid"
                        style={{ background: '#ef4444' }}
                        disabled={stoppingMigration}
                        onClick={stopMigration}
                      >
                        {stoppingMigration ? (
                          <><FontAwesomeIcon icon={faSpinner} spin /> {t('storageSettings.stopping')}...</>
                        ) : (
                          <><FontAwesomeIcon icon={faStop} /> {t('storageSettings.stopMigration')}</>
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {/* Migration completed */}
                {migrationState && migrationState.status === 'completed' && (
                  <div style={{ background: '#ecfdf5', border: '1px solid #6ee7b7', borderRadius: '8px', padding: '1rem', marginBottom: '1rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#059669', fontWeight: '600' }}>
                      <FontAwesomeIcon icon={faCheckCircle} /> {t('storageSettings.migrationComplete')}
                    </div>
                  </div>
                )}

                {/* Migration stopped */}
                {migrationState && migrationState.status === 'stopped' && (
                  <div style={{ background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: '8px', padding: '1rem', marginBottom: '1rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#d97706', fontWeight: '600' }}>
                      <FontAwesomeIcon icon={faStop} /> {t('storageSettings.migrationStopped')}
                    </div>
                    {migrationState.error && <p style={{ margin: '0.3rem 0 0 0', color: '#92400e' }}>{migrationState.error}</p>}
                  </div>
                )}

                {/* Migration error */}
                {migrationState && (migrationState.status === 'error') && (
                  <div className="alert-error" style={{ marginBottom: '1rem' }}>
                    <FontAwesomeIcon icon={faExclamationTriangle} />
                    <div>
                      <strong>{t('storageSettings.migrationError')}</strong>
                      {migrationState.error && <p style={{ margin: '0.3rem 0 0 0' }}>{migrationState.error}</p>}
                    </div>
                  </div>
                )}

                {/* Resync in progress — block migration controls */}
                {resyncProgress && (!migrationState || migrationState.status !== 'running') && (
                  <div className="alert-warning" style={{ marginTop: '1rem' }}>
                    <FontAwesomeIcon icon={faSpinner} spin />
                    <div>
                      <strong>{t('storageSettings.resyncInProgress')}</strong>
                      <p style={{ margin: '0.3rem 0 0 0' }}>{t('storageSettings.resyncBlocksMigration')}</p>
                    </div>
                  </div>
                )}

                {/* RAID level selector for migration (only when not migrating and no resync) */}
                {(!migrationState || migrationState.status !== 'running') && !resyncProgress && (
                  <>
                    <h3 style={{ marginTop: '1rem', marginBottom: '0.5rem' }}>{t('storageSettings.targetRaidLevel')}</h3>
                    <div className="raid-levels-grid">
                      {RAID_LEVELS.filter(l => l.id !== 'raid0').map(level => {
                        const isActive = migrateLevel === level.id;
                        const totalDisks = migrateDisks.length;
                        const enoughDisks = totalDisks >= level.minDisks && (!level.evenOnly || totalDisks % 2 === 0 || totalDisks === 0);

                        return (
                          <div
                            key={level.id}
                            className={`raid-level-card ${isActive ? 'active' : ''}`}
                            onClick={() => setMigrateLevel(level.id)}
                            style={isActive ? { borderColor: level.color, boxShadow: `0 0 20px ${level.color}33` } : {}}
                          >
                            <div className="raid-level-icon" style={{ background: level.color }}>
                              <FontAwesomeIcon icon={level.icon} />
                            </div>
                            <div className="raid-level-info">
                              <div className="raid-level-label">{level.label}</div>
                              <div className="raid-level-subtitle">{level.subtitle}</div>
                              <div className="raid-level-meta">
                                <span>{t('storageSettings.minDisks')}: {level.minDisks}</span>
                                <span>{t('storageSettings.faultTolerance')}: {level.faultTolerance} {level.faultTolerance === 1 ? t('storageSettings.disk') : t('storageSettings.disksLower')}</span>
                              </div>
                            </div>
                            {isActive && <div className="raid-level-check"><FontAwesomeIcon icon={faCheck} /></div>}
                          </div>
                        );
                      })}
                    </div>

                    {/* Disk selection for migration */}
                    <h3 style={{ marginTop: '1.5rem', marginBottom: '0.5rem' }}>{t('storageSettings.selectDisksToMigrate')}</h3>
                    <p className="section-subtitle">{t('storageSettings.selectDisksToMigrateDesc')}</p>

                    <div className="disks-grid">
                      {disks.map(disk => {
                        const isSelected = migrateDisks.includes(disk.path);
                        const isDisabled = disk.isSystemDisk || (disk.isMounted && !raidMemberDisksMap[disk.path]);
                        const health = diskHealth[disk.path] || {};
                        const diskHasRaidPartition = !!raidMemberDisksMap[disk.path];

                        return (
                          <div
                            key={disk.path}
                            className={`disk-card-simple ${isSelected ? 'selected' : ''} ${isDisabled ? 'disabled' : ''}`}
                            onClick={() => !isDisabled && handleMigrateDiskToggle(disk.path)}
                          >
                            {isSelected && <div className="disk-check"><FontAwesomeIcon icon={faCheckCircle} /></div>}
                            <div className="storage-disk-icon"><FontAwesomeIcon icon={faHdd} /></div>
                            <div className="disk-name">{disk.path}</div>
                            <div className="disk-size">{disk.size}</div>
                            {health.model && <div className="disk-model">{health.model}</div>}
                            <div className="disk-status">
                              {diskHasRaidPartition && <span className="storage-badge-raid-active">RAID</span>}
                              {disk.isSystemDisk && <span className="storage-badge-system">{t('storageSettings.system')}</span>}
                              {!diskHasRaidPartition && !disk.isMounted && !disk.isSystemDisk && <span className="storage-badge-available">{t('storageSettings.available')}</span>}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Selection summary + capacity estimate */}
                    {migrateDisks.length > 0 && (
                      <div className="create-summary" style={{ marginTop: '1rem' }}>
                        <div className="create-summary-row">
                          <span><strong>{t('storageSettings.selectedDisks')}:</strong> {migrateDisks.length}</span>
                          <span><strong>{t('storageSettings.raidLevelLabel')}:</strong> {migrateLevel.toUpperCase()}</span>
                          {getMigrateCapacity() > 0 && (
                            <span><strong>{t('storageSettings.usableCapacity')}:</strong> {formatBytes(getMigrateCapacity())}</span>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Validation */}
                    {migrateDisks.length > 0 && migrateDisks.length < getMigrateMinDisks() && (
                      <div className="alert-error" style={{ marginTop: '0.5rem' }}>
                        <FontAwesomeIcon icon={faExclamationTriangle} />
                        <div>{t('storageSettings.notEnoughDisksForLevel', { level: migrateLevel.replace('raid', ''), min: getMigrateMinDisks() })}</div>
                      </div>
                    )}

                    {/* Apply button */}
                    <div style={{ display: 'flex', justifyContent: 'center', marginTop: '1rem' }}>
                      <button
                        className="btn-create-raid"
                        style={{ background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}
                        disabled={!canMigrate() || executionStatus === 'running'}
                        onClick={executeAutoMigrate}
                      >
                        <FontAwesomeIcon icon={faPlay} /> {t('storageSettings.applyMigration')}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </>
          )}

          {/* ==================== RESYNC PROGRESS (shared) ==================== */}
          {resyncProgress && (
            <div className="resync-progress-section" style={{ background: '#fff', border: '1px solid #e0e0e0', borderRadius: '8px', padding: '1.5rem', marginBottom: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: '600' }}>{t('storageSettings.resyncInProgress')}</h3>
                <span style={{ fontSize: '1.2rem', fontWeight: 'bold', color: '#2196f3' }}>{resyncProgress.percent.toFixed(1)}%</span>
              </div>
              <div style={{ width: '100%', height: '24px', background: '#e0e0e0', borderRadius: '12px', overflow: 'hidden', marginBottom: '0.5rem' }}>
                <div style={{ width: `${resyncProgress.percent}%`, height: '100%', background: 'linear-gradient(90deg, #2196f3, #1976d2)', transition: 'width 0.5s ease', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: '8px', color: 'white', fontSize: '0.85rem', fontWeight: 'bold' }}>
                  {resyncProgress.percent > 10 && `${resyncProgress.percent.toFixed(1)}%`}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', gap: '1rem', fontSize: '0.9rem', color: '#666' }}>
                  {resyncProgress.eta && <span><FontAwesomeIcon icon={faClock} /> {t('storageSettings.timeRemaining')}: <strong>{resyncProgress.eta}</strong></span>}
                  {resyncProgress.speed && <span><FontAwesomeIcon icon={faBolt} /> {t('storageSettings.speed')}: <strong>{resyncProgress.speed}</strong></span>}
                </div>
                <button
                  className="btn-create-raid"
                  style={{ background: '#ef4444', padding: '0.4rem 1rem', fontSize: '0.85rem' }}
                  onClick={handleStopResync}
                >
                  <FontAwesomeIcon icon={faStop} /> {t('storageSettings.stopResync')}
                </button>
              </div>
            </div>
          )}

          {/* ==================== LOGS (shared) ==================== */}
          {(mode === 'create' || mode === 'manage') && (
            <div className="logs-section">
              <div className="logs-header">
                <h2>{t('storageSettings.executionLogs')}</h2>
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
                  <p className="logs-placeholder">{t('storageSettings.noLogsYet')}</p>
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
          )}
        </>
      )}

      {/* ==================== MODALS ==================== */}
      {/* Smart optimization modal */}
      {showConfirmModal && smartOptimization && mode === 'manage' && (
        <div className="modal-overlay" onClick={() => setShowConfirmModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h2>{t('storageSettings.smartOptimization')}</h2>
            <div className="modal-section" style={{ background: '#e3f2fd', padding: '1rem', borderRadius: '6px', marginBottom: '1rem' }}>
              <h3 style={{ color: '#1976d2', margin: '0 0 0.5rem 0' }}>{t('storageSettings.optimizationOpportunity')}</h3>
              <p style={{ margin: '0', fontSize: '0.95rem' }}>{stripEmojis(smartOptimization.message)}</p>
            </div>
            <div className="modal-warning">
              <FontAwesomeIcon icon={faExclamationTriangle} />
              <div><strong>ATTENTION:</strong> {t('storageSettings.optimizationWarning')}</div>
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setShowConfirmModal(false)}>{t('storageSettings.cancel')}</button>
              <button className="btn-primary" style={{ background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', color: '#fff', border: 'none', padding: '0.75rem 2rem', borderRadius: '8px', fontWeight: '600', cursor: 'pointer' }} onClick={executeSmartOptimization}>{t('storageSettings.optimizeRaid')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Add disk(s) to existing RAID modal */}
      {showConfirmModal && !smartOptimization && mode === 'manage' && (
        <div className="modal-overlay" onClick={() => setShowConfirmModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h2>{t('storageSettings.confirmAddDisk')}</h2>
            <div className="modal-section">
              <h3>{t('storageSettings.configSummary')}</h3>
              <div className="summary-grid">
                <div className="summary-item"><strong>Array:</strong> {raidStatus?.array || '/dev/md0'}</div>
                <div className="summary-item"><strong>{t('storageSettings.diskToAdd')}:</strong> {selectedDisks.join(', ')}</div>
                {selectedDisks.length > 1 && (
                  <div className="summary-item"><strong>Mode:</strong> Parallel preparation</div>
                )}
              </div>
            </div>
            <div className="modal-section">
              <h3>{t('storageSettings.commandsToExecute')}</h3>
              <div className="commands-list">
                {commandsList.map((cmd, index) => (
                  <div key={index} className="command-item"><code className="command-code">{cmd.command}</code></div>
                ))}
              </div>
            </div>
            <div className="modal-warning">
              <FontAwesomeIcon icon={faExclamationTriangle} />
              <strong>ATTENTION:</strong> {t('storageSettings.diskWillBeErasedWarning', { disk: selectedDisks.join(', ') })}
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setShowConfirmModal(false)}>{t('storageSettings.cancel')}</button>
              <button className="btn-danger" onClick={executeAddDisk}>{t('storageSettings.addToRaid')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Reshape confirmation modal */}
      {showReshapeModal && selectedReshapeLevel && (
        <div className="modal-overlay" onClick={() => setShowReshapeModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h2><FontAwesomeIcon icon={faExchangeAlt} /> {t('storageSettings.confirmReshape')}</h2>
            <div className="modal-section">
              <h3>{t('storageSettings.configSummary')}</h3>
              <div className="summary-grid">
                <div className="summary-item"><strong>Array:</strong> {raidStatus?.array || reshapeOptions?.array}</div>
                <div className="summary-item"><strong>{t('storageSettings.currentLevel')}:</strong> {reshapeOptions?.currentLevel?.toUpperCase()}</div>
                <div className="summary-item"><strong>{t('storageSettings.targetLevel')}:</strong> {selectedReshapeLevel.toUpperCase()}</div>
                <div className="summary-item"><strong>{t('storageSettings.activeDisks')}:</strong> {reshapeOptions?.activeDevices}</div>
                {reshapeOptions?.options?.find((o: any) => o.level === selectedReshapeLevel)?.capacityEstimate && (
                  <div className="summary-item"><strong>{t('storageSettings.estimatedCapacity')}:</strong> {reshapeOptions.options.find((o: any) => o.level === selectedReshapeLevel).capacityEstimate}</div>
                )}
              </div>
            </div>
            <div className="modal-warning">
              <FontAwesomeIcon icon={faExclamationTriangle} />
              <div>
                <strong>ATTENTION:</strong> {t('storageSettings.reshapeWarning')}
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setShowReshapeModal(false)}>{t('storageSettings.cancel')}</button>
              <button className="btn-danger" style={{ background: '#6366f1' }} onClick={executeReshape}>
                <FontAwesomeIcon icon={faExchangeAlt} /> {t('storageSettings.convertTo')} {selectedReshapeLevel.toUpperCase()}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Auto-migrate confirmation modal removed — migration starts directly */}

      {/* Setup mode: Continue to create account */}
      {isSetupMode && (
        <div className="setup-continue-section" style={{ marginTop: '2rem', padding: '1.5rem', background: 'linear-gradient(135deg, #e8f4fd 0%, #d1ecf9 100%)', borderRadius: '12px', textAlign: 'center', border: '1px solid #b8daff' }}>
          <p style={{ margin: '0 0 1rem 0', fontSize: '1.05em', color: '#333' }}>
            {t('storageSettings.setupContinueDesc')}
          </p>
          <button
            className="btn-create-raid"
            style={{ padding: '0.75rem 2rem', fontSize: '1.05em' }}
            onClick={() => navigate('/first-time-setup')}
          >
            <FontAwesomeIcon icon={faUserPlus} style={{ marginRight: '0.5rem' }} />
            {t('storageSettings.setupContinueButton')}
            <FontAwesomeIcon icon={faArrowRight} style={{ marginLeft: '0.5rem' }} />
          </button>
        </div>
      )}

      {/* Create new RAID modal */}
      {showConfirmModal && mode === 'create' && (
        <div className="modal-overlay" onClick={() => setShowConfirmModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h2>{t('storageSettings.confirmCreateRaid')}</h2>
            <div className="modal-section">
              <h3>{t('storageSettings.configSummary')}</h3>
              <div className="summary-grid">
                <div className="summary-item"><strong>{t('storageSettings.raidLevelLabel')}:</strong> {raidLevel.toUpperCase()}</div>
                <div className="summary-item"><strong>{t('storageSettings.disksLabel')}:</strong> {selectedDisks.join(', ')}</div>
                {expectedCapacity > 0 && <div className="summary-item"><strong>{t('storageSettings.expectedCapacity')}:</strong> {formatBytes(expectedCapacity)}</div>}
              </div>
            </div>
            <div className="modal-section">
              <h3>{t('storageSettings.commandsToExecute')}</h3>
              <div className="commands-list">
                {commandsList.map((cmd, index) => (
                  <div key={index} className="command-item"><code className="command-code">{cmd.command}</code></div>
                ))}
              </div>
            </div>
            <div className="modal-warning">
              <FontAwesomeIcon icon={faExclamationTriangle} />
              <strong>ATTENTION:</strong> {t('storageSettings.createRaidWarning')}
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setShowConfirmModal(false)}>{t('storageSettings.cancel')}</button>
              <button className="btn-danger" onClick={executeCreateRaid}>{t('storageSettings.createRaidArray')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Remove disk confirmation modal */}
      {showRemoveModal && partitionToRemove && (
        <div className="modal-overlay" onClick={() => setShowRemoveModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h2><FontAwesomeIcon icon={faMinus} /> {t('storageSettings.confirmRemoveDisk')}</h2>
            <div className="modal-section">
              <h3>{t('storageSettings.configSummary')}</h3>
              <div className="summary-grid">
                <div className="summary-item"><strong>Array:</strong> {raidStatus?.array || '/dev/md0'}</div>
                <div className="summary-item"><strong>{t('storageSettings.partitionToRemove')}:</strong> {partitionToRemove}</div>
              </div>
            </div>
            <div className="modal-warning">
              <FontAwesomeIcon icon={faExclamationTriangle} />
              <div>
                <strong>ATTENTION:</strong> {t('storageSettings.removeDiskWarning', { partition: partitionToRemove })}
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setShowRemoveModal(false)}>{t('storageSettings.cancel')}</button>
              <button className="btn-danger" onClick={executeRemoveDisk}>
                <FontAwesomeIcon icon={faMinus} /> {t('storageSettings.removeMember')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Grow array confirmation modal */}
      {showGrowModal && (
        <div className="modal-overlay" onClick={() => setShowGrowModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h2><FontAwesomeIcon icon={faExpand} /> {t('storageSettings.confirmGrowArray')}</h2>
            <div className="modal-section">
              <h3>{t('storageSettings.configSummary')}</h3>
              <div className="summary-grid">
                <div className="summary-item"><strong>Array:</strong> {raidStatus?.array || '/dev/md0'}</div>
                <div className="summary-item"><strong>{t('storageSettings.operation')}:</strong> {t('storageSettings.growArrayDesc')}</div>
              </div>
            </div>
            <div className="modal-section" style={{ background: '#e8f5e9', padding: '1rem', borderRadius: '6px' }}>
              <p style={{ margin: 0, fontSize: '0.95rem' }}>{t('storageSettings.growArrayExplanation')}</p>
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setShowGrowModal(false)}>{t('storageSettings.cancel')}</button>
              <button className="btn-danger" style={{ background: '#10b981' }} onClick={executeGrowArray}>
                <FontAwesomeIcon icon={faExpand} /> {t('storageSettings.growArray')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default StorageSettings;
