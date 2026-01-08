import { useState, useCallback, useRef } from 'react';

interface DragOffset {
  x: number;
  y: number;
}

interface DragPosition {
  x: number;
  y: number;
}

interface DraggedItem {
  itemId: string;
  itemData: any;
}

interface DragEndData {
  itemId: string;
  itemData: any;
  x: number;
  y: number;
  initialX: number;
  initialY: number;
}

interface UseDragHandlers {
  onPointerDown: (e: any, itemId: string, itemData: any) => void;
  onPointerMove: (e: any) => void;
  onPointerUp: (e: any) => void;
}

interface UseDragReturn {
  isDragging: boolean;
  dragPosition: DragPosition;
  draggedItem: DraggedItem | null;
  hasDragged: boolean;
  handlers: UseDragHandlers;
}

const useDrag = (
  onDragEnd?: (data: DragEndData) => void,
  onDragMove?: (x: number, y: number, item: DraggedItem) => void
): UseDragReturn => {
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState<DragOffset>({ x: 0, y: 0 });
  const [dragPosition, setDragPosition] = useState<DragPosition>({ x: 0, y: 0 });
  const draggedItemRef = useRef<DraggedItem | null>(null);
  const initialPosRef = useRef<DragPosition>({ x: 0, y: 0 });
  const hasDraggedRef = useRef(false);
  const longPressTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const longPressTriggeredRef = useRef(false);
  const latestPointerRef = useRef<DragPosition>({ x: 0, y: 0 });
  const offsetRef = useRef<DragOffset>({ x: 0, y: 0 });
  const LONG_PRESS_MS = 200;
  const [, setDragTick] = useState(0);

  const handlePointerDown = useCallback((e: React.PointerEvent, itemId: string, itemData: unknown) => {
    if ((e as any).button === 2) {
      console.log('[useDrag] ⏭️  Ignorer pointerDown: clic droit détecté');
      return;
    }
    
    if ((e.target as HTMLElement).closest('.context-menu') || 
        (e.target as HTMLElement).closest('button') || 
        (e.target as HTMLElement).closest('.widget-remove-btn')) {
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
    hasDraggedRef.current = false;
    setDragTick((t: number) => t + 1);
    offsetRef.current = { x: offsetX, y: offsetY };
    latestPointerRef.current = { x: e.clientX, y: e.clientY };

    longPressTriggeredRef.current = false;
    try { (e.currentTarget as any).setPointerCapture(e.pointerId); } catch {}
    if (longPressTimeoutRef.current) clearTimeout(longPressTimeoutRef.current);
    longPressTimeoutRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      setIsDragging(true);
      setDragOffset({ x: offsetRef.current.x, y: offsetRef.current.y });
      setDragPosition({ 
        x: latestPointerRef.current.x - offsetRef.current.x, 
        y: latestPointerRef.current.y - offsetRef.current.y 
      });
    }, LONG_PRESS_MS);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    latestPointerRef.current = { x: e.clientX, y: e.clientY };

    if (!longPressTriggeredRef.current) return;

    if (!isDragging) return;

    e.preventDefault();
    const newX = e.clientX - dragOffset.x;
    const newY = e.clientY - dragOffset.y;
    
    const deltaX = Math.abs(newX - initialPosRef.current.x);
    const deltaY = Math.abs(newY - initialPosRef.current.y);
    if (deltaX > 5 || deltaY > 5) {
      hasDraggedRef.current = true;
    }
    
    setDragPosition({ x: newX, y: newY });
    
    if (onDragMove && draggedItemRef.current) {
      onDragMove(newX, newY, draggedItemRef.current);
    }
  }, [isDragging, dragOffset, onDragMove]);

  const handlePointerUp = useCallback((e: PointerEvent) => {
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
