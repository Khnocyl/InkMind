export interface ElectronWindowApi {
  isElectron: boolean;
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  onMaximizeChange: (callback: (isMaximized: boolean) => void) => () => void;
}

declare global {
  interface Window {
    electronWindow?: ElectronWindowApi;
  }
}
