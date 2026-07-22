import type { MyselfApi } from './shared/myself-api';

declare global {
  interface Window {
    myself: MyselfApi;
  }
}

export {};
