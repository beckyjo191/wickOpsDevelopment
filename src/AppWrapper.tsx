import {
  Authenticator,
  TextField,
  View,
} from '@aws-amplify/ui-react';
import App from './App';
import logoOriginal from "./assets/brand/wickops-logo-original.svg";

type AppWrapperProps = {
  initialState?: "signIn" | "signUp";
};

export default function AppWrapper({ initialState = "signIn" }: AppWrapperProps) {
  return (
    <Authenticator
      initialState={initialState}
      loginMechanisms={['email']}
      components={{
        Header() {
          return (
            <View textAlign="center" marginBottom="1rem">
              <div className="brand-lockup">
                <img className="brand-logo" src={logoOriginal} alt="WickOps Systems" />
              </div>
            </View>
          );
        },

        SignUp: {
          FormFields() {
            return (
              <>
                <View className="signup-account-note" marginBottom="0.8rem">
                  <strong>Sign-up options:</strong> Organization accounts include up to 5 users.
                  Leave Organization Name blank for a personal account (1 user).
                </View>

                {/* Optional Organization Name */}
                <TextField
                  name="custom:organizationName"
                  label="Organization Name (optional)"
                  placeholder="Fire Department, Company, etc."
                />

                {/* Friendly display name (NOT Cognito attribute) */}
                <TextField
                  name="name"
                  label="Your Name"
                  placeholder="John Smith"
                  required
                />

                {/* Email + Password handled by Amplify */}
                <Authenticator.SignUp.FormFields />
              </>
            );
          },
        },
      }}
    >
      <App />
    </Authenticator>
  );
}
