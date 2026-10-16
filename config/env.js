'use strict';
require('dotenv').config();

const env = {
  isProd: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT) || 3000,
  siteUrl: (process.env.SITE_URL || '').replace(/\/+$/, ''),
  supabaseUrl: process.env.SUPABASE_URL || '',
  // aceita os nomes novos (PUBLISHABLE/SECRET) e os antigos (ANON/SERVICE_ROLE)
  supabaseAnonKey: process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '',
  supabaseServiceRoleKey: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
};
env.supabaseConfigured = Boolean(env.supabaseUrl && env.supabaseAnonKey);

module.exports = env;
