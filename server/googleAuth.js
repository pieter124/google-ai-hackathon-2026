// ---------------------------------------------------------------------------
// Application Default Credentials (ADC) — the one place in this codebase
// that touches Google auth. ADC transparently picks up, in priority order:
//   1. A service account key file, if GOOGLE_APPLICATION_CREDENTIALS is set.
//   2. User credentials from `gcloud auth application-default login`.
//   3. The attached service account, when running on Cloud Run / Cloud
//      Functions / GCE / GKE (fetched from the metadata server).
// No API key is stored or transmitted anywhere in this app anymore.
//
// One-time local setup:
//   bash <(curl -sSL https://storage.googleapis.com/cloud-samples-data/adc/setup_adc.sh)
// which is equivalent to:
//   gcloud auth application-default login
// ---------------------------------------------------------------------------
import { GoogleAuth } from "google-auth-library";

const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

let clientPromise = null;

// Lazily creates and caches the authenticated client. `client.request()`
// attaches (and silently refreshes) the OAuth Authorization: Bearer header,
// plus the quota-project header if one was set via
// `gcloud auth application-default set-quota-project`.
export function getAuthClient() {
  if (!clientPromise) {
    clientPromise = auth.getClient().catch((err) => {
      clientPromise = null; // don't cache a failure — let the next request retry
      throw new AdcError(err);
    });
  }
  return clientPromise;
}

export async function getProjectId() {
  return auth.getProjectId();
}

// Wraps whatever google-auth-library throws (usually a terse "Could not
// load the default credentials") into a message that tells whoever is
// running this locally exactly what to do next.
export class AdcError extends Error {
  constructor(cause) {
    super(
      "No Application Default Credentials found. Run " +
        "`gcloud auth application-default login` (see README.md for the " +
        `one-line setup script), then restart the server. Original error: ${cause.message}`
    );
    this.name = "AdcError";
    this.cause = cause;
  }
}
