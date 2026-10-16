'use strict';
// Uso: npm run db:check — confirma conexão, migrações aplicadas e fechamento das tabelas.
const env = require('../config/env');
const { getAnonClient, getAdminClient } = require('../config/supabase');

const ok = (m) => console.log(`  ✔ ${m}`);
const fail = (m) => { console.error(`  ✘ ${m}`); process.exitCode = 1; };

(async () => {
  console.log('Verificando Supabase…');
  if (!env.supabaseConfigured) { fail('Defina SUPABASE_URL e SUPABASE_PUBLISHABLE_KEY no arquivo .env (na raiz do projeto, não em config/)'); return; }
  const anon = getAnonClient();

  const info = await anon.from('v_salon_info').select('timezone').limit(1);
  info.error ? fail(`Conexão/views: ${info.error.message} (migrações aplicadas?)`) : ok(`Conectado (fuso: ${info.data[0]?.timezone})`);

  const serv = await anon.from('v_services').select('id', { count: 'exact', head: true });
  serv.error ? fail(`v_services: ${serv.error.message}`) : ok(`Catálogo público: ${serv.count} serviços`);

  const dia = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const slots = await anon.rpc('get_available_slots', { p_date: dia });
  slots.error ? fail(`get_available_slots: ${slots.error.message} (migração 3 aplicada?)`) : ok(`Horários em ${dia}: ${slots.data.map((s) => s.slot_time).join(', ') || 'nenhum'}`);

  const pop = await anon.rpc('get_popular_services', { p_limit: 3 });
  pop.error ? fail(`get_popular_services: ${pop.error.message}`) : ok(`Populares: ${pop.data.map((s) => s.name).join(', ')}`);

  // Ocultação estrutural: o acesso direto às tabelas precisa estar negado para a chave pública
  for (const tabela of ['profiles', 'bookings', 'services']) {
    const r = await anon.from(tabela).select('*').limit(1);
    r.error ? ok(`Tabela "${tabela}" fechada para a chave pública (${r.error.code})`) : fail(`Tabela "${tabela}" está ACESSÍVEL pela chave pública!`);
  }

  if (env.supabaseServiceRoleKey) {
    const r = await getAdminClient().from('services').select('id', { count: 'exact', head: true });
    r.error ? fail(`service_role: ${r.error.message}`) : ok(`service_role OK (${r.count} serviços na tabela)`);
  } else {
    console.log('  – SUPABASE_SECRET_KEY não definida: cadastro e redefinição de senha NÃO funcionarão até você preenchê-la.');
  }
})().catch((e) => { fail(e.message); });
