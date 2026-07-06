import React from 'react';
import axios from '../../utils/setupAxios';
import urlsConfig from '../../config/urls';
import { useLanguage } from '../../contexts/LanguageContext';

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
  accessMode: string;
  onExposureStart?: (op: 'create' | 'delete') => void;
  onExposureSettled?: () => void;
  onExposureError?: () => void;
}

const EXPOSURE_TIMEOUT_MS = 240000;

/** Panneau « Adresse publique » (exposition *.ryvie.fr via Netbird/Caddy). */
const ExposurePanel: React.FC<Props> = ({ appId, accessMode, onExposureStart, onExposureSettled, onExposureError }) => {
  const { t } = useLanguage();
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [exposure, setExposure] = React.useState<Exposure | null>(null);
  const [confirming, setConfirming] = React.useState<'create' | 'delete' | null>(null);
  const [working, setWorking] = React.useState<'create' | 'delete' | null>(null);
  const [toast, setToast] = React.useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [copied, setCopied] = React.useState(false);
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

  React.useEffect(() => { loadExposure(); }, [loadExposure]);

  React.useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);

  const createExposure = async () => {
    setConfirming(null);
    setWorking('create');
    onExposureStart?.('create');
    try {
      const res = await axios.post(
        `${serverUrl}/api/apps/${appId}/exposure`,
        {},
        { timeout: EXPOSURE_TIMEOUT_MS, _noAuthRedirect: true } as any
      );
      onExposureSettled?.();
      const base = res.data?.ready === false ? t('appSettings.createdPending') : t('appSettings.created');
      setToast({ type: 'success', msg: res.data?.restarted ? `${base} ${t('appSettings.envUpdated')}` : base });
      await Promise.all([refreshNetbirdData(), loadExposure()]);
    } catch (e: any) {
      onExposureError?.();
      setToast({ type: 'error', msg: e?.response?.data?.error || t('appSettings.createError') });
    } finally {
      setWorking(null);
    }
  };

  const deleteExposure = async () => {
    setConfirming(null);
    setWorking('delete');
    onExposureStart?.('delete');
    try {
      const res = await axios.delete(
        `${serverUrl}/api/apps/${appId}/exposure`,
        { timeout: EXPOSURE_TIMEOUT_MS, _noAuthRedirect: true } as any
      );
      onExposureSettled?.();
      setToast({
        type: 'success',
        msg: res.data?.restarted ? `${t('appSettings.deleted')} ${t('appSettings.envUpdated')}` : t('appSettings.deleted')
      });
      await Promise.all([refreshNetbirdData(), loadExposure()]);
    } catch (e: any) {
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

  return (
    <>
      {toast && (
        <div style={{ ...styles.toast, ...(toast.type === 'error' ? styles.toastError : styles.toastSuccess) }}>
          {toast.msg}
        </div>
      )}

      <div style={styles.sectionHead}>
        <span style={styles.sectionTitle}>{t('appSettings.publicAddress')}</span>
        <button
          style={{ ...styles.iconBtn, ...(showInfo ? styles.iconBtnActive : {}) }}
          onClick={() => setShowInfo((v) => !v)}
          aria-label={t('appSettings.info')}
          aria-expanded={showInfo}
          title={t('appSettings.info')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="11" x2="12" y2="16" />
            <circle cx="12" cy="8" r="0.6" fill="currentColor" stroke="none" />
          </svg>
        </button>
      </div>

      {showInfo && (
        <div style={styles.infoBox}>
          <div style={styles.infoTitleText}>{t('appSettings.infoTitle')}</div>
          <div style={styles.infoText}>{t('appSettings.infoText')}</div>
        </div>
      )}

      {loading && (
        <div aria-busy="true" aria-label={t('common.loading')}>
          <div style={styles.skelRow}><div style={{ ...styles.skel, height: 14, width: '60%' }} className="rv-skel" /></div>
          <div style={styles.skelRow}><div style={{ ...styles.skel, height: 34, width: '100%' }} className="rv-skel" /></div>
          <div style={{ ...styles.skelRow, justifyContent: 'flex-end' }}><div style={{ ...styles.skel, height: 32, width: 180 }} className="rv-skel" /></div>
        </div>
      )}

      {!loading && error && <div style={styles.errorBox}>{error}</div>}

      {!loading && !error && exposure && !exposure.supported && (
        <div style={styles.muted}>
          {exposure.reason === 'managed_natively' ? t('appSettings.managedNatively') : t('appSettings.notAvailable')}
        </div>
      )}

      {!loading && !error && exposure && exposure.supported && exposure.exposed && (
        <>
          <div style={styles.domainRow}>
            <a href={`https://${exposure.domain}`} target="_blank" rel="noopener noreferrer" style={styles.domainLink}>
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
              <span className="rv-spinner" style={styles.spinner} />
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
              <span className="rv-spinner" style={styles.spinner} />
              <span style={styles.hint}>{t('appSettings.creatingHint')}</span>
            </div>
          )}
        </>
      )}
    </>
  );
};

const styles: Record<string, React.CSSProperties> = {
  sectionHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  sectionTitle: { fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--rv-muted)' },
  iconBtn: {
    background: 'transparent', border: 'none', color: 'var(--rv-muted)',
    cursor: 'pointer', lineHeight: 0, padding: 4, borderRadius: 8,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  },
  iconBtnActive: { color: '#3b6fe0', background: 'rgba(59,111,224,0.12)' },
  infoBox: {
    margin: '0 0 12px', padding: '12px 14px', borderRadius: 8,
    background: 'rgba(59,111,224,0.08)', border: '1px solid rgba(59,111,224,0.22)',
  },
  infoTitleText: { fontSize: 13.5, fontWeight: 600, marginBottom: 6, color: 'var(--rv-fg)' },
  infoText: { fontSize: 13, lineHeight: 1.55, color: 'var(--rv-muted)' },
  muted: { color: 'var(--rv-muted)', padding: '4px 0 10px', fontSize: 14, lineHeight: 1.5 },
  hint: { color: 'var(--rv-muted)', fontSize: 12.5, marginTop: 8, lineHeight: 1.4 },
  errorBox: { color: '#c0392b', background: 'rgba(220,80,80,0.12)', padding: 12, borderRadius: 8, fontSize: 14 },
  warnBox: { background: 'rgba(220,160,60,0.14)', padding: '12px', borderRadius: 8, marginTop: 10 },
  confirmBox: { background: 'rgba(220,80,80,0.10)', padding: '12px', borderRadius: 8, marginTop: 12 },
  confirmText: { fontSize: 13.5, lineHeight: 1.5, marginBottom: 10 },
  domainRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 2 },
  domainLink: {
    flex: 1, background: 'var(--rv-input-bg)', border: '1px solid var(--rv-input-border)',
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
    background: 'transparent', color: 'var(--rv-muted)', border: '1px solid var(--rv-input-border)',
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
    border: '2px solid rgba(59,111,224,0.25)', borderTopColor: '#3b6fe0', display: 'inline-block',
  },
  skelRow: { display: 'flex', alignItems: 'center', padding: '8px 0' },
  skel: { borderRadius: 8 },
  toast: { marginBottom: 12, padding: '10px 12px', borderRadius: 8, fontSize: 13 },
  toastSuccess: { background: 'rgba(60,180,120,0.18)', color: '#1e7a4d' },
  toastError: { background: 'rgba(220,80,80,0.16)', color: '#c0392b' },
};

export default ExposurePanel;
