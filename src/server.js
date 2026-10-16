'use strict';
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const env = require('../config/env');
const { getAnonClient, getUserClient, getAdminClient } = require('../config/supabase');
const {
  isValidEmail, validateRegistration, normalizeAddress, digits,
  sanitizeProfileUpdate, validateProfileUpdate,
} = require('./validation');

const app = express();
app.set('trust proxy', 1); // Vercel / balanceadores de carga
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '20kb' }));

const limiterOptions = { standardHeaders: true, legacyHeaders: false };
app.use('/api', rateLimit({ ...limiterOptions, windowMs: 15 * 60 * 1000, limit: 120,
  message: { error: 'Muitas requisicoes. Tente novamente em alguns minutos.' } }));
app.use('/api/auth', rateLimit({ ...limiterOptions, windowMs: 15 * 60 * 1000, limit: 30,
  message: { error: 'Muitas tentativas. Aguarde alguns minutos.' } }));

// Em desenvolvimento o Express serve o site; na Vercel os arquivos de assets/ saem direto da CDN.
app.use(express.static(path.join(__dirname, '..', 'assets')));

// ---------------------------------------------------------------- utilidades
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  return error;
}

/** Traduz erros do Postgres/Supabase em respostas seguras (sem SQL nem stack trace). */
function fromSupabase(error) {
  const known = {
    P0001: [422, null],                                   // RAISE EXCEPTION das nossas funções (mensagem já amigável)
    28000: [401, 'Autenticacao necessaria.'],
    23514: [422, 'Alguns dados informados sao invalidos.'], // check_violation
    23505: [409, 'Este registro ja existe.'],               // unique_violation
    42501: [403, 'Acesso negado.'],
  }[error.code];
  if (!known) {
    const unexpected = new Error(error.message);
    unexpected.status = 500;
    return unexpected;
  }
  return httpError(known[0], known[1] || error.message);
}

/** Desembrulha respostas do supabase-js: lança se houver erro. */
function unwrap({ data, error }) {
  if (error) throw fromSupabase(error);
  return data;
}

async function auth(req, res, next) {
  try {
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    if (!match) throw httpError(401, 'Autenticacao necessaria.');
    const client = getUserClient(match[1]);
    const { data, error } = await client.auth.getUser(match[1]);
    if (error || !data?.user) throw httpError(401, 'Autenticacao necessaria.');
    req.user = { id: data.user.id, email: data.user.email };
    req.db = client; // consultas seguintes rodam com a identidade do usuário (auth.uid())
    next();
  } catch (error) {
    next(error);
  }
}

const dateOk = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

function publicProfile(row, email) {
  const address = {};
  const map = { cep: row.zip_code, street: row.street, number: row.number, complement: row.complement,
    neighborhood: row.neighborhood, city: row.city, state: row.state };
  Object.entries(map).forEach(([key, value]) => { if (value) address[key] = value; });
  return {
    id: row.id, name: row.full_name, email, phone: row.phone, birthDate: row.birth_date,
    cpf: row.cpf_masked, // o CPF completo nunca sai do banco (view v_my_profile)
    address,
  };
}

// ---------------------------------------------------------------- catálogo
app.get('/api/health', (_req, res) => res.json({ ok: true, supabase: env.supabaseConfigured }));

app.get('/api/health/db', wrap(async (_req, res) => {
  unwrap(await getAnonClient().from('v_salon_info').select('timezone').limit(1));
  res.json({ ok: true });
}));

app.get('/api/services', wrap(async (_req, res) => {
  const rows = unwrap(await getAnonClient().from('v_services').select('*').order('sort_order'));
  res.json({
    services: rows.map((s) => ({
      id: s.id, name: s.name, description: s.description,
      price_cents: s.price_cents, price_note: s.price_note, popular: s.is_featured ? 1 : 0,
    })),
  });
}));

app.get('/api/services/popular', wrap(async (_req, res) => {
  const rows = unwrap(await getAnonClient().rpc('get_popular_services', { p_limit: 3 }));
  res.json({ services: rows.map(({ id, name, description, price_note }) => ({ id, name, description, price_note })) });
}));

