import React from 'react';
import '../../styles/Widgets.css';

/**
 * Composant de base pour tous les widgets
 * @param {string} id - ID unique du widget
 * @param {string} title - Titre du widget
 * @param {string} icon - Icône du widget (emoji ou classe)
 * @param {React.ReactNode} children - Contenu du widget
 * @param {function} onRemove - Callback pour supprimer le widget
 * @param {number} w - Largeur en slots (défaut: 2)
 * @param {number} h - Hauteur en slots (défaut: 2)
 */
const BaseWidget = ({ id, title, icon, children, onRemove, w = 2, h = 2 }) => {
  return (
    <div className={`base-widget widget-${w}x${h}`}>
      <div className="widget-header">
        <div className="widget-title">
          <span className="widget-icon">{icon}</span>
          <span className="widget-title-text">{title}</span>
        </div>
        {onRemove && (
          <button 
            className="widget-remove-btn" 
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              console.log('[BaseWidget] Suppression du widget:', id);
              e.preventDefault();
              e.stopPropagation();
              onRemove(id);
            }}
            title="Supprimer le widget"
          >
            ✕
          </button>
        )}
      </div>
      <div className="widget-content">
        {children}
      </div>
    </div>
  );
};

export default BaseWidget;
