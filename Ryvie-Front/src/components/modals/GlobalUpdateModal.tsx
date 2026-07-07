import React from 'react';
import ReactDOM from 'react-dom';
import { useUpdate } from '../contexts/UpdateContext';
import UpdateModal from './UpdateModal';

const GlobalUpdateModal: React.FC = () => {
  const { isUpdating, updateTargetVersion, accessMode } = useUpdate();

  if (!isUpdating) return null;

  // Utiliser un portail pour rendre le modal au niveau du body
  // Cela garantit qu'il reste visible même si la route change
  return ReactDOM.createPortal(
    <UpdateModal 
      isOpen={isUpdating}
      targetVersion={updateTargetVersion || 'latest'}
      accessMode={accessMode || 'private'}
    />,
    document.body
  );
};

export default GlobalUpdateModal;