app.get('/api/availability', wrap(async (req, res) => {
  const date = String(req.query.date || '');
  if (!dateOk(date)) throw httpError(400, 'Data invalida.');
  const rows = unwrap(await getAnonClient().rpc('get_available_slots', { p_date: date }));
  // o id do horário é o próprio instante (ISO); create_booking revalida tudo no banco
  res.json({ date, slots: rows.map((r) => ({ id: r.slot_start, time: r.slot_time })) });
}));

// ---------------------------------------------------------------- autenticação (Supabase Auth)
app.post('/api/auth/register', wrap(async (req, res) => {
  const body = req.body || {};
  const invalid = validateRegistration(body);
  if (invalid) throw httpError(400, invalid);

  const admin = getAdminClient();
  const email = body.email.trim().toLowerCase();
  const name = body.name.trim();
  const cpf = digits(body.cpf);
  const address = normalizeAddress(body.address);

  const existing = unwrap(await admin.from('profiles').select('id').eq('cpf', cpf).limit(1));
  if (existing.length) throw httpError(409, 'E-mail ou CPF ja cadastrado.');

  // O trigger handle_new_user cria o perfil e o banco revalida nome, telefone, CPF e termos.
  const created = await admin.auth.admin.createUser({
    email, password: body.password, email_confirm: true,
    user_metadata: { full_name: name, phone: digits(body.phone), birth_date: body.birthDate, cpf, terms_accepted: 'true' },
  });
  if (created.error) {
    if (/already|registered|exists/i.test(created.error.message)) throw httpError(409, 'E-mail ou CPF ja cadastrado.');
    if (created.error.status && created.error.status < 500) throw httpError(400, 'Confira os campos obrigatorios.');
    throw created.error;
  }
  const user = created.data.user;

  if (address) {
    const saved = await admin.from('client_addresses').insert({
      user_id: user.id, zip_code: digits(address.cep), street: address.street, number: address.number,
      complement: address.complement || null, neighborhood: address.neighborhood, city: address.city, state: address.state,
    });
    if (saved.error) {
      await admin.auth.admin.deleteUser(user.id); // não deixa cadastro pela metade
      throw fromSupabase(saved.error);
    }
  }
  res.status(201).json({ user: { id: user.id, name, email } });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) throw httpError(401, 'E-mail ou senha invalidos.');
  const { data, error } = await getAnonClient().auth.signInWithPassword({ email, password });
  if (error || !data?.session) throw httpError(401, 'E-mail ou senha invalidos.');

  const token = data.session.access_token;
  const [profile] = unwrap(await getUserClient(token).from('v_my_profile').select('id, full_name, phone'));
  res.json({ token, user: { id: data.user.id, name: profile?.full_name, email: data.user.email, phone: profile?.phone } });
}));

const RECOVER_MESSAGE = 'Se o e-mail estiver cadastrado, enviaremos um link para redefinir a senha.';
app.post('/api/auth/recover', wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) return res.json({ message: RECOVER_MESSAGE }); // resposta genérica
  const site = env.siteUrl || `${req.protocol}://${req.get('host')}`;
  const { error } = await getAnonClient().auth.resetPasswordForEmail(email, { redirectTo: `${site}/redefinir-senha.html` });
  if (error) {
    console.error('Erro ao enviar recuperacao:', error.message);
    throw httpError(503, 'Nao foi possivel enviar o e-mail agora. Tente novamente mais tarde.');
  }
  res.json({ message: RECOVER_MESSAGE });
}));

