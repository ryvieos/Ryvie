import React, { useState, useEffect } from 'react';
import axios from '../../utils/setupAxios';
import BaseWidget from './BaseWidget';
import urlsConfig from '../../config/urls';
import '../../styles/widgets/DevicesWidget.css';
import { useLanguage } from '../../contexts/LanguageContext';

const { getServerUrl } = urlsConfig;

// Cache "dernière valeur connue" (stale-while-revalidate) : réaffiche immédiatement
// la dernière liste connue puis rafraîchit en arrière-plan (l'appel `netbird status`
// peut prendre quelques secondes). Évite le skeleton gris à chaque visite.
const DEVICES_CACHE_KEY = 'ryvie_widget_devices_cache';

interface Peer {
  fqdn?: string;
  hostname: string;
  ip: string | null;
  status: string;
  connectionType?: string | null;
  latency?: string | null;
  self?: boolean;
}
interface DevicesData { count: number; connected: number; peers: Peer[] }

const readCache = (): DevicesData | null => {
  try {
    const raw = localStorage.getItem(DEVICES_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.peers)) return parsed;
    }
  } catch {}
  return null;
};
const writeCache = (d: DevicesData) => {
  try { localStorage.setItem(DEVICES_CACHE_KEY, JSON.stringify(d)); } catch {}
};

// Arrondit un temps de réponse NetBird (ex. "2.082409ms") au dixième → "2.1ms".
const formatLatency = (raw?: string | null): string => {
  if (!raw) return '';
  const m = String(raw).match(/([\d.]+)\s*(ms|µs|us|ns|s)?/i);
  if (!m) return '';
  const num = parseFloat(m[1]);
  if (isNaN(num)) return '';
  return `${num.toFixed(1)}${m[2] || 'ms'}`;
};

// Heuristique d'icône selon le hostname (NetBird ne renvoie pas de type d'appareil
// explicite). On reconnaît les plateformes courantes ; sinon un ordinateur générique.
const deviceIcon = (peer: Peer): string => {
  const h = String(peer.hostname || peer.fqdn || '').toLowerCase();
  if (/iphone|ipod|android|pixel|samsung|galaxy|redmi|xiaomi|oneplus|huawei|phone|mobile/.test(h)) return '📱';
  if (/ipad|tablet/.test(h)) return '📱';
  if (/raspberry|rpi|server|nas|ryvie/.test(h)) return '🖥️';
  if (/macbook|imac|mac-|-mac|macos|darwin/.test(h)) return '💻';
  if (/pc|windows|win-|desktop|laptop|linux|ubuntu|debian/.test(h)) return '💻';
  return '💻';
};

const isConnected = (p: Peer) => /connected/i.test(p.status || '');

/**
 * Widget listant les appareils connectés au réseau privé Ryvie (peers NetBird).
 */
const DevicesWidget = ({ id, onRemove, accessMode }: { id: string; onRemove?: () => void; accessMode?: string }) => {
  const { t } = useLanguage();
  const cached = readCache();
  const [data, setData] = useState<DevicesData>(cached || { count: 0, connected: 0, peers: [] });
  const [loading, setLoading] = useState(!cached);

  useEffect(() => {
    let cancelled = false;
    const fetchPeers = async () => {
      try {
        const serverUrl = getServerUrl(accessMode || 'private');
        const res = await axios.get(`${serverUrl}/api/settings/vpn-peers`, { timeout: 20000 });
        if (cancelled || !res.data?.success) return;
        const next: DevicesData = {
          count: res.data.count || 0,
          connected: res.data.connected || 0,
          peers: Array.isArray(res.data.peers) ? res.data.peers : [],
        };
        setData(next);
        writeCache(next);
        setLoading(false);
      } catch (error) {
        console.error('[DevicesWidget] Erreur lors de la récupération des appareils:', error);
        if (!cancelled) setLoading(false);
      }
    };
    fetchPeers();
    const interval = setInterval(fetchPeers, 15000); // rafraîchissement silencieux
    return () => { cancelled = true; clearInterval(interval); };
  }, [accessMode]);

  const peers = data.peers;

  const metaFor = (p: Peer): string => {
    if (!isConnected(p)) return t('devicesWidget.offline');
    return formatLatency(p.latency) || p.connectionType || t('devicesWidget.online');
  };

  // Titre natif de BaseWidget (même position que les autres widgets) + compteur
  // en pilule juste après le libellé, à gauche → jamais sous la croix (top-right).
  const titleNode = (
    <span className="devices-title-wrap">
      {t('devicesWidget.title')}
      {!loading && (
        <span className="devices-count" title={`${data.connected}/${data.count}`}>
          <span className="devices-count-connected">{data.connected}</span>
          <span className="devices-count-sep">/</span>
          <span className="devices-count-total">{data.count}</span>
        </span>
      )}
    </span>
  );

  return (
    <BaseWidget
      id={id}
      title={titleNode}
      icon="📡"
      onRemove={onRemove}
      w={2}
      h={2}
      className="gradient devices-widget"
    >
      {loading ? (
        <div className="devices-list">
          {[0, 1, 2].map((i) => (
            <div className="devices-row devices-row--skeleton" key={i}>
              <div className="devices-skel-icon" />
              <div className="devices-skel-line" />
            </div>
          ))}
        </div>
      ) : peers.length === 0 ? (
        <div className="devices-empty">{t('devicesWidget.empty')}</div>
      ) : (
        <div className="devices-list">
          {peers.map((p, i) => (
            <div className={`devices-row ${isConnected(p) ? 'is-online' : 'is-offline'}`} key={p.fqdn || p.hostname || i}>
              <span className="devices-icon">{deviceIcon(p)}</span>
              <div className="devices-info">
                <div className="devices-name" title={p.fqdn || p.hostname}>
                  {p.hostname}
                  {p.self && <span className="devices-self">{t('devicesWidget.thisDevice')}</span>}
                </div>
              </div>
              <span className={`devices-dot ${isConnected(p) ? 'online' : 'offline'}`} />
            </div>
          ))}
        </div>
      )}
    </BaseWidget>
  );
};

export default DevicesWidget;
