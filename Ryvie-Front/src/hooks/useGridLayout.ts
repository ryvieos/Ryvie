import { useState, useEffect, useCallback, useRef } from 'react';
import { GRID_CONFIG } from '../config/appConfig';
import { GridLayout, GridPosition, GridAnchors } from '../types';

interface GridItem {
  id: string;
  w?: number;
  h?: number;
  type?: string;
}

interface UseGridLayoutReturn {
  layout: GridLayout;
  moveItem: (itemId: string, col: number, row: number, width: number, height: number) => boolean;
  swapItems: (a: string, b: string) => void;
  isPositionValid: (itemId: string, col: number, row: number, width: number, height: number) => boolean;
  pixelToGrid: (x: number, y: number, slotSize: number, gap: number) => { col: number; row: number };
  findFreePosition: (w: number, h: number) => GridPosition | null;
  getAnchors: () => GridAnchors;
}

const useGridLayout = (
  items: GridItem[],
  cols: number = 12,
  initialLayout: GridLayout | null = null,
  initialAnchors: GridAnchors | null = null
): UseGridLayoutReturn => {
  const [layout, setLayout] = useState(initialLayout || {});
  const [prevCols, setPrevCols] = useState(cols);
  const [anchors, setAnchors] = useState(initialAnchors || {});
  const BASE_COLS = GRID_CONFIG.BASE_COLS; // grille logique de référence pour les indices d'ancrage
  
  // Référence stable aux ancres originales du backend (ne change que quand initialAnchors change)
  // Utilisée pour repositionner correctement les items lors des changements de colonnes
  const referenceAnchorsRef = useRef(initialAnchors || {});
  // Flag pour savoir si on a déjà synchronisé les ancres au premier chargement
  const initialSyncDoneRef = useRef(false);

  // Mettre à jour le layout et les ancres quand ils changent depuis le parent
  useEffect(() => {
    if (initialLayout) {
      setLayout(initialLayout);
    }
  }, [initialLayout]);

  useEffect(() => {
    if (initialAnchors) {
      setAnchors(initialAnchors);
      // Mettre à jour les ancres de référence seulement quand le parent envoie de nouvelles ancres
      referenceAnchorsRef.current = { ...initialAnchors };
      console.log('[useGridLayout] 📌 Ancres de référence mises à jour:', Object.keys(initialAnchors).length, 'items');
    }
  }, [initialAnchors]);

  // Synchronisation initiale : recalculer les ancres depuis le layout pour garantir la cohérence
  // Cela "simule" un drag & drop initial pour aligner ancres et positions
  useEffect(() => {
    if (initialSyncDoneRef.current) return;
    if (!initialLayout || Object.keys(initialLayout).length === 0) return;
    
    // Recalculer les ancres depuis le layout actuel pour garantir la cohérence
    const syncedAnchors = {};
    Object.entries(initialLayout).forEach(([itemId, pos]) => {
      if (pos && typeof pos.col === 'number' && typeof pos.row === 'number') {
        const anchorIndex = pos.row * BASE_COLS + pos.col;
        syncedAnchors[itemId] = anchorIndex;
      }
    });
    
    if (Object.keys(syncedAnchors).length > 0) {
      console.log('[useGridLayout] 🔄 Synchronisation initiale des ancres depuis le layout:', Object.keys(syncedAnchors).length, 'items');
      referenceAnchorsRef.current = { ...syncedAnchors };
      setAnchors(prev => ({ ...prev, ...syncedAnchors }));
      initialSyncDoneRef.current = true;
    }
  }, [initialLayout, BASE_COLS]);

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

      // Purger referenceAnchorsRef
      Object.keys(referenceAnchorsRef.current).forEach(id => {
        if (!validIds.has(id)) {
          delete referenceAnchorsRef.current[id];
        }
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

        // IMPORTANT: Utiliser les ancres de RÉFÉRENCE (du backend) pour le repositionnement
        // Cela garantit que les items reviennent à leur position d'origine quand on agrandit
        const refAnchors = referenceAnchorsRef.current || {};
        
        // Créer des ancres UNIQUEMENT pour les nouveaux items (pas dans la référence)
        const newAnchors = {};
        let nextAnchor = Object.values(refAnchors).length > 0 ? Math.max(...Object.values(refAnchors)) + 1 : 0;
        
        items.forEach(it => {
          if (refAnchors[it.id] == null && anchors[it.id] == null) {
            // Nouvel item sans ancre
            newAnchors[it.id] = nextAnchor;
            nextAnchor += (it.w || 1) * (it.h || 1) === 4 ? 4 : 1;
          }
        });
        
        // Sauvegarder les nouvelles ancres dans le state ET la référence
        if (Object.keys(newAnchors).length > 0) {
          setAnchors(prev => ({ ...prev, ...newAnchors }));
          referenceAnchorsRef.current = { ...referenceAnchorsRef.current, ...newAnchors };
        }

        // Trier par ancre pour préserver l'ordre relatif (utiliser les ancres de RÉFÉRENCE)
        const ordered = [...items].sort((a, b) => {
          const anchorA = refAnchors[a.id] ?? anchors[a.id] ?? newAnchors[a.id] ?? 0;
          const anchorB = refAnchors[b.id] ?? anchors[b.id] ?? newAnchors[b.id] ?? 0;
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
          // IMPORTANT: Utiliser les ancres de RÉFÉRENCE pour calculer la position d'origine
          const anchor = refAnchors[it.id] ?? anchors[it.id] ?? newAnchors[it.id] ?? 0;
          
          // Calculer la position d'origine depuis l'ancre
          // L'ancre est : row * BASE_COLS + col (voir moveItem)
          const anchorRow = Math.floor(anchor / BASE_COLS);
          const anchorCol = anchor % BASE_COLS;
          
          // Stratégie : toujours essayer de placer à la position d'ancre d'abord
          // Seulement si ça ne rentre pas dans la grille actuelle, ajuster
          let targetCol = anchorCol;
          let targetRow = anchorRow;
          
          // Si l'item dépasse la grille actuelle, le décaler
          if (targetCol + w > cols) {
            // Décaler vers la gauche pour qu'il rentre
            targetCol = Math.max(0, cols - w);
            console.log(`[useGridLayout] ⚠️ ${it.id} ancre col ${anchorCol} ajustée à ${targetCol} (cols=${cols})`);
          }
          
          // Essayer de placer à la position cible
          let pos;
          if (canPlace(targetCol, targetRow, w, h)) {
            pos = { col: targetCol, row: targetRow };
            if (targetCol === anchorCol && targetRow === anchorRow) {
              console.log(`[useGridLayout] 🎯 ${it.id} placé à position d'ancre exacte (${targetCol}, ${targetRow})`);
            } else {
              console.log(`[useGridLayout] 📍 ${it.id} placé à position ajustée (${targetCol}, ${targetRow}) depuis ancre (${anchorCol}, ${anchorRow})`);
            }
          } else {
            // Position occupée, chercher la prochaine position libre
            pos = findNextFreePosition(w, h, targetRow);
            console.log(`[useGridLayout] 🔄 ${it.id} position occupée, placé à (${pos.col}, ${pos.row})`);
          }
          
          tempLayout[it.id] = { col: pos.col, row: pos.row, w, h };
          mark(pos.col, pos.row, w, h);
          
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

      // Placer les nouveaux items sans position dans les cases libres
      const itemsWithoutPosition = items.filter(item => {
        // Si l'item n'a pas de position dans le layout, on le considère comme nécessitant un placement
        return !newLayout[item.id];
      });
      if (itemsWithoutPosition.length > 0) {
        console.log(`[useGridLayout] 🆕 Nouveaux items à placer:`, itemsWithoutPosition.map(i => i.id).join(', '));
        
        // Grille d'occupation pour trouver les cases libres
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
        
        // Marquer toutes les positions déjà occupées
        Object.entries(newLayout).forEach(([id, pos]) => {
          if (pos) {
            const w = pos.w || 1;
            const h = pos.h || 1;
            mark(pos.col, pos.row, w, h);
          }
        });
        
        // Placer chaque nouvel item
        itemsWithoutPosition.forEach(item => {
          const w = item.w || 1;
          const h = item.h || 1;
          
          // Chercher la première position libre
          let placed = false;
          for (let r = 0; r < 100 && !placed; r++) {
            for (let c = 0; c <= cols - w && !placed; c++) {
              if (canPlace(c, r, w, h)) {
                newLayout[item.id] = { col: c, row: r, w, h };
                mark(c, r, w, h);
                
                // Créer une ancre pour ce nouvel item
                const anchorIndex = r * BASE_COLS + c;
                setAnchors(prev => ({ ...prev, [item.id]: anchorIndex }));
                referenceAnchorsRef.current = { ...referenceAnchorsRef.current, [item.id]: anchorIndex };
                
                console.log(`[useGridLayout] ✅ ${item.id} placé à (${c}, ${r})`);
                placed = true;
                hasChanges = true;
              }
            }
          }
          
          if (!placed) {
            console.warn(`[useGridLayout] ⚠️ Impossible de placer ${item.id}`);
          }
        });
      }

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
      const anchorIndex = row * BASE_COLS + col; // top-left comme référence
      
      setAnchors(prev => {
        const newAnchors = { ...prev };
        newAnchors[itemId] = anchorIndex;
        return newAnchors;
      });
      
      // IMPORTANT: Mettre à jour aussi les ancres de référence lors d'un drag manuel
      // pour que la nouvelle position devienne la position "officielle"
      referenceAnchorsRef.current = { ...referenceAnchorsRef.current, [itemId]: anchorIndex };

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
      // Mettre à jour aussi les ancres de référence lors d'un swap manuel
      referenceAnchorsRef.current = { ...referenceAnchorsRef.current, [a]: next[a], [b]: next[b] };
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
