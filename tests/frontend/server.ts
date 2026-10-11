import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

// Existing Lab journeys have no Session. Session-specific tests replace these HTTP defaults.
export const server = setupServer(
  http.get('*/api/v1/lab/labs/:labId/installations', () =>
    HttpResponse.json({ data: [] }),
  ),
  http.get('*/api/v1/lab/labs/:labId/sessions', () =>
    HttpResponse.json({
      data: [],
      active_session_id: null,
      development_synthetic_enabled: false,
    }),
  ),
  http.get(
    '*/api/v1/lab/labs/:labId/sessions/events',
    () =>
      new HttpResponse(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(': ready\n\n'));
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  ),
);
