import {
  createDocument,
  getDocument,
  listDocuments,
  loginAs,
  scenarioOptions,
  writeSummary,
} from './lib.js';

// The steady-state reading: logged-in users browsing their knowledge base —
// a read-heavy mix (list / read / occasional create) at constant VUs.
// Answers "what does ordinary usage look like at N concurrent users".

export const options = scenarioOptions({ vus: 4, duration: '60s' });

export default function () {
  const s = loginAs(__VU);
  if (!s) return;
  if (Math.random() < 0.05) {
    createDocument(
      s,
      `load ${__VU}-${__ITER}`,
      `# load sample\n\n created during the load scenario, iteration ${__ITER}.\n`,
    );
    return;
  }
  const page = listDocuments(s);
  if (page && Math.random() < 0.35) {
    const docs = page.json('data');
    if (docs.length > 0)
      getDocument(s, docs[Math.floor(Math.random() * docs.length)].id);
  }
}

export const handleSummary = writeSummary({
  description: 'steady read-heavy mix at constant VUs',
});
