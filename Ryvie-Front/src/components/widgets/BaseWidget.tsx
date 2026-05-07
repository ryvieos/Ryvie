import React from 'react';
import WidgetRemoveButton from './WidgetRemoveButton';
import '../../styles/Widgets.css';

/**
 * Composant de base pour tous les widgets
 * @param {string} id - ID unique du widget
 * @param {string} [title] - Titre du widget (optionnel)
 * @param {string} icon - Icône du widget (emoji ou classe)
 * @param {React.ReactNode} children - Contenu du widget
 * @param {function} onRemove - Callback pour supprimer le widget
 * @param {number} w - Largeur en slots (défaut: 2)
 * @param {number} h - Hauteur en slots (défaut: 2)
 */
const BaseWidget = ({ id, title = '', icon = '', children, onRemove, w = 2, h = 2, className = '', action = null, onClick = null, overlay = false }) => {
  return (
    <div
      className={`base-widget widget-${w}x${h} ${overlay ? 'overlay' : ''} ${className}`}
      onClick={(e) => {
        if (!onClick) return;
        console.log('[BaseWidget] click on widget', id);
        onClick(e);
      }}
    >
      <div className={`widget-inner ${overlay ? 'overlay' : ''}`}>
        {(title || icon) && (
          <div className="widget-header">
            <div className="widget-title">
              {icon && <span className="widget-icon">{icon}</span>}
              {title && <span className="widget-title-text">{title}</span>}
            </div>
          </div>
        )}
        {action}
        <div className={`widget-content ${overlay ? 'overlay' : ''}`}>
          {children}
          {onRemove && <WidgetRemoveButton id={id} onRemove={onRemove} />}
        </div>
      </div>
    </div>
  );
};

export default BaseWidget;
