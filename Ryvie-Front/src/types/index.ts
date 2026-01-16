export interface GridConfig {
  BASE_COLS: number;
  BASE_ROWS: number;
  SLOT_SIZE: number;
  GAP: number;
  MIN_COLS: number;
  HORIZONTAL_PADDING: number;
}

export interface AppConfig {
  id?: string;
  name: string;
  description?: string;
  category?: string;
  icon?: string;
  urlKey: string;
  showStatus: boolean;
  isTaskbarApp: boolean;
  containerName?: string;
  mainPort?: number;
  ports?: number[];
  route?: string | null;
}

export interface AppManifest {
  id: string;
  name: string;
  description: string;
  category: string;
  mainPort: number;
  ports: number[];
  requiresHttps?: boolean;
}

export interface NetbirdData {
  domains: Record<string, string>;
  received: {
    backendHost: string;
  };
}

export interface UrlConfig {
  REMOTE: string;
  PRIVATE: string;
}

export interface BaseUrls {
  FRONTEND: UrlConfig;
  SERVER: UrlConfig;
  APPS: Record<string, UrlConfig>;
  RDRIVE_BACKEND: {
    BACKEND: UrlConfig;
    CONNECTOR: UrlConfig;
    DOCUMENT: UrlConfig;
  };
}

export interface LocationInfo {
  hostname: string;
  protocol: string;
  port: string;
}

export type AccessMode = 'private' | 'remote';

export interface SessionInfo {
  token: string;
  user: string;
  role: string;
  email?: string;
}

export interface UserInfo {
  name: string;
  role: string;
  email: string | null;
  fromUrl?: boolean;
}

export interface AppStatus {
  status: 'running' | 'stopped' | 'error';
  containerName?: string;
}

export interface ServerInfo {
  cpuUsage: number;
  ramUsage: number;
  totalRam: number;
  storageUsage: number;
  totalStorage: number;
}

export interface InstallProgress {
  appId: string;
  status: 'downloading' | 'installing' | 'completed' | 'error';
  progress: number;
  message?: string;
}

// API Response types
export interface ApiResponse<T = unknown> {
  success: boolean;
  data: T;
  error?: string;
  message?: string;
}

export interface AppInstallResponse {
  appId: string;
  status: 'pending' | 'installing' | 'completed' | 'error';
  progress: number;
  message?: string;
}

export interface AppActionResponse {
  success: boolean;
  appId: string;
  action: 'start' | 'stop' | 'restart' | 'install' | 'uninstall';
  message?: string;
}

// Grid Layout types
export interface GridPosition {
  col: number;
  row: number;
  w: number;
  h: number;
}

export interface GridLayout {
  [itemId: string]: GridPosition;
}

export interface GridAnchors {
  [itemId: string]: number;
}

// Drag & Drop types
export interface DragOffset {
  x: number;
  y: number;
}

export interface DragPosition {
  x: number;
  y: number;
}

export interface DraggedItem {
  itemId: string;
  itemData: unknown;
}

export interface DragEndData {
  itemId: string;
  itemData: unknown;
  x: number;
  y: number;
  initialX: number;
  initialY: number;
}
