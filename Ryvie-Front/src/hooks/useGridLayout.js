import { useState, useEffect, useCallback } from 'react';
import { GRID_CONFIG } from '../config/appConfig';

/**
 * Hook pour gérer le layout de la grille iOS
 * @param {Array} items - Liste des items {id, type, w, h}
 * @param {number} cols - Nombre de colonnes
 */
const useGridLayout = (items, cols = 12, initialLayout = null, initialAnchors = null) => {
  const [layout, setLayout] = useState(initialLayout || {});
  const [prevCols, setPrevCols] = useState(cols);
  const [anchors, setAnchors] = useState(initialAnchors || {});
  const BASE_COLS = GRID_CONFIG.BASE_COLS; // grille logique de référence pour les indices d'ancrage

  // Mettre à jour le layout et les ancres quand ils changent depuis le parent
  useEffect(() => {
    if (initialLayout) {
      setLayout(initialLayout);
    }
  }, [initialLayout]);

  useEffect(() => {
    if (initialAnchors) {
      setAnchors(initialAnchors);
    }
  }, [initialAnchors]);

  // Initialiser les positions pour les nouveaux items et réorganiser intelligemment quand cols change
  useEffect(() => {
    // Détecter si le nombre de colonnes a changé
    const colsChanged = prevCols !== cols;
    if (colsChanged) {
      console.log('[useGridLayout] Nombre de colonnes changé:', prevCols, '->', cols);
      setPrevCols(cols);
    }
    
    setLayout(prev => {
      const newLayout = { ...prev };
      let hasChanges = false;

      // Purger les positions des items supprimés pour libérer les cases
      const validIds = new Set(items.map(i => i.id));
      const removedItems = [];
      Object.keys(newLayout).forEach(id => {
        if (!validIds.has(id)) {
          removedItems.push(id);
          delete newLayout[id];
          hasChanges = true;
        }
      });
      if (removedItems.length > 0) {
        console.log('[useGridLayout] 🗑️ Items supprimés du layout:', removedItems);
      }
      // Purger également les ancres obsolètes
      setAnchors(prevAnchors => {
        const next = { ...prevAnchors };
        let mutated = false;
        Object.keys(next).forEach(id => {
          if (!validIds.has(id)) {
            delete next[id];
            mutated = true;
          }
        });
        return mutated ? next : prevAnchors;
      });

      // Vérifier si des items dépassent avec le nouveau nombre de colonnes
      // IMPORTANT: Toujours réorganiser si cols a changé pour éviter les items coupés
      const itemsOverflowing = Object.keys(newLayout).filter(itemId => {
        const pos = newLayout[itemId];
        const item = items.find(i => i.id === itemId);
        return item && pos && (pos.col + (item.w || 1) > cols);
      });
      
      const needsReorganization = colsChanged || itemsOverflowing.length > 0;
      
      if (itemsOverflowing.length > 0) {
        console.log('[useGridLayout] ⚠️ Items dépassant détectés:', itemsOverflowing);
      }
      
      // Log pour confirmer qu'on ne réorganise PAS lors d'une simple suppression
      if (removedItems.length > 0 && !needsReorganization) {
        console.log('[useGridLayout] ✅ Suppression sans réorganisation - positions préservées');
      }

      if (needsReorganization) {
        console.log('[useGridLayout] 🔄 Réorganisation intelligente, cols:', cols, 'raison:', colsChanged ? 'colonnes changées' : 'items dépassent');

        // Utiliser les ancres existantes sans les modifier (pour préserver la position d'origine)
        // Créer des ancres UNIQUEMENT pour les nouveaux items
        const newAnchors = {};
        let nextAnchor = Object.values(anchors).length > 0 ? Math.max(...Object.values(anchors)) + 1 : 0;
        
        items.forEach(it => {
          if (anchors[it.id] == null) {
            // Nouvel item sans ancre
            newAnchors[it.id] = nextAnchor;
            nextAnchor += (it.w || 1) * (it.h || 1) === 4 ? 4 : 1;
          }
        });
        
        // Sauvegarder les nouvelles ancres si il y en a
        if (Object.keys(newAnchors).length > 0) {
          setAnchors(prev => ({ ...prev, ...newAnchors }));
        }

        // Trier par ancre pour préserver l'ordre relatif (utiliser les ancres existantes)
        const ordered = [...items].sort((a, b) => {
          const anchorA = anchors[a.id] ?? newAnchors[a.id] ?? 0;
          const anchorB = anchors[b.id] ?? newAnchors[b.id] ?? 0;
          return anchorA - anchorB;
        });

        console.log('[useGridLayout] 📋 Ordre de placement:', ordered.map(it => `${it.id}(${it.w}×${it.h})`).join(', '));

        // Grille d'occupation pour éviter les collisions
        const occupied = new Set();
        const mark = (c, r, w, h) => {
          for (let rr = r; rr < r + h; rr++) {
            for (let cc = c; cc < c + w; cc++) {
              occupied.add(`${rr},${cc}`);
            }
          }
        };
        const canPlace = (c, r, w, h) => {
          if (c < 0 || r < 0 || c + w > cols) return false;
          for (let rr = r; rr < r + h; rr++) {
            for (let cc = c; cc < c + w; cc++) {
              if (occupied.has(`${rr},${cc}`)) return false;
            }
          }
          return true;
        };

        // Trouver la prochaine position libre en scannant de gauche à droite, ligne par ligne
        const findNextFreePosition = (w, h, startRow = 0) => {
          for (let r = startRow; r < 100; r++) {
            for (let c = 0; c <= cols - w; c++) {
              if (canPlace(c, r, w, h)) {
                return { col: c, row: r };
              }
            }
          }
          return { col: 0, row: startRow }; // fallback
        };

        const tempLayout = {};
        let currentRow = 0;

        ordered.forEach(it => {
          const w = it.w || 1;
          const h = it.h || 1;
          const anchor = anchors[it.id] ?? newAnchors[it.id] ?? 0;
          
          // Calculer la position d'origine basée sur l'ancre (grille de référence BASE_COLS)
          let targetRow = Math.floor(anchor / BASE_COLS);
          let targetCol = anchor % BASE_COLS;
          
          // Si on a le nombre de colonnes maximum (ou proche), essayer de placer exactement à la position d'origine
          let pos;
          if (cols >= BASE_COLS && targetCol + w <= cols && canPlace(targetCol, targetRow, w, h)) {
            // Position d'origine disponible !
            pos = { col: targetCol, row: targetRow };
            console.log(`[useGridLayout] 🎯 ${it.id} replacé à sa position d'origine (${targetCol}, ${targetRow})`);
          } else {
            // Sinon, chercher la meilleure position disponible
            // Pour une réorganisation fluide, chercher à partir de la ligne courante
            const searchStartRow = cols < BASE_COLS ? Math.max(0, Math.floor(targetRow * 0.7)) : 0;
            pos = findNextFreePosition(w, h, searchStartRow);
          }
          
          tempLayout[it.id] = { col: pos.col, row: pos.row, w, h };
          mark(pos.col, pos.row, w, h);
          
          // Mettre à jour la ligne courante pour optimiser le placement suivant
          if (pos.row >= currentRow) {
            // Si on a placé un item sur une nouvelle ligne, on avance
            if (pos.col + w >= cols - 1) {
              currentRow = pos.row + h;
            }
          }
          
          console.log(`[useGridLayout] ✅ ${it.id} placé à (${pos.col}, ${pos.row})`);
        });

        // Remplacer entièrement le layout par le nouveau placement
        Object.keys(newLayout).forEach(k => delete newLayout[k]);
        Object.assign(newLayout, tempLayout);
        hasChanges = true;

        // NE PAS mettre à jour les ancres ici - elles restent fixes pour permettre
        // de revenir à la position d'origine quand on agrandit la fenêtre
        console.log('[useGridLayout] ✅ Réorganisation terminée, ancres préservées');
      }

      // Ajouter les nouveaux items (apps/widgets nouvellement installés)
      items.forEach(item => {
        if (!newLayout[item.id]) {
          console.log(`[useGridLayout] 🆕 Nouvel item détecté: ${item.id} (${item.w}x${item.h})`);
          console.log(`[useGridLayout] 📊 Layout actuel avant placement:`, Object.keys(newLayout).map(id => `${id}@(${newLayout[id].col},${newLayout[id].row})`));
          const pos = findFreePosition(newLayout, item.w || 1, item.h || 1, cols);
          if (pos) {
            newLayout[item.id] = pos;
            hasChanges = true;
            console.log(`[useGridLayout] ✅ ${item.id} placé à (${pos.col}, ${pos.row})`);
            
            // Créer une ancre pour le nouvel item basée sur sa position
            setAnchors(prevAnchors => {
              if (prevAnchors[item.id] == null) {
                const newAnchors = { ...prevAnchors };
                const anchorIndex = pos.row * BASE_COLS + pos.col;
                newAnchors[item.id] = anchorIndex;
                console.log(`[useGridLayout] 🔗 Ancre créée pour ${item.id}: ${anchorIndex} (pos: ${pos.col},${pos.row})`);
                return newAnchors;
              }
              return prevAnchors;
            });
          } else {
            console.error(`[useGridLayout] ❌ Impossible de placer ${item.id} - aucune position libre`);
          }
        }
      });

      return hasChanges ? newLayout : prev;
    });
  }, [items, cols]);

  // Trouver une position libre dans la grille
  const findFreePosition = (currentLayout, width, height, maxCols) => {
    const occupiedCells = new Set();
    
    // Marquer toutes les cellules occupées en parcourant TOUS les items du layout
    Object.entries(currentLayout).forEach(([id, pos]) => {
      if (!pos) return; // Ignorer les positions nulles/undefined
      const w = pos.w || 1;
      const h = pos.h || 1;
      // Marquer chaque cellule occupée par cet item
      for (let r = pos.row; r < pos.row + h; r++) {
        for (let c = pos.col; c < pos.col + w; c++) {
          occupiedCells.add(`${r},${c}`);
        }
      }
      console.log(`[useGridLayout] 🔒 ${id} occupe (${pos.col},${pos.row}) taille ${w}x${h}`);
    });
    
    console.log(`[useGridLayout] 🔍 Recherche position libre pour ${width}x${height}, ${occupiedCells.size} cellules occupées`);

    // Chercher une position libre en scannant ligne par ligne
    for (let row = 0; row < 100; row++) {
      for (let col = 0; col <= maxCols - width; col++) {
        let isFree = true;
        
        // Vérifier si TOUTES les cellules nécessaires sont libres
        for (let r = row; r < row + height; r++) {
          for (let c = col; c < col + width; c++) {
            if (occupiedCells.has(`${r},${c}`)) {
              isFree = false;
              break;
            }
          }
          if (!isFree) break;
        }

        if (isFree) {
          console.log(`[useGridLayout] 📍 Position libre trouvée: (${col}, ${row}) pour ${width}x${height}`);
          return { col, row, w: width, h: height };
        }
      }
    }

    console.warn(`[useGridLayout] ⚠️ Aucune position libre trouvée pour ${width}x${height}`);
    return null;
  };

  // Vérifier si une position est valide (pas de collision)
  const isPositionValid = useCallback((itemId, col, row, width, height) => {
    // Vérifier les limites
    if (col < 0 || col + width > cols || row < 0) {
      return false;
    }

    // Vérifier les collisions avec les autres items
    for (const [id, pos] of Object.entries(layout)) {
      if (id === itemId) continue;

      const w = pos.w || 1;
      const h = pos.h || 1;

      // Vérifier si les rectangles se chevauchent
      const overlap = !(
        col + width <= pos.col ||
        col >= pos.col + w ||
        row + height <= pos.row ||
        row >= pos.row + h
      );

      if (overlap) {
        return false;
      }
    }

    return true;
  }, [layout, cols]);

  // Déplacer un item
  const moveItem = useCallback((itemId, col, row, width, height) => {
    if (!isPositionValid(itemId, col, row, width, height)) {
      return false;
    }

    setLayout(prev => {
      const newLayout = {
        ...prev,
        [itemId]: { col, row, w: width, h: height }
      };

      // Mettre à jour l'ancre pour cet item selon la grille de référence BASE_COLS
      setAnchors(prev => {
        const newAnchors = { ...prev };
        const anchorIndex = row * BASE_COLS + col; // top-left comme référence
        newAnchors[itemId] = anchorIndex;
        return newAnchors;
      });

      return newLayout;
    });

    return true;
  }, [isPositionValid]);

  // Échanger les positions de deux items (et leurs ancres)
  const swapItems = useCallback((a, b) => {
    setLayout(prev => {
      const A = prev[a];
      const B = prev[b];
      if (!A || !B) return prev;
      const next = { ...prev, [a]: { ...B }, [b]: { ...A } };
      return next;
    });
    setAnchors(prev => {
      const next = { ...prev };
      const tmp = next[a];
      next[a] = next[b];
      next[b] = tmp;
      return next;
    });
  }, []);

  // Convertir une position pixel en position grille
  const pixelToGrid = useCallback((x, y, slotSize, gap) => {
    const col = Math.round(x / (slotSize + gap));
    const row = Math.round(y / (slotSize + gap));
    return { col: Math.max(0, col), row: Math.max(0, row) };
  }, []);

  return {
    layout,
    moveItem,
    swapItems,
    isPositionValid,
    pixelToGrid,
    findFreePosition: (w, h) => findFreePosition(layout, w, h, cols),
    getAnchors: () => anchors
  };
};

export default useGridLayout;
