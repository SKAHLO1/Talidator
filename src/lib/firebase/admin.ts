import "server-only";

import { cert, getApp, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

/**
 * Firebase Admin, used only by route handlers (Node.js runtime).
 *
 * Production (e.g. Vercel): FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY from a
 * service-account key. Local emulators: FIREBASE_AUTH_EMULATOR_HOST + FIRESTORE_EMULATOR_HOST (the Admin SDK
 * picks those up itself) and only a project id is needed.
 */
const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
// Env UIs usually store the PEM with literal "\n" sequences, and a pasted .env line may keep its quotes.
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.trim().replace(/^"|"$/g, "").replace(/\\n/g, "\n");
const emulated = Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST && process.env.FIRESTORE_EMULATOR_HOST);

export const adminConfigured = Boolean(projectId && (emulated || (clientEmail && privateKey)));

function app(): App {
  if (!adminConfigured) throw new Error("Firebase Admin is not configured (FIREBASE_* env vars)");
  if (getApps().length) return getApp();
  // The emulators accept any token; a static credential stops the SDK probing the GCP metadata server
  // for default credentials (which stalls ~15 s off-cloud).
  const credential = emulated
    ? { getAccessToken: async () => ({ access_token: "owner", expires_in: 3600 }) }
    : cert({ projectId, clientEmail, privateKey });
  return initializeApp({ projectId, credential });
}

export const adminAuth = () => getAuth(app());
export const adminDb = () => getFirestore(app());
