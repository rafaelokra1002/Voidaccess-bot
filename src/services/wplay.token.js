const axios = require('axios');

const LOGIN_URL = 'https://mcapi.knewcms.com:2087/auth/login';
let cachedToken = null;
let tokenExp = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExp) {
    return cachedToken;
  }

  console.log('[WPLAY] Fazendo login para renovar token...');
  const response = await axios.post(LOGIN_URL, {
    username: process.env.WPLAY_USERNAME,
    password: process.env.WPLAY_PASSWORD,
  });

  cachedToken = response.data.token;
  // JWT expira em 2h, renovar 5 min antes
  const payload = JSON.parse(Buffer.from(cachedToken.split('.')[1], 'base64').toString());
  tokenExp = (payload.exp * 1000) - (5 * 60 * 1000);
  console.log('[WPLAY] Token renovado com sucesso!');
  return cachedToken;
}

module.exports = getToken;
