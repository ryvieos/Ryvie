// global.d.ts
declare module '*.module.css' {
  const classes: { [key: string]: string };
  export default classes;
}

declare module '*.css' {
  const content: { [key: string]: string };
  export default content;
}

declare module '*.png' {
  const value: string;
  export default value;
}

declare module '*.jpg' {
  const value: string;
  export default value;
}

declare module '*.jpeg' {
  const value: string;
  export default value;
}

declare module '*.svg' {
  const value: string;
  export default value;
}

declare module '*.gif' {
  const value: string;
  export default value;
}

declare namespace __WebpackModuleApi {
  interface RequireContext {
    keys(): string[];
    <T = any>(id: string): T;
    resolve(id: string): string;
    id: string;
  }
}

interface NodeRequire {
  context(
    directory: string,
    useSubdirectories: boolean,
    regExp: RegExp
  ): __WebpackModuleApi.RequireContext;
}

// Electron API types
interface Window {
  electronAPI?: {
    redirectToLogin: () => Promise<void>;
    closeCurrentWindow: () => void;
  };
}
