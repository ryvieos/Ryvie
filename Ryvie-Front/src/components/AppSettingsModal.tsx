import React from 'react';
import ReactDOM from 'react-dom';
import axios from '../utils/setupAxios';
import urlsConfig from '../config/urls';
import { useLanguage } from '../contexts/LanguageContext';

const { getServerUrl, refreshNetbirdData } = urlsConfig;

interface Exposure {
  supported: boolean;
  reason?: string;
  exposed: boolean;
  domain?: string | null;
  port?: number;
}

interface Props {
  appId: string;
  appName: string;
  accessMode: string;
  onClose: () => void;
  /** Opération d'exposition lancée (création ou suppression) : l'icône affiche
      un spinner (plancher 10 s) qui ne s'arrête que lorsque le backend a confirmé
      que l'app est de nouveau joignable (cf. onExposureSettled). */
  onExposureStart?: (op: 'create' | 'delete') => void;
  /** Backend confirmé : la requête create/delete a répondu, ce qui — côté backend
      — n'arrive qu'après avoir sondé l'app post-redémarrage. Autorise l'arrêt du
      spinner de l'icône (effectif une fois le plancher de 10 s écoulé). */
  onExposureSettled?: () => void;
  /** Opération échouée : couper le spinner de l'icône immédiatement. */
  onExposureError?: () => void;
}

// La création côté cloud peut prendre jusqu'à ~2 min + le backend attend ensuite
// que l'adresse réponde réellement (jusqu'à 1 min) → large marge.
const EXPOSURE_TIMEOUT_MS = 240000;

/**
 * Réglages d'une app (admin) : gestion de l'adresse publique (*.ryvie.fr).
 * Création/suppression via le backend, avec avertissement de sécurité avant
 * exposition publique.
 */
