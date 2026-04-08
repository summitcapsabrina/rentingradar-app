// Thin Firebase wrapper used by the extension service worker.
//
// We use the modular v10 SDK loaded from a local bundle so the extension
// doesn't need to fetch remote code (MV3 forbids remote script execution).
//
// NOTE: Before shipping, bundle firebase-app, firebase-auth, and firebase-firestore
// into ./firebase-bundle.js using esbuild. See ../README.md for the bundle command.
// For now this file imports from the bundle at runtime.

import {
  initializeApp,
} from './firebase-bundle.js';
import {
  getAuth,
  signInWithCustomToken as fbSignInWithCustomToken,
  onAuthStateChanged,
  signOut as fbSignOut,
  setPersistence,
  indexedDBLocalPersistence,
} from './firebase-bundle.js';
import {
  getFirestore,
  collection,
  addDoc,
  serverTimestamp,
} from './firebase-bundle.js';

// RentingRadar Firebase web config — matches the CRM so the extension signs
// into the exact same project.
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAiWI-bB-HxFmvgiFSIuYLtFnv7BniFlQk',
  authDomain: 'rentingradar.firebaseapp.com',
  projectId: 'rentingradar',
  storageBucket: 'rentingradar.firebasestorage.app',
  messagingSenderId: '622768449810',
  appId: '1:622768449810:web:fde8ec3ba25a70643d2bcb',
};

let app = null;
let auth = null;
let db = null;
let currentUser = null;
let readyPromise = null;

export async function ensureReady() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    app = initializeApp(FIREBASE_CONFIG);
    auth = getAuth(app);
    // Persist across service worker restarts
    try { await setPersistence(auth, indexedDBLocalPersistence); } catch (_) {}
    db = getFirestore(app);
    await new Promise((resolve) => {
      const unsub = onAuthStateChanged(auth, (u) => {
        currentUser = u || null;
        unsub();
        resolve();
      });
    });
    // Keep currentUser fresh
    onAuthStateChanged(auth, (u) => { currentUser = u || null; });
  })();
  return readyPromise;
}

export function getCurrentUser() {
  return currentUser;
}

export async function signInWithCustomToken(token) {
  await ensureReady();
  const cred = await fbSignInWithCustomToken(auth, token);
  currentUser = cred.user;
  return cred.user;
}

export async function signOut() {
  await ensureReady();
  await fbSignOut(auth);
  currentUser = null;
}

export async function addCompetitor(uid, payload) {
  await ensureReady();
  const ref = collection(db, 'users', uid, 'competitors');
  await addDoc(ref, {
    ...payload,
    createdAt: serverTimestamp(),
  });
}
