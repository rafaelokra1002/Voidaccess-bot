const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const API_URL = process.env.OKRA_API_URL;
const LOGIN_URL = process.env.OKRA_LOGIN_URL;
const OKRA_USER = process.env.OKRA_USERNAME;
const OKRA_PASS = process.env.OKRA_PASSWORD;

function getOkraConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config.json'), 'utf-8'));
  return cfg.okra || {};
}

function generateCode(length) {
  return crypto.randomInt(10 ** (length - 1), 10 ** length).toString();
}

// Faz login no painel e retorna o cookie de sessão
async function login() {
  const response = await axios.get(LOGIN_URL, {
    params: { login: 1, username: OKRA_USER, password: OKRA_PASS },
  });

  const cookies = response.headers['set-cookie'];
  if (!cookies) throw new Error('Falha ao obter sessão do Okra');

  const sessionCookie = cookies.find(c => c.startsWith('PHPSESSID'));
  return sessionCookie.split(';')[0];
}

// Cria usuário de teste no Okra TV (Android / TV Box)
async function createTest(name) {
  const username = generateCode(6);
  const password = generateCode(6);

  try {
    const cookie = await login();
    console.log('[OKRA] Login OK, cookie obtido');

    const okraCfg = getOkraConfig();
    const params = new URLSearchParams();
    params.append('confirme_adicionar_testes', '');
    params.append('name', name || '');
    params.append('usuario', username);
    params.append('senha', password);
    params.append('tempo', okraCfg.testDuration || '3');
    params.append('adulto', okraCfg.adulto || '0');
    params.append('plano', okraCfg.plano || '56');
    params.append('dispositivo', 'app');
    params.append('forma-de-pagamento', 'PIX');
    params.append('nome-do-pagador', 'whatsapp');
    params.append('indicacao', '');

    const response = await axios.post(API_URL, params, {
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    console.log('[OKRA] Resposta:', JSON.stringify(response.data));
    console.log('[OKRA] Teste criado - User:', username, 'Pass:', password);

    return { username, password };
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    throw new Error(`Erro ao criar teste Okra: ${message}`);
  }
}

module.exports = { createTest };