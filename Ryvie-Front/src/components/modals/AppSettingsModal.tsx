import React from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import Modal from './Modal';
import ExposurePanel from '../settings/ExposurePanel';
import AccountsPanel from '../settings/AccountsPanel';
import ConfigPanel from '../settings/ConfigPanel';

interface Props {
  appId: string;
  appName: string;
  accessMode: string;
  onClose: () => void;
  /** Onglet « Adresse publique » disponible (apps non gérées nativement). */
  showExposure?: boolean;
  /** Onglet « Comptes » disponible (app avec recette de reset). */
  hasAccounts?: boolean;
  /** Onglet « Configuration avancée » disponible (app avec configEditor). */
  hasConfigEditor?: boolean;
  // Spinner d'icône pendant l'exposition (voir ExposurePanel).
  onExposureStart?: (op: 'create' | 'delete') => void;
  onExposureSettled?: () => void;
  onExposureError?: () => void;
}

type TabKey = 'exposure' | 'accounts' | 'config';

// Icônes des onglets (reprises des anciennes entrées du menu contextuel).
const TAB_ICONS: Record<TabKey, React.ReactNode> = {
  accounts: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 4-6 8-6s8 2 8 6" strokeLinecap="round" />
    </svg>
  ),
  exposure: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" strokeLinecap="round" />
      <path d="M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" strokeLinecap="round" />
    </svg>
  ),
  config: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <polyline points="16 18 22 12 16 6" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="8 6 2 12 8 18" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

/**
 * Fenêtre « Réglages » d'une app (admin) : point d'entrée unique regroupant en
 * onglets l'adresse publique, la gestion des comptes et la configuration avancée.
 * Les onglets n'apparaissent que si l'app expose la capacité correspondante.
 */
const AppSettingsModal: React.FC<Props> = ({
  appId, appName, accessMode, onClose,
  showExposure = true, hasAccounts, hasConfigEditor,
  onExposureStart, onExposureSettled, onExposureError,
}) => {
  const { t } = useLanguage();

  // Ordre : Comptes d'abord, puis Adresse publique, puis Configuration avancée.
  const tabs: { key: TabKey; label: string }[] = [
    ...(hasAccounts ? [{ key: 'accounts' as TabKey, label: t('appAccounts.title') }] : []),
    ...(showExposure ? [{ key: 'exposure' as TabKey, label: t('appSettings.publicAddress') }] : []),
    ...(hasConfigEditor ? [{ key: 'config' as TabKey, label: t('configEditor.title') }] : []),
  ];

  const [active, setActive] = React.useState<TabKey>(tabs[0]?.key || 'exposure');

  // Taille STABLE quand il y a des onglets : la fenêtre ne doit pas se
  // redimensionner en changeant d'onglet (largeur figée + hauteur mini commune,
  // le contenu défile si besoin). Un seul panneau → taille naturelle.
  const isTabbed = tabs.length > 1;
  const width = isTabbed ? 720 : (tabs[0]?.key === 'config' ? 760 : 520);

  return (
    <Modal
      title={`${t('appSettings.title')} — ${appName}`}
      onClose={onClose}
      width={width}
      bodyStyle={{ padding: '14px 20px 20px', ...(isTabbed ? { minHeight: '56vh' } : {}) }}
    >
      {tabs.length > 1 && (
        <div style={styles.tabBar} role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              role="tab"
              aria-selected={active === tab.key}
              style={{ ...styles.tab, ...(active === tab.key ? styles.tabActive : {}) }}
              onClick={() => setActive(tab.key)}
            >
              <span style={styles.tabIcon}>{TAB_ICONS[tab.key]}</span>
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {active === 'exposure' && (
        <ExposurePanel
          appId={appId}
          accessMode={accessMode}
          onExposureStart={onExposureStart}
          onExposureSettled={onExposureSettled}
          onExposureError={onExposureError}
        />
      )}
      {active === 'accounts' && <AccountsPanel appId={appId} accessMode={accessMode} />}
      {active === 'config' && <ConfigPanel appId={appId} accessMode={accessMode} />}
    </Modal>
  );
};

const styles: Record<string, React.CSSProperties> = {
  tabBar: {
    display: 'flex', gap: 4, marginBottom: 16,
    borderBottom: '1px solid var(--rv-border)', paddingBottom: 2,
  },
  tab: {
    display: 'flex', alignItems: 'center', gap: 6,
    background: 'transparent', color: 'var(--rv-muted)',
    border: 'none', borderBottom: '2px solid transparent',
    padding: '8px 12px', fontSize: 13.5, cursor: 'pointer', marginBottom: -3,
  },
  tabIcon: { display: 'inline-flex', lineHeight: 0 },
  tabActive: { color: '#3b6fe0', borderBottomColor: '#3b6fe0', fontWeight: 500 },
};

export default AppSettingsModal;
