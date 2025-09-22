export interface ServerOptions {
  port?: number;
  host?: string;
  directory?: string;
  openBrowser?: boolean;
  silent?: boolean;
  header?: Record<string, string>;
}
