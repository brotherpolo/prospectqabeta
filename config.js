// Firebase project settings, unchanged from the original app.
// (A Firebase web API key is a public identifier, not a secret. Access is controlled by your Firestore rules.)
export const firebaseConfig = {
  apiKey: "AIzaSyBieU7YR2JrgYE7iQ829vD-Nlvwmi08MUY",
  authDomain: "prospectqa-9273b.firebaseapp.com",
  projectId: "prospectqa-9273b",
  storageBucket: "prospectqa-9273b.firebasestorage.app",
  messagingSenderId: "565778844784",
  appId: "1:565778844784:web:22cef4615109d63e45b8b5"
};

// Where the shared dataset lives: artifacts/{APP_ID}/public/{DATA_DOC}.
// The original app uses "data". To test on staging without touching production data,
// change DATA_DOC to e.g. "data-staging" (your Firestore rules must allow that path).
export const APP_ID = "prospectqa-9273b";
export const DATA_DOC = "data";

export const XLSX_URL = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
export const PLANNER_URL = "https://brotherpolo.github.io/ppscplanner";
