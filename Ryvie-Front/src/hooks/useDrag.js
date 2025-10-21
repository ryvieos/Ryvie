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

  const handlePointerDown = useCallback((e, itemId, itemData) => {
    // Ignorer si le clic vient du menu contextuel
    if (e.target.closest('.context-menu')) {
      console.log('[useDrag] ⏭️  Ignorer pointerDown: clic dans menu contextuel');
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
    
    setIsDragging(true);
    setDragOffset({ x: offsetX, y: offsetY });
    setDragPosition({ x: e.clientX - offsetX, y: e.clientY - offsetY });

    // Capturer le pointeur
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e) => {
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
