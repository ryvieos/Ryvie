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
      Object.keys(newLayout).forEach(id => {
        if (!validIds.has(id)) {
          delete newLayout[id];
          hasChanges = true;
        }
      });
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

      // Vérifier si des items dépassent avec le nouveau nombre de colonnes OU si cols a changé
      const needsReorganization = colsChanged || Object.keys(newLayout).some(itemId => {
        const pos = newLayout[itemId];
        const item = items.find(i => i.id === itemId);
        return item && pos && (pos.col + (item.w || 1) > cols);
      });

      if (needsReorganization) {
        console.log('[useGridLayout] Réorganisation nécessaire, cols:', cols);

        // Utiliser les ancres de l'état

        // Créer des ancres manquantes (ordre items)
        let nextAnchor = Object.values(anchors).length > 0 ? Math.max(...Object.values(anchors)) + 1 : 0;
        items.forEach(it => {
          if (anchors[it.id] == null) {
            anchors[it.id] = nextAnchor;
            nextAnchor += (it.w || 1) * (it.h || 1) === 4 ? 4 : 1; // réserver plus pour météo
          }
        });

        // Ordonner par anchor croissant
        const ordered = [...items].sort((a, b) => (anchors[a.id] || 0) - (anchors[b.id] || 0));

        // Grille d'occupation
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

        const tempLayout = {};
        ordered.forEach(it => {
          const w = it.w || 1;
          const h = it.h || 1;
          const anchor = anchors[it.id] || 0;
          // Calculer la position cible basée sur BASE_COLS (grille de référence)
          let targetRow = Math.floor(anchor / BASE_COLS);
          let targetCol = anchor % BASE_COLS;

          // si déborde la ligne, forcer retour ligne
          if (targetCol + w > cols) {
            targetCol = 0;
            targetRow += 1;
          }

          // si collision, trouver prochaine case libre (scan)
          let placed = false;
          let r = targetRow;
          let c = targetCol;
          for (let guard = 0; guard < 10000 && !placed; guard++) {
            if (canPlace(c, r, w, h)) {
              tempLayout[it.id] = { col: c, row: r, w, h };
              mark(c, r, w, h);
              placed = true;
              break;
            }
            // avancer
            c += 1;
            if (c + w > cols) { c = 0; r += 1; }
          }
          if (!placed) {
            // fallback
            tempLayout[it.id] = { col: 0, row: r, w, h };
            mark(0, r, w, h);
          }
        });

        // Remplacer entièrement le layout par le nouveau placement
        Object.keys(newLayout).forEach(k => delete newLayout[k]);
        Object.assign(newLayout, tempLayout);
        hasChanges = true;

        // Mettre à jour l'état des ancres
        setAnchors(anchors);
      }

      // Ajouter les nouveaux items
      items.forEach(item => {
        if (!newLayout[item.id]) {
          const pos = findFreePosition(newLayout, item.w || 1, item.h || 1, cols);
          if (pos) {
            newLayout[item.id] = pos;
            hasChanges = true;
          }
        }
      });

      return hasChanges ? newLayout : prev;
    });
  }, [items, cols]);

  // Trouver une position libre dans la grille
  const findFreePosition = (currentLayout, width, height, maxCols) => {
    const occupiedCells = new Set();
    
    // Marquer toutes les cellules occupées
    Object.values(currentLayout).forEach(pos => {
      const w = pos.w || 1;
      const h = pos.h || 1;
      for (let r = pos.row; r < pos.row + h; r++) {
        for (let c = pos.col; c < pos.col + w; c++) {
          occupiedCells.add(`${r},${c}`);
        }
      }
    });

    // Chercher une position libre
    for (let row = 0; row < 100; row++) {
      for (let col = 0; col <= maxCols - width; col++) {
        let isFree = true;
        
        // Vérifier si toutes les cellules nécessaires sont libres
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
          return { col, row, w: width, h: height };
        }
      }
    }

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
