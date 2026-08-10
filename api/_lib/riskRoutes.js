// ─── Risks app — HTTP routes ───────────────────────────────────────────────────
// Thin layer over riskRegister.js. Owner-gated exactly like the rest of the PM
// vault surface: the register holds internal risk scoring and client-sensitive
// blockers, so `requirePmBrainOwner` applies to every route here.
//
// Registered from api/index.js AFTER the auth middleware, per the project rule.

import express from 'express';
import { requirePmBrainOwner } from './pmBrain.js';
import { loadRiskPayload, seedFromGraph, setRiskOverride } from './riskRegister.js';

const json = express.json({ limit: '64kb' });

const fail = (res, e, fallback = 'Risk register request failed') => {
  console.warn('[risks]', e?.message);
  res.status(500).json({ error: e?.message || fallback });
};

export function registerRiskRoutes(app) {
  // The register for one project, plus how much call material each milestone has.
  app.get('/api/risks/:project', requirePmBrainOwner, async (req, res) => {
    try {
      const data = await loadRiskPayload(req.params.project);
      if (!data.available) return res.status(503).json(data);
      res.json(data);
    } catch (e) { fail(res, e); }
  });

  // One-time import of the canonical Risk Graph as seed history. Idempotent: an
  // already-imported node is skipped, so pressing it twice cannot duplicate or
  // overwrite anything the engine has since changed.
  app.post('/api/risks/:project/seed', requirePmBrainOwner, json, async (req, res) => {
    try {
      const out = await seedFromGraph(req.params.project, { force: !!req.body?.force });
      if (!out.ok) return res.status(422).json(out);
      res.json(out);
    } catch (e) { fail(res, e, 'Seeding from Risk Graph failed'); }
  });

  // The human's verdict on one risk — always stronger than the engine's.
  app.post('/api/risks/:project/override', requirePmBrainOwner, json, async (req, res) => {
    const { riskId, status = null, why = '' } = req.body ?? {};
    if (!riskId) return res.status(400).json({ error: 'riskId is required' });
    try {
      const risk = await setRiskOverride(req.params.project, riskId, {
        status, why, by: req.authEmail ?? null,
      });
      res.json({ ok: true, risk });
    } catch (e) {
      // "not in the register" / unknown status are the caller's mistake, not a bug.
      if (/not in the register|Unknown status/.test(e?.message ?? '')) {
        return res.status(400).json({ error: e.message });
      }
      fail(res, e, 'Could not set the override');
    }
  });
}
