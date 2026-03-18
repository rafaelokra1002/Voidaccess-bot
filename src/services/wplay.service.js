
const axios = require('axios');
const API_URL = process.env.WPLAY_API_URL;
const getToken = require('./wplay.token');

async function createTest(name) {
  try {
    const token = await getToken();
    const response = await axios.post(
      `${API_URL}/test`,
      {
        notes: name || '',
        package_p2p: '64399dca5ea59e8a1de2b083',
        package_iptv: '30',
        testDuration: 4,
        krator_package: '1',
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const { username, password, access_code } = response.data;
    console.log('[WPLAY] Resposta completa:', JSON.stringify(response.data));
    console.log('[WPLAY] Teste criado - User:', username, 'Pass:', password, 'Code:', access_code);
    return { username, password, access_code };
  } catch (error) {
    const message = error.response?.data?.message || error.message;
    throw new Error(`Erro ao criar teste: ${message}`);
  }
}

module.exports = { createTest };
