import { defineAuth } from "@aws-amplify/backend";
import { postConfirmationLambda } from "../functions/postConfirmationLambda/resource";

export const auth = defineAuth({
  loginWith: {
    email: {
      userInvitation: {
        emailSubject: "You've been invited to WickOps",
        emailBody: (user, code) =>
          `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">` +
          `<div style="text-align:center;padding:20px 0;border-bottom:2px solid #2472B1">` +
          `<h1 style="color:#2472B1;margin:0;font-size:28px">WickOps</h1>` +
          `</div>` +
          `<div style="padding:30px 0">` +
          `<h2 style="color:#333;margin-top:0">You're invited!</h2>` +
          `<p style="color:#555;font-size:16px;line-height:1.5">` +
          `A team member has invited you to join their organization on WickOps.` +
          `</p>` +
          `<p style="color:#555;font-size:16px;line-height:1.5">Your login credentials are:</p>` +
          `<div style="background:#f5f5f5;border-radius:8px;padding:15px 20px;margin:20px 0">` +
          `<p style="margin:5px 0;font-size:15px"><strong>Email:</strong> ${user()}</p>` +
          `<p style="margin:5px 0;font-size:15px"><strong>Temporary Password:</strong> ${code()}</p>` +
          `</div>` +
          `<p style="color:#555;font-size:16px;line-height:1.5">` +
          `Click the button below to sign in. You'll be asked to set a new password on your first login.` +
          `</p>` +
          `<div style="text-align:center;margin:30px 0">` +
          `<a href="https://systems.wickops.com" style="background:#2472B1;color:#ffffff;padding:12px 30px;border-radius:6px;text-decoration:none;font-size:16px;font-weight:bold">Sign In to WickOps</a>` +
          `</div>` +
          `</div>` +
          `<div style="border-top:1px solid #eee;padding-top:15px;text-align:center">` +
          `<p style="color:#999;font-size:13px">` +
          `This is an automated message from WickOps. If you did not expect this invitation, you can safely ignore this email.` +
          `</p>` +
          `</div>` +
          `</div>`,
      },
    },
  },

  userAttributes: {
    email: {
      required: true,
      mutable: true,
    },

    "custom:organizationName": {
      dataType: "String",
      mutable: false,
      maxLen: 100,
    },
  },

  triggers: {
    postConfirmation: postConfirmationLambda,
  },
});
