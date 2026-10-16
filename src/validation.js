'use strict';

function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function isValidCpf(value) {
  const cpf = String(value || '').replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false;
  const digit = (length) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1)
      sum += Number(cpf[index]) * (length + 1 - index);
    const result = (sum * 10) % 11;
    return result === 10 ? 0 : result;
  };
  return digit(9) === Number(cpf[9]) && digit(10) === Number(cpf[10]);
}

const digits = (value) => String(value || '').replace(/\D/g, '');
// DDD (11-99) + celular (9 dígitos, começando em 9) ou fixo (8 dígitos, começando em 2-5)
const isValidPhone = (value) => /^[1-9][1-9](9\d{8}|[2-5]\d{7})$/.test(digits(value));

function isValidBirthDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00`);
  const oldest = new Date();
  oldest.setFullYear(oldest.getFullYear() - 120);
  return !Number.isNaN(date.getTime()) && date <= new Date() && date >= oldest;
}

const ADDRESS_LIMITS = { cep: 9, street: 120, number: 10, complement: 60, neighborhood: 80, city: 80, state: 2 };

/** Limpa o endereço enviado pelo navegador. Retorna null quando nada foi preenchido. */
function normalizeAddress(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const address = {};
  for (const key of Object.keys(ADDRESS_LIMITS)) {
    const value = String(raw[key] || '').trim();
    if (value) address[key] = key === 'state' ? value.toUpperCase() : value;
  }
  return Object.keys(address).length ? address : null;
}

/** Endereço é opcional, mas se informado precisa estar completo (complemento é opcional). */
function validateAddress(address) {
  if (!address) return null;
  for (const [key, max] of Object.entries(ADDRESS_LIMITS))
    if ((address[key] || '').length > max) return `O campo ${key} excede o limite de ${max} caracteres.`;
  if (address.cep && digits(address.cep).length !== 8) return 'CEP invalido. Use 8 digitos.';
  if (address.state && !/^[A-Z]{2}$/.test(address.state)) return 'Estado invalido. Use 2 letras.';
  const required = ['cep', 'street', 'number', 'neighborhood', 'city', 'state'];
  if (required.some((key) => !address[key]))
    return 'Endereco incompleto: preencha CEP, rua, numero, bairro, cidade e estado, ou deixe tudo em branco.';
  return null;
}

/** Valida o cadastro (as mesmas regras também são garantidas pelo banco). Retorna mensagem de erro ou null. */
function validateRegistration(body = {}) {
  const name = String(body.name || '').trim();
  if (name.length < 5 || name.length > 120 || !/\S+\s+\S+/.test(name) || /[0-9<>{}\\/@;"=]/.test(name))
    return 'Informe seu nome completo.';
  if (!isValidEmail(body.email) || String(body.email).length > 120) return 'E-mail invalido.';
  if (!isValidPhone(body.phone)) return 'Telefone invalido. Use DDD + numero.';
  if (!isValidBirthDate(body.birthDate)) return 'Data de nascimento invalida.';
  if (!isValidCpf(body.cpf)) return 'CPF invalido.';
  if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 72)
    return 'A senha deve ter entre 8 e 72 caracteres.';
  if (!body.terms) return 'E necessario aceitar os termos de uso.';
  return validateAddress(normalizeAddress(body.address));
}

// A edição de perfil está desabilitada no servidor, mas as regras continuam disponíveis.
function sanitizeProfileUpdate(payload = {}) {
  const rawPhone = String(payload.phone || '').trim();
  const phone = digits(rawPhone).length >= 10 ? rawPhone : undefined;
  return { phone: phone || undefined, address: normalizeAddress(payload.address) || {} };
}

function validateProfileUpdate(payload = {}) {
  const phone = String(payload.phone || '').trim();
  if (!/^.{10,15}$/.test(phone) || ![10, 11].includes(digits(phone).length))
    return 'Telefone invalido. Use um telefone com 10 ou 11 digitos.';
  if (!isValidBirthDate(payload.birthDate)) return 'Data de nascimento invalida.';
  const address = payload.address && typeof payload.address === 'object' ? payload.address : {};
  for (const [key, max] of Object.entries(ADDRESS_LIMITS))
    if (String(address[key] || '').trim().length > max) return `O campo ${key} excede o limite de ${max} caracteres.`;
  if (digits(address.cep) && digits(address.cep).length !== 8) return 'CEP invalido. Use 8 digitos.';
  if (address.state && !/^[a-z]{2}$/i.test(String(address.state).trim())) return 'Estado invalido. Use 2 letras.';
  return null;
}

module.exports = {
  isValidCpf, isValidEmail, isValidPhone, isValidBirthDate,
  normalizeAddress, validateAddress, validateRegistration,
  sanitizeProfileUpdate, validateProfileUpdate, digits,
};
