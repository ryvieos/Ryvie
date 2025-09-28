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
  // Step 3 — Préflight (sans écrire)
  const [preflightAck, setPreflightAck] = useState(false);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightError, setPreflightError] = useState(null);
  const [preflightReport, setPreflightReport] = useState(null);

  const fetchDisks = async () => {
    try {
      setLoading(true);
      setError(null);
      const mode = getCurrentAccessMode() || 'private';
      const base = getServerUrl(mode);
      const resp = await axios.get(`${base}/api/storage/disks`);
      const list = Array.isArray(resp.data?.disks) ? resp.data.disks : [];
      setDisks(list);
      // Sélection automatique: source = disque/partition monté sur /data, cible = premier disque non-système
      const init = {};
      let sourceDiskKey = null;
      list.forEach(d => {
        const key = d.id || d.device;
        const hasDataMount = (d.mountpoint === '/data') || (Array.isArray(d.partitions) && d.partitions.some(p => p.mountpoint === '/data'));
        if (hasDataMount) {
          sourceDiskKey = key;
          init[key] = true;
        } else {
          init[key] = false;
        }
      });
      if (sourceDiskKey) {
        // pick a default target disk: first non-system and not the source
        const target = list.find(d => !(d.isSystem) && (d.id || d.device) !== sourceDiskKey);
        if (target) init[target.id || target.device] = true;
      }
      setSelected(init);
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'scan_error');
    } finally {
      setLoading(false);
    }
  };

  const humanize = (b) => {
    const unit = 1024;
    const n = Number(b || 0);
    if (n < unit) return `${n|0} B`;
    const exp = Math.floor(Math.log(n) / Math.log(unit));
    const pre = 'KMGTPE'.charAt(exp - 1);
    const val = (n / Math.pow(unit, exp)).toFixed(1);
    return `${val} ${pre}B`;
  };

  // Étape 3 — Préflight (sans écrire)
  const runPreflight = async () => {
    try {
      setPreflightLoading(true);
      setPreflightError(null);
      setPreflightReport(null);
      const body = buildRaid1Body();
      if (!body) {
        setPreflightError('Impossible de déterminer source=/data et une cible valide.');
        setPreflightLoading(false);
        return;
      }
      if (!preflightAck) {
        setPreflightError("Veuillez cocher l'accusé de compréhension : seuls les disques non-système seront formatés pour créer le RAID.");
        setPreflightLoading(false);
        return;
      }
      const mode = getCurrentAccessMode() || 'private';
      const base = getServerUrl(mode);
      const resp = await axios.post(`${base}/api/storage/preflight`, body);
      setPreflightReport(resp.data);
    } catch (e) {
      setPreflightError(e?.response?.data?.error || e.message || 'preflight_error');
    } finally {
      setPreflightLoading(false);
    }
  };

  useEffect(() => { fetchDisks(); }, []);

  const toggle = (d) => {
    if (d.isSystem) return; // Empêcher la désélection du système
    const key = d.id || d.device;
    setSelected(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const proposePlan = async () => {
    try {
      setProposalLoading(true);
      setProposalError(null);
      setProposal(null);
      const body = buildRaid1Body();
      if (!body) {
        setProposalError('Impossible de déterminer source=/data et une cible valide.');
        setProposalLoading(false);
        return;
      }
      const mode = getCurrentAccessMode() || 'private';
      const base = getServerUrl(mode);
      const resp = await axios.post(`${base}/api/storage/proposal`, body);
      setProposal(resp.data);
    } catch (e) {
      setProposalError(e?.response?.data?.error || e.message || 'proposal_error');
    } finally {
      setProposalLoading(false);
    }
  };

  // Construit le corps { sourcePartitionId, targetPartitionId } pour RAID1 dégradé
  const buildRaid1Body = () => {
    // Trouver la partition montée sur /data comme source
    const all = Array.isArray(disks) ? disks : [];
    let sourcePart = null;
    let sourceDiskKey = null;
    for (const d of all) {
      // Cas 1: device de premier niveau monté sur /data (partition levée au top-level)
      if (d.mountpoint === '/data' && d.device) {
        sourcePart = d.device; // ex: /dev/sda6
        sourceDiskKey = d.id || d.device;
        break;
      }
      const key = d.id || d.device;
      const parts = Array.isArray(d.partitions) ? d.partitions : [];
      const p = parts.find(x => x.mountpoint === '/data');
      if (p) { sourcePart = p.path; sourceDiskKey = key; break; }
    }
    if (!sourcePart) return null;

    // Choisir une cible par les cases cochées: privilégier le disque complet sélectionné
    const selectedKeys = Object.entries(selected).filter(([, v]) => !!v).map(([k]) => k);
    const targetDisk = all.find(d => selectedKeys.includes(d.id || d.device) && (d.id || d.device) !== sourceDiskKey && !d.isSystem);
    if (!targetDisk) return null;
    // Passer le disque complet (ex: /dev/sdb) au backend, qui supporte disque ou partition
    const targetId = targetDisk.id || targetDisk.device;
    return { sourcePartitionId: sourcePart, targetPartitionId: targetId };
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
                {(() => {
                  // Filtrer: masquer fd*, loop* et les disques < 1 Go
                  const all = Array.isArray(disks) ? disks : [];
                  const visibleDisks = all.filter(d => {
                    const name = (d.device || '').toString();
                    const isWeird = name.startsWith('fd') || name.startsWith('loop');
                    const bigEnough = (d.sizeBytes ?? 0) >= 1_000_000_000;
                    return !isWeird && bigEnough;
                  });
                  const hiddenCount = all.length - visibleDisks.length;
                  return (
                    <>
                      {visibleDisks.map(d => {
                        const key = d.id || d.device;
                        return (
                          <tr key={key}>
                            <td style={{ padding: '10px 12px', borderBottom: '1px solid #f1f5f9' }}>
                              <input
                                type="checkbox"
                                checked={!!selected[key]}
                                onChange={() => toggle(d)}
                                disabled={!!d.isSystem}
                                title={d.isSystem ? 'Disque système non sélectionnable' : ''}
                              />
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
                              {(() => {
                                const parts = Array.isArray(d.partitions) ? d.partitions : [];
                                const visible = parts.filter(p => (p?.sizeBytes ?? 0) >= 1_000_000_000);
                                const hiddenParts = parts.length - visible.length;
                                if (visible.length === 0) {
                                  return <span style={{ color: '#888' }}>Aucune</span>;
                                }
                                return (
                                  <>
                                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                                      {visible.map(p => (
                                        <li key={p.path}>
                                          {p.path} — {p.fs || 'no-fs'} — {p.sizeBytes} B
                                          {p.mountpoint ? (
                                            <span style={{ marginLeft: 6, color: '#0f766e' }}> (monté: {p.mountpoint})</span>
                                          ) : null}
                                        </li>
                                      ))}
                                    </ul>
                                    {hiddenParts > 0 && (
                                      <div style={{ marginTop: 4, color: '#64748b', fontSize: 12 }}>
                                        {hiddenParts} partition(s) &lt; 1 Go masquée(s)
                                      </div>
                                    )}
                                  </>
                                );
                              })()}
                            </td>
                          </tr>
                        );
                      })}
                      {hiddenCount > 0 && (
                        <tr>
                          <td colSpan={6} style={{ padding: '8px 12px', color: '#64748b', fontSize: 12 }}>
                            {hiddenCount} périphérique(s) non pertinent(s) masqué(s) (fd*, loop*, &lt; 1 Go)
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })()}
              </tbody>
            </table>
          </div>
        )}

        <p style={{ color: '#475569', marginTop: 12 }}>
          Les cases sont désactivées pour les disques système (sélectionnés par défaut et non désélectionnables). Un avertissement est affiché si un disque est monté.
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
            <div>Type: <strong>{proposal.level || proposal.suggested || 'raid1'}</strong></div>
            <div>Capacité: <strong>{humanize(proposal.capacityBytes)}</strong></div>
            <div>Tolérance aux pannes: <strong>{proposal.faultTolerance}</strong></div>
            {proposal.mdName && (
              <div>Périphérique RAID: <strong>{proposal.mdName}</strong></div>
            )}
            {proposal.selection && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontWeight: 600 }}>Sélection:</div>
                <ul>
                  <li>Source: <strong>{proposal.selection.source?.short || proposal.selection.source?.id}</strong>{proposal.selection.source?.mountpoint ? ` (monté: ${proposal.selection.source.mountpoint})` : ''} — {humanize(proposal.selection.source?.sizeBytes)}</li>
                  <li>Cible: <strong>{proposal.selection.target?.short || proposal.selection.target?.id}</strong>{proposal.selection.target?.mountpoint ? ` (monté: ${proposal.selection.target.mountpoint})` : ''} — {humanize(proposal.selection.target?.sizeBytes)}</li>
                </ul>
              </div>
            )}
            <div style={{ marginTop: 8 }}>
              <div>Plan:</div>
              <ul>
                {(proposal.planPreview || []).map((text, idx) => (
                  <li key={idx}>{typeof text === 'string' ? text : JSON.stringify(text)}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>

      {/* Step 3 — Préflight (sans écrire) */}
      <div style={{
        marginTop: 16,
        padding: 16,
        border: '1px solid #cbd5e1',
        borderRadius: 12,
        background: '#ffffff',
        boxShadow: '0 1px 2px rgba(16,24,40,0.06)'
      }}>
        <h2 style={{ color: '#0f172a', marginTop: 0 }}>Étape 3 — Préflight (sans écrire)</h2>
        <p style={{ color: '#475569', marginTop: 0 }}>
          Cette étape vérifie les conditions avant toute action destructive.
        </p>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}>
          <input
            type="checkbox"
            checked={preflightAck}
            onChange={e => setPreflightAck(e.target.checked)}
          />
          <span>
            Je comprends que <strong>seuls les disques non‑système</strong> sélectionnés seront <strong>formatés</strong> pour créer le RAID. Le(s) disque(s) système ne seront <strong>jamais formatés</strong>.
          </span>
        </label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <button onClick={runPreflight} disabled={preflightLoading} style={{ background: '#0f172a', color: '#fff', padding: '8px 12px', border: 0, borderRadius: 8 }}>
            {preflightLoading ? 'Vérification…' : 'Lancer le préflight'}
          </button>
          {preflightError && <span style={{ color: '#b91c1c' }}>Erreur: {String(preflightError)}</span>}
        </div>
        {preflightReport && (
          <div style={{ marginTop: 12, color: '#334155' }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Rapport de préflight</div>
            <pre style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 12, overflowX: 'auto' }}>
{JSON.stringify(preflightReport, null, 2)}
            </pre>
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
