import React, { useState } from 'react';
import ReactDOM from 'react-dom';
import '../styles/WidgetAddButton.css';
import { useLanguage } from '../contexts/LanguageContext';

/**
 * Menu de sélection de widget rendu via portal
 */
const WidgetMenuPortal = ({ x, y, onSelect, onClose }: { x: number; y: number; onSelect: (id: string) => void; onClose: () => void }) => {
  const { t } = useLanguage();
  const widgets = [
    { id: 'cpu-ram', name: t('widgetAddButton.cpuRam.name'), icon: '💻', description: t('widgetAddButton.cpuRam.description') },
    { id: 'storage', name: t('widgetAddButton.storage.name'), icon: '💾', description: t('widgetAddButton.storage.description') }
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
          <span>{t('widgetAddButton.title')}</span>
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
const WidgetAddButton = ({ onAddWidget }: { onAddWidget: (widgetType: string) => void }) => {
  const { t } = useLanguage();
  const [showMenu, setShowMenu] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });

  const handleButtonClick = (e: React.MouseEvent) => {
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

  const handleSelectWidget = (widgetType: string) => {
    console.log('[WidgetAddButton] Widget sélectionné:', widgetType);
    onAddWidget(widgetType);
  };

  return (
    <>
      <button 
        className="widget-add-button"
        onClick={handleButtonClick}
        title={t('widgetAddButton.title')}
      >
        <span className="widget-add-icon">+</span>
      </button>

      {showMenu && (
        <WidgetMenuPortal
          x={menuPosition.x}
          y={menuPosition.y}
          onSelect={handleSelectWidget}
          onClose={() => setShowMenu(false)}
        />
      )}
    </>
  );
};

export default WidgetAddButton;
