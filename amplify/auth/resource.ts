import { defineAuth } from '@aws-amplify/backend';
import { postConfirmationLambda } from '../functions/postConfirmationLambda/resource';

export const auth = defineAuth({
  loginWith: {
    email: true, // email is username
  },

  userAttributes: {
    email: {
      required: true,
      mutable: true,
    },

    // Optional — enforced in Lambda, NOT Cognito
    'custom:organizationName': {
      dataType: 'String',
      mutable: false,
      maxLen: 100,
    },
  },

  triggers: {
    postConfirmation: postConfirmationLambda,
  },
});
