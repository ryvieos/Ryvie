import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from '../utils/setupAxios';
import { getServerUrl } from '../config/urls';
import { getCurrentAccessMode } from '../utils/detectAccessMode';

const StorageSettings = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [disks, setDisks] = useState([]);
  const [selected, setSelected] = useState({}); // { idOrDevice: boolean }
  const [proposal, setProposal] = useState(null);
  const [proposalLoading, setProposalLoading] = useState(false);
  const [proposalError, setProposalError] = useState(null);

  const fetchDisks = async () => {
    try {
      setLoading(true);
      setError(null);
      const mode = getCurrentAccessMode() || 'private';
      const base = getServerUrl(mode);
      const resp = await axios.get(`${base}/api/storage/disks`);
      const list = Array.isArray(resp.data?.disks) ? resp.data.disks : [];
      setDisks(list);
      const init = {};
      list.forEach(d => { init[d.id || d.device] = false; });
      setSelected(init);
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'scan_error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchDisks(); }, []);

  const toggle = (d) => {
    if (d.isSystem) return;
    const key = d.id || d.device;
    setSelected(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const proposePlan = async () => {
    try {
      setProposalLoading(true);
      setProposalError(null);
      setProposal(null);
      const ids = Object.entries(selected)
        .filter(([, v]) => !!v)
        .map(([k]) => k);
      if (ids.length < 2) {
        setProposalError('Sélectionnez au moins deux disques');
        setProposalLoading(false);
        return;
      }
      const mode = getCurrentAccessMode() || 'private';
      const base = getServerUrl(mode);
      const resp = await axios.post(`${base}/api/storage/proposal`, { diskIds: ids });
      setProposal(resp.data);
    } catch (e) {
      setProposalError(e?.response?.data?.error || e.message || 'proposal_error');
    } finally {
      setProposalLoading(false);
    }
  };

  return (
    <div style={{ padding: '24px', color: '#0f172a', background: '#f8fafc', minHeight: '100vh' }}>
      <button onClick={() => navigate('/settings')} style={{ marginBottom: 16 }}>
        ← Retour aux paramètres
      </button>
      <h1 style={{ color: '#111827' }}>Stockage (RAID + Btrfs)</h1>
      <p style={{ color: '#334155' }}>Assistant en plusieurs étapes pour configurer le stockage Ryvie.</p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <button onClick={fetchDisks} disabled={loading}>{loading ? 'Scan en cours…' : 'Rescanner'}</button>
        {error && <span style={{ color: 'crimson' }}>Erreur: {String(error)}</span>}
      </div>

      <div style={{
        marginTop: 8,
        padding: 16,
        border: '1px solid #cbd5e1',
        borderRadius: 12,
        background: '#ffffff',
        boxShadow: '0 1px 2px rgba(16,24,40,0.06)'
      }}>
        <h2 style={{ color: '#0f172a', marginTop: 0 }}>Disques détectés (lecture seule)</h2>
        {loading ? (
          <p style={{ color: '#475569' }}>Chargement…</p>
        ) : disks.length === 0 ? (
          <p style={{ color: '#475569' }}>Aucun disque détecté.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
              <thead>
                <tr style={{ background: '#f1f5f9' }}>
                  <th style={{ textAlign: 'left', borderBottom: '1px solid #e2e8f0', padding: '10px 12px', color: '#0f172a' }}>Sélection</th>
                  <th style={{ textAlign: 'left', borderBottom: '1px solid #e2e8f0', padding: '10px 12px', color: '#0f172a' }}>Périphérique</th>
                  <th style={{ textAlign: 'left', borderBottom: '1px solid #e2e8f0', padding: '10px 12px', color: '#0f172a' }}>Taille</th>
                  <th style={{ textAlign: 'left', borderBottom: '1px solid #e2e8f0', padding: '10px 12px', color: '#0f172a' }}>Système</th>
                  <th style={{ textAlign: 'left', borderBottom: '1px solid #e2e8f0', padding: '10px 12px', color: '#0f172a' }}>Monté</th>
                  <th style={{ textAlign: 'left', borderBottom: '1px solid #e2e8f0', padding: '10px 12px', color: '#0f172a' }}>Partitions</th>
                </tr>
              </thead>
              <tbody>
                {disks.map(d => {
                  const key = d.id || d.device;
                  return (
                    <tr key={key}>
                      <td style={{ padding: '10px 12px', borderBottom: '1px solid #f1f5f9' }}>
                        <input type="checkbox" checked={!!selected[key]} onChange={() => toggle(d)} disabled={!!d.isSystem} />
                      </td>
                      <td style={{ padding: '10px 12px', borderBottom: '1px solid #f1f5f9' }}>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <strong>{d.device}</strong>
                          <small style={{ color: '#888' }}>{d.id}</small>
                        </div>
                      </td>
                      <td style={{ padding: '10px 12px', borderBottom: '1px solid #f1f5f9' }}>{d.sizeHuman || `${d.sizeBytes} B`}</td>
                      <td style={{ padding: '10px 12px', borderBottom: '1px solid #f1f5f9' }}>{d.isSystem ? <span style={{ color: '#b91c1c', background: '#fee2e2', padding: '2px 6px', borderRadius: 6 }}>Oui</span> : <span style={{ color: '#065f46', background: '#d1fae5', padding: '2px 6px', borderRadius: 6 }}>Non</span>}</td>
                      <td style={{ padding: '10px 12px', borderBottom: '1px solid #f1f5f9' }}>{d.isMounted ? <span style={{ color: '#b45309', background: '#fef3c7', padding: '2px 6px', borderRadius: 6 }}>Monté{d.mountpoint ? ` (${d.mountpoint})` : ''}</span> : <span style={{ color: '#334155' }}>Non</span>}</td>
                      <td style={{ padding: '10px 12px', borderBottom: '1px solid #f1f5f9' }}>
                        {(d.partitions || []).length ? (
                          <ul style={{ margin: 0, paddingLeft: 18 }}>
                            {d.partitions.map(p => (
                              <li key={p.path}>{p.path} — {p.fs || 'no-fs'} — {p.sizeBytes} B</li>
                            ))}
                          </ul>
                        ) : <span style={{ color: '#888' }}>Aucune</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p style={{ color: '#475569', marginTop: 12 }}>
          Les cases sont désactivées pour les disques système. Un avertissement est affiché si un disque est monté.
        </p>
      </div>

      {/* Step 2 — Proposition (dry-run) */}
       <div style={{
        marginTop: 16,
        padding: 16,
        border: '1px solid #cbd5e1',
        borderRadius: 12,
        background: '#ffffff',
        boxShadow: '0 1px 2px rgba(16,24,40,0.06)'
      }}>
        <h2 style={{ color: '#0f172a', marginTop: 0 }}>Étape 2 — Proposition (dry‑run)</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <button onClick={proposePlan} disabled={proposalLoading} style={{ background: '#111827', color: '#fff', padding: '8px 12px', border: 0, borderRadius: 8 }}>
            {proposalLoading ? 'Calcul en cours…' : 'Proposer un plan'}
          </button>
          {proposalError && <span style={{ color: '#b91c1c' }}>Erreur: {String(proposalError)}</span>}
        </div>
        {proposal && (
          <div style={{ marginTop: 8, color: '#334155' }}>
            <div>Type suggéré: <strong>{proposal.suggested}</strong></div>
            <div>Capacité: <strong>{proposal.capacityBytes} B</strong></div>
            <div>Tolérance aux pannes: <strong>{proposal.faultTolerance}</strong></div>
            <div style={{ marginTop: 8 }}>
              <div>Plan:</div>
              <ul>
                {(proposal.planPreview || []).map((s, idx) => (
                  <li key={idx}>{s.step}{s.fs ? ` (fs: ${s.fs})` : ''}{s.mountpoint ? ` → ${s.mountpoint}` : ''}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>

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
      </div>
    </div>
  );
};

export default StorageSettings;
