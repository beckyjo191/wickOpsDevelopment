import {
  Authenticator,
  TextField,
  View,
} from '@aws-amplify/ui-react';
import App from './App';

export default function AppWrapper() {
  return (
    <Authenticator
      loginMechanisms={['email']}
      components={{
        Header() {
          return (
            <View textAlign="center" marginBottom="1rem">
              <h1>WickOps Systems</h1>
            </View>
          );
        },

        SignUp: {
          FormFields() {
            return (
              <>
                {/* Optional Organization Name */}
                <TextField
                  name="custom:organizationName"
                  label="Organization Name (optional)"
                  placeholder="Fire Department, Company, etc."
                />

                {/* Friendly display name (NOT Cognito attribute) */}
                <TextField
                  name="displayName"
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
