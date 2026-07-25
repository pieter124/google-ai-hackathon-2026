// Server config, all from the environment so nothing sensitive lives in source.
// Copy .env.example to .env and fill these in.
import "dotenv/config";

export const PORT = process.env.PORT || 8000;

// Required for the Vertex AI Gemini calls.
export const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || "";
export const GCP_LOCATION = process.env.GCP_LOCATION || "europe-west1";
export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

// Optional AI Studio API key. When set, Gemini calls use it instead of Vertex
// AI over ADC. Speech-to-Text and Text-to-Speech still need ADC regardless.
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
