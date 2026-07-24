// ---------------------------------------------------------------------------
// Server-side config for the ADC-authenticated Google API proxy. Every value
// here is read from the environment so no project IDs or credentials ever
// live in source control — copy .env.example to .env and fill these in. See
// README.md for the one-time `gcloud auth application-default login` setup.
// ---------------------------------------------------------------------------
import "dotenv/config";

export const PORT = process.env.PORT || 8000;

// Required for the Vertex AI Gemini calls (projects/{id}/locations/{loc}/...).
// Speech-to-Text and Text-to-Speech don't need it in the URL, only the ADC
// token itself.
export const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || "";
export const GCP_LOCATION = process.env.GCP_LOCATION || "europe-west1";
export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

// Optional alternative to ADC, just for the Gemini routes: a plain API key
// from Google AI Studio (https://aistudio.google.com/apikey). When set, the
// Gemini proxy route calls generativelanguage.googleapis.com with this key
// instead of Vertex AI over ADC, so GCP_PROJECT_ID/ADC login aren't needed
// just to talk to Gemini. Speech-to-Text still needs ADC regardless, since
// AI Studio keys aren't scoped for that API.
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
