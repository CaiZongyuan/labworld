import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { PublicFailure } from './failure.ts';

const limit = bodyLimit({
  maxSize: 16 * 1024,
  onError: () => {
    throw new PublicFailure(
      413,
      'http.payload_too_large',
      'Request body exceeds the allowed size',
    );
  },
});
// The timeout contains only body parsing. A late parser completion cannot dispatch a use case.
export const boundedJson: MiddlewareHandler = async (context, next) => {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      limit(context, async () => {
        if (
          !/^application\/(?:[^\s;]+\+)?json(?:;.*)?$/i.test(
            context.req.header('content-type') ?? '',
          )
        )
          throw new PublicFailure(
            400,
            'http.invalid_json',
            'Provide a valid JSON request',
          );
        try {
          await context.req.json();
        } catch {
          throw new PublicFailure(
            400,
            'http.invalid_json',
            'Provide a valid JSON request',
          );
        }
      }),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () =>
            reject(
              new PublicFailure(
                408,
                'http.body_timeout',
                'Request body was not received in time',
              ),
            ),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
  await next();
};
