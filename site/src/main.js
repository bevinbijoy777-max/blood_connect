import { injectSpeedInsights } from "@vercel/speed-insights";

import "./style.css";

// Reports Core Web Vitals from real visitors once this page is deployed to
// Vercel. It is a no-op elsewhere, so local development stays silent.
injectSpeedInsights();

const LATEST_RELEASE_API =
  "https://api.github.com/repos/bevinbijoy777-max/blood_connect/releases/latest";

/**
 * The download buttons point at GitHub's "latest release" URLs, which return a
 * 404 until CI publishes the first build. The page says so up front; once a
 * release exists that notice is wrong, so drop it.
 */
async function refreshReleaseNotice() {
  const notice = document.querySelector("[data-release-note]");
  if (!notice) {
    return;
  }
  try {
    const response = await fetch(LATEST_RELEASE_API, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (response.ok) {
      notice.remove();
    }
  } catch {
    // Offline or the API is unreachable: keep the notice rather than imply
    // that the downloads are ready.
  }
}

void refreshReleaseNotice();
