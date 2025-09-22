import React from 'react';
import { useNavigate } from 'react-router-dom';

const StorageSettings = () => {
  const navigate = useNavigate();
  return (
    <div style={{ padding: '24px' }}>
      <button onClick={() => navigate('/settings')} style={{ marginBottom: 16 }}>
        ← Retour aux paramètres
      </button>
      <h1>Stockage (RAID + Btrfs)</h1>
      <p>
        Assistant en plusieurs étapes pour configurer le stockage Ryvie. Étape 0: squelette uniquement.
        Aucune opération disque ne sera effectuée.
      </p>
      <div style={{
        marginTop: 24,
        padding: 16,
        border: '1px solid #ddd',
        borderRadius: 8,
        background: '#fafafa'
      }}>
        <h2>Étapes (aperçu)</h2>
        <ol>
          <li>Scan lecture seule</li>
          <li>Proposition (dry‑run)</li>
          <li>Préflight (sans écrire)</li>
          <li>Partition (SHR‑like)</li>
          <li>Création RAID</li>
          <li>Persistance mdadm</li>
          <li>Aggregation LVM (si nécessaire)</li>
          <li>Formatage Btrfs</li>
          <li>Montage & fstab</li>
          <li>Sous‑volumes & snapshot initial</li>
          <li>Statut & progression</li>
        </ol>
        <p style={{ color: '#888' }}>
          Les actions seront activées dans les étapes suivantes. Pour l'instant, seule la navigation est opérationnelle.
        </p>
      </div>
    </div>
  );
};

export default StorageSettings;
