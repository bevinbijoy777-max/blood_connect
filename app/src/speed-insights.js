/**
 * Speed Insights entry point: bundles the @vercel/speed-insights package
 * into a standalone module that can be imported by app.js.
 */
import { injectSpeedInsights } from "@vercel/speed-insights";

// Reports Core Web Vitals from real visitors once this page is deployed to
// Vercel. It is a no-op elsewhere, so local development stays silent.
injectSpeedInsights();
