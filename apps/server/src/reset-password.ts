import { resetPasswordOperation } from './password-operation.ts';
import { PublicFailure } from '../../../packages/server/src/platform/http/failure.ts';
void resetPasswordOperation(process.argv.slice(2))
  .then((result) => console.log(JSON.stringify(result)))
  .catch((error) => {
    console.error(
      JSON.stringify({
        error: {
          code:
            error instanceof PublicFailure ? error.code : 'auth.unavailable',
          message:
            error instanceof PublicFailure
              ? error.message
              : 'Password reset is unavailable',
        },
      }),
    );
    process.exitCode = 1;
  });
