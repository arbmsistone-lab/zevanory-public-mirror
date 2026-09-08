import type { NubeSDK } from '@tiendanube/nube-sdk-types';

/**
 * ZEVANORY NubeSDK bootstrap.
 * Intentionally non-invasive: backend/API integration remains server-side.
 */
export function App(nube: NubeSDK) {
  void nube;
}
