import React from 'react';
import ReactDOM from 'react-dom';
import { useLanguage } from '../../contexts/LanguageContext';

interface Props {
  appName: string;
  email?: string;
  username?: string;
  password?: string;
  onClose: () => void;
  onOpen?: () => void; // si fourni : bouton « Ouvrir l'app » (cas 1re ouverture, avant ouverture)
}

/**
 * Rappel affiché juste après l'ouverture d'une app, tant que son compte par
 * défaut n'a pas été changé : montre identifiant + mot de passe et invite à
 * les changer. Purement informatif (l'app est déjà ouverte) — non bloquant.
 */
const DefaultCredentialsModal: React.FC<Props> = ({ appName, email, username, password, onClose, onOpen }) => {
  const { t } = useLanguage();
  const [copied, setCopied] = React.useState<string | null>(null);

  const copy = (label: string, value?: string) => {
    if (!value) return;
    try {
      navigator.clipboard?.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch (_) { /* clipboard indispo : ignore */ }
  };

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const loginId = email || username || '';

  const Field = ({ labelKey, value, copyKey }: { labelKey: string; value?: string; copyKey: string }) => (
    <div style={styles.field}>
      <span style={styles.fieldLabel}>{t(labelKey)}</span>
      <code style={styles.fieldValue}>{value || '—'}</code>
      <button style={styles.copyBtn} onClick={() => copy(copyKey, value)}>
        {copied === copyKey ? t('defaultCredentials.copied') : t('defaultCredentials.copy')}
      </button>
    </div>
  );

  return ReactDOM.createPortal(
    <div style={styles.overlay} onClick={onClose} onMouseDown={stop} onPointerDown={stop}>
      <style>{themeStyle}</style>
      <div style={styles.modal} className="dcm-modal" onClick={stop} onMouseDown={stop}>
        <div style={styles.header}>
          <h3 style={styles.title}>{t('defaultCredentials.title')} — {appName}</h3>
          <button style={styles.closeBtn} onClick={onClose} aria-label={t('common.close')}>✕</button>
        </div>

        <div style={styles.body}>
          <div style={styles.warn}>⚠️ {t('defaultCredentials.warning')}</div>

          {loginId && <Field labelKey="defaultCredentials.loginId" value={loginId} copyKey="id" />}
          {username && email && username !== email && (
            <Field labelKey="defaultCredentials.username" value={username} copyKey="user" />
          )}
          <Field labelKey="defaultCredentials.password" value={password} copyKey="pwd" />

          <div style={styles.buttons}>
            {onOpen ? (
              <>
                <button style={styles.secondaryBtn} onClick={onClose}>{t('common.close')}</button>
                <button style={styles.primaryBtn} onClick={() => { onOpen(); onClose(); }}>
                  {t('defaultCredentials.open')}
                </button>
              </>
            ) : (
              <button style={styles.primaryBtn} onClick={onClose}>{t('common.close')}</button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

// Thème clair par défaut, override sombre via prefers-color-scheme (cf. UpdateModal)
const themeStyle = `
  .dcm-modal {
    --dcm-bg: #ffffff;
    --dcm-fg: #0f172a;
    --dcm-muted: #64748b;
    --dcm-border: rgba(15,23,42,0.10);
    --dcm-value-bg: #f1f5f9;
    --dcm-value-border: rgba(15,23,42,0.12);
  }
  @media (prefers-color-scheme: dark) {
    .dcm-modal {
      --dcm-bg: #1f2430;
      --dcm-fg: #e6e8ee;
      --dcm-muted: #9aa3b2;
      --dcm-border: rgba(255,255,255,0.08);
      --dcm-value-bg: #161b24;
      --dcm-value-border: rgba(255,255,255,0.10);
    }
  }
`;

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 10001, backdropFilter: 'blur(2px)',
  },
  modal: {
    width: 'min(460px, 92vw)', background: 'var(--dcm-bg)', color: 'var(--dcm-fg)',
    borderRadius: 14, boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
    border: '1px solid var(--dcm-border)', overflow: 'hidden',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '16px 20px', borderBottom: '1px solid var(--dcm-border)',
  },
  title: { margin: 0, fontSize: 16, fontWeight: 600 },
  closeBtn: { background: 'transparent', border: 'none', color: 'var(--dcm-muted)', fontSize: 18, cursor: 'pointer', lineHeight: 1 },
  body: { padding: '16px 20px 20px' },
  warn: {
    background: 'rgba(220,160,60,0.14)', color: '#b7791f', padding: '10px 12px',
    borderRadius: 8, fontSize: 13.5, marginBottom: 16, lineHeight: 1.4,
  },
  field: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 },
  fieldLabel: { fontSize: 12, color: 'var(--dcm-muted)', width: 90, flexShrink: 0 },
  fieldValue: {
    flex: 1, background: 'var(--dcm-value-bg)', border: '1px solid var(--dcm-value-border)',
    borderRadius: 6, padding: '7px 10px', fontSize: 13.5, wordBreak: 'break-all',
  },
  copyBtn: {
    background: 'rgba(59,111,224,0.12)', color: '#3b6fe0',
    border: '1px solid rgba(59,111,224,0.35)', borderRadius: 6,
    padding: '6px 10px', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  buttons: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 },
  secondaryBtn: {
    background: 'transparent', color: 'var(--dcm-muted)', border: '1px solid var(--dcm-value-border)',
    borderRadius: 8, padding: '8px 16px', fontSize: 13.5, cursor: 'pointer',
  },
  primaryBtn: {
    background: '#3b6fe0', color: '#fff', border: 'none', borderRadius: 8,
    padding: '8px 16px', fontSize: 13.5, cursor: 'pointer', fontWeight: 500,
  },
};

export default DefaultCredentialsModal;
