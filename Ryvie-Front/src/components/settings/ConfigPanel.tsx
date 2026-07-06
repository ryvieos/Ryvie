import React from 'react';
import axios from '../../utils/setupAxios';
import urlsConfig from '../../config/urls';
import { useLanguage } from '../../contexts/LanguageContext';

const { getServerUrl } = urlsConfig;

interface ConfigFileMeta {
  key: string;
  label: string;
  language: string;
  path: string;
  exists: boolean;
  size: number;
}

interface Props {
  appId: string;
  accessMode: string;
}

/** Panneau « Configuration avancée » (édition YAML zéro-terminal). */
const ConfigPanel: React.FC<Props> = ({ appId, accessMode }) => {
  const { t } = useLanguage();
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [files, setFiles] = React.useState<ConfigFileMeta[]>([]);
  const [restartOnSave, setRestartOnSave] = React.useState(true);
  const [activeKey, setActiveKey] = React.useState<string | null>(null);
  const [content, setContent] = React.useState('');
  const [dirty, setDirty] = React.useState(false);
  const [fileLoading, setFileLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [toast, setToast] = React.useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  const serverUrl = getServerUrl(accessMode);

  const loadFile = React.useCallback(async (key: string) => {
    setFileLoading(true);
    setError(null);
    try {
      const res = await axios.get(`${serverUrl}/api/apps/${appId}/config-files/${key}`, { _noAuthRedirect: true } as any);
      setActiveKey(key);
      setContent(res.data.content || '');
      setDirty(false);
    } catch (e: any) {
      setError(e?.response?.data?.error || t('configEditor.loadError'));
    } finally {
      setFileLoading(false);
    }
  }, [serverUrl, appId, t]);

  const loadFiles = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await axios.get(`${serverUrl}/api/apps/${appId}/config-files`, { _noAuthRedirect: true } as any);
      const list: ConfigFileMeta[] = Array.isArray(res.data.files) ? res.data.files : [];
      setFiles(list);
      setRestartOnSave(res.data.restartOnSave !== false);
      if (list.length > 0) await loadFile(list[0].key);
    } catch (e: any) {
      setError(e?.response?.data?.error || t('configEditor.loadError'));
    } finally {
      setLoading(false);
    }
  }, [serverUrl, appId, t, loadFile]);

  React.useEffect(() => { loadFiles(); }, [loadFiles]);

  React.useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  const save = async () => {
    if (!activeKey || saving) return;
    setSaving(true);
    try {
      const res = await axios.put(
        `${serverUrl}/api/apps/${appId}/config-files/${activeKey}`,
        { content, restart: restartOnSave },
        { _noAuthRedirect: true } as any
      );
      setDirty(false);
      setToast({
        type: 'success',
        msg: res.data?.restarted ? t('configEditor.savedRestarted') : t('configEditor.saved'),
      });
    } catch (e: any) {
      setToast({ type: 'error', msg: e?.response?.data?.error || t('configEditor.saveError') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={styles.wrap}>
      {toast && (
        <div style={{ ...styles.toast, ...(toast.type === 'error' ? styles.toastError : styles.toastSuccess) }}>
          {toast.msg}
        </div>
      )}

      {loading && <div style={styles.muted}>{t('configEditor.loading')}</div>}
      {!loading && error && <div style={styles.errorBox}>{error}</div>}

      {!loading && !error && files.length === 0 && (
        <div style={styles.muted}>{t('configEditor.empty')}</div>
      )}

      {!loading && !error && files.length > 0 && (
        <>
          {files.length > 1 && (
            <div style={styles.tabs}>
              {files.map((f) => (
                <button
                  key={f.key}
                  style={{ ...styles.tab, ...(f.key === activeKey ? styles.tabActive : {}) }}
                  onClick={() => { if (f.key !== activeKey) loadFile(f.key); }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}
          {files.length === 1 && <div style={styles.fileLabel}>{files[0].label}</div>}

          <textarea
            spellCheck={false}
            wrap="off"
            style={styles.editor}
            value={content}
            disabled={fileLoading || saving}
            onChange={(e) => { setContent(e.target.value); setDirty(true); }}
          />

          <div style={styles.footer}>
            <div style={styles.hint}>
              {restartOnSave ? `⚠️ ${t('configEditor.restartWarn')}` : t('configEditor.savedHint')}
            </div>
            <button
              style={{ ...styles.saveBtn, ...(dirty && !saving ? {} : styles.btnDisabled) }}
              onClick={save}
              disabled={!dirty || saving}
            >
              {saving ? t('configEditor.saving') : t('configEditor.save')}
            </button>
          </div>
        </>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column' },
  muted: { color: 'var(--rv-muted)', padding: '12px 0', fontSize: 14 },
  errorBox: { color: '#c0392b', background: 'rgba(220,80,80,0.12)', padding: 12, borderRadius: 8, fontSize: 14 },
  tabs: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 },
  tab: {
    background: 'var(--rv-input-bg)', color: 'var(--rv-muted)',
    border: '1px solid var(--rv-input-border)', borderRadius: 8,
    padding: '5px 10px', fontSize: 12.5, cursor: 'pointer',
  },
  tabActive: { color: '#3b6fe0', borderColor: 'rgba(59,111,224,0.5)', background: 'rgba(59,111,224,0.10)' },
  fileLabel: { fontSize: 12.5, color: 'var(--rv-muted)', marginBottom: 8 },
  editor: {
    width: '100%', minHeight: '46vh', resize: 'vertical',
    background: 'var(--rv-input-bg)', color: 'var(--rv-fg)',
    border: '1px solid var(--rv-input-border)', borderRadius: 10,
    padding: '12px 14px', fontSize: 13, lineHeight: 1.5,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    whiteSpace: 'pre', overflow: 'auto', boxSizing: 'border-box',
  },
  footer: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 12, marginTop: 12,
  },
  hint: { color: '#b7791f', fontSize: 12.5, lineHeight: 1.4, flex: 1 },
  saveBtn: {
    background: '#3b6fe0', color: '#fff', border: 'none', borderRadius: 8,
    padding: '8px 18px', fontSize: 13, cursor: 'pointer', fontWeight: 500, whiteSpace: 'nowrap',
  },
  btnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  toast: { marginBottom: 12, padding: '10px 12px', borderRadius: 8, fontSize: 13 },
  toastSuccess: { background: 'rgba(60,180,120,0.18)', color: '#1e7a4d' },
  toastError: { background: 'rgba(220,80,80,0.16)', color: '#c0392b' },
};

export default ConfigPanel;
