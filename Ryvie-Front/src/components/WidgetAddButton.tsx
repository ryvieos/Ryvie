import React, { useState } from 'react';
import ReactDOM from 'react-dom';
import '../styles/WidgetAddButton.css';

/**
 * Menu de sélection de widget rendu via portal
 */
const WidgetMenuPortal = ({ x, y, onSelect, onClose }) => {
  const widgets = [
    { id: 'cpu-ram', name: 'CPU & RAM', icon: '💻', description: 'Utilisation processeur et mémoire' },
    { id: 'storage', name: 'Stockage', icon: '💾', description: 'Espace disque disponible' }
  ];

  const menu = (
    <>
      {/* Overlay pour fermer le menu */}
      <div 
        className="widget-menu-overlay" 
        onClick={onClose}
      />
      
      {/* Menu */}
      <div
        className="widget-menu"
        style={{
          position: 'fixed',
          left: `${x}px`,
          top: `${y}px`,
          zIndex: 10001,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="widget-menu-header">
          <span>Ajouter un widget</span>
          <button className="widget-menu-close" onClick={onClose}>✕</button>
        </div>
        <div className="widget-menu-items">
          {widgets.map(widget => (
            <div
              key={widget.id}
              className="widget-menu-item"
              onClick={() => {
                onSelect(widget.id);
                onClose();
              }}
            >
              <span className="widget-menu-icon">{widget.icon}</span>
              <div className="widget-menu-info">
                <div className="widget-menu-name">{widget.name}</div>
                <div className="widget-menu-description">{widget.description}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );

  return ReactDOM.createPortal(menu, document.body);
};

/**
 * Bouton flottant en bas à droite pour ajouter des widgets
 */
const WidgetAddButton = ({ onAddWidget }) => {
  const [showMenu, setShowMenu] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });

  const handleClick = (e) => {
    const button = e.currentTarget.getBoundingClientRect();
    
    // Positionner le menu au-dessus du bouton, aligné à droite
    const menuWidth = 280;
    const menuHeight = 200;
    
    setMenuPosition({
      x: button.right - menuWidth,
      y: button.top - menuHeight - 10
    });
    
    setShowMenu(true);
  };

  const handleSelect = (widgetType) => {
    console.log('[WidgetAddButton] Widget sélectionné:', widgetType);
    onAddWidget(widgetType);
  };

  return (
    <>
      <button 
        className="widget-add-button"
        onClick={handleClick}
        title="Ajouter un widget"
      >
        <span className="widget-add-icon">+</span>
      </button>

      {showMenu && (
        <WidgetMenuPortal
          x={menuPosition.x}
          y={menuPosition.y}
          onSelect={handleSelect}
          onClose={() => setShowMenu(false)}
        />
      )}
    </>
  );
};

export default WidgetAddButton;
