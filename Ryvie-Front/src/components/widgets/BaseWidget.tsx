import React from 'react';
import WidgetRemoveButton from './WidgetRemoveButton';
import '../../styles/Widgets.css';

const BaseWidget = ({ id, title = '', icon = '', children, onRemove, w = 2, h = 2, className = '', action = null, onClick = null }) => {
  return (
    <div
      className={`base-widget widget-${w}x${h} ${className}`}
      onClick={(e) => {
        if (!onClick) return;
        onClick(e);
      }}
    >
      <div className="widget-inner">
        {(title || icon) && (
          <div className="widget-header">
            <div className="widget-title">
              {icon && <span className="widget-icon">{icon}</span>}
              {title && <span className="widget-title-text">{title}</span>}
            </div>
            {action}
          </div>
        )}
        <div className="widget-content">
          {children}
          {onRemove && <WidgetRemoveButton id={id} onRemove={onRemove} />}
        </div>
      </div>
    </div>
  );
};

export default BaseWidget;
