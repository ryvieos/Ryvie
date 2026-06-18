import React from 'react';
import axios from '../utils/setupAxios';
import urlsConfig from '../config/urls';
import { useLanguage } from '../contexts/LanguageContext';

const { getServerUrl } = urlsConfig;

interface Provider {
  id: string;
  label: string;
  needsKey: boolean;
  needsBaseUrl: boolean;
  models: string[];
  defaultBaseUrl: string;
}
interface AiApp { id: string; name: string; connected: boolean; restarts?: boolean; model?: string | null; }
interface AiStatus {
  configured: boolean;
  provider: string | null;
  model: string | null;
  baseUrl: string;
  hasKey: boolean;
  running: boolean;
  appBaseUrl: string | null;
}

/**
 * Réglages du point central IA (Réglages cloud, admin). L'utilisateur connecte
 * UN fournisseur LLM (clé/modèle) une seule fois, puis choisit quelles apps
 * installées sont reliées à l'IA. Le backend pilote LiteLLM (cf. aiService).
 */
const AiSettings: React.FC<{ accessMode: string }> = ({ accessMode }) => {
  const { t } = useLanguage();
  const serverUrl = getServerUrl(accessMode);

  const [loading, setLoading] = React.useState(true);
  const [status, setStatus] = React.useState<AiStatus | null>(null);
  const [providers, setProviders] = React.useState<Provider[]>([]);
  const [apps, setApps] = React.useState<AiApp[]>([]);

  const [provider, setProvider] = React.useState('');
  const [apiKey, setApiKey] = React.useState('');
  const [baseUrl, setBaseUrl] = React.useState('');
  const [model, setModel] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [savedFlash, setSavedFlash] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [loadingModels, setLoadingModels] = React.useState(false);
  const [liveModels, setLiveModels] = React.useState<string[]>([]);
  const [customMode, setCustomMode] = React.useState(false);
  const [busyApps, setBusyApps] = React.useState<Set<string>>(new Set());
  const [confirmApp, setConfirmApp] = React.useState<AiApp | null>(null);
  const [confirmModel, setConfirmModel] = React.useState<{ app: AiApp; model: string } | null>(null);
  const [confirmSave, setConfirmSave] = React.useState(false);
  const [toast, setToast] = React.useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  // État d'authentification du fournisseur « Claude CLI » (binaire claude local) +
  // flux de connexion OAuth piloté depuis Ryvie (lien à ouvrir + code à recoller).
  const [cliAuth, setCliAuth] = React.useState<{ loggedIn: boolean; installed?: boolean; email?: string; subscriptionType?: string } | null>(null);
  const [cliBusy, setCliBusy] = React.useState(false);
  const [loginUrl, setLoginUrl] = React.useState('');
  const [loginCode, setLoginCode] = React.useState('');

  const selectedProvider = providers.find((p) => p.id === provider);
  // Fournisseur réellement ENREGISTRÉ (≠ sélection en cours dans le formulaire) :
  // sert de base aux modèles proposés par app, indépendamment d'un changement non sauvé.
  const activeProvider = providers.find((p) => p.id === status?.provider);
  const appModelChoices = activeProvider?.models || [];
  // Options du menu déroulant de modèles : liste live si chargée, sinon suggestions
  // du fournisseur ; on y ajoute toujours le modèle courant s'il n'y figure pas.
  const baseModels = liveModels.length ? liveModels : (selectedProvider?.models || []);
  const modelOptions = model && !baseModels.includes(model) ? [model, ...baseModels] : baseModels;

  // Les champs du formulaire (fournisseur/modèle/URL) ne sont initialisés qu'UNE
  // fois depuis le backend : un rafraîchissement (après test, etc.) ne doit jamais
  // écraser une sélection en cours de l'utilisateur.
  const formInited = React.useRef(false);

  const load = React.useCallback(async () => {
    try {
      const res = await axios.get(`${serverUrl}/api/ai/config`, { _noAuthRedirect: true } as any);
      const s: AiStatus = res.data.status;
      setStatus(s);
      setProviders(res.data.providers || []);
      setApps(res.data.apps || []);
      if (!formInited.current) {
        if (s.provider) setProvider(s.provider);
        if (s.model) setModel(s.model);
        setBaseUrl(s.baseUrl || '');
        formInited.current = true;
      }
    } catch (e: any) {
      setToast({ type: 'error', msg: e?.response?.data?.error || t('settings.ai.loadError') });
    } finally {
      setLoading(false);
    }
    // t volontairement hors deps : sinon l'effet de montage se redéclencherait à
    // chaque rendu et réécraserait la sélection. eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverUrl]);

  // Chargement initial unique.
  React.useEffect(() => { load(); }, [load]);

  // Rafraîchit périodiquement la liste des apps connectables tant que la carte des
  // réglages IA est ouverte : une app installée ou désinstallée apparaît/disparaît
  // automatiquement, sans avoir à recharger la page. On saute le tick pendant une
  // action en cours (connexion/déconnexion/sauvegarde) pour ne pas écraser l'état
  // optimiste local. Les refs évitent de recréer l'intervalle à chaque action.
  const busyRef = React.useRef(busyApps);
  busyRef.current = busyApps;
  const savingRef = React.useRef(saving);
  savingRef.current = saving;
  React.useEffect(() => {
    const id = setInterval(() => {
      if (busyRef.current.size === 0 && !savingRef.current) load();
    }, 5000);
    return () => clearInterval(id);
  }, [load]);

  React.useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);

  const onProviderChange = (id: string) => {
    setProvider(id);
    const p = providers.find((x) => x.id === id);
    setModel(p?.models?.[0] || '');
    setBaseUrl(p?.defaultBaseUrl || '');
    setApiKey('');
    setLiveModels([]); // suggestions live invalides pour le nouveau fournisseur
    setCustomMode(false);
  };

  // silent = déclenché automatiquement (ouverture de la liste) : pas de toast, pour
  // ne pas spammer. Le bouton ↻ appelle fetchModels(false) et affiche le retour.
  const fetchModels = async (silent = false) => {
    if (!provider || loadingModels) return;
    setLoadingModels(true);
    try {
      const res = await axios.post(
        `${serverUrl}/api/ai/models`,
        { provider, apiKey: apiKey || undefined, baseUrl },
        { timeout: 30000, _noAuthRedirect: true } as any
      );
      if (res.data?.ok) {
        const models: string[] = res.data.models || [];
        setLiveModels(models);
        if (!silent) setToast({ type: 'success', msg: `${models.length} ${t('settings.ai.modelsLoaded')}` });
      } else if (!silent) {
        setToast({ type: 'error', msg: `${t('settings.ai.modelsError')} ${res.data?.error || ''}`.trim() });
      }
    } catch (e: any) {
      if (!silent) setToast({ type: 'error', msg: e?.response?.data?.error || t('settings.ai.modelsError') });
    } finally {
      setLoadingModels(false);
    }
  };

  const save = async () => {
    if (!provider) return;
    setSaving(true);
    try {
      const res = await axios.put(
        `${serverUrl}/api/ai/config`,
        { provider, apiKey: apiKey || undefined, baseUrl, model },
        { timeout: 120000, _noAuthRedirect: true } as any
      );
      setStatus(res.data);
      setApiKey('');
      setToast({
        type: 'success',
        msg: res.data?.ready === false ? t('settings.ai.savedPending') : t('settings.ai.saved')
      });
      // Flash « ✓ Enregistré » animé sur le bouton pendant ~2,5 s.
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);
    } catch (e: any) {
      setToast({ type: 'error', msg: e?.response?.data?.error || t('settings.ai.saveError') });
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const res = await axios.post(`${serverUrl}/api/ai/test`, { provider, model }, { timeout: 60000, _noAuthRedirect: true } as any);
      const tested = res.data?.model ? ` (${res.data.model})` : '';
      if (res.data?.ok) {
        // On ne montre PAS la réponse du modèle (variable, ex. « pong ») : seul
        // compte de savoir si le modèle répond/est connecté.
        setToast({ type: 'success', msg: `${t('settings.ai.testOk')}${tested}`.trim() });
      } else {
        setToast({ type: 'error', msg: `${t('settings.ai.testFail')}${tested} ${res.data?.error || ''}`.trim() });
      }
      // Le test peut avoir (re)démarré la passerelle → rafraîchit l'état.
      load();
    } catch (e: any) {
      setToast({ type: 'error', msg: e?.response?.data?.error || t('settings.ai.testFail') });
    } finally {
      setTesting(false);
    }
  };

  // ───── Fournisseur Claude CLI : état d'auth + connexion OAuth depuis l'interface ─────
  const fetchCliStatus = React.useCallback(async () => {
    setCliBusy(true);
    try {
      const res = await axios.get(`${serverUrl}/api/ai/cli/status`, { timeout: 15000, _noAuthRedirect: true } as any);
      setCliAuth(res.data || { loggedIn: false });
    } catch (_) {
      setCliAuth({ loggedIn: false });
    } finally {
      setCliBusy(false);
    }
  }, [serverUrl]);

  // Charge l'état d'auth dès que le fournisseur Claude CLI est sélectionné.
  React.useEffect(() => {
    if (provider === 'claude-cli') { fetchCliStatus(); }
    else { setCliAuth(null); setLoginUrl(''); setLoginCode(''); }
  }, [provider, fetchCliStatus]);

  const startCliLogin = async () => {
    setCliBusy(true);
    setLoginCode('');
    try {
      const res = await axios.post(`${serverUrl}/api/ai/cli/login/start`, {}, { timeout: 30000, _noAuthRedirect: true } as any);
      if (res.data?.url) setLoginUrl(res.data.url);
      else setToast({ type: 'error', msg: res.data?.error || t('settings.ai.cliLoginError') });
    } catch (e: any) {
      setToast({ type: 'error', msg: e?.response?.data?.error || t('settings.ai.cliLoginError') });
    } finally {
      setCliBusy(false);
    }
  };

  const submitCliCode = async () => {
    if (!loginCode.trim()) return;
    setCliBusy(true);
    try {
      const res = await axios.post(
        `${serverUrl}/api/ai/cli/login/complete`,
        { code: loginCode.trim() },
        { timeout: 30000, _noAuthRedirect: true } as any
      );
      if (res.data?.ok) {
        setToast({ type: 'success', msg: t('settings.ai.cliLoginOk') });
        setLoginUrl(''); setLoginCode('');
        fetchCliStatus();
      } else {
        setToast({ type: 'error', msg: res.data?.error || t('settings.ai.cliLoginError') });
      }
    } catch (e: any) {
      setToast({ type: 'error', msg: e?.response?.data?.error || t('settings.ai.cliLoginError') });
    } finally {
      setCliBusy(false);
    }
  };

  const cancelCliLogin = async () => {
    setLoginUrl(''); setLoginCode('');
    try { await axios.post(`${serverUrl}/api/ai/cli/login/cancel`, {}, { timeout: 10000, _noAuthRedirect: true } as any); } catch (_) { /* best effort */ }
  };

  const cliLogout = async () => {
    setCliBusy(true);
    try {
      const res = await axios.post(`${serverUrl}/api/ai/cli/logout`, {}, { timeout: 20000, _noAuthRedirect: true } as any);
      if (res.data?.ok) { setToast({ type: 'success', msg: t('settings.ai.cliLogoutOk') }); }
      else { setToast({ type: 'error', msg: res.data?.error || t('settings.ai.cliLogoutError') }); }
    } catch (e: any) {
      setToast({ type: 'error', msg: e?.response?.data?.error || t('settings.ai.cliLogoutError') });
    } finally {
      setLoginUrl(''); setLoginCode('');
      fetchCliStatus();
      setCliBusy(false);
    }
  };

  const toggleApp = async (app: AiApp) => {
    setBusyApps((prev) => new Set(prev).add(app.id));
    try {
      if (app.connected) {
        await axios.delete(`${serverUrl}/api/ai/apps/${app.id}/connect`, { timeout: 120000, _noAuthRedirect: true } as any);
      } else {
        await axios.post(`${serverUrl}/api/ai/apps/${app.id}/connect`, {}, { timeout: 120000, _noAuthRedirect: true } as any);
      }
      setApps((prev) => prev.map((a) => (a.id === app.id ? { ...a, connected: !a.connected } : a)));
    } catch (e: any) {
      setToast({ type: 'error', msg: e?.response?.data?.error || t('settings.ai.appError') });
    } finally {
      setBusyApps((prev) => { const n = new Set(prev); n.delete(app.id); return n; });
    }
  };

  // Change le modèle PROPRE à une app (override). model vide → retour au modèle global.
  const changeAppModel = async (app: AiApp, model: string) => {
    setBusyApps((prev) => new Set(prev).add(app.id));
    try {
      await axios.put(
        `${serverUrl}/api/ai/apps/${app.id}/model`,
        { model: model || '' },
        { timeout: 120000, _noAuthRedirect: true } as any
      );
      setApps((prev) => prev.map((a) => (a.id === app.id ? { ...a, model: model || null } : a)));
      setToast({ type: 'success', msg: t('settings.ai.appModelSaved') });
    } catch (e: any) {
      setToast({ type: 'error', msg: e?.response?.data?.error || t('settings.ai.appError') });
    } finally {
      setBusyApps((prev) => { const n = new Set(prev); n.delete(app.id); return n; });
    }
  };

  if (loading) {
    return (
      <div className="settings-card">
        <h3>🤖 {t('settings.ai.title')}</h3>
        <p className="setting-hint">{t('common.loading')}</p>
      </div>
    );
  }

  const configured = !!status?.configured;

  return (
    <div className="settings-grid">
      {/* Carte fournisseur */}
      <div className="settings-card">
        <h3 className="ai-card-head">
          <span>🤖 {t('settings.ai.title')}</span>
          {configured && (
            <span className={`ai-gateway-pill ${status?.running ? 'on' : 'off'}`}>
              <span className="ai-gateway-dot" />
              {status?.running ? t('settings.ai.running') : t('settings.ai.notRunning')}
            </span>
          )}
        </h3>
        <p className="setting-hint" style={{ marginBottom: 12 }}>{t('settings.ai.description')}</p>

        {toast && (
          <div className={`status-message ${toast.type === 'success' ? 'success' : 'error'}`} style={{ marginBottom: 12 }}>
            {toast.msg}
          </div>
        )}

        <div className="setting-item">
          <label>{t('settings.ai.provider')}</label>
          <select className="setting-select" value={provider} onChange={(e) => onProviderChange(e.target.value)}>
            <option value="" disabled>{t('settings.ai.selectProvider')}</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>

        {/* Fournisseur Claude CLI : état de connexion + login OAuth depuis l'interface */}
        {provider === 'claude-cli' && (
          <div className="setting-item ai-cli-auth">
            <div className="ai-cli-status-row">
              <span className={`ai-cli-pill ${cliAuth?.loggedIn ? 'on' : 'off'}`}>
                <span className="ai-cli-dot" />
                {cliBusy && !cliAuth
                  ? t('settings.ai.cliChecking')
                  : cliAuth?.installed === false
                    ? t('settings.ai.cliNotInstalled')
                    : cliAuth?.loggedIn
                      ? t('settings.ai.cliConnected').replace('{email}', cliAuth.email || '')
                        + (cliAuth.subscriptionType ? ` (${cliAuth.subscriptionType})` : '')
                      : t('settings.ai.cliNotConnected')}
              </span>
              {/* Bouton « Se connecter » uniquement si claude est installé mais pas connecté */}
              {cliAuth && cliAuth.installed !== false && !cliAuth.loggedIn && !loginUrl && (
                <button type="button" className="toggle-button active" disabled={cliBusy} onClick={startCliLogin}>
                  {cliBusy ? t('settings.ai.cliStarting') : t('settings.ai.cliConnect')}
                </button>
              )}
              {/* Bouton « Se déconnecter » quand on est connecté */}
              {cliAuth?.loggedIn && (
                <button type="button" className="toggle-button" disabled={cliBusy} onClick={cliLogout}>
                  {cliBusy ? '…' : t('settings.ai.cliDisconnect')}
                </button>
              )}
            </div>

            {loginUrl && (
              <div className="ai-cli-login">
                <p className="setting-hint">{t('settings.ai.cliLoginIntro')}</p>
                <a className="toggle-button active ai-cli-link" href={loginUrl} target="_blank" rel="noopener noreferrer">
                  🔗 {t('settings.ai.cliOpenLink')}
                </a>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <input
                    type="text"
                    className="setting-select"
                    style={{ flex: 1 }}
                    value={loginCode}
                    placeholder={t('settings.ai.cliCodePlaceholder')}
                    onChange={(e) => setLoginCode(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') submitCliCode(); }}
                    autoFocus
                  />
                  <button type="button" className="toggle-button active" disabled={cliBusy || !loginCode.trim()} onClick={submitCliCode}>
                    {cliBusy ? '…' : t('settings.ai.cliValidate')}
                  </button>
                  <button type="button" className="toggle-button" disabled={cliBusy} onClick={cancelCliLogin}>
                    {t('settings.ai.cancel')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {selectedProvider?.needsKey && (
          <div className="setting-item">
            <label>{t('settings.ai.apiKey')}</label>
            <input
              type="password"
              className="setting-select"
              value={apiKey}
              autoComplete="new-password"
              placeholder={status?.hasKey ? '•••••••••••• ' + t('settings.ai.keyStored') : t('settings.ai.apiKeyPlaceholder')}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
        )}

        {selectedProvider?.needsBaseUrl && (
          <div className="setting-item">
            <label>{t('settings.ai.baseUrl')}</label>
            <input
              type="text"
              className="setting-select"
              value={baseUrl}
              placeholder="http://…"
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
        )}

        {provider && (
          <div className="setting-item">
            <label>{t('settings.ai.model')}</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {/* Menu déroulant scrollable (montre tout le catalogue, défile nativement) */}
              <select
                className="setting-select"
                style={{ flex: 1 }}
                value={customMode ? '__custom__' : model}
                // Charge la liste live du fournisseur à chaque ouverture (silencieux,
                // guardé) → plus besoin de cliquer ↻ pour voir les modèles.
                onMouseDown={() => fetchModels(true)}
                onChange={(e) => {
                  if (e.target.value === '__custom__') { setCustomMode(true); setModel(''); }
                  else { setCustomMode(false); setModel(e.target.value); }
                }}
              >
                <option value="" disabled>{t('settings.ai.pickModel')}</option>
                {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                <option value="__custom__">{t('settings.ai.customModel')}</option>
              </select>
              <button
                type="button"
                className="toggle-button"
                disabled={loadingModels}
                onClick={() => fetchModels(false)}
                title={t('settings.ai.loadModels')}
              >
                {loadingModels ? '…' : '↻'}
              </button>
            </div>
            {customMode && (
              <input
                type="text"
                className="setting-select"
                style={{ marginTop: 6 }}
                value={model}
                placeholder={t('settings.ai.modelPlaceholder')}
                onChange={(e) => setModel(e.target.value)}
                autoFocus
              />
            )}
            <p className="setting-hint" style={{ fontSize: '0.85em', marginTop: 4 }}>
              {liveModels.length
                ? `${liveModels.length} ${t('settings.ai.modelsAvailable')}`
                : t('settings.ai.modelHint')}
            </p>
          </div>
        )}

        <div className="ai-actions">
          <button
            className={`toggle-button active${savedFlash ? ' ai-saved-flash' : ''}`}
            disabled={!provider || saving}
            onClick={() => (configured ? setConfirmSave(true) : save())}
          >
            {saving ? t('settings.ai.saving') : savedFlash ? `✓ ${t('settings.ai.savedShort')}` : t('settings.ai.save')}
          </button>
          <button className="toggle-button" disabled={!configured || testing || saving} onClick={test}>
            {testing ? t('settings.ai.testing') : t('settings.ai.test')}
          </button>
        </div>

        {configured && (
          <p className="ai-alias-note">
            <span className="ai-alias-icon" aria-hidden>ℹ️</span>
            <span>{t('settings.ai.aliasNote')}</span>
          </p>
        )}
      </div>

      {/* Carte apps connectées */}
      <div className="settings-card">
        <h3>
          {t('settings.ai.connectedApps')}
          {configured && apps.length > 0 && (
            <span className="ai-app-count"> · {apps.filter((a) => a.connected).length}/{apps.length}</span>
          )}
        </h3>
        {!configured && <p className="setting-hint">{t('settings.ai.configureFirst')}</p>}
        {configured && apps.length === 0 && <p className="setting-hint">{t('settings.ai.noApps')}</p>}
        {configured && apps.length > 0 && (
          <div className="ai-app-list">
            {apps.map((app) => {
              const busy = busyApps.has(app.id);
              return (
                <div className="ai-app-row" key={app.id}>
                  <div className="ai-app-info">
                    <img
                      className="ai-app-icon"
                      src={`${serverUrl}/api/apps/${app.id}/icon`}
                      alt=""
                      onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }}
                    />
                    <span className="ai-app-name">{app.name}</span>
                  </div>
                  <div className="ai-app-right">
                    {/* Modèle propre à l'app (override). Vide = modèle global. */}
                    {app.connected && (
                      <select
                        className="setting-select ai-app-model"
                        value={app.model || ''}
                        disabled={busy}
                        title={t('settings.ai.appModelTitle')}
                        onChange={(e) => {
                          const v = e.target.value;
                          let chosen: string | null = v;
                          if (v === '__custom__') {
                            chosen = window.prompt(t('settings.ai.appModelCustomPrompt'), app.model || '');
                            if (chosen === null) return; // annulé
                            chosen = chosen.trim();
                          }
                          // Apps qui redémarrent → confirmation (comme connecter/déconnecter).
                          if (app.restarts) setConfirmModel({ app, model: chosen });
                          else changeAppModel(app, chosen);
                        }}
                      >
                        <option value="">{t('settings.ai.appModelDefault')}</option>
                        {appModelChoices.map((m) => <option key={m} value={m}>{m}</option>)}
                        {app.model && !appModelChoices.includes(app.model) && (
                          <option value={app.model}>{app.model}</option>
                        )}
                        <option value="__custom__">{t('settings.ai.customModel')}</option>
                      </select>
                    )}
                    {busy ? (
                      <span className="ai-app-spinner" aria-hidden />
                    ) : (
                      <span className={`ai-app-status ${app.connected ? 'on' : ''}`}>
                        {app.connected ? t('settings.ai.statusOn') : t('settings.ai.statusOff')}
                      </span>
                    )}
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={app.connected}
                        disabled={busy}
                        onChange={() => setConfirmApp(app)}
                      />
                      <span className="slider"></span>
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Pop-up de confirmation : connecter/déconnecter redémarre l'app */}
      {confirmApp && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9999,
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}
          onClick={() => setConfirmApp(null)}
        >
          <div
            style={{
              background: '#fff', color: '#111', borderRadius: 12, padding: 24, maxWidth: 420,
              width: '90%', boxShadow: '0 10px 40px rgba(0,0,0,0.3)'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0 }}>
              {(confirmApp.connected ? t('settings.ai.confirmDisconnect') : t('settings.ai.confirmConnect')).replace('{app}', confirmApp.name)}
            </h3>
            {confirmApp.restarts && (
              <p style={{ color: '#b45309', fontSize: '0.92em' }}>{t('settings.ai.confirmWarn')}</p>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
              <button className="toggle-button" onClick={() => setConfirmApp(null)}>
                {t('settings.ai.cancel')}
              </button>
              <button
                className="toggle-button active"
                onClick={() => { const a = confirmApp; setConfirmApp(null); toggleApp(a); }}
              >
                {t('settings.ai.proceed')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pop-up de confirmation : changer le modèle d'une app qui redémarre */}
      {confirmModel && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9999,
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}
          onClick={() => setConfirmModel(null)}
        >
          <div
            style={{
              background: '#fff', color: '#111', borderRadius: 12, padding: 24, maxWidth: 420,
              width: '90%', boxShadow: '0 10px 40px rgba(0,0,0,0.3)'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0 }}>
              {t('settings.ai.confirmModelTitle')
                .replace('{app}', confirmModel.app.name)
                .replace('{model}', confirmModel.model || t('settings.ai.appModelDefault'))}
            </h3>
            <p style={{ color: '#b45309', fontSize: '0.92em' }}>{t('settings.ai.confirmWarn')}</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
              <button className="toggle-button" onClick={() => setConfirmModel(null)}>
                {t('settings.ai.cancel')}
              </button>
              <button
                className="toggle-button active"
                onClick={() => { const c = confirmModel; setConfirmModel(null); changeAppModel(c.app, c.model); }}
              >
                {t('settings.ai.proceed')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pop-up de confirmation : enregistrer redémarre la passerelle (coupe l'IA des apps) */}
      {confirmSave && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9999,
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}
          onClick={() => setConfirmSave(false)}
        >
          <div
            style={{
              background: '#fff', color: '#111', borderRadius: 12, padding: 24, maxWidth: 420,
              width: '90%', boxShadow: '0 10px 40px rgba(0,0,0,0.3)'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0 }}>{t('settings.ai.confirmSaveTitle')}</h3>
            <p style={{ color: '#b45309', fontSize: '0.92em' }}>{t('settings.ai.saveWarn')}</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
              <button className="toggle-button" onClick={() => setConfirmSave(false)}>
                {t('settings.ai.cancel')}
              </button>
              <button
                className="toggle-button active"
                onClick={() => { setConfirmSave(false); save(); }}
              >
                {t('settings.ai.proceed')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AiSettings;
