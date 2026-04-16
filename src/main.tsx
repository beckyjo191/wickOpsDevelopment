import React from 'react';
import ReactDOM from 'react-dom/client';
import { Amplify } from 'aws-amplify';
import outputs from '../amplify_outputs.json';
import AppWrapper from './AppWrapper';
import './index.css';
import './App.css';
import '@aws-amplify/ui-react/styles.css';
import { LandingPage } from './components/LandingPage';
import { TermsPage } from './components/TermsPage';
import { PrivacyPage } from './components/PrivacyPage';
import { CookiePage } from './components/CookiePage';
import { applyThemePreference, loadThemePreference } from './lib/themePreference';

Amplify.configure(outputs);
applyThemePreference(loadThemePreference());

const pathname = window.location.pathname;
const search = new URLSearchParams(window.location.search);
const checkoutSuccess = search.get("checkout") === "success";
const showLanding = pathname === "/" && !checkoutSuccess;
const showTerms = pathname === "/terms";
const showPrivacy = pathname === "/privacy";
const showCookies = pathname === "/cookies";
const authInitialState = pathname === "/signup" ? "signUp" : "signIn";

function Root() {
  if (showLanding) return <LandingPage />;
  if (showTerms) return <TermsPage />;
  if (showPrivacy) return <PrivacyPage />;
  if (showCookies) return <CookiePage />;
  return <AppWrapper initialState={authInitialState} />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
