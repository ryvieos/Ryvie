import React, { useState, useEffect, useRef } from 'react';
import '../styles/GridLauncher.css';
import useGridLayout from '../hooks/useGridLayout';
import useDrag from '../hooks/useDrag';
import GRID_CONFIG from '../config/gridConfig';
import Icon from './Icon';
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
  initialAnchors
}) => {
  const gridRef = useRef(null);
  const { SLOT_SIZE: slotSize, GAP: gap, BASE_COLS: baseCols, BASE_ROWS: baseRows, MIN_COLS: minCols, HORIZONTAL_PADDING: horizontalPadding } = GRID_CONFIG;
  const [cols, setCols] = useState(baseCols);
  const [snappedPosition, setSnappedPosition] = useState(null);

  // Calculer le nombre de colonnes qui rentrent dans la largeur de la fenêtre
  useEffect(() => {
    const updateGridLayout = () => {
      // Largeur disponible basée sur la fenêtre moins une marge pour les paddings/éléments latéraux
      const availableWidth = Math.max(320, window.innerWidth - horizontalPadding);

      // Calculer combien de colonnes de taille slotSize + gap peuvent rentrer
      // Formule: n * slotSize + (n-1) * gap <= availableWidth
      // => n * (slotSize + gap) - gap <= availableWidth
      // => n <= (availableWidth + gap) / (slotSize + gap)
      const maxCols = Math.floor((availableWidth + gap) / (slotSize + gap));
      
      // Limiter entre minCols colonnes minimum et baseCols colonnes maximum (grille de base)
      const newCols = Math.max(minCols, Math.min(baseCols, maxCols));
      
      setCols(newCols);
    };

    updateGridLayout();
    window.addEventListener('resize', updateGridLayout);
    return () => window.removeEventListener('resize', updateGridLayout);
  }, [gap, slotSize, baseCols, minCols, horizontalPadding]);

  // Préparer les items pour le layout
  const items = [
    { id: 'weather', type: 'weather', w: 2, h: 2 },
    ...apps.map(appId => ({ id: appId, type: 'app', w: 1, h: 1 }))
  ];

  const { layout, moveItem, pixelToGrid, getAnchors } = useGridLayout(items, cols, initialLayout, initialAnchors);

  // Notifier le parent quand le layout change (debounce)
  const notifyRef = useRef(null);
  useEffect(() => {
    if (!onLayoutChange) return;
    if (notifyRef.current) clearTimeout(notifyRef.current);
    const snapshot = { layout, anchors: getAnchors() };
    notifyRef.current = setTimeout(() => {
      try { onLayoutChange(snapshot); } catch (e) { /* noop */ }
    }, 200);
    return () => notifyRef.current && clearTimeout(notifyRef.current);
  }, [layout]);

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
      const success = moveItem(dragData.itemId, col, row, item.w, item.h);
      
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
    // Toujours garder le même nombre de cases visibles au minimum (baseCols x baseRows)
    const baseTotalSlots = baseCols * baseRows;
    // Besoin réel en fonction des items: météo 2x2 = 4 + chaque app 1x1
    const itemsRequiredSlots = 4 + apps.length;
    const totalSlots = Math.max(baseTotalSlots, itemsRequiredSlots);
    // Calculer le nombre de lignes en fonction du nombre de colonnes actuel
    const rows = Math.ceil(totalSlots / cols);
    
    for (let row = 0; row < rows; row++) {
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
        
        slots.push(
          <div 
            key={`slot-${row}-${col}`} 
            className={`grid-slot ${isHighlighted ? 'highlight' : ''}`}
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
    <div className="grid-launcher">
      <div 
        ref={gridRef}
        className="grid-container"
        style={{
          gridTemplateColumns: `repeat(${cols}, ${slotSize}px)`,
          gap: `${gap}px`
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
              gridColumn: `${layout['weather'].col + 1} / span 2`,
              gridRow: `${layout['weather'].row + 1} / span 2`,
              backgroundImage: weatherImages[`./${weather.icon}`] ? `url(${weatherImages[`./${weather.icon}`]})` : 'linear-gradient(135deg, rgba(100, 180, 255, 0.9), rgba(80, 150, 255, 0.9))',
              backgroundSize: 'cover',
              backgroundPosition: 'center'
            }}
            onPointerDown={(e) => handlers.onPointerDown(e, 'weather', { w: 2, h: 2 })}
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
            <div className="weather-city">{weather.location || 'Localisation...'}</div>
            <div className="weather-temp">
              {weather.temperature ? `${Math.round(weather.temperature)}°C` : '...'}
            </div>
            <div className="weather-details">
              <div>
                {weatherIcons['./humidity.png'] && (
                  <img src={weatherIcons['./humidity.png']} alt="Humidity" />
                )}
                {weather.humidity ? `${weather.humidity}%` : '...'}
              </div>
              <div>
                {weatherIcons['./wind.png'] && (
                  <img src={weatherIcons['./wind.png']} alt="Wind" />
                )}
                {weather.wind ? `${Math.round(weather.wind)} km/h` : '...'}
              </div>
            </div>
          </div>
        )}

        {/* Apps */}
        {apps.map((appId, index) => {
          if (!layout[appId]) return null;
          
          return (
            <div
              key={appId}
              id={`tile-${appId}`}
              className={`grid-tile ${isDragging && draggedItem?.itemId === appId ? 'dragging' : ''}`}
              style={{
                gridColumn: layout[appId].col + 1,
                gridRow: layout[appId].row + 1,
                animationDelay: `${index * 0.05}s`
              }}
              onPointerDown={(e) => handlers.onPointerDown(e, appId, { w: 1, h: 1 })}
              tabIndex={0}
            >
              <Icon
                id={appId}
                src={iconImages[appId]}
                zoneId="grid"
                moveIcon={moveIcon || (() => {})}
                handleClick={() => {
                  if (!hasDragged) {
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
              />
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
              background: draggedItem.itemId === 'weather' 
                ? 'linear-gradient(135deg, rgba(100, 180, 255, 0.5), rgba(80, 150, 255, 0.5))'
                : 'rgba(255, 255, 255, 0.5)',
              borderRadius: 'var(--tile-radius)',
              backdropFilter: 'blur(10px)'
            }}
          />
        )}
      </div>
    </div>
  );
};

export default GridLauncher;
