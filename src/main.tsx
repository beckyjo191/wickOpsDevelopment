import React from 'react';
import ReactDOM from 'react-dom/client';
import { Amplify } from 'aws-amplify';
import outputs from '../amplify_outputs.json';
import AppWrapper from './AppWrapper';
import './index.css';
import './App.css';
import '@aws-amplify/ui-react/styles.css';
import { LandingPage } from './components/LandingPage';

Amplify.configure(outputs);

const pathname = window.location.pathname;
const showLanding = pathname === "/";
const authInitialState = pathname === "/signup" ? "signUp" : "signIn";

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {showLanding ? <LandingPage /> : <AppWrapper initialState={authInitialState} />}
  </React.StrictMode>
);
