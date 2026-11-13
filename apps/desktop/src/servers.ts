// The desktop shell's server switcher (src-tauri/src/servers.rs): saved remote hubs and which hub the
// window shows. These are real Tauri commands — not hub RPCs — so they bypass transport.ts's hub
// branch; they exist only inside the desktop app (local hub page or a saved server's page).
import { invoke, isTauri } from '@tauri-apps/api/core';

export interface Server {
  id: string;
  name: string;
  url: string;
}

export interface ServerState {
  servers: Server[];
  /** The saved server the window shows; null = the local hub. */
  active: string | null;
}

export const canSwitchServers = (): boolean => isTauri();

export const listServers = (): Promise<ServerState> => invoke<ServerState>('servers_list');

export const addServer = (name: string, url: string): Promise<Server> =>
  invoke<Server>('servers_add', { name, url });

export const removeServer = (id: string): Promise<void> => invoke<void>('servers_remove', { id });

/** Navigates the window; null = back to the local hub. */
export const switchServer = (id: string | null): Promise<void> => invoke<void>('servers_switch', { id });

/** Adding and removing servers is for the local hub's UI only; a saved server's page may list and switch. */
export const canEditServers = (): boolean => ['127.0.0.1', 'localhost'].includes(window.location.hostname);
