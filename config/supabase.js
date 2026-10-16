'use strict';
const { createClient } = require('@supabase/supabase-js');
const env = require('./env');

const baseOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

function requireConfig() {
  if (!env.supabaseConfigured) {
    const err = new Error('Supabase não configurado (defina SUPABASE_URL e SUPABASE_ANON_KEY no .env).');
    err.status = 503;
    err.expose = true;
    throw err;
  }
}

let anon;
/** Cliente anônimo: só enxerga as views/funções públicas (catálogo, horários). */
function getAnonClient() {
  requireConfig();
  if (!anon) anon = createClient(env.supabaseUrl, env.supabaseAnonKey, baseOptions);
  return anon;
}

/** Cliente "como o usuário": repassa o JWT, então auth.uid() e as views funcionam. */
function getUserClient(accessToken) {
  requireConfig();
  return createClient(env.supabaseUrl, env.supabaseAnonKey, {
    ...baseOptions,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

let admin;
/** Cliente administrativo (service_role). Ignora RLS: use só no servidor, em rotas de equipe. */
function getAdminClient() {
  requireConfig();
  if (!env.supabaseServiceRoleKey) {
    const err = new Error('SUPABASE_SERVICE_ROLE_KEY não configurada.');
    err.status = 503;
    throw err;
  }
  if (!admin) admin = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, baseOptions);
  return admin;
}

module.exports = { getAnonClient, getUserClient, getAdminClient };
