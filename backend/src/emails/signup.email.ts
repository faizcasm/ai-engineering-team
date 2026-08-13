interface SignupEmailProps {
  username: string;
}

export const signupEmailTemplate = ({
  username,
}: SignupEmailProps) => {
  return {
    subject: "Welcome to our platform",

    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8" />
          <title>Welcome</title>
        </head>

        <body>
          <div>
            <h1>Welcome, ${username}!</h1>

            <p>
              Your account has been successfully created.
            </p>

            <p>
              We're happy to have you here.
            </p>

            <p>
              Thanks for joining us.
            </p>
          </div>
        </body>
      </html>
    `,
  };
};