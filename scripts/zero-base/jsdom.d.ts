/**
 * Minimal ambient types for `jsdom`.
 *
 * `@types/jsdom` is not a dependency of this project and adding one for a
 * single build script is not worth the supply-chain surface. This declares only
 * the surface the frame harness actually uses; anything beyond it stays a type
 * error rather than silently becoming `any`.
 */
declare module "jsdom" {
  export interface JSDOMOptions {
    pretendToBeVisual?: boolean;
    url?: string;
  }

  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions);
    /** The document's window. Typed as the DOM lib's Window, which it models. */
    readonly window: Window & typeof globalThis;
    serialize(): string;
  }
}