const AppSettingsModal: React.FC<Props> = ({ appId, appName, accessMode, onClose, onExposureStart, onExposureSettled, onExposureError }) => {
  const { t } = useLanguage();
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [exposure, setExposure] = React.useState<Exposure | null>(null);

  // Étapes de l'action en cours : confirmation inline puis requête longue
  const [confirming, setConfirming] = React.useState<'create' | 'delete' | null>(null);
  const [working, setWorking] = React.useState<'create' | 'delete' | null>(null);
  const [toast, setToast] = React.useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [copied, setCopied] = React.useState(false);
  // Panneau d'aide (icône ⓘ) : explique ce qu'est une adresse publique.
  const [showInfo, setShowInfo] = React.useState(false);

  const serverUrl = getServerUrl(accessMode);

  const loadExposure = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await axios.get(`${serverUrl}/api/apps/${appId}/exposure`, { _noAuthRedirect: true } as any);
      setExposure(res.data);
    } catch (e: any) {
      setError(e?.response?.data?.error || t('appSettings.loadError'));
    } finally {
      setLoading(false);
    }
  }, [serverUrl, appId, t]);

  React.useEffect(() => {
    loadExposure();
  }, [loadExposure]);

  React.useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);

  const createExposure = async () => {
    setConfirming(null);
    setWorking('create');
    // Spinner sur l'icône de l'app : il ne s'arrêtera que lorsque l'adresse
    // générée répondra réellement (sonde backend), même après fermeture du modal.
    onExposureStart?.('create');
    try {
      const res = await axios.post(
        `${serverUrl}/api/apps/${appId}/exposure`,
        {},
        { timeout: EXPOSURE_TIMEOUT_MS, _noAuthRedirect: true } as any
      );
      // Le backend a fini d'attendre que l'adresse réponde réellement → on peut
      // arrêter le spinner de l'icône (après son plancher de 10 s).
      onExposureSettled?.();
      // ready === false : l'adresse est créée mais la route met encore quelques
      // instants à s'activer côté cloud → on prévient l'utilisateur.
      const base = res.data?.ready === false ? t('appSettings.createdPending') : t('appSettings.created');
      setToast({
        type: 'success',
        msg: res.data?.restarted ? `${base} ${t('appSettings.envUpdated')}` : base
      });
      // Recharge les domaines en mémoire : le prochain clic sur l'icône
      // utilise la nouvelle adresse, sans recharger la page.
      await Promise.all([refreshNetbirdData(), loadExposure()]);
    } catch (e: any) {
      // Échec → on coupe aussi le spinner de l'icône
      onExposureError?.();
      setToast({ type: 'error', msg: e?.response?.data?.error || t('appSettings.createError') });
    } finally {
      setWorking(null);
    }
  };

  const deleteExposure = async () => {
    setConfirming(null);
    setWorking('delete');
    // Spinner sur l'icône de l'app (plancher 10 s) : l'app redémarre pour retirer
    // l'exposition, le spinner tient jusqu'à son retour « running », même après
    // fermeture du modal.
    onExposureStart?.('delete');
    try {
      const res = await axios.delete(
        `${serverUrl}/api/apps/${appId}/exposure`,
        { timeout: EXPOSURE_TIMEOUT_MS, _noAuthRedirect: true } as any
      );
      // Le backend a fini d'attendre que l'app réponde de nouveau en local → on
      // peut arrêter le spinner de l'icône (après son plancher de 10 s).
      onExposureSettled?.();
      setToast({
        type: 'success',
        msg: res.data?.restarted
          ? `${t('appSettings.deleted')} ${t('appSettings.envUpdated')}`
          : t('appSettings.deleted')
      });
      // Recharge les domaines en mémoire : le prochain clic repasse sur l'accès direct.
      await Promise.all([refreshNetbirdData(), loadExposure()]);
    } catch (e: any) {
      // Échec → on coupe aussi le spinner de l'icône
      onExposureError?.();
      setToast({ type: 'error', msg: e?.response?.data?.error || t('appSettings.deleteError') });
    } finally {
      setWorking(null);
    }
  };

  const copyDomain = () => {
    if (!exposure?.domain) return;
    try {
      navigator.clipboard?.writeText(`https://${exposure.domain}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_) { /* clipboard indispo : ignore */ }
  };

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  // Clic sur l'overlay : ferme la fenêtre (la création éventuelle continue en
  // arrière-plan, cf. createExposure). stopPropagation est INDISPENSABLE : la
  // modale est rendue via un portail dans l'arbre React de l'icône, donc sans ça
  // le clic « remonte » jusqu'au onClick de la tuile (GridLauncher) et ouvrirait
  // l'app au lieu de simplement fermer la fenêtre.
  const handleOverlayClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClose();
  };

  return ReactDOM.createPortal(
    <div style={styles.overlay} onClick={handleOverlayClick} onMouseDown={stop} onMouseUp={stop} onPointerDown={stop}>
      <style>{themeStyle}</style>
      <div style={styles.modal} className="asm-modal" onClick={stop} onMouseDown={stop}>
        <div style={styles.header}>
          <h3 style={styles.title}>{t('appSettings.title')} — {appName}</h3>
          <div style={styles.headerActions}>
            <button
              style={{ ...styles.iconBtn, ...(showInfo ? styles.iconBtnActive : {}) }}
              onClick={() => setShowInfo((v) => !v)}
              aria-label={t('appSettings.info')}
              aria-expanded={showInfo}
              title={t('appSettings.info')}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="11" x2="12" y2="16" />
                <circle cx="12" cy="8" r="0.6" fill="currentColor" stroke="none" />
              </svg>
            </button>
            <button style={styles.closeBtn} onClick={onClose} aria-label={t('common.close')}>✕</button>
          </div>
        </div>

        {showInfo && (
          <div style={styles.infoBox}>
            <div style={styles.infoTitleText}>{t('appSettings.infoTitle')}</div>
            <div style={styles.infoText}>{t('appSettings.infoText')}</div>
          </div>
        )}

        {toast && (
          <div style={{ ...styles.toast, ...(toast.type === 'error' ? styles.toastError : styles.toastSuccess) }}>
            {toast.msg}
          </div>
        )}

        <div style={styles.body}>
          <div style={styles.sectionTitle}>{t('appSettings.publicAddress')}</div>

          {loading && (
            <div aria-busy="true" aria-label={t('common.loading')}>
              <div style={styles.skelRow}>
                <div style={{ ...styles.skel, height: 14, width: '60%' }} className="asm-skel" />
              </div>
              <div style={styles.skelRow}>
                <div style={{ ...styles.skel, height: 34, width: '100%' }} className="asm-skel" />
              </div>
              <div style={{ ...styles.skelRow, justifyContent: 'flex-end' }}>
                <div style={{ ...styles.skel, height: 32, width: 180 }} className="asm-skel" />
              </div>
            </div>
          )}

          {!loading && error && <div style={styles.errorBox}>{error}</div>}

          {!loading && !error && exposure && !exposure.supported && (
            <div style={styles.muted}>
              {exposure.reason === 'managed_natively'
                ? t('appSettings.managedNatively')
                : t('appSettings.notAvailable')}
            </div>
          )}

          {!loading && !error && exposure && exposure.supported && exposure.exposed && (
            <>
              <div style={styles.domainRow}>
                <a
                  href={`https://${exposure.domain}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={styles.domainLink}
                >
                  https://{exposure.domain}
                </a>
                <button style={styles.copyBtn} onClick={copyDomain}>
                  {copied ? t('appSettings.copied') : t('appSettings.copy')}
                </button>
              </div>
              <div style={styles.hint}>{t('appSettings.exposedHint')}</div>

              {confirming === 'delete' ? (
                <div style={styles.confirmBox}>
                  <div style={styles.confirmText}>{t('appSettings.deleteWarning')}</div>
                  <div style={styles.buttons}>
                    <button style={styles.secondaryBtn} onClick={() => setConfirming(null)}>{t('common.cancel')}</button>
                    <button style={styles.dangerBtn} onClick={deleteExposure}>{t('appSettings.confirmDelete')}</button>
                  </div>
                </div>
              ) : (
                <div style={styles.buttons}>
                  <button
                    style={{ ...styles.dangerBtn, ...(working ? styles.btnDisabled : {}) }}
                    disabled={!!working}
                    onClick={() => setConfirming('delete')}
                  >
                    {working === 'delete' ? t('appSettings.deleting') : t('appSettings.delete')}
                  </button>
                </div>
              )}

              {working === 'delete' && (
                <div style={styles.workingRow}>
                  <span className="asm-spinner" style={styles.spinner} />
                  <span style={styles.hint}>{t('appSettings.deletingHint')}</span>
                </div>
              )}
            </>
          )}

          {!loading && !error && exposure && exposure.supported && !exposure.exposed && (
            <>
              <div style={styles.muted}>{t('appSettings.notExposed')}</div>

              {confirming === 'create' ? (
                <div style={styles.warnBox}>
                  <div style={styles.confirmText}>⚠️ {t('appSettings.createWarning')}</div>
                  <div style={styles.buttons}>
                    <button style={styles.secondaryBtn} onClick={() => setConfirming(null)}>{t('common.cancel')}</button>
                    <button style={styles.primaryBtn} onClick={createExposure}>{t('appSettings.confirmCreate')}</button>
                  </div>
                </div>
              ) : (
                <div style={styles.buttons}>
                  <button
                    style={{ ...styles.primaryBtn, ...(working ? styles.btnDisabled : {}) }}
                    disabled={!!working}
                    onClick={() => setConfirming('create')}
                  >
                    {working === 'create' ? t('appSettings.creating') : t('appSettings.create')}
                  </button>
                </div>
              )}

              {working === 'create' && (
                <div style={styles.workingRow}>
                  <span className="asm-spinner" style={styles.spinner} />
                  <span style={styles.hint}>{t('appSettings.creatingHint')}</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};

// Thème clair par défaut, override sombre via prefers-color-scheme (cf. UpdateModal)
const themeStyle = `
  .asm-modal {
    --asm-bg: #ffffff;
    --asm-fg: #0f172a;
    --asm-muted: #64748b;
    --asm-border: rgba(15,23,42,0.10);
    --asm-input-bg: #f1f5f9;
    --asm-input-border: rgba(15,23,42,0.14);
    --asm-skel-base: rgba(15,23,42,0.07);
    --asm-skel-shine: rgba(15,23,42,0.14);
  }
  @media (prefers-color-scheme: dark) {
    .asm-modal {
      --asm-bg: #1f2430;
      --asm-fg: #e6e8ee;
      --asm-muted: #9aa3b2;
      --asm-border: rgba(255,255,255,0.08);
      --asm-input-bg: #161b24;
      --asm-input-border: rgba(255,255,255,0.12);
      --asm-skel-base: rgba(255,255,255,0.07);
      --asm-skel-shine: rgba(255,255,255,0.15);
    }
  }
  .asm-skel {
    background: linear-gradient(90deg, var(--asm-skel-base) 25%, var(--asm-skel-shine) 37%, var(--asm-skel-base) 63%);
    background-size: 400% 100%;
    animation: asm-shimmer 1.4s ease infinite;
  }
  @keyframes asm-shimmer {
    0% { background-position: 100% 0; }
    100% { background-position: -100% 0; }
  }
  .asm-spinner {
    animation: asm-spin 1s linear infinite;
  }
  @keyframes asm-spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
`;

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 10001, backdropFilter: 'blur(2px)',
  },
  modal: {
    width: 'min(520px, 92vw)', maxHeight: '82vh', overflow: 'hidden',
    display: 'flex', flexDirection: 'column',
    background: 'var(--asm-bg)', color: 'var(--asm-fg)', borderRadius: 14,
    boxShadow: '0 20px 60px rgba(0,0,0,0.25)', border: '1px solid var(--asm-border)',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '16px 20px', borderBottom: '1px solid var(--asm-border)',
  },
  title: { margin: 0, fontSize: 16, fontWeight: 600 },
  headerActions: { display: 'flex', alignItems: 'center', gap: 4 },
  iconBtn: {
    background: 'transparent', border: 'none', color: 'var(--asm-muted)',
    cursor: 'pointer', lineHeight: 0, padding: 4, borderRadius: 8,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  },
  iconBtnActive: { color: '#3b6fe0', background: 'rgba(59,111,224,0.12)' },
  closeBtn: {
    background: 'transparent', border: 'none', color: 'var(--asm-muted)',
    fontSize: 18, cursor: 'pointer', lineHeight: 1,
  },
  infoBox: {
    margin: '12px 20px 0', padding: '12px 14px', borderRadius: 8,
    background: 'rgba(59,111,224,0.08)', border: '1px solid rgba(59,111,224,0.22)',
  },
  infoTitleText: { fontSize: 13.5, fontWeight: 600, marginBottom: 6, color: 'var(--asm-fg)' },
  infoText: { fontSize: 13, lineHeight: 1.55, color: 'var(--asm-muted)' },
  body: { padding: '14px 20px 20px', overflowY: 'auto' },
  sectionTitle: { fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--asm-muted)', marginBottom: 10 },
  muted: { color: 'var(--asm-muted)', padding: '4px 0 10px', fontSize: 14, lineHeight: 1.5 },
  hint: { color: 'var(--asm-muted)', fontSize: 12.5, marginTop: 8, lineHeight: 1.4 },
  errorBox: { color: '#c0392b', background: 'rgba(220,80,80,0.12)', padding: 12, borderRadius: 8, fontSize: 14 },
  warnBox: {
    background: 'rgba(220,160,60,0.14)', padding: '12px', borderRadius: 8,
    marginTop: 10,
  },
  confirmBox: {
    background: 'rgba(220,80,80,0.10)', padding: '12px', borderRadius: 8,
    marginTop: 12,
  },
  confirmText: { fontSize: 13.5, lineHeight: 1.5, marginBottom: 10 },
  domainRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 2 },
  domainLink: {
    flex: 1, background: 'var(--asm-input-bg)', border: '1px solid var(--asm-input-border)',
    borderRadius: 8, padding: '8px 10px', fontSize: 13.5, wordBreak: 'break-all',
    color: '#3b6fe0', textDecoration: 'none',
  },
  copyBtn: {
    background: 'rgba(59,111,224,0.12)', color: '#3b6fe0',
    border: '1px solid rgba(59,111,224,0.35)', borderRadius: 8,
    padding: '7px 12px', fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  buttons: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 },
  primaryBtn: {
    background: '#3b6fe0', color: '#fff', border: 'none', borderRadius: 8,
    padding: '8px 16px', fontSize: 13.5, cursor: 'pointer', fontWeight: 500,
  },
  secondaryBtn: {
    background: 'transparent', color: 'var(--asm-muted)', border: '1px solid var(--asm-input-border)',
    borderRadius: 8, padding: '8px 16px', fontSize: 13.5, cursor: 'pointer',
  },
  dangerBtn: {
    background: 'rgba(220,80,80,0.12)', color: '#dc2626',
    border: '1px solid rgba(220,80,80,0.4)', borderRadius: 8,
    padding: '8px 16px', fontSize: 13.5, cursor: 'pointer', fontWeight: 500,
  },
  btnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  workingRow: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 },
  spinner: {
    width: 16, height: 16, flexShrink: 0, borderRadius: '50%',
    border: '2px solid rgba(59,111,224,0.25)', borderTopColor: '#3b6fe0',
    display: 'inline-block',
  },
  skelRow: { display: 'flex', alignItems: 'center', padding: '8px 0' },
  skel: { borderRadius: 8 },
  toast: { margin: '12px 20px 0', padding: '10px 12px', borderRadius: 8, fontSize: 13 },
  toastSuccess: { background: 'rgba(60,180,120,0.18)', color: '#1e7a4d' },
  toastError: { background: 'rgba(220,80,80,0.16)', color: '#c0392b' },
};

export default AppSettingsModal;
