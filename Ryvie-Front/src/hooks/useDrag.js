import { useState, useCallback, useRef } from 'react';

/**
 * Hook pour gérer le drag & drop avec Pointer Events
 */
const useDrag = (onDragEnd, onDragMove) => {
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [dragPosition, setDragPosition] = useState({ x: 0, y: 0 });
  const draggedItemRef = useRef(null);
  const initialPosRef = useRef({ x: 0, y: 0 });
  const hasDraggedRef = useRef(false);
  const longPressTimeoutRef = useRef(null);
  const longPressTriggeredRef = useRef(false);
  const latestPointerRef = useRef({ x: 0, y: 0 });
  const offsetRef = useRef({ x: 0, y: 0 });
  const LONG_PRESS_MS = 250; // délai avant activation du drag
  const [, setDragTick] = useState(0);
  const handlePointerDown = useCallback((e, itemId, itemData) => {
    // Ignorer le clic droit (button 2) pour permettre le menu contextuel
    if (e.button === 2) {
      console.log('[useDrag] ⏭️  Ignorer pointerDown: clic droit détecté');
      return;
    }
    
    // Ignorer si le clic vient du menu contextuel ou d'un bouton
    if (e.target.closest('.context-menu') || e.target.closest('button') || e.target.closest('.widget-remove-btn')) {
      console.log('[useDrag] ⏭️  Ignorer pointerDown: clic sur bouton/menu');
      return;
    }
    
    e.preventDefault();
    e.stopPropagation();

    const rect = e.currentTarget.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;

    draggedItemRef.current = { itemId, itemData };
    initialPosRef.current = { x: rect.left, y: rect.top };
    hasDraggedRef.current = false; // Reset
    // Force a re-render so onClick reads the updated value
    setDragTick(t => t + 1);
    offsetRef.current = { x: offsetX, y: offsetY };
    latestPointerRef.current = { x: e.clientX, y: e.clientY };

    longPressTriggeredRef.current = false;
    // Capturer le pointeur IMMÉDIATEMENT pour continuer à recevoir les events hors du cadre
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    if (longPressTimeoutRef.current) clearTimeout(longPressTimeoutRef.current);
    longPressTimeoutRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      setIsDragging(true);
      setDragOffset({ x: offsetRef.current.x, y: offsetRef.current.y });
      setDragPosition({ x: latestPointerRef.current.x - offsetRef.current.x, y: latestPointerRef.current.y - offsetRef.current.y });
      // Le pointeur est déjà capturé
    }, LONG_PRESS_MS);
  }, []);

  const handlePointerMove = useCallback((e) => {
    // Toujours mémoriser la dernière position
    latestPointerRef.current = { x: e.clientX, y: e.clientY };

    // Si long press pas encore déclenché, ne pas annuler même si on bouge ou sort du cadre
    if (!longPressTriggeredRef.current) return;

    if (!isDragging) return;

    e.preventDefault();
    const newX = e.clientX - dragOffset.x;
    const newY = e.clientY - dragOffset.y;
    
    // Détecter si on a bougé de plus de 5px (seuil pour considérer comme drag)
    const deltaX = Math.abs(newX - initialPosRef.current.x);
    const deltaY = Math.abs(newY - initialPosRef.current.y);
    if (deltaX > 5 || deltaY > 5) {
      hasDraggedRef.current = true;
    }
    
    setDragPosition({ x: newX, y: newY });
    
    // Appeler onDragMove pour permettre le snap en temps réel
    if (onDragMove && draggedItemRef.current) {
      onDragMove(newX, newY, draggedItemRef.current);
    }
  }, [isDragging, dragOffset, onDragMove]);

  const handlePointerUp = useCallback((e) => {
    // Nettoyer le timer si le long press n'a pas été atteint
    if (!longPressTriggeredRef.current) {
      if (longPressTimeoutRef.current) {
        clearTimeout(longPressTimeoutRef.current);
        longPressTimeoutRef.current = null;
      }
      draggedItemRef.current = null;
      return;
    }

    if (!isDragging) return;

    setIsDragging(false);

    if (draggedItemRef.current && onDragEnd) {
      const finalX = e.clientX - dragOffset.x;
      const finalY = e.clientY - dragOffset.y;
      
      onDragEnd({
        itemId: draggedItemRef.current.itemId,
        itemData: draggedItemRef.current.itemData,
        x: finalX,
        y: finalY,
        initialX: initialPosRef.current.x,
        initialY: initialPosRef.current.y
      });
    }

    draggedItemRef.current = null;
  }, [isDragging, dragOffset, onDragEnd]);

  return {
    isDragging,
    dragPosition,
    draggedItem: draggedItemRef.current,
    hasDragged: hasDraggedRef.current,
    handlers: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp
    }
  };
};

export default useDrag;
