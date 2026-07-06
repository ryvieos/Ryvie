import React from 'react';
import axios from '../../utils/setupAxios';
import urlsConfig from '../../config/urls';
import { useLanguage } from '../../contexts/LanguageContext';

const { getServerUrl } = urlsConfig;

interface Account {
  id: string;
  email?: string;
  username?: string;
  isAdmin?: boolean;
}

interface Props {
  appId: string;
  accessMode: string;
}

const MIN_PWD = 8;

/** Panneau « Comptes » (réutilisé dans la fenêtre Réglages de l'app). */
const AccountsPanel: React.FC<Props> = ({ appId, accessMode }) => {
  const { t } = useLanguage();
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [supported, setSupported] = React.useState(true);
  const [reason, setReason] = React.useState<string | null>(null);
  const [accounts, setAccounts] = React.useState<Account[]>([]);
  const [restartsOnReset, setRestartsOnReset] = React.useState(false);

  const [resettingId, setResettingId] = React.useState<string | null>(null);
  const [pwd, setPwd] = React.useState('');
  const [pwd2, setPwd2] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [toast, setToast] = React.useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  const serverUrl = getServerUrl(accessMode);

  const loadAccounts = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await axios.get(`${serverUrl}/api/apps/${appId}/accounts`, { _noAuthRedirect: true } as any);
      setSupported(res.data.supported !== false);
      setReason(res.data.reason || null);
      setAccounts(Array.isArray(res.data.accounts) ? res.data.accounts : []);
      setRestartsOnReset(res.data.restartsOnReset === true);
    } catch (e: any) {
      setError(e?.response?.data?.error || t('appAccounts.loadError'));
    } finally {
      setLoading(false);
    }
  }, [serverUrl, appId, t]);

  React.useEffect(() => { loadAccounts(); }, [loadAccounts]);

  React.useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  const openReset = (id: string) => { setResettingId(id); setPwd(''); setPwd2(''); };
  const cancelReset = () => { setResettingId(null); setPwd(''); setPwd2(''); };

  const pwdTooShort = pwd.length > 0 && pwd.length < MIN_PWD;
  const pwdMismatch = pwd2.length > 0 && pwd !== pwd2;
  const canSubmit = pwd.length >= MIN_PWD && pwd === pwd2 && !submitting;

  const submitReset = async (id: string) => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await axios.post(
        `${serverUrl}/api/apps/${appId}/accounts/${id}/reset-password`,
        { password: pwd },
        { _noAuthRedirect: true } as any
      );
      setToast({ type: 'success', msg: t('appAccounts.resetSuccess') });
      cancelReset();
    } catch (e: any) {
      setToast({ type: 'error', msg: e?.response?.data?.error || t('appAccounts.resetError') });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      {toast && (
        <div style={{ ...styles.toast, ...(toast.type === 'error' ? styles.toastError : styles.toastSuccess) }}>
          {toast.msg}
        </div>
      )}

      {loading && (
        <div style={styles.skelList} aria-busy="true" aria-label={t('appAccounts.loading')}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={styles.skelRow}>
              <div style={{ ...styles.skel, ...styles.skelText, width: `${55 - i * 8}%` }} className="rv-skel" />
              <div style={{ ...styles.skel, ...styles.skelBtn }} className="rv-skel" />
            </div>
          ))}
        </div>
      )}

      {!loading && error && <div style={styles.errorBox}>{error}</div>}

      {!loading && !error && !supported && (
        <div style={styles.warnBox}>{reason || t('appAccounts.unsupported')}</div>
      )}

      {!loading && !error && supported && accounts.length === 0 && (
        <div style={styles.muted}>{t('appAccounts.empty')}</div>
      )}

      {!loading && !error && supported && accounts.map((acc) => (
        <div key={acc.id} style={styles.row}>
          <div style={styles.rowMain}>
            <div style={styles.identity}>
              <span style={styles.primaryText}>{acc.email || acc.username || acc.id}</span>
              {acc.username && acc.email && <span style={styles.secondaryText}>{acc.username}</span>}
              {acc.isAdmin && <span style={styles.adminBadge}>admin</span>}
            </div>
            {resettingId !== acc.id && (
              <button style={styles.resetBtn} onClick={() => openReset(acc.id)}>
                {t('appAccounts.reset')}
              </button>
            )}
          </div>

          {resettingId === acc.id && (
            <div style={styles.form}>
              {restartsOnReset && (
                <div style={styles.restartWarn}>⚠️ {t('appAccounts.resetRestartWarn')}</div>
              )}
              <input
                type="password"
                autoFocus
                style={styles.input}
                placeholder={t('appAccounts.newPassword')}
                value={pwd}
                onChange={(e) => setPwd(e.target.value)}
              />
              <input
                type="password"
                style={styles.input}
                placeholder={t('appAccounts.confirmPassword')}
                value={pwd2}
                onChange={(e) => setPwd2(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) submitReset(acc.id); }}
              />
              {pwdTooShort && <div style={styles.fieldError}>{t('appAccounts.tooShort')}</div>}
              {pwdMismatch && <div style={styles.fieldError}>{t('appAccounts.mismatch')}</div>}
              <div style={styles.formButtons}>
                <button style={styles.cancelBtn} onClick={cancelReset} disabled={submitting}>
                  {t('common.cancel')}
                </button>
                <button
                  style={{ ...styles.confirmBtn, ...(canSubmit ? {} : styles.btnDisabled) }}
                  onClick={() => submitReset(acc.id)}
                  disabled={!canSubmit}
                >
                  {submitting ? '…' : t('appAccounts.confirm')}
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </>
  );
};

const styles: Record<string, React.CSSProperties> = {
  muted: { color: 'var(--rv-muted)', padding: '12px 0', fontSize: 14 },
  skelList: { display: 'flex', flexDirection: 'column', padding: '4px 0' },
  skelRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    padding: '14px 0', borderBottom: '1px solid var(--rv-row-border)',
  },
  skel: { borderRadius: 8 },
  skelText: { height: 14 },
  skelBtn: { height: 30, width: 110, flexShrink: 0, borderRadius: 8 },
  errorBox: { color: '#c0392b', background: 'rgba(220,80,80,0.12)', padding: 12, borderRadius: 8, fontSize: 14 },
  warnBox: { color: '#b7791f', background: 'rgba(220,160,60,0.14)', padding: 12, borderRadius: 8, fontSize: 14 },
  row: { padding: '10px 0', borderBottom: '1px solid var(--rv-row-border)' },
  rowMain: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  identity: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 },
  primaryText: { fontSize: 14, fontWeight: 500, wordBreak: 'break-all' },
  secondaryText: { fontSize: 12, color: 'var(--rv-muted)' },
  adminBadge: {
    fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5,
    background: 'rgba(59,111,224,0.14)', color: '#3b6fe0',
    padding: '2px 6px', borderRadius: 6,
  },
  resetBtn: {
    background: 'rgba(59,111,224,0.12)', color: '#3b6fe0',
    border: '1px solid rgba(59,111,224,0.35)', borderRadius: 8,
    padding: '6px 12px', fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  form: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 },
  input: {
    background: 'var(--rv-input-bg)', border: '1px solid var(--rv-input-border)',
    borderRadius: 8, padding: '8px 10px', color: 'var(--rv-fg)', fontSize: 14,
  },
  fieldError: { color: '#c0392b', fontSize: 12 },
  restartWarn: {
    color: '#b7791f', background: 'rgba(220,160,60,0.14)',
    padding: '8px 10px', borderRadius: 8, fontSize: 12.5, lineHeight: 1.4,
  },
  formButtons: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  cancelBtn: {
    background: 'transparent', color: 'var(--rv-muted)',
    border: '1px solid var(--rv-input-border)', borderRadius: 8,
    padding: '6px 14px', fontSize: 13, cursor: 'pointer',
  },
  confirmBtn: {
    background: '#3b6fe0', color: '#fff', border: 'none', borderRadius: 8,
    padding: '6px 14px', fontSize: 13, cursor: 'pointer', fontWeight: 500,
  },
  btnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  toast: { marginBottom: 12, padding: '10px 12px', borderRadius: 8, fontSize: 13 },
  toastSuccess: { background: 'rgba(60,180,120,0.18)', color: '#1e7a4d' },
  toastError: { background: 'rgba(220,80,80,0.16)', color: '#c0392b' },
};

export default AccountsPanel;
