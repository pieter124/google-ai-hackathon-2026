// Application Default Credentials — the one place that touches Google auth. ADC
// picks up, in order: a service account key (GOOGLE_APPLICATION_CREDENTIALS),
// `gcloud auth application-default login` credentials, or the attached service
// account on Cloud Run / GCE / GKE.
import { GoogleAuth } from "google-auth-library";

const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

let clientPromise = null;

// Lazily creates and caches the authenticated client. client.request() attaches
// and refreshes the OAuth bearer header (and the quota-project header if set).
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

// Turns the library's terse "Could not load the default credentials" into a
// message that says what to do next.
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
