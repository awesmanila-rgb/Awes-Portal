// payroll-compute — computes a pay run with the payroll engine.
//
// CONTRACT: POST { runId }, caller's JWT.
//   → { ok:true, people, totalNet } | { error, code?, errors?:[{name, message}] }
//
// 1. Reads everything with payroll_run_inputs() AS THE CALLER, so the
//    database checks their access (Pay Runs › Edit) and the run's state.
// 2. Runs engine.ts for each person (../_shared/payroll/compute.ts).
// 3. Saves with payroll_run_store() using the service role. That function
//    can't be called by any app user, so nobody can type numbers into a
//    payslip. If anyone fails, nothing is saved.
//
// DEPLOY
//   supabase functions deploy payroll-compute
// (verify_jwt stays ON — default.)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { computeRun, type RunInputs } from '../_shared/payroll/compute.ts';

const ALLOWED_ORIGINS = ['https://awesmanila-rgb.github.io', 'http://localhost:8000', 'http://127.0.0.1:8000'];
function cors(origin: string | null) {
  return {
    'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

Deno.serve(async (req) => {
  const h = cors(req.headers.get('origin'));
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...h, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response('ok', { headers: h });
  if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return reply({ error: 'Sign in again.', code: 'no_auth' }, 401);

  let runId = '';
  try { runId = String((await req.json()).runId || ''); } catch { /* handled below */ }
  if (!/^[0-9a-f-]{36}$/i.test(runId)) return reply({ error: 'Missing pay run.' }, 400);

  const asUser = createClient(url, anon, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: me } = await asUser.auth.getUser();
  if (!me?.user) return reply({ error: 'Sign in again.', code: 'no_auth' }, 401);

  const { data: inputs, error: inErr } = await asUser.rpc('payroll_run_inputs', { p_run: runId });
  if (inErr) return reply({ error: inErr.message, code: inErr.code === '42501' ? 'forbidden' : 'inputs' }, inErr.code === '42501' ? 403 : 400);

  let outcome;
  try { outcome = computeRun(inputs as RunInputs); }
  catch (e) { return reply({ error: 'The payroll rules couldn\u2019t be read: ' + (e instanceof Error ? e.message : String(e)), code: 'rules' }, 400); }
  if (outcome.errors.length) {
    return reply({ error: outcome.errors.length + ' person(s) couldn\u2019t be computed \u2014 nothing was saved.', code: 'people', errors: outcome.errors }, 422);
  }

  const admin = createClient(url, service, { auth: { persistSession: false } });
  const lines = outcome.lines.map((l) => ({ profile_id: l.profile_id, input: l.input, result: l.result }));
  const { error: stErr } = await admin.rpc('payroll_run_store', { p_run: runId, p_lines: lines, p_rules: outcome.ruleIds, p_actor: me.user.id });
  if (stErr) return reply({ error: stErr.message, code: 'store' }, 400);

  const totalNet = outcome.lines.reduce((a, l) => a + l.result.totals.netPay, 0);
  return reply({ ok: true, people: lines.length, totalNet: Math.round(totalNet * 100) / 100 });
});
