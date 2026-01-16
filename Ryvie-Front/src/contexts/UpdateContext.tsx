import React, { createContext, useContext, useState, ReactNode } from 'react';

interface UpdateContextType {
  isUpdating: boolean;
  updateTargetVersion: string | null;
  accessMode: string | null;
  startUpdate: (version: string, mode: string) => void;
  stopUpdate: () => void;
}

const UpdateContext = createContext<UpdateContextType | undefined>(undefined);

export const UpdateProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateTargetVersion, setUpdateTargetVersion] = useState<string | null>(null);
  const [accessMode, setAccessMode] = useState<string | null>(null);

  const startUpdate = (version: string, mode: string) => {
    setIsUpdating(true);
    setUpdateTargetVersion(version);
    setAccessMode(mode);
  };

  const stopUpdate = () => {
    setIsUpdating(false);
    setUpdateTargetVersion(null);
    setAccessMode(null);
  };

  return (
    <UpdateContext.Provider value={{ isUpdating, updateTargetVersion, accessMode, startUpdate, stopUpdate }}>
      {children}
    </UpdateContext.Provider>
  );
};

export const useUpdate = () => {
  const context = useContext(UpdateContext);
  if (context === undefined) {
    throw new Error('useUpdate must be used within an UpdateProvider');
  }
  return context;
};
