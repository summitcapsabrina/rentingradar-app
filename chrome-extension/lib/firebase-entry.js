// Entry point consumed by esbuild to produce lib/firebase-bundle.js.
// Run:
//   npx esbuild lib/firebase-entry.js --bundle --format=esm --outfile=lib/firebase-bundle.js

export { initializeApp } from 'firebase/app';
export {
  getAuth,
  signInWithCustomToken,
  onAuthStateChanged,
  signOut,
  setPersistence,
  indexedDBLocalPersistence,
} from 'firebase/auth';
export {
  getFirestore,
  collection,
  addDoc,
  serverTimestamp,
} from 'firebase/firestore';
