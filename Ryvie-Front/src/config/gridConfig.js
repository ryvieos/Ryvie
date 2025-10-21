/**
 * Configuration centralisée de la grille du launcher
 * Modifier ces valeurs pour changer le comportement de toute la grille
 */

export const GRID_CONFIG = {
  // Nombre de colonnes de base (plein écran)
  BASE_COLS: 10,
  
  // Nombre de lignes minimum
  BASE_ROWS: 4,
  
  // Taille fixe d'un slot en pixels (ne change jamais)
  SLOT_SIZE: 120,
  
  // Espacement entre les slots en pixels
  GAP: 12,
  
  // Nombre minimum de colonnes (fenêtre très réduite)
  MIN_COLS: 3,
  
  // Padding horizontal estimé (marges latérales de la page)
  HORIZONTAL_PADDING: 80
};

// Calculer le nombre total de slots minimum
export const getBaseTotalSlots = () => GRID_CONFIG.BASE_COLS * GRID_CONFIG.BASE_ROWS;

// Calculer la largeur minimum nécessaire pour afficher toutes les colonnes
export const getMinWidthForFullGrid = () => {
  return GRID_CONFIG.BASE_COLS * GRID_CONFIG.SLOT_SIZE + 
         (GRID_CONFIG.BASE_COLS - 1) * GRID_CONFIG.GAP + 
         GRID_CONFIG.HORIZONTAL_PADDING;
};

export default GRID_CONFIG;
