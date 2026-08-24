export interface DeprecationHeadersOptions {
  path: string;
  mode: "LEGACY" | "DUAL_RUN" | "GATEWAY";
  sunset?: Date;
}

const SUCCESSORS: ReadonlyArray<{ pattern: RegExp; href: string }> = [
  { pattern: /^\/spatial\/nearby$/u, href: "/v1/operations/spatial.find-nearby:execute" },
  { pattern: /^\/spatial\/nearest$/u, href: "/v1/operations/spatial.find-nearest:execute" },
  { pattern: /^\/spatial\/in-area$/u, href: "/v1/operations/spatial.find-in-area:execute" },
  { pattern: /^\/spatial\/intersections$/u, href: "/v1/operations/spatial.find-intersections:execute" },
  { pattern: /^\/spatial\/(?:near-route|objects-along-route)$/u, href: "/v1/operations/spatial.find-near-route:execute" },
  { pattern: /^\/spatial\/area-summary$/u, href: "/v1/operations/spatial.summarize-area:execute" },
  { pattern: /^\/situation\/cells\/[^/]+$/u, href: "/v1/operations/gowm.situation.h3.get-cell:execute" },
  { pattern: /^\/situation\/area$/u, href: "/v1/operations/gowm.situation.h3.get-area:execute" },
  { pattern: /^\/situation\/hotspots$/u, href: "/v1/operations/gowm.situation.h3.get-hotspots:execute" },
  { pattern: /^\/situation\/coverage-gaps$/u, href: "/v1/operations/gowm.situation.h3.get-coverage-gaps:execute" }
];

export function compatibilityDeprecationHeaders(options: DeprecationHeadersOptions): Record<string, string> | undefined {
  const path = options.path.split("?", 1)[0] ?? options.path;
  if (!path.startsWith("/spatial/") && !path.startsWith("/situation/")) return undefined;
  const successor = SUCCESSORS.find((candidate) => candidate.pattern.test(path))?.href ?? "/v1/capabilities";
  const sunset = options.sunset ?? new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000);
  if (Number.isNaN(sunset.getTime())) throw new Error("compatibility sunset must be a valid date");
  return {
    Deprecation: "true",
    Sunset: sunset.toUTCString(),
    Link: `<${successor}>; rel="successor-version"`,
    Warning: `299 GOWM "Deprecated compatibility route; mode=${options.mode}"`,
    "X-GOWM-Compatibility-Mode": options.mode
  };
}