// Etapa final da recuperação: o link do e-mail traz um token temporário (access_token)
app.post('/api/auth/reset', wrap(async (req, res) => {
  const { accessToken, password } = req.body || {};
  if (typeof password !== 'string' || password.length < 8 || password.length > 72)
    throw httpError(400, 'A senha deve ter entre 8 e 72 caracteres.');
  if (typeof accessToken !== 'string' || accessToken.length < 20)
    throw httpError(401, 'Link invalido ou expirado. Solicite uma nova recuperacao.');
  const { data, error } = await getAnonClient().auth.getUser(accessToken);
  if (error || !data?.user) throw httpError(401, 'Link invalido ou expirado. Solicite uma nova recuperacao.');
  const updated = await getAdminClient().auth.admin.updateUserById(data.user.id, { password });
  if (updated.error) throw httpError(400, 'Nao foi possivel alterar a senha. Escolha outra senha.');
  res.json({ message: 'Senha alterada. Voce ja pode entrar.' });
}));

// ---------------------------------------------------------------- perfil
app.get('/api/me', auth, wrap(async (req, res) => {
  const [row] = unwrap(await req.db.from('v_my_profile').select('*'));
  if (!row) throw httpError(404, 'Usuario nao encontrado.');
  res.json({ user: publicProfile(row, req.user.email) });
}));

app.put('/api/me', auth, (_req, res) =>
  res.status(403).json({ error: 'A edicao dos dados cadastrais esta desabilitada.' }));

// ---------------------------------------------------------------- agendamentos
app.post('/api/bookings', auth, wrap(async (req, res) => {
  const requested = Array.isArray(req.body?.serviceIds) ? req.body.serviceIds : [req.body?.serviceId];
  const serviceIds = [...new Set(requested.map(String))];
  const slotId = String(req.body?.slotId || '');
  if (!serviceIds.length || serviceIds.length > 15 || !serviceIds.every((id) => UUID.test(id)) || Number.isNaN(Date.parse(slotId)))
    throw httpError(400, 'Selecione pelo menos um servico e um horario disponivel.');

  // Total e validações são feitos dentro do banco; o preço nunca vem do navegador.
  // Confirmar na etapa 3 equivale a aceitar os avisos exibidos (teste de mechas e valores sujeitos a alteração).
  const bookingId = unwrap(await req.db.rpc('create_booking', {
    p_service_ids: serviceIds, p_starts_at: new Date(slotId).toISOString(), p_notes: null, p_disclaimers_accepted: true,
  }));
  const [booking] = unwrap(await req.db.from('v_my_bookings').select('id, total_cents').eq('id', bookingId));
  res.status(201).json({ bookingId, totalCents: booking.total_cents, serviceIds });
}));

app.get('/api/bookings/history', auth, wrap(async (req, res) => {
  const rows = unwrap(await req.db.from('v_my_bookings').select('*').neq('status', 'cancelled'));
  const now = Date.now();
  const bookings = rows
    .map((b) => ({
      id: b.id, total_cents: b.total_cents, date: b.local_date, time: b.local_time, starts_at: b.starts_at,
      status: Date.parse(b.starts_at) >= now ? 'upcoming' : 'completed',
      services: b.services.map((s) => ({ id: s.service_id, name: s.name, price_cents: s.price_cents })),
    }))
    .sort((a, b) => b.starts_at.localeCompare(a.starts_at));
  res.json({
    upcoming: bookings.filter((b) => b.status === 'upcoming'),
    completed: bookings.filter((b) => b.status === 'completed'),
  });
}));

// ---------------------------------------------------------------- páginas e erros
app.get('/agendamento.html', (_req, res) => res.redirect(301, '/servicos.html'));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Rota nao encontrada.' }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'assets', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  if (status >= 500) console.error('Erro do servidor:', error.message);
  const message = status < 500 && error.expose ? error.message : 'Erro interno do servidor. Tente novamente em instantes.';
  res.status(status).json({ error: message });
});

if (require.main === module) {
  if (!env.supabaseConfigured) console.warn('[aviso] Defina SUPABASE_URL e SUPABASE_ANON_KEY no .env (veja config/env.example).');
  app.listen(env.port, () => console.log(`Hairstyles em http://localhost:${env.port}`));
}
module.exports = { app, sanitizeProfileUpdate, validateProfileUpdate };
