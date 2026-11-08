import type { Server } from 'node:http';

export declare function createLlmProxyServer(secretText: string, options?: {
  credentialDir?: string;
  idpBaseUrl?: string;
  refreshFloorMs?: number;
  forwardTo?: { host: string; port: number; protocol: 'http' | 'https' };
}): Server;
