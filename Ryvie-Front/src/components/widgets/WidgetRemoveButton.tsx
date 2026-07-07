import React from 'react';
import '../../styles/widgets/Widgets.css';

interface WidgetRemoveButtonProps {
  id: string;
  onRemove: (id: string) => void;
  className?: string;
}

const WidgetRemoveButton = ({ id, onRemove, className = '' }: WidgetRemoveButtonProps) => {
  return (
    <button
      className={`widget-remove-btn ${className}`}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onRemove(id);
      }}
      title="Supprimer le widget"
    >
      ✕
    </button>
  );
};

export default WidgetRemoveButton;
