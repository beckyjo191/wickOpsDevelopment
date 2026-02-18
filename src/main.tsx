import React from 'react';
import ReactDOM from 'react-dom/client';
import { Amplify } from 'aws-amplify';
import outputs from '../amplify_outputs.json';
import AppWrapper from './AppWrapper';
import './index.css';
import './App.css';
import '@aws-amplify/ui-react/styles.css';
import { LandingPage } from './components/LandingPage';
import { applyThemePreference, loadThemePreference } from './lib/themePreference';

Amplify.configure(outputs);
applyThemePreference(loadThemePreference());

const pathname = window.location.pathname;
const search = new URLSearchParams(window.location.search);
const checkoutSuccess = search.get("checkout") === "success";
const showLanding = pathname === "/" && !checkoutSuccess;
const authInitialState = pathname === "/signup" ? "signUp" : "signIn";

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {showLanding ? <LandingPage /> : <AppWrapper initialState={authInitialState} />}
  </React.StrictMode>
);
