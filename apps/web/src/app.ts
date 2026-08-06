/**
 * AH-UX-WEB-001: Web application with Phase 2 screens.
 * Real client-side rendering with fetch API integration.
 */
import { WEB_SCREENS, getScreen } from './index.js';

export interface WebClientConfig {
  apiBaseUrl: string;
}

export interface WebClient {
  navigate(screenId: string): void;
  getApiBaseUrl(): string;
  getScreens(): typeof WEB_SCREENS;
  fetchSessions(): Promise<unknown[]>;
  createSession(task: string): Promise<unknown>;
}

export function createWebClient(config: WebClientConfig): WebClient {
  let currentScreen: string | null = null;

  return {
    navigate(screenId: string) {
      const screen = getScreen(screenId);
      if (!screen) throw new Error(`unknown screen: ${screenId}`);
      currentScreen = screenId;
    },
    getApiBaseUrl() {
      return config.apiBaseUrl;
    },
    getScreens() {
      return WEB_SCREENS;
    },
    async fetchSessions() {
      const resp = await fetch(`${config.apiBaseUrl}/api/sessions`);
      if (!resp.ok) throw new Error(`failed to fetch sessions: ${resp.status}`);
      const body = await resp.json() as { data: unknown[] };
      return body.data;
    },
    async createSession(task: string) {
      const resp = await fetch(`${config.apiBaseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task }),
      });
      if (!resp.ok) throw new Error(`failed to create session: ${resp.status}`);
      return resp.json();
    },
  };
}

/** Render a screen as HTML string (for SSR or static generation). */
export function renderScreen(screenId: string, state: string, data?: unknown): string {
  const screen = getScreen(screenId);
  if (!screen) return '<div>Unknown screen</div>';
  const dataStr = data ? JSON.stringify(data) : 'null';
  return `<div class="screen screen-${state}" data-screen="${screen.id}" role="main" aria-label="${screen.title}">
  <h1>${screen.title}</h1>
  <div class="state state-${state}" aria-live="polite">${state}</div>
  <div class="content" data-content="${globalThis.btoa ? globalThis.btoa(dataStr) : dataStr}"></div>
</div>`;
}
