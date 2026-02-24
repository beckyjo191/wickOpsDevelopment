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
                {/* Friendly display name */}
                <TextField
                  name="name"
                  label="Your Name"
                  placeholder="John Smith"
                  required
                />

                {/* Organization or account name — used to label the org, does not affect seat count */}
                <TextField
                  name="custom:organizationName"
                  label="Organization or Account Name (optional)"
                  placeholder="Fire Department, Studio, Family, etc."
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
