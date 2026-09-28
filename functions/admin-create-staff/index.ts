// admin-create-staff — creates and manages department staff logins.
//
// WHO CAN CALL WHAT
//   Super Admin (profiles.role = 'admin'): every action, for any staff user.
//   Department Head (staff, is_head in some department, no supervisor):
//     create / update_access / update_profile / change_username /
//     reset_password / deactivate / reactivate — ONLY for their own
//     sub-users, and only within their own access (the database refuses
//     anything above it; see 20260926_01_departments_access.sql).
//   Any active staff user (and the Super Admin): reauth.
//
// SIGN-IN
//   Staff sign in with a username. Supabase Auth needs an email, so each
//   username maps to a fixed internal address:
//       <username>@staff.awes-app.local
//   That address never receives mail and is never shown in the app, and no
//   public roster of staff usernames exists (unlike technicians, whose
//   sign-in screen looks usernames up through list-technicians).
//
// CONTRACT — every call: POST, JSON body with `action`, caller's JWT.
//   create          { username, name, position?, password, supervisorId?,
//                     departments:[{id,is_head}], access:[{module,level,approve_limit?,expires_at?}] }
//                   → { id, username }
//   update_access   { userId, departments, access }        → { id, departments, access }
//   update_profile  { userId, name?, position? }           → { id }
//   change_username { userId, username }                   → { id, username }
//   reset_password  { userId, password }                   → { id }
//   set_supervisor  { userId, supervisorId|null }  (Super Admin only) → { id }
//   deactivate      { userId, subUsers?: 'deactivate'|'reassign', reassignTo? }
//                   → { id, subUsers:[ids] }   (a Head with active sub-users
//                     must say what happens to them, else error code has_sub_users)
//   reactivate      { userId }                             → { id }
//   reauth          { password }                           → { ok:true, validForMinutes:5 }
//   Errors: { error: 'readable message', code?: 'machine_code' } — never a
//   raw Postgres error object.
//
// Every change is written to activity_log with the caller as the actor.
//
// DEPLOY
//   supabase functions deploy admin-create-staff
// (verify_jwt stays ON — default.)

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const STAFF_EMAIL_DOMAIN = 'staff.awes-app.local';
const MIN_PASSWORD = 6;
const REAUTH_MINUTES = 5;
const BAN_FOREVER = '876000h';   // ~100 years; Supabase has no "permanent" ban value

const ALLOWED_ORIGINS = [
  'https://awesmanila-rgb.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000'
];

function corsHeaders(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin'
  };
}

class HttpError extends Error {
  status: number; code?: string; extra?: Record<string, unknown>;
  constructor(status: number, message: string, code?: string, extra?: Record<string, unknown>) {
    super(message); this.status = status; this.code = code; this.extra = extra;
  }
}

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;
function normUsername(u: unknown): string {
  const s = String(u ?? '').trim().toLowerCase();
  if (!USERNAME_RE.test(s)) {
    throw new HttpError(400, 'Username must be 3–30 characters: letters, numbers, dot, dash or underscore, starting with a letter or number.', 'bad_username');
  }
  return s;
}
const staffEmail = (username: string) => `${username}@${STAFF_EMAIL_DOMAIN}`;

// Case-insensitive "is this username used by anyone else?" ('_' is a LIKE
// wildcard, so it is escaped; technicians and staff share one namespace).
async function usernameTaken(admin: SupabaseClient, username: string, exceptId?: string): Promise<boolean> {
  let q = admin.from('profiles').select('id').ilike('username', username.replace(/[\\%_]/g, (c) => '\\' + c)).limit(1);
  if (exceptId) q = q.neq('id', exceptId);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).length > 0;
}

