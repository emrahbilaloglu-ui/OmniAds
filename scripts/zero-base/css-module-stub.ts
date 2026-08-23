/**
 * Let a plain `tsx` script import a CSS module.
 *
 * The shell harness renders real components to static HTML, and those
 * components import `*.module.css`. Node's CommonJS loader hands the file to
 * the JavaScript parser, which fails on the first selector:
 *
 *   /components/zero-base/legacy-workspace-interior.module.css:1
 *   .workspace {
 *   ^
 *   SyntaxError: Unexpected token '.'
 *
 * That is why `npm run zero-base:shell:harness` has been failing, and with it
 * every gate that starts by building the harness — `test:zero-base:a11y`,
 * `test:zero-base:responsive`, `test:zero-base:visual`, `test:zero-base:frames`
 * and `test:zero-base:fidelity`. The design gates the plan relies on were not
 * running at all; they were failing at step one.
 *
 * The stub returns the requested class name for any key, so
 * `styles.workspace` renders as `"workspace"`. That is deliberate and it is
 * what a layout harness needs: the measurable contract is the element tree and
 * the stylesheet the page loads (`app/globals.css`), not the hashed local name
 * a bundler would have minted. A harness that resolved real hashes would be
 * asserting the bundler's output rather than the design's layout.
 *
 * `default` is handled explicitly so `import styles from "./x.module.css"`
 * receives the proxy itself rather than a string called "default".
 */
import { createRequire } from "node:module";

/**
 * Inert under Vitest, deliberately.
 *
 * These stubs exist for `node --import tsx` scripts, where Node's CommonJS
 * loader is what resolves a `.module.css`. Vitest resolves it through Vite,
 * which handles CSS and `next/image` itself — and patching `Module._load`
 * inside a test worker would change resolution for every other module in it.
 * The gate scripts import this file; so does the test that imports those
 * scripts for their pure comparison functions, and only the first needs it.
 */
const UNDER_VITEST = Boolean(process.env.VITEST);

const require = createRequire(import.meta.url);

const handler: ProxyHandler<Record<string, string>> = {
  get(_target, property) {
    if (typeof property !== "string") return undefined;
    if (property === "default" || property === "__esModule") return undefined;
    return property;
  },
};

function registerCssModuleStub() {
  if (UNDER_VITEST) return;
  const Module = require("node:module") as {
    _extensions: Record<string, (module: NodeJS.Module, filename: string) => void>;
  };
  for (const extension of [".css", ".scss", ".sass"]) {
    Module._extensions[extension] = (module) => {
      const stub = new Proxy({}, handler);
      // Both shapes, because the components use the default import and some
      // tooling reaches for the namespace.
      (module as unknown as { exports: unknown }).exports = Object.assign(stub, {
        default: stub,
        __esModule: true,
      });
    };
  }
}

registerCssModuleStub();

/**
 * Render `next/image` as a plain `<img>` for the harnesses.
 *
 * Outside a Next request, the default loader builds `/_next/image?url=…` and
 * `new URL()` throws `Invalid URL` on the relative result — so the frame,
 * reference and fidelity harnesses died the moment any body rendered a platform
 * logo. This is the second reason those gates have not been running.
 *
 * A plain `<img>` carrying the same `src`, `width`, `height`, `className`,
 * `style` and `alt` is the faithful substitute for what these harnesses
 * measure: they compare LAYOUT against a design reference that is itself static
 * HTML with plain images. What is deliberately not reproduced is Next's
 * optimisation pipeline — srcset, lazy loading, the blur placeholder — none of
 * which changes the box the element occupies, and all of which would be the
 * bundler's behaviour rather than the design's.
 */
function registerNextImageStub() {
  if (UNDER_VITEST) return;
  const Module = require("node:module") as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const load = Module._load.bind(Module);
  const React = require("react") as typeof import("react");

  Module._load = (request: string, parent: unknown, isMain: boolean) => {
    if (request !== "next/image") return load(request, parent, isMain);
    const Image = (props: Record<string, unknown>) => {
      const {
        src,
        alt,
        width,
        height,
        className,
        style,
        // Next-only props with no DOM meaning. Passing them through would emit
        // React warnings and unknown attributes into the compared markup.
        priority: _priority,
        quality: _quality,
        fill: _fill,
        sizes: _sizes,
        loader: _loader,
        placeholder: _placeholder,
        blurDataURL: _blurDataURL,
        unoptimized: _unoptimized,
        ...rest
      } = props;
      return React.createElement("img", {
        ...rest,
        src: typeof src === "string" ? src : ((src as { src?: string })?.src ?? ""),
        alt: typeof alt === "string" ? alt : "",
        width,
        height,
        className,
        style,
      });
    };
    return { __esModule: true, default: Image };
  };
}

registerNextImageStub();
