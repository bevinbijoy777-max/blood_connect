import { injectSpeedInsights } from "@vercel/speed-insights";

import "./style.css";

// Reports Core Web Vitals from real visitors once this page is deployed to
// Vercel. It is a no-op elsewhere, so local development stays silent.
injectSpeedInsights();

const LATEST_RELEASE_API =
  "https://api.github.com/repos/bevinbijoy777-max/blood_connect/releases/latest";

// The download buttons point at GitHub's "latest release" URLs. The static
// notice warns that a 404 means nothing is published yet, which stays true
// whether or not this request succeeds. Only a confirmed release removes it.
fetch(LATEST_RELEASE_API, { headers: { Accept: "application/vnd.github+json" } })
  .then((response) => {
    if (response.ok) {
      document.querySelector("[data-release-note]")?.remove();
    }
    // A 404, or a 403 from GitHub's rate limit, leaves the notice in place:
    // its wording does not assert that a release is missing.
  })
  .catch(() => {
    // Blocked, offline or otherwise unavailable: same reasoning.
  });