function checkPassword(p: unknown): string {
  const s = String(p ?? '');
  if (s.length < MIN_PASSWORD) throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters.`, 'bad_password');
  return s;
}

// Turn database exceptions (ceiling rule etc.) into readable messages.
function dbError(e: unknown): HttpError {
  const msg = (e && typeof e === 'object' && 'message' in e) ? String((e as { message: unknown }).message) : String(e);
  if (/duplicate key|profiles_username_unique_ci/i.test(msg)) return new HttpError(409, 'That username is already taken.', 'username_taken');
  return new HttpError(400, msg.replace(/^ERROR:\s*/i, ''), 'rejected');
}

type Profile = {
  id: string; name: string | null; role: string | null; active: boolean;
  username: string | null; supervisor_id: string | null; position: string | null;
};

type Caller = {
  id: string; email: string; profile: Profile;
  isSuper: boolean; isHead: boolean; headDepartments: string[];
};

async function loadCaller(admin: SupabaseClient, authHeader: string): Promise<Caller> {
  const callerClient = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } }
  );
  const { data, error } = await callerClient.auth.getUser();
  if (error || !data?.user) throw new HttpError(401, 'Please sign in again.', 'no_session');

  const { data: prof, error: pErr } = await admin.from('profiles')
    .select('id, name, role, active, username, supervisor_id, position').eq('id', data.user.id).maybeSingle();
  if (pErr || !prof) throw new HttpError(403, 'Account not found.', 'no_profile');
  if (!prof.active) throw new HttpError(403, 'This account is deactivated.', 'inactive');

  const { data: deps } = await admin.from('staff_departments')
    .select('department_id, is_head').eq('user_id', prof.id);
  const headDepartments = (deps || []).filter((d) => d.is_head).map((d) => d.department_id as string);

  return {
    id: prof.id, email: data.user.email || '', profile: prof as Profile,
    isSuper: prof.role === 'admin',
    isHead: prof.role === 'staff' && !prof.supervisor_id && headDepartments.length > 0,
    headDepartments
  };
}

async function loadStaff(admin: SupabaseClient, id: unknown): Promise<Profile> {
  if (!id || typeof id !== 'string') throw new HttpError(400, 'userId is required.', 'bad_request');
  const { data, error } = await admin.from('profiles')
    .select('id, name, role, active, username, supervisor_id, position').eq('id', id).maybeSingle();
  if (error || !data || data.role !== 'staff') throw new HttpError(404, 'Staff account not found.', 'not_found');
  return data as Profile;
}

// Super Admin: anyone. Head: only their own sub-users.
function assertCanManage(caller: Caller, target: Profile) {
  if (caller.isSuper) return;
  if (caller.isHead && target.supervisor_id === caller.id) return;
  throw new HttpError(403, 'You can only manage your own sub-users.', 'forbidden');
}

// A Head may only place sub-users in departments they head, never as Head.
function headDepartmentsFilter(caller: Caller, departments: unknown) {
  const list = Array.isArray(departments) ? departments : [];
  if (caller.isSuper) return list;
  for (const d of list) {
    if (d?.is_head) throw new HttpError(403, 'Sub-users cannot be department Heads.', 'forbidden');
    if (!caller.headDepartments.includes(d?.id)) throw new HttpError(403, 'You can only add sub-users to departments you head.', 'forbidden');
  }
  return list.map((d) => ({ id: d.id, is_head: false }));
}

async function log(admin: SupabaseClient, actor: string, action: string, targetId: string, label: string, details: Record<string, unknown> = {}) {
  await admin.rpc('log_activity_as', {
    p_actor: actor, p_action: action, p_entity_type: 'staff',
    p_entity_id: targetId, p_label: label, p_details: details
  });
}

async function applyAccess(admin: SupabaseClient, userId: string, departments: unknown, access: unknown, actor: string) {
  const { data, error } = await admin.rpc('staff_apply_access', {
    p_user: userId,
    p_departments: Array.isArray(departments) ? departments : [],
    p_access: Array.isArray(access) ? access : [],
    p_actor: actor
  });
  if (error) throw dbError(error);
  return data;
}

async function setBanned(admin: SupabaseClient, userId: string, banned: boolean) {
  const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: banned ? BAN_FOREVER : 'none' });
  if (error) throw error;
}

async function deactivateOne(admin: SupabaseClient, userId: string, actor: string) {
  await setBanned(admin, userId, true);
  const { error } = await admin.from('profiles')
    .update({ active: false, deactivated_at: new Date().toISOString(), deactivated_by: actor }).eq('id', userId);
  if (error) { await setBanned(admin, userId, false).catch(() => {}); throw dbError(error); }
  // Stop pushes to their devices; best-effort.
  await admin.from('push_subscriptions').delete().eq('user_id', userId).then(() => {}, () => {});
}

// ---------------------------------------------------------------------

async function handle(req: Request): Promise<Record<string, unknown>> {
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } }
  );
  const caller = await loadCaller(admin, req.headers.get('authorization') || '');
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || 'create');

  // ---- reauth: any active staff user, or the Super Admin -------------
  if (action === 'reauth') {
    if (!caller.isSuper && caller.profile.role !== 'staff') throw new HttpError(403, 'Not a staff account.', 'forbidden');
    const pw = String(body.password || '');
    if (!pw) throw new HttpError(400, 'Enter your password.', 'bad_password');
    const probe = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
                               { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await probe.auth.signInWithPassword({ email: caller.email, password: pw });
    if (error || data?.user?.id !== caller.id) {
      await log(admin, caller.id, 'staff.reauth_failed', caller.id, caller.profile.username || caller.profile.name || '');
      throw new HttpError(401, 'Incorrect password.', 'wrong_password');
    }
    // Discard ONLY this extra check session. The default scope is 'global',
    // which would sign the user out on every device — never do that
    // (all logouts in AWES are manual).
    await probe.auth.signOut({ scope: 'local' }).catch(() => {});
    const { error: rErr } = await admin.rpc('staff_record_reauth', { p_user: caller.id });
    if (rErr) throw dbError(rErr);
    return { ok: true, validForMinutes: REAUTH_MINUTES };
  }

  if (!caller.isSuper && !caller.isHead) throw new HttpError(403, 'Only the Super Admin or a department Head can manage staff.', 'forbidden');

  // ---- create ---------------------------------------------------------
  if (action === 'create') {
    const username = normUsername(body.username);
    const password = checkPassword(body.password);
    const name = String(body.name || '').trim();
    if (!name) throw new HttpError(400, 'Full name is required.', 'bad_request');
    const position = String(body.position || '').trim();

    let supervisorId: string | null = null;
    if (caller.isSuper) supervisorId = body.supervisorId ? String(body.supervisorId) : null;
    else supervisorId = caller.id;             // a Head's new user is always their own sub-user
    const departments = headDepartmentsFilter(caller, body.departments);
    if (supervisorId && departments.some((d: { is_head?: boolean }) => d?.is_head)) {
      throw new HttpError(400, 'A sub-user cannot be a department Head.', 'bad_request');
    }

    if (await usernameTaken(admin, username)) throw new HttpError(409, 'That username is already taken.', 'username_taken');

    const { data: created, error: cErr } = await admin.auth.admin.createUser({
      email: staffEmail(username), password, email_confirm: true,
      user_metadata: { role: 'staff', username }
    });
    if (cErr || !created?.user) {
      if (/already/i.test(cErr?.message || '')) throw new HttpError(409, 'That username is already taken.', 'username_taken');
      throw cErr || new Error('Could not create the account.');
    }
    const newId = created.user.id;

    try {
      const { error: pErr } = await admin.from('profiles').insert({
        id: newId, name, role: 'staff', username, position,
        supervisor_id: supervisorId, created_by: caller.id,
        must_change_password: true, active: true
      });
      if (pErr) throw dbError(pErr);
      const applied = await applyAccess(admin, newId, departments, body.access, caller.id);
      await log(admin, caller.id, 'staff.create', newId, username, { name, position, supervisor_id: supervisorId, ...applied });
    } catch (e) {
      // Undo everything so a half-made account never lingers.
      await admin.from('profiles').delete().eq('id', newId).then(() => {}, () => {});
      await admin.auth.admin.deleteUser(newId).catch(() => {});
      throw e;
    }
    return { id: newId, username };
  }

  const target = await loadStaff(admin, body.userId);
  const label = target.username || target.name || '';

  // ---- set_supervisor (Super Admin only) -----------------------------
  if (action === 'set_supervisor') {
    if (!caller.isSuper) throw new HttpError(403, 'Only the Super Admin can move users between Heads.', 'forbidden');
    const supervisorId = body.supervisorId ? String(body.supervisorId) : null;
    const { error } = await admin.from('profiles').update({ supervisor_id: supervisorId }).eq('id', target.id);
    if (error) throw dbError(error);   // trigger enforces one level; access is clamped to the new Head
    await log(admin, caller.id, 'staff.set_supervisor', target.id, label, { from: target.supervisor_id, to: supervisorId });
    return { id: target.id };
  }

  assertCanManage(caller, target);

  switch (action) {
    case 'update_access': {
      const departments = headDepartmentsFilter(caller, body.departments);
      const applied = await applyAccess(admin, target.id, departments, body.access, caller.id);
      // Access changed by hand → no longer kept in sync with a role template
      // (Round 2, 20260927_01). Harmless if that migration isn't installed.
      await admin.from('staff_template_links').delete().eq('user_id', target.id).then(() => {}, () => {});
      await log(admin, caller.id, 'staff.update_access', target.id, label, applied as Record<string, unknown>);
      return { id: target.id, ...(applied as Record<string, unknown>) };
    }

    case 'update_profile': {
      const patch: Record<string, string> = {};
      if (body.name !== undefined) {
        const n = String(body.name).trim();
        if (!n) throw new HttpError(400, 'Full name cannot be empty.', 'bad_request');
        patch.name = n;
      }
      if (body.position !== undefined) patch.position = String(body.position).trim();
      if (!Object.keys(patch).length) return { id: target.id };
      const { error } = await admin.from('profiles').update(patch).eq('id', target.id);
      if (error) throw dbError(error);
      await log(admin, caller.id, 'staff.update_profile', target.id, label, patch);
      return { id: target.id };
    }

    case 'change_username': {
      const username = normUsername(body.username);
      if (username === (target.username || '').toLowerCase()) return { id: target.id, username };
      if (await usernameTaken(admin, username, target.id)) throw new HttpError(409, 'That username is already taken.', 'username_taken');
      const { error: aErr } = await admin.auth.admin.updateUserById(target.id, { email: staffEmail(username), email_confirm: true });
      if (aErr) throw aErr;
      const { error } = await admin.from('profiles').update({ username }).eq('id', target.id);
      if (error) {
        await admin.auth.admin.updateUserById(target.id, { email: staffEmail(target.username || username), email_confirm: true }).catch(() => {});
        throw dbError(error);
      }
      await log(admin, caller.id, 'staff.change_username', target.id, username, { from: target.username, to: username });
      return { id: target.id, username };
    }

    case 'reset_password': {
      const password = checkPassword(body.password);
      const { error } = await admin.auth.admin.updateUserById(target.id, { password });
      if (error) throw error;
      await admin.from('profiles').update({ must_change_password: true }).eq('id', target.id);
      await log(admin, caller.id, 'staff.reset_password', target.id, label);
      return { id: target.id };
    }

    case 'deactivate': {
      if (target.id === caller.id) throw new HttpError(400, 'You cannot deactivate your own account.', 'bad_request');
      const { data: subs } = await admin.from('profiles').select('id').eq('supervisor_id', target.id).eq('active', true);
      const subIds = (subs || []).map((s) => s.id as string);

      if (subIds.length) {
        const mode = body.subUsers;
        if (mode === 'reassign') {
          if (!caller.isSuper) throw new HttpError(403, 'Only the Super Admin can move users between Heads.', 'forbidden');
          if (!body.reassignTo) throw new HttpError(400, 'Choose the Head to move the sub-users to.', 'bad_request');
          const { error } = await admin.from('profiles').update({ supervisor_id: String(body.reassignTo) }).in('id', subIds);
          if (error) throw dbError(error);
        } else if (mode === 'deactivate') {
          for (const id of subIds) await deactivateOne(admin, id, caller.id);
        } else {
          throw new HttpError(409, `This Head has ${subIds.length} active sub-user${subIds.length === 1 ? '' : 's'}. Choose whether to move them to another Head or deactivate them too.`,
                              'has_sub_users', { subUsers: subIds });
        }
      }
      await deactivateOne(admin, target.id, caller.id);
      await log(admin, caller.id, 'staff.deactivate', target.id, label,
                { sub_users: subIds, sub_users_mode: subIds.length ? body.subUsers : null, reassign_to: body.reassignTo || null });
      return { id: target.id, subUsers: subIds };
    }

    case 'reactivate': {
      if (target.supervisor_id) {
        const { data: sup } = await admin.from('profiles').select('active').eq('id', target.supervisor_id).maybeSingle();
        if (!sup?.active) throw new HttpError(409, 'This user\u2019s Head is deactivated. Move them to an active Head first.', 'supervisor_inactive');
      }
      await setBanned(admin, target.id, false);
      const { error } = await admin.from('profiles')
        .update({ active: true, deactivated_at: null, deactivated_by: null }).eq('id', target.id);
      if (error) throw dbError(error);
      await log(admin, caller.id, 'staff.reactivate', target.id, label);
      return { id: target.id };
    }
  }

  throw new HttpError(400, `Unknown action: ${action}`, 'bad_request');
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get('origin'));
  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    return json(await handle(req));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code, ...(e.extra || {}) }, e.status);
    console.error('admin-create-staff:', e);
    const msg = (e && typeof e === 'object' && 'message' in e) ? String((e as { message: unknown }).message) : 'Unexpected error';
    return json({ error: msg, code: 'server_error' }, 500);
  }
});
