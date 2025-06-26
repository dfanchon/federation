// Type declarations for modules without TypeScript definitions

declare module 'make-fetch-happen' {
  import { RequestInit, Response } from 'node-fetch';
  
  interface FetchOptions extends RequestInit {
    maxSockets?: number;
    retry?: boolean | number;
    timeout?: number;
    cache?: string;
  }
  
  interface FetchFunction {
    (url: string, options?: FetchOptions): Promise<Response>;
    defaults(options: FetchOptions): FetchFunction;
  }
  
  const fetcher: FetchFunction;
  export = fetcher;
} 
