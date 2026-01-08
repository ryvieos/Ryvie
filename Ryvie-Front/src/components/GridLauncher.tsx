import React, { useState, useEffect, useRef } from 'react';
import '../styles/GridLauncher.css';
import useGridLayout from '../hooks/useGridLayout';
import useDrag from '../hooks/useDrag';
import { GRID_CONFIG } from '../config/appConfig';
import Icon from './Icon';
import WidgetAddButton from './WidgetAddButton';
import CpuRamWidget from './widgets/CpuRamWidget';
import StorageWidget from './widgets/StorageWidget';
import '../styles/GridLauncher.css';

const GridLauncher = ({
  apps,
  weather,
  weatherImages,
  weatherIcons,
  weatherCity,
  iconImages,
  appsConfig,
  appStatus,
  handleClick,
  setShowWeatherModal,
  setTempCity,
  setClosingWeatherModal,
  activeContextMenu,
  setActiveContextMenu,
  isAdmin,
  setAppStatus,
  moveIcon,
  onLayoutChange,
  initialLayout,
  initialAnchors,
  zonesReady,
  accessMode,
  widgets = [],
  onAddWidget,
  onRemoveWidget,
  refreshDesktopIcons
}) => {
  const gridRef = useRef(null);
  const resizeTimeoutRef = useRef(null);
  const { SLOT_SIZE: slotSize, GAP: gap, BASE_COLS: baseCols, BASE_ROWS: baseRows, MIN_COLS: minCols, HORIZONTAL_PADDING: horizontalPadding } = GRID_CONFIG;
  const [cols, setCols] = useState(baseCols);
  const [rows, setRows] = useState(baseRows);
  const [snappedPosition, setSnappedPosition] = useState(null);
  const pendingManualSaveRef = useRef(false); // Track si on doit sauvegarder après un drag manuel

  // Calculer le nombre de colonnes et lignes qui rentrent dans l'espace disponible
  useEffect(() => {
    const updateGridLayout = () => {
      // Calculer la largeur disponible uniquement à partir de la fenêtre, pour
      // couvrir le cas plein écran -> fenêtre (bouton "réduire") où les mesures
      // DOM peuvent être transitoirement incorrectes.
      const windowWidth = window.innerWidth || 1024;

      // Largeur fixe de la taskbar à gauche (voir Home.css: .taskbar width: 80px)
      const taskbarWidth = 80;
      // Padding horizontal de .background + .grid-launcher (20px de chaque côté environ)
      const launcherPadding = 40; // 20px * 2
      // Marge de sécurité un peu plus large pour éviter toute colonne coupée
      const safetyMargin = 32;

      const availableWidth = Math.max(320, windowWidth - taskbarWidth - launcherPadding - safetyMargin);

      // Calculer combien de colonnes de taille slotSize + gap peuvent rentrer
      // Formule: n * slotSize + (n-1) * gap <= availableWidth
      // => n * (slotSize + gap) - gap <= availableWidth
      // => n <= (availableWidth + gap) / (slotSize + gap)
      const maxCols = Math.floor((availableWidth + gap) / (slotSize + gap));
      
      // Limiter entre minCols colonnes minimum et baseCols colonnes maximum (grille de base)
      let newCols = Math.max(minCols, Math.min(baseCols, maxCols));

      // Sécurité supplémentaire : s'assurer que la largeur réelle de la grille ne dépasse pas
      // la largeur disponible (utile lors des transitions plein écran -> fenêtre réduite).
      const tileFullWidth = slotSize + gap; // largeur d'une colonne (slot + gap)
      const computeGridWidth = (colsCount) => colsCount * tileFullWidth - gap;
      while (newCols > minCols && computeGridWidth(newCols) > availableWidth) {
        newCols -= 1;
      }
      
      console.log('[GridLauncher] Calcul colonnes:', {
        windowWidth,
        availableWidth,
        maxCols,
        newCols
      });
      
      // Calculer le nombre de lignes en fonction de la hauteur réellement disponible
      // dans le conteneur .grid-launcher (plutôt que window.innerHeight), afin
      // d'éviter que la grille dépasse et déclenche un scroll inutile.
      let availableHeight = null;
      try {
        if (gridRef.current) {
          const launcher = gridRef.current.closest('.grid-launcher');
          if (launcher) {
            // padding-top/bottom : 20px chacun dans GridLauncher.css
            const launcherStyles = window.getComputedStyle(launcher);
            const paddingTop = parseFloat(launcherStyles.paddingTop || '20');
            const paddingBottom = parseFloat(launcherStyles.paddingBottom || '20');
            availableHeight = launcher.clientHeight - paddingTop - paddingBottom;
          }
        }
      } catch (_) {}

      if (!availableHeight || Number.isNaN(availableHeight)) {
        // Fallback raisonnable si on n'a pas pu lire le DOM
        availableHeight = Math.max(400, window.innerHeight - 140);
      }

      // On calcule un nombre de lignes qui remplit la zone utile sans la dépasser.
      // Petite marge négative pour être sûr de ne jamais provoquer de scroll
      // à cause d'un pixel de trop.
      const safetyHeight = 8; // px
      const effectiveHeight = Math.max(0, availableHeight - safetyHeight);
      const maxRows = Math.max(2, Math.floor((effectiveHeight + gap) / (slotSize + gap)));
      
      // Nombre de lignes effectif : dépend de la hauteur disponible
      // en utilisant maxRows (au moins 2 lignes).
      const newRows = maxRows;
      
      setCols(newCols);
      setRows(newRows);
    };

    // 1) Calcul immédiat au montage
    updateGridLayout();

    // 2) Recalcul différé pour laisser le temps au DOM et aux prefs
    //    (launcherLayout, widgets, barres du navigateur...) de se stabiliser.
    //    Cela évite que la première organisation soit faite sur une taille
    //    intermédiaire de la fenêtre.
    const delayedTimeoutId = setTimeout(() => {
      try {
        updateGridLayout();
      } catch (_) {}
    }, 200);

    // 3) Debounce pour le resize (éviter trop de recalculs)
    const debouncedResize = () => {
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
      }
      resizeTimeoutRef.current = setTimeout(updateGridLayout, 50);
    };
    
    window.addEventListener('resize', debouncedResize);
    return () => {
      clearTimeout(delayedTimeoutId);
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
      }
      window.removeEventListener('resize', debouncedResize);
    };
  }, [gap, slotSize, baseCols, baseRows, minCols, horizontalPadding, apps.length, widgets.length]);

  // Préparer les items pour le layout
  const items = [
    { id: 'weather', type: 'weather', w: 3, h: 2 },
    ...apps.map(appId => ({ id: appId, type: 'app', w: 1, h: 1 })),
    ...widgets.map(widget => ({ id: widget.id, type: 'widget', widgetType: widget.type, w: 2, h: 2 }))
  ];

  const { layout, moveItem, swapItems, pixelToGrid, getAnchors } = useGridLayout(items, cols, initialLayout, initialAnchors);

  // NE PLUS notifier automatiquement le parent à chaque changement de layout
  // car cela déclenchait des sauvegardes backend lors des réorganisations automatiques (responsive).
  // Seuls les drags manuels (handleDrop) déclenchent maintenant onLayoutChange avec isManualChange=true.
  
  // Notifier une seule fois au chargement initial (quand le layout est prêt)
  const initialNotificationSent = useRef(false);
  useEffect(() => {
    if (!onLayoutChange || initialNotificationSent.current) return;
    if (!layout || Object.keys(layout).length === 0) return;
    
    // Attendre que le layout soit stabilisé (après la première réorganisation)
    const timer = setTimeout(() => {
      const snapshot = { layout, anchors: getAnchors() };
      try { 
        onLayoutChange(snapshot, false); // false = pas un changement manuel
        initialNotificationSent.current = true;
        console.log('[GridLauncher] ✅ Notification initiale envoyée au parent');
      } catch (e) { /* noop */ }
    }, 500);
    
    return () => clearTimeout(timer);
  }, [layout, onLayoutChange]);

  // Détecter l'ajout/suppression de widgets et apps, et marquer comme changement manuel
  const prevWidgetsCountRef = useRef(null);
  const prevAppsCountRef = useRef(null);
  
  useEffect(() => {
    // Initialiser au premier rendu
    if (prevWidgetsCountRef.current === null) {
      prevWidgetsCountRef.current = widgets.length;
      return;
    }
    
    // Un widget a été ajouté ou supprimé
    if (prevWidgetsCountRef.current !== widgets.length && initialNotificationSent.current && layout && Object.keys(layout).length > 0) {
      console.log('[GridLauncher] ✅ Changement de widgets détecté, marquage pour sauvegarde');
      pendingManualSaveRef.current = true;
      prevWidgetsCountRef.current = widgets.length;
    }
  }, [widgets.length, layout]);
  
  useEffect(() => {
    // Initialiser au premier rendu
    if (prevAppsCountRef.current === null) {
      prevAppsCountRef.current = apps.length;
      return;
    }
    
    // Une app a été ajoutée (PAS supprimée - la suppression ne doit pas déclencher de sauvegarde)
    // Seul l'ajout d'apps doit déclencher une sauvegarde automatique
    if (apps.length > prevAppsCountRef.current && initialNotificationSent.current && layout && Object.keys(layout).length > 0) {
      console.log('[GridLauncher] 🆕 Nouvelles apps ajoutées (avant:', prevAppsCountRef.current, 'après:', apps.length, '), marquage pour sauvegarde');
      pendingManualSaveRef.current = true;
      prevAppsCountRef.current = apps.length;
    } else if (apps.length < prevAppsCountRef.current) {
      // App supprimée - juste mettre à jour le compteur sans déclencher de sauvegarde
      console.log('[GridLauncher] 🗑️ Apps supprimées (avant:', prevAppsCountRef.current, 'après:', apps.length, '), PAS de sauvegarde automatique');
      prevAppsCountRef.current = apps.length;
    }
  }, [apps.length, layout]);

  // Sauvegarder après un changement manuel (drag & drop OU ajout/suppression widget)
  useEffect(() => {
    if (!pendingManualSaveRef.current || !onLayoutChange) return;
    if (!layout || Object.keys(layout).length === 0) return;
    
    // Attendre un peu que le layout soit complètement à jour
    const timer = setTimeout(() => {
      const snapshot = { layout, anchors: getAnchors() };
      try {
        console.log('[GridLauncher] 💾 Sauvegarde après drag manuel:', snapshot);
        onLayoutChange(snapshot, true); // true = changement manuel
        pendingManualSaveRef.current = false; // Reset
      } catch (e) {
        console.error('[GridLauncher] ❌ Erreur sauvegarde:', e);
      }
    }, 100);
    
    return () => clearTimeout(timer);
  }, [layout, onLayoutChange, getAnchors]);

  // Callback pendant le drag pour snap visuel
  const handleDragMove = (x, y, dragData) => {
    if (!gridRef.current) return;
    
    const rect = gridRef.current.getBoundingClientRect();
    const relX = x - rect.left;
    const relY = y - rect.top;
    
    // Calculer position sur la grille
    const col = Math.round(relX / (slotSize + gap));
    const row = Math.round(relY / (slotSize + gap));
    
    // Limiter aux bornes
    const clampedCol = Math.max(0, Math.min(col, cols - (dragData.itemData?.w || 1)));
    const clampedRow = Math.max(0, row);
    
    setSnappedPosition({ col: clampedCol, row: clampedRow });
  };

  const handleDragEnd = (dragData) => {
    setSnappedPosition(null); // Reset snap visuel
    if (!gridRef.current) return;

    const rect = gridRef.current.getBoundingClientRect();
    const relativeX = dragData.x - rect.left;
    const relativeY = dragData.y - rect.top;

    const { col, row } = pixelToGrid(relativeX, relativeY, slotSize, gap);
    const item = items.find(i => i.id === dragData.itemId);
    
    if (item) {
      let success = moveItem(dragData.itemId, col, row, item.w, item.h);
      
      // Si impossible (collision) et que c'est une app 1x1, tenter un échange avec l'app ciblée
      if (!success && item.type === 'app' && item.w === 1 && item.h === 1) {
        // Chercher s'il y a une app à la position cible
        let targetAppId = null;
        for (const [id, pos] of Object.entries(layout)) {
          if (id === dragData.itemId) continue;
          const w = pos.w || 1; const h = pos.h || 1;
          // intersection rectangles (col,row,1,1) vs (pos.col,pos.row,w,h)
          const overlap = !(col + 1 <= pos.col || col >= pos.col + w || row + 1 <= pos.row || row >= pos.row + h);
          if (overlap) {
            // N'autoriser l'échange qu'avec une app 1x1
            const isOneByOneApp = apps.includes(id) && w === 1 && h === 1;
            if (isOneByOneApp) { targetAppId = id; break; }
          }
        }
        if (targetAppId) {
          try { swapItems(dragData.itemId, targetAppId); success = true; } catch (_) {}
        }
      }
      
      // Si succès, marquer qu'on doit sauvegarder (le useEffect s'en chargera)
      if (success) {
        console.log('[GridLauncher] ✅ Drag réussi, sauvegarde programmée');
        pendingManualSaveRef.current = true;
      }
      
      if (!success) {
        // Animation shake si échec
        const element = document.getElementById(`tile-${dragData.itemId}`);
        if (element) {
          element.classList.add('tile-shake');
          setTimeout(() => element.classList.remove('tile-shake'), 300);
        }
      }
    }
  };

  const { isDragging, dragPosition, draggedItem, hasDragged, handlers } = useDrag(handleDragEnd, handleDragMove);

  // Rendre les slots de la grille
  const renderSlots = () => {
    const slots = [];

    // Construire un set des cases occupées (pour afficher un slot visible uniquement sous les apps)
    const occupied = new Set();
    // Apps 1x1
    let maxOccupiedRow = rows - 1;
    apps.forEach((appId) => {
      const pos = layout[appId];
      if (pos) {
        occupied.add(`${pos.row},${pos.col}`);
        // Tracker la ligne max occupée pour s'assurer de rendre les slots jusqu'à cette ligne
        if (pos.row > maxOccupiedRow) maxOccupiedRow = pos.row;
      }
    });
    // Widgets (pas de fond visible derrière les widgets, ils ont leur propre style)
    // Note: on n'ajoute PAS les widgets au set occupied car ils gèrent leur propre fond
    
    // S'assurer de rendre les slots jusqu'à la ligne max occupée (pour le fond des apps en scroll)
    const effectiveRows = Math.max(rows, maxOccupiedRow + 1);
    
    for (let row = 0; row < effectiveRows; row++) {
      for (let col = 0; col < cols; col++) {
        // Vérifier si ce slot doit être highlighted
        let isHighlighted = false;
        if (snappedPosition && draggedItem) {
          const w = draggedItem.itemData?.w || 1;
          const h = draggedItem.itemData?.h || 1;
          
          // Vérifier si ce slot est dans la zone snappée
          if (col >= snappedPosition.col && col < snappedPosition.col + w &&
              row >= snappedPosition.row && row < snappedPosition.row + h) {
            isHighlighted = true;
          }
        }
        const isOccupied = occupied.has(`${row},${col}`);
        
        slots.push(
          <div 
            key={`slot-${row}-${col}`} 
            className={`grid-slot ${isHighlighted ? 'highlight' : ''} ${isOccupied ? 'occupied' : ''}`}
            style={{
              gridColumn: col + 1,
              gridRow: row + 1
            }}
          />
        );
      }
    }
    
    return slots;
  };

  return (
    <div className={`grid-launcher ${zonesReady ? 'zones-ready' : ''}`}>
      <div 
        ref={gridRef}
        className="grid-container"
        style={{
          gridTemplateColumns: `repeat(${cols}, ${slotSize}px)`,
          gap: `${gap}px`,
          gridAutoRows: `${slotSize}px`
        }}
        onPointerMove={handlers.onPointerMove}
        onPointerUp={handlers.onPointerUp}
      >
        {/* Slots en arrière-plan */}
        {renderSlots()}

        {/* Widget Météo */}
        {layout['weather'] && (
          <div
            id="tile-weather"
            className={`weather-widget ${isDragging && draggedItem?.itemId === 'weather' ? 'dragging' : ''}`}
            style={{
              gridColumn: `${layout['weather'].col + 1} / span 3`,
              gridRow: `${layout['weather'].row + 1} / span 2`,
              alignSelf: 'center',
              animation: `accordionReveal 1200ms cubic-bezier(0.34, 1.56, 0.64, 1) ${Math.max(0, (layout['weather'].col || 0)) * 180}ms forwards`
            }}
            onPointerDown={(e) => handlers.onPointerDown(e, 'weather', { w: 3, h: 2 })}
            onClick={(e) => {
              e.stopPropagation();
              if (hasDragged) {
                return; // Ne pas ouvrir la modale si c'était un drag
              }
              setTempCity((weatherCity || weather.location || '').toString());
              setClosingWeatherModal(false);
              setShowWeatherModal(true);
            }}
            tabIndex={0}
          >
            <div
              className="weather-card"
              style={{
                backgroundImage: weatherImages[`./${weather.icon}`] ? `url(${weatherImages[`./${weather.icon}`]})` : 'linear-gradient(135deg, rgba(100, 180, 255, 0.9), rgba(80, 150, 255, 0.9))',
                backgroundSize: 'cover',
                backgroundPosition: 'center'
              }}
            >
              <div className="weather-overlay" />
              <div className="weather-content">
                <div className="weather-city">{weather.location || 'Localisation...'}</div>
                <div className="weather-temp">
                  {weather.temperature ? `${Math.round(weather.temperature)}°C` : '...'}
                </div>
                <div className="weather-details">
                  <div className="weather-humidity">
                    {weatherIcons['./humidity.png'] && (
                      <img src={weatherIcons['./humidity.png']} alt="Humidité" />
                    )}
                    {weather.humidity ? `${weather.humidity}%` : '...'}
                  </div>
                  <div className="weather-wind">
                    {weatherIcons['./wind.png'] && (
                      <img src={weatherIcons['./wind.png']} alt="Vent" />
                    )}
                    {weather.wind ? `${Math.round(weather.wind)} km/h` : '...'}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Apps */}
        {apps.map((appId, index) => {
          if (!layout[appId]) return null;
          
          const colIndex = layout[appId].col || 0;
          const animDelayMs = colIndex * 180;
          const isClickable = !appsConfig?.[appId]?.showStatus || (appStatus?.[appId]?.status === 'running');

          return (
            <div
              key={appId}
              id={`tile-${appId}`}
              className={`grid-tile ${isDragging && draggedItem?.itemId === appId ? 'dragging' : ''}`}
              style={{
                gridColumn: layout[appId].col + 1,
                gridRow: layout[appId].row + 1,
                animation: `accordionReveal 1200ms cubic-bezier(0.34, 1.56, 0.64, 1) ${animDelayMs}ms forwards`,
                cursor: isClickable ? 'pointer' : 'not-allowed'
              }}
              onPointerDown={(e) => handlers.onPointerDown(e, appId, { w: 1, h: 1 })}
              onClick={(e) => {
                e.stopPropagation();
                // Ne pas ouvrir si le menu contextuel est actif
                if (activeContextMenu) return;
                if (!hasDragged) {
                  if (!isClickable) return;
                  try { handleClick(appId); } catch (_) {}
                }
              }}
              // onContextMenu supprimé - laissé au composant Icon enfant
              tabIndex={0}
              role="button"
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (!isClickable) return;
                  try { handleClick(appId); } catch (_) {}
                }
              }}
            >
              <Icon
                id={appId}
                src={iconImages[appId]}
                zoneId="grid"
                moveIcon={moveIcon || (() => {})}
                handleClick={() => {
                  if (!isDragging) {
                    handleClick(appId);
                  }
                }}
                showName={true}
                appStatusData={appStatus?.[appId]}
                appsConfig={appsConfig}
                activeContextMenu={activeContextMenu}
                setActiveContextMenu={setActiveContextMenu}
                isAdmin={isAdmin}
                setAppStatus={setAppStatus}
                accessMode={accessMode}
                refreshDesktopIcons={refreshDesktopIcons}
              />
            </div>
          );
        })}

        {/* Widgets */}
        {widgets.map((widget) => {
          if (!layout[widget.id]) return null;
          
          const colIndex = layout[widget.id].col || 0;
          const animDelayMs = colIndex * 180;

          // Rendu du widget selon son type
          const renderWidget = () => {
            switch (widget.type) {
              case 'cpu-ram':
                return <CpuRamWidget id={widget.id} onRemove={onRemoveWidget} accessMode={accessMode} />;
              case 'storage':
                return <StorageWidget id={widget.id} onRemove={onRemoveWidget} accessMode={accessMode} />;
              default:
                return null;
            }
          };

          return (
            <div
              key={widget.id}
              className={`grid-tile widget-tile ${isDragging && draggedItem?.itemId === widget.id ? 'dragging' : ''}`}
              style={{
                gridColumn: `${layout[widget.id].col + 1} / span 2`,
                gridRow: `${layout[widget.id].row + 1} / span 2`,
                animation: `accordionReveal 1200ms cubic-bezier(0.34, 1.56, 0.64, 1) ${animDelayMs}ms forwards`,
                cursor: 'grab'
              }}
              onPointerDown={(e) => handlers.onPointerDown(e, widget.id, { w: 2, h: 2 })}
            >
              {renderWidget()}
            </div>
          );
        })}

        {/* Ghost pendant le drag */}
        {isDragging && draggedItem && (
          <div
            className="drag-ghost"
            style={{
              left: `${dragPosition.x}px`,
              top: `${dragPosition.y}px`,
              width: `${slotSize * (draggedItem.itemData.w || 1) + gap * ((draggedItem.itemData.w || 1) - 1)}px`,
              height: `${slotSize * (draggedItem.itemData.h || 1) + gap * ((draggedItem.itemData.h || 1) - 1)}px`,
              background: 'rgba(255, 255, 255, 0.5)',
              borderRadius: 'var(--tile-radius)',
              backdropFilter: 'blur(10px)'
            }}
          />
        )}
      </div>

      {/* Bouton d'ajout de widgets */}
      {onAddWidget && <WidgetAddButton onAddWidget={onAddWidget} />}
    </div>
  );
};

export default GridLauncher;
