export function isElectron(): boolean {
  return !!(window && (window as any).electronAPI);
}

export function isWeb(): boolean {
  return !isElectron();
}

export function ifElectron<T>(electronFn: () => T, webFallback: () => T = () => ({} as T)): T {
  if (isElectron()) {
    return electronFn();
  } else {
    return webFallback();
  }
}

export function ifWeb<T>(webFn: () => T, electronFallback: () => T = () => ({} as T)): T {
  if (isWeb()) {
    return webFn();
  } else {
    return electronFallback();
  }
}

export const WindowManager = {
  openWindow: (url: string, options: { width?: number; height?: number } = {}) => {
    if (isElectron()) {
      window.open(url, '_blank', `width=${options.width || 1000},height=${options.height || 700}`);
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  },

  closeWindow: () => {
    if (isElectron() && (window as any).electronAPI) {
      (window as any).electronAPI.closeCurrentWindow();
    } else {
      window.location.href = '/login';
    }
  }
};

export const StorageManager = {
  setItem: (key: string, value: any) => {
    const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
    localStorage.setItem(key, stringValue);
  },

  getItem: <T = any>(key: string, defaultValue: T | null = null): T | null => {
    try {
      const value = localStorage.getItem(key);
      if (value === null) return defaultValue;
      
      try {
        return JSON.parse(value) as T;
      } catch {
        return value as any;
      }
    } catch {
      return defaultValue;
    }
  },

  removeItem: (key: string) => {
    localStorage.removeItem(key);
  },

  clear: () => {
    localStorage.clear();
  }
};

export const NotificationManager = {
  show: (title: string, message: string, options: NotificationOptions = {}) => {
    if (isElectron()) {
      new Notification(title, {
        body: message,
        icon: options.icon,
        ...options
      });
    } else {
      if (Notification.permission === 'granted') {
        new Notification(title, {
          body: message,
          icon: options.icon || '/favicon.ico',
          ...options
        });
      } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then(permission => {
          if (permission === 'granted') {
            new Notification(title, {
              body: message,
              icon: options.icon || '/favicon.ico',
              ...options
            });
          }
        });
      }
    }
  }
};

export default {
  isElectron,
  isWeb,
  ifElectron,
  ifWeb,
  WindowManager,
  StorageManager,
  NotificationManager
};
