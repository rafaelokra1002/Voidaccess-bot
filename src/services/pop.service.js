const axios = require('axios');

const API_URL = process.env.POP_API_URL;
const LOGIN_URL = process.env.POP_LOGIN_URL;
const POP_USER = process.env.POP_USERNAME;
const POP_PASS = process.env.POP_PASSWORD;

// Faz login no painel Pop e retorna o cookie de sessão
async function login() {
  const params = new URLSearchParams();
  params.append('username', POP_USER);
  params.append('password', POP_PASS);
  params.append('login', '');

  const response = await axios.post(LOGIN_URL, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    maxRedirects: 0,
    validateStatus: (s) => s < 500,
  });

  const cookies = response.headers['set-cookie'];
  if (!cookies) throw new Error('Falha ao obter sessão do Pop');

  // Pop usa cookie customizado ATV_*, não PHPSESSID
  const sessionCookie = cookies.find(c => c.startsWith('ATV_') || c.toUpperCase().startsWith('PHPSESSID'));
  if (!sessionCookie) throw new Error('Cookie de sessão não encontrado no Pop');
  console.log('[POP] Login OK, cookie obtido');
  return sessionCookie.split(';')[0];
}

// Cadastra MAC no painel Pop Player
async function registerMac(mac, username, password, title) {
  try {
    const cookie = await login();

    // Busca a página do formulário para extrair o campo "key" dinâmico
    const formPage = await axios.get(API_URL, {
      headers: { Cookie: cookie },
    });
    const keyMatch = formPage.data.match(/name="key"\s+value="([^"]*)"/);
    const key = keyMatch ? keyMatch[1] : '';
    console.log('[POP] Key extraída:', key);

    const m3uUrl = `http://painel.okratv.fun/get.php?username=${username}&password=${password}&type=m3u_plus&output=m3u8`;

    const params = new URLSearchParams();
    params.append('mac_address', mac);
    params.append('key', key);
    params.append('title', title || '');
    params.append('url', m3uUrl);
    params.append('epg_url', '');
    params.append('expire_date', '2050-01-01');
    params.append('app_selection', 'IBO PRO');
    params.append('submit', '');

    console.log('[POP] Cadastrando MAC:', mac, '| M3U:', m3uUrl);

    const response = await axios.post(API_URL, params, {
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    return response.data;
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    throw new Error(`Erro ao registrar MAC: ${message}`);
  }
}

module.exports = { registerMac };