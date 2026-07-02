import { useAppBridge } from '@shopify/app-bridge-react';
import { useCallback } from 'react';

/**
 * Authenticated fetch wrapper for App Bridge v4.
 * useAuthenticatedFetch was removed in v4 — use useAppBridge + idToken() instead.
 */
export function useApi() {
  const shopify = useAppBridge();

  const apiFetch = useCallback(async (path: string, options: RequestInit = {}) => {
    const token = await shopify.idToken();
    return window.fetch(`/api${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
        'Authorization': `Bearer ${token}`,
      },
    });
  }, [shopify]);

  const get = useCallback(async (path: string) => {
    const res = await apiFetch(path);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  }, [apiFetch]);

  const patch = useCallback(async (path: string, body: object) => {
    const res = await apiFetch(path, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  }, [apiFetch]);

  const post = useCallback(async (path: string, body: object = {}) => {
    const res = await apiFetch(path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  }, [apiFetch]);

  return { get, patch, post };
}
