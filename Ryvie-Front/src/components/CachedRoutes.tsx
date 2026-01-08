import React, { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * CachedRoutes - Garde Home et Settings montés en arrière-plan
 * Permet une navigation instantanée sans démontage/remontage
 */
export const CachedRoutes = ({ homeComponent, settingsComponent }) => {
  const location = useLocation();
  const [homeLoaded, setHomeLoaded] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  const isHome = location.pathname === '/home';
  const isSettings = location.pathname === '/settings';

  useEffect(() => {
    // Marquer les pages comme chargées quand on les visite
    if (isHome) setHomeLoaded(true);
    if (isSettings) setSettingsLoaded(true);
  }, [isHome, isSettings]);

  return (
    <>
      {/* Home - toujours monté après première visite */}
      {homeLoaded && (
        <div style={{ display: isHome ? 'block' : 'none' }}>
          {homeComponent}
        </div>
      )}
      
      {/* Settings - toujours monté après première visite */}
      {settingsLoaded && (
        <div style={{ display: isSettings ? 'block' : 'none' }}>
          {settingsComponent}
        </div>
      )}
    </>
  );
};
