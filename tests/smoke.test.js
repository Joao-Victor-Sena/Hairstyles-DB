// Testes que NÃO dependem de internet nem de conexão real com o Supabase.
process.env.SUPABASE_URL = '';
process.env.SUPABASE_ANON_KEY = '';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidCpf, isValidEmail, isValidPhone, validateRegistration,
  sanitizeProfileUpdate, validateProfileUpdate,
} = require('../src/validation');
const { app } = require('../src/server');

test('valida email e CPF no servidor', () => {
  assert.equal(isValidEmail('cliente@example.com'), true);
  assert.equal(isValidEmail('invalido'), false);
  assert.equal(isValidCpf('529.982.247-25'), true);
  assert.equal(isValidCpf('111.111.111-11'), false);
});

test('valida telefone brasileiro (DDD + celular ou fixo)', () => {
  assert.equal(isValidPhone('(81) 98765-4321'), true);
  assert.equal(isValidPhone('(81) 3333-4444'), true);
  assert.equal(isValidPhone('12345'), false);
  assert.equal(isValidPhone('(81) 88765-4321'), false);
});

const cadastro = (extra = {}) => ({
  name: 'Maria Silva', email: 'maria@example.com', phone: '(81) 98765-4321', birthDate: '1995-05-10',
  cpf: '529.982.247-25', password: 'senhaforte1', terms: 'on', ...extra,
});

test('cadastro: regras de entrada', () => {
  assert.equal(validateRegistration(cadastro()), null);
  assert.match(validateRegistration(cadastro({ name: 'Maria' })), /nome completo/);
  assert.match(validateRegistration(cadastro({ cpf: '111.111.111-11' })), /CPF/);
  assert.match(validateRegistration(cadastro({ password: '123' })), /senha/);
  assert.match(validateRegistration(cadastro({ terms: undefined })), /termos/);
  assert.match(validateRegistration(cadastro({ birthDate: '2999-01-01' })), /nascimento/);
});

test('cadastro: endereço é opcional, mas se informado deve estar completo', () => {
  assert.equal(validateRegistration(cadastro({ address: { cep: '', street: '' } })), null);
  assert.match(validateRegistration(cadastro({ address: { cep: '50000-000', street: 'Rua A' } })), /incompleto/);
  const completo = { cep: '50000-000', street: 'Rua A', number: '10', neighborhood: 'Centro', city: 'Recife', state: 'pe' };
  assert.equal(validateRegistration(cadastro({ address: completo })), null);
});

test('permite alterar apenas telefone e endereço no perfil', () => {
  const profile = sanitizeProfileUpdate({
    name: 'Nome', email: 'a@b.com', phone: '(11) 99999-8888', cpf: '111.111.111-11', birthDate: '2000-01-01',
    address: { cep: '01000-000', street: 'Rua A', number: '123' },
  });
  assert.deepEqual(profile, { phone: '(11) 99999-8888', address: { cep: '01000-000', street: 'Rua A', number: '123' } });
});

test('valida perfil com as mesmas regras de entrada do cadastro', () => {
  assert.equal(validateProfileUpdate({ phone: '(11) 99999-8888', birthDate: '2000-01-01', address: { cep: '01000-000', state: 'sp' } }), null);
  assert.match(validateProfileUpdate({ phone: '123', birthDate: '2000-01-01', address: {} }), /Telefone invalido/);
  assert.match(validateProfileUpdate({ phone: '(11) 99999-8888', birthDate: '2000-01-01', address: { cep: '123' } }), /CEP invalido/);
});

// ---- API (sem Supabase configurado) ----
let server; let base;
test.before(() => new Promise((resolve) => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); }); }));
test.after(() => server.close());
const call = (path, options) => fetch(base + path, options);
const post = (path, body) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('health responde ok', async () => {
  const response = await call('/api/health');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test('rotas autenticadas exigem token', async () => {
  for (const path of ['/api/me', '/api/bookings/history']) assert.equal((await call(path)).status, 401, path);
  assert.equal((await post('/api/bookings', { serviceIds: [], slotId: 'x' })).status, 401);
});

test('disponibilidade valida a data antes de consultar o banco', async () => {
  assert.equal((await call('/api/availability?date=ontem')).status, 400);
});

test('cadastro inválido é barrado antes de chegar ao banco', async () => {
  const response = await post('/api/auth/register', { name: 'x' });
  assert.equal(response.status, 400);
});

test('edição de perfil segue desabilitada', async () => {
  // sem token: 401; o 403 só ocorre com sessão válida (coberto na validação manual com Supabase)
  const response = await call('/api/me', { method: 'PUT' });
  assert.equal(response.status, 401);
});

test('sem Supabase configurado a API informa erro genérico, sem vazar detalhes', async () => {
  const response = await call('/api/services');
  assert.ok(response.status >= 500);
  const text = JSON.stringify(await response.json());
  assert.ok(!text.includes('node_modules') && !text.includes(' at '));
});

test('recuperação de senha mantém resposta genérica para e-mail inválido', async () => {
  const response = await post('/api/auth/recover', { email: 'invalido' });
  assert.equal(response.status, 200);
});

test('cabeçalhos de segurança e rota de API inexistente', async () => {
  const response = await call('/api/nada');
  assert.equal(response.status, 404);
  assert.ok(response.headers.get('x-content-type-options'));
  assert.equal(response.headers.get('x-powered-by'), null);
});
