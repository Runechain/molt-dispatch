// Layered validation (WHITEPAPER §7). Each layer escalates from cheap to expensive.
//   L1 schema    — is the submitted result well-formed?
//   L2 static    — does the patch apply? forbidden files? scope (max files) respected?
//   L3 automated — run the objective's acceptance commands (tests/lint) in the worktree.
//   L4 review    — a review job's rubric meets thresholds.
//
// M1 wires L1 + thresholds for review jobs. L2/L3 are filled in M3 (they need the
// worktree on disk). validateResult returns a verdict the lifecycle consumes.

import { getDb, now } from './db.mjs';
import { RESULT_ENVELOPE_SCHEMA, REVIEW_RUBRIC_SCHEMA, validateAgainst } from '../shared/schema.mjs';

// Workers that authored an implementation this review job depends on (from the assignment record).
function implAuthorsOf(reviewJobId) {
  return getDb()
    .prepare(
      `SELECT DISTINCT j.assigned_worker_id AS w FROM job_dependencies jd
         JOIN jobs j ON j.id = jd.depends_on_job_id
        WHERE jd.job_id = ? AND j.type = 'code.implementation'`
    )
    .all(reviewJobId)
    .map((r) => r.w)
    .filter(Boolean);
}

function recordValidation(jobId, type, result, score, notes, workerId = null) {
  getDb()
    .prepare(
      `INSERT INTO validations(job_id, validator_type, validator_worker_id, result, score_json, notes, created_at)
       VALUES(?,?,?,?,?,?,?)`
    )
    .run(jobId, type, workerId, result, score ? JSON.stringify(score) : null, notes || null, now());
}

// Returns { pass: boolean, layers: [...], reasons: [...] }
export async function validateResult(job, result, ctx = {}) {
  const layers = [];
  const reasons = [];

  // L1 — schema
  const s = validateAgainst(RESULT_ENVELOPE_SCHEMA, result);
  recordValidation(job.id, 'schema', s.valid ? 'pass' : 'fail', null, s.errors.join('; '));
  layers.push({ layer: 'schema', pass: s.valid });
  if (!s.valid) {
    reasons.push(`schema: ${s.errors.join('; ')}`);
    return { pass: false, layers, reasons };
  }
  if (result.status === 'failed') {
    reasons.push(`worker reported failure: ${result.error || 'unknown'}`);
    return { pass: false, layers, reasons };
  }

  // L2 + L3 — static + automated (only meaningful for implementation jobs with a patch).
  // ctx.staticCheck / ctx.automatedCheck are injected by the broker (buildResultCtx) once the
  // worktree exists. They run untrusted, worker-authored code, so the broker — not the worker —
  // must be the one to clear them.
  let ranGroundTruth = false;
  if (ctx.staticCheck) {
    const r = await ctx.staticCheck(job, result);
    recordValidation(job.id, 'static', r.pass ? 'pass' : 'fail', r.score, r.notes);
    layers.push({ layer: 'static', pass: r.pass });
    ranGroundTruth = true;
    if (!r.pass) reasons.push(`static: ${r.notes}`);
  }
  if (ctx.automatedCheck) {
    const r = await ctx.automatedCheck(job, result);
    recordValidation(job.id, 'automated', r.pass ? 'pass' : 'fail', r.score, r.notes);
    layers.push({ layer: 'automated', pass: r.pass });
    ranGroundTruth = true;
    if (!r.pass) reasons.push(`automated: ${r.notes}`);
  }

  // FAIL-CLOSED for untrusted code. A code.implementation result is the output of an untrusted
  // worker editing a worktree; accepting it requires the broker to have actually verified it
  // against ground truth (L2 and/or L3). If NEITHER check could run — buildResultCtx didn't
  // attach them, meaning no worktree/repo was bound — we must NOT silently accept on schema
  // alone. Reject so unverified code can't slip through.
  //
  // Scoping: this fires ONLY for type === 'code.implementation'. Inference/mock/non-code jobs
  // (e.g. verify_grid's inference flow) carry no static/automated ctx by design and are
  // unaffected — there is no untrusted patch to verify for them.
  if (job.type === 'code.implementation' && !ranGroundTruth) {
    recordValidation(job.id, 'static', 'fail', null, 'no ground-truth verification available (fail-closed)');
    layers.push({ layer: 'static', pass: false });
    reasons.push('fail-closed: code.implementation accepted without static/automated verification');
  }

  // L4 — review jobs. The verdict is attacker-controlled (worker POSTs result.review), so it is
  // NOT trusted as-is: the rubric must be well-formed (REVIEW_RUBRIC_SCHEMA — previously defined
  // but never applied), and the reviewer must be INDEPENDENT of the implementer (identity taken
  // from the claim record job.assigned_worker_id, never the self-reported result.review_worker_id).
  if (job.type === 'code.review') {
    const reviewer = job.assigned_worker_id;
    const rubric = validateAgainst(REVIEW_RUBRIC_SCHEMA, result.review || {});
    if (!rubric.valid) {
      recordValidation(job.id, 'review', 'fail', result.review || null, `malformed rubric: ${rubric.errors.join('; ')}`, reviewer);
      layers.push({ layer: 'review', pass: false });
      reasons.push(`review rubric: ${rubric.errors.join('; ')}`);
      return { pass: false, layers, reasons };
    }
    const authors = implAuthorsOf(job.id);
    if (!reviewer || authors.includes(reviewer)) {
      recordValidation(job.id, 'review', 'fail', result.review, 'reviewer not independent of implementer', reviewer);
      layers.push({ layer: 'review', pass: false });
      reasons.push('review not independent: reviewer authored the implementation it reviews');
      return { pass: false, layers, reasons };
    }
    const v = evaluateRubric(result.review, ctx.contract || {});
    recordValidation(job.id, 'review', v.pass ? 'pass' : 'fail', result.review, v.notes, reviewer);
    layers.push({ layer: 'review', pass: v.pass });
    if (!v.pass) reasons.push(`review: ${v.notes}`);
  }

  const pass = layers.every((l) => l.pass);
  return { pass, layers, reasons };
}

// Mechanical rubric check against the objective's quality thresholds (§12).
export function evaluateRubric(review, contract) {
  const q = contract.quality_thresholds || {};
  const dims = ['correctness', 'scope_control', 'maintainability', 'security', 'test_coverage'];
  const mean = dims.reduce((a, k) => a + (review[k] ?? 0), 0) / dims.length; // 0..5
  const normalized = mean / 5; // 0..1
  const minScore = q.implementation_review_score_min ?? 0.7;
  const minConfidence = q.confidence_min ?? 0.6;
  const confNorm = (review.confidence ?? 0) / 5;

  const problems = [];
  if (review.recommendation === 'reject') problems.push('reviewer recommends reject');
  if (review.recommendation === 'request_changes') problems.push('reviewer requests changes');
  if (normalized < minScore) problems.push(`quality ${normalized.toFixed(2)} < ${minScore}`);
  if (confNorm < minConfidence) problems.push(`confidence ${confNorm.toFixed(2)} < ${minConfidence}`);
  if ((review.objections || []).some((o) => o.severity === 'high')) problems.push('high-severity objection');

  return {
    pass: problems.length === 0,
    quality_score: Number(normalized.toFixed(2)),
    notes: problems.length ? problems.join('; ') : `quality ${normalized.toFixed(2)}, recommend ${review.recommendation}`,
  };
}
