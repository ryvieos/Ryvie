import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { getCurrentUser } from '../utils/sessionManager';
import frTranslations from '../i18n/fr.json';
import enTranslations from '../i18n/en.json';

type Translations = Record<string, any>;

interface LanguageContextType {
  language: string;
  setLanguage: (lang: string) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  translations: Translations;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

const translations: { [key: string]: Translations } = {
  fr: frTranslations,
  en: enTranslations,
};

export const LanguageProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<string>(() => {
    try {
      const currentUser = getCurrentUser();
      if (currentUser) {
        const cached = localStorage.getItem(`ryvie_language_${currentUser}`);
        if (cached && (cached === 'fr' || cached === 'en')) {
          return cached;
        }
      }
      const globalLang = localStorage.getItem('ryvie_language_global');
      if (globalLang && (globalLang === 'fr' || globalLang === 'en')) {
        return globalLang;
      }
    } catch (e) {
      console.error('[LanguageContext] Error loading language:', e);
    }
    return 'fr';
  });

  const setLanguage = (lang: string) => {
    console.log(`[LanguageContext] Changement de langue: ${language} → ${lang}`);
    setLanguageState(lang);
    try {
      const currentUser = getCurrentUser();
      if (currentUser) {
        localStorage.setItem(`ryvie_language_${currentUser}`, lang);
      }
      localStorage.setItem('ryvie_language_global', lang);
      console.log(`[LanguageContext] Langue sauvegardée: ${lang}`);
    } catch (e) {
      console.error('[LanguageContext] Error saving language:', e);
    }
  };

  const t = (key: string, params?: Record<string, string | number>): string => {
    const keys = key.split('.');
    let value: any = translations[language] || translations.fr;
    
    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        console.warn(`[i18n] Translation key not found: ${key}`);
        return key;
      }
    }
    
    if (typeof value !== 'string') return key;

    if (!params) return value;

    return Object.entries(params).reduce((acc, [paramKey, paramValue]) => {
      return acc.replaceAll(`{${paramKey}}`, String(paramValue));
    }, value);
  };

  useEffect(() => {
    const currentUser = getCurrentUser();
    if (currentUser) {
      const cached = localStorage.getItem(`ryvie_language_${currentUser}`);
      if (cached && (cached === 'fr' || cached === 'en') && cached !== language) {
        setLanguageState(cached);
      }
    }
  }, []);

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t, translations: translations[language] || translations.fr }}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = (): LanguageContextType => {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
};
